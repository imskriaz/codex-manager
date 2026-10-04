import * as vscode from "vscode";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as autoResumeSelection from "../src/services/codexSessionAutoResumeSelection";
import {
  AUTO_RESUME_SESSION_IDS_KEY,
  AUTO_RESUME_OPEN_SESSION_IDS_KEY,
  MAX_AUTO_RESUME_SESSIONS,
  formatAutoResumeResult,
  persistRunningCodexSessions,
  persistOpenCodexSessions,
  registerCodexSessionAutoResumeTracking,
  resumePersistedCodexSessions
} from "../src/services/codexSessionAutoResume";

function createContext(initial?: unknown) {
  const values = new Map<string, unknown>([[AUTO_RESUME_SESSION_IDS_KEY, initial]]);
  return {
    context: {
      workspaceState: {
        get: vi.fn((key: string) => values.get(key)),
        update: vi.fn(async (key: string, next: unknown) => {
          values.set(key, next);
        })
      }
    } as never,
    read: (key = AUTO_RESUME_SESSION_IDS_KEY) => values.get(key),
    set: (next: unknown, key = AUTO_RESUME_SESSION_IDS_KEY) => {
      values.set(key, next);
    }
  };
}

describe("durable open conversation recovery", () => {
  const first = "01a04882-d037-7a42-ad24-9afb61901181";
  const second = "01a04882-d037-7a42-ad24-9afb61901182";
  beforeEach(() => {
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockReset();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: () => true } as never);
  });

  it("records idle open tabs and restores them through a fresh host without a managed reload", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-open-restart-"));
    const file = path.join(root, "workspace.json");
    const newHost = async () => {
      const values = await readFile(file, "utf8").then((text) => JSON.parse(text) as Record<string, unknown>)
        .catch(() => ({} as Record<string, unknown>));
      return { workspaceState: {
        get: (key: string) => values[key],
        update: async (key: string, value: unknown) => {
          values[key] = value;
          await writeFile(file, JSON.stringify(values));
        }
      } } as never;
    };
    try {
      await persistOpenCodexSessions(await newHost(), async () => [first, second]);
      const open = vi.fn(async (_sessionId: string) => undefined);
      expect((await resumePersistedCodexSessions(await newHost(), open)).opened).toBe(2);
      expect(open.mock.calls.map(([id]) => id)).toEqual([first, second]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures tab changes and disposes its event subscription and retry timer on shutdown", async () => {
    vi.useFakeTimers();
    const previousTabs = vscode.window.tabGroups;
    const dispose = vi.fn();
    let changed: (() => void) | undefined;
    let ids: string[] = [first];
    const selection = vi.spyOn(autoResumeSelection, "readAutoResumeCodexSessionIds")
      .mockImplementation(async () => [...ids]);
    const tabs = () => ids.map((id) => ({ input: { viewType: "chatgpt.conversationEditor",
      uri: { scheme: "openai-codex", authority: "route", path: `/local/${id}` } } }));
    Object.assign(vscode.window, { tabGroups: {
      get all() { return [{ tabs: tabs() }]; },
      onDidChangeTabs: (listener: () => void) => { changed = listener; return { dispose }; }
    } });
    const state = createContext();
    const tracker = registerCodexSessionAutoResumeTracking(state.context);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toEqual([first]);
      ids = [second];
      changed?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toEqual([second]);
      tracker.dispose();
      expect(dispose).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      tracker.dispose();
      Object.assign(vscode.window, { tabGroups: previousTabs });
      selection.mockRestore();
      vi.useRealTimers();
    }
  });

  it("removes closed tabs while preserving failed restoration in its independent queue", async () => {
    const state = createContext([second]);
    await persistOpenCodexSessions(state.context, async () => [first]);
    await persistOpenCodexSessions(state.context, async () => []);
    expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toBeUndefined();
    const open = vi.fn(async (_sessionId: string) => undefined);
    await resumePersistedCodexSessions(state.context, open);
    expect(open.mock.calls.map(([id]) => id)).toEqual([second]);
  });

  it("keeps failed open tabs queued when the current window has no such tab", async () => {
    const state = createContext();
    await persistOpenCodexSessions(state.context, async () => [first]);
    await resumePersistedCodexSessions(state.context, async () => { throw new Error("offline"); });
    await persistOpenCodexSessions(state.context, async () => []);
    expect(state.read()).toEqual([first]);
  });

  it("transfers the previous snapshot before replacing it after a failed startup storage write", async () => {
    const state = createContext();
    state.set([first], AUTO_RESUME_OPEN_SESSION_IDS_KEY);
    state.context.workspaceState.update.mockRejectedValueOnce(new Error("disk full"));
    await expect(resumePersistedCodexSessions(state.context, async () => undefined)).rejects.toThrow("disk full");
    await persistOpenCodexSessions(state.context, async () => []);
    expect(state.read()).toEqual([first]);
    expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toBeUndefined();
  });

  it("keeps the last acknowledged snapshot when discovery fails or the tab queue overflows", async () => {
    const state = createContext();
    await persistOpenCodexSessions(state.context, async () => [first]);
    await expect(persistOpenCodexSessions(state.context, async () => { throw new Error("metadata incomplete"); }))
      .rejects.toThrow("metadata incomplete");
    const oversized = Array.from({ length: 201 }, (_, index) =>
      `01a04882-d037-7a42-ad24-${index.toString(16).padStart(12, "0")}`);
    await expect(persistOpenCodexSessions(state.context, async () => oversized)).rejects.toThrow("200");
    expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toEqual([first]);
  });

  it("recovers the acknowledged snapshot when Memento updates its cache before a failed replacement", async () => {
    const state = createContext();
    await persistOpenCodexSessions(state.context, async () => [first]);
    state.context.workspaceState.update.mockImplementationOnce(async (key, next) => {
      state.set(next, key);
      throw new Error("storage unavailable");
    });
    await expect(persistOpenCodexSessions(state.context, async () => [second])).rejects.toThrow("storage unavailable");
    const open = vi.fn(async (_sessionId: string) => undefined);
    await resumePersistedCodexSessions(state.context, open);
    expect(open.mock.calls.map(([id]) => id)).toEqual([first]);
  });

  it("clears both records when disabled, without reading tabs", async () => {
    const state = createContext([first]);
    state.set([second], AUTO_RESUME_OPEN_SESSION_IDS_KEY);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: () => false } as never);
    const read = vi.fn(async () => [first]);
    await persistOpenCodexSessions(state.context, read);
    expect(read).not.toHaveBeenCalled();
    expect(state.read()).toBeUndefined();
    expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toBeUndefined();
  });

  it("does not capture after tracker cancellation", async () => {
    const state = createContext();
    const controller = new AbortController();
    controller.abort(new Error("shutting down"));
    const read = vi.fn(async () => [first]);
    await expect(persistOpenCodexSessions(state.context, read, controller.signal)).rejects.toThrow("shutting down");
    expect(read).not.toHaveBeenCalled();
    expect(state.context.workspaceState.update).not.toHaveBeenCalled();
  });
});

describe("Codex session auto resume", () => {
  const id1 = "01a04882-d037-7a42-ad24-9afb61901181";
  const id2 = "01a04882-d037-7a42-ad24-9afb61901182";
  beforeEach(() => {
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockReset();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => (key === "autoResumeEnabled" ? true : fallback))
    } as never);
  });

  it("coalesces duplicate capture requests without scanning or writing twice", async () => {
    const state = createContext();
    const read = vi.fn(async () => [id1]);
    expect(
      await Promise.all([
        persistRunningCodexSessions(state.context, read),
        persistRunningCodexSessions(state.context, read)
      ])
    ).toEqual([[id1], [id1]]);
    expect(read).toHaveBeenCalledOnce();
    expect(state.context.workspaceState.update).toHaveBeenCalledOnce();
  });

  it("coalesces duplicate restoration even when the editor fails", async () => {
    const state = createContext([id1]);
    const open = vi.fn(async () => {
      throw new Error("offline");
    });
    const results = await Promise.all([
      resumePersistedCodexSessions(state.context, open),
      resumePersistedCodexSessions(state.context, open)
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(open).toHaveBeenCalledOnce();
    expect(state.read()).toEqual([id1]);
  });

  it("preserves recovery when Memento changes its cache before rejecting acknowledgement", async () => {
    const state = createContext([id1, id2]);
    let writes = 0;
    state.context.workspaceState.update.mockImplementation(async (_key, next) => {
      state.set(next);
      if (++writes === 2) throw new Error("disk full");
    });
    await expect(resumePersistedCodexSessions(state.context, async () => undefined)).rejects.toThrow("disk full");
    const replay = vi.fn(async (_id: string) => undefined);
    expect((await resumePersistedCodexSessions(state.context, replay)).attempted).toBe(2);
    expect(replay.mock.calls.map((call) => call[0]).sort()).toEqual([id1, id2]);
    expect(state.read()).toBeUndefined();
  });

  it("blocks further writes while a timed-out Memento write has an uncertain outcome", async () => {
    vi.useFakeTimers();
    try {
      const state = createContext([id1]);
      let settle: (() => void) | undefined;
      state.context.workspaceState.update.mockImplementationOnce((_key, next) => {
        state.set(next);
        return new Promise<void>((resolve) => {
          settle = resolve;
        });
      });
      const captured = persistRunningCodexSessions(state.context, async () => [id2]);
      const failed = expect(captured).rejects.toThrow("storage did not respond");
      await vi.advanceTimersByTimeAsync(5_000);
      await failed;
      await expect(persistRunningCodexSessions(state.context, async () => [])).rejects.toThrow(
        "previous auto-resume storage write"
      );
      expect(state.context.workspaceState.update).toHaveBeenCalledOnce();
      settle?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(await persistRunningCodexSessions(state.context, async () => [])).toEqual([id1, id2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out discovery without allowing its late result to overwrite saved IDs", async () => {
    vi.useFakeTimers();
    try {
      const state = createContext([id1]);
      let finish: ((ids: string[]) => void) | undefined;
      const captured = persistRunningCodexSessions(
        state.context,
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      const failed = expect(captured).rejects.toThrow("discovery did not respond");
      await vi.advanceTimersByTimeAsync(30_000);
      await failed;
      finish?.([id2]);
      await vi.advanceTimersByTimeAsync(0);
      expect(state.read()).toEqual([id1]);
      expect(state.context.workspaceState.update).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels discovery and clears pending recovery when the setting is disabled", async () => {
    let enabled = true;
    let changed: (() => void) | undefined;
    const dispose = vi.fn();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: () => enabled } as never);
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockImplementation((listener) => {
      changed = () => listener({ affectsConfiguration: () => true });
      return { dispose };
    });
    const state = createContext([id1]);
    let finish: ((ids: string[]) => void) | undefined;
    const captured = persistRunningCodexSessions(
      state.context,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    await vi.waitFor(() => expect(changed).toBeDefined());
    enabled = false;
    changed?.();
    expect(await captured).toEqual([]);
    finish?.([id2]);
    await Promise.resolve();
    expect(state.read()).toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("aborts restoration immediately on disable and never opens the next tab", async () => {
    let enabled = true;
    let changed: (() => void) | undefined;
    const dispose = vi.fn();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: () => enabled } as never);
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockImplementation((listener) => {
      changed = () => listener({ affectsConfiguration: () => true });
      return { dispose };
    });
    const state = createContext([id1, id2]);
    const open = vi.fn(async (_id: string, signal?: AbortSignal) => {
      enabled = false;
      changed?.();
      expect(signal?.aborted).toBe(true);
      await new Promise(() => {});
    });
    const result = await resumePersistedCodexSessions(state.context, open);
    expect(result.failed).toHaveLength(2);
    expect(open).toHaveBeenCalledOnce();
    expect(state.read()).toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("refuses queue overflow without dropping the previous recovery record", async () => {
    const state = createContext([id1]);
    const ids = Array.from(
      { length: MAX_AUTO_RESUME_SESSIONS + 1 },
      (_, i) => `01a04882-d037-7a42-ad24-${i.toString(16).padStart(12, "0")}`
    );
    await expect(persistRunningCodexSessions(state.context, async () => ids)).rejects.toThrow("up to 200");
    expect(state.read()).toEqual([id1]);
    expect(state.context.workspaceState.update).not.toHaveBeenCalled();
  });

  it("rejects malformed storage and allows explicit disable to clear it", async () => {
    const state = createContext({ sessionIds: [id1] });
    const open = vi.fn();
    await expect(resumePersistedCodexSessions(state.context, open)).rejects.toThrow("malformed");
    expect(open).not.toHaveBeenCalled();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: () => false } as never);
    await persistRunningCodexSessions(state.context);
    expect(state.read()).toBeUndefined();
  });

  it("normalizes UUID casing and drops invalid persisted identifiers", async () => {
    const state = createContext([id1.toUpperCase(), ` ${id1} `, "../escape", "", 4]);
    const open = vi.fn(async (_sessionId: string) => undefined);
    expect((await resumePersistedCodexSessions(state.context, open)).opened).toBe(1);
    expect(open).toHaveBeenCalledWith(id1, expect.any(AbortSignal));
  });

  it("bounds failure notification size", () => {
    const failed = Array.from({ length: 200 }, () => ({ sessionId: id1, message: "x".repeat(10_000) }));
    expect(formatAutoResumeResult({ attempted: 200, opened: 0, failed })!.length).toBeLessThan(1_200);
    expect(formatAutoResumeResult({ attempted: 200, opened: 0, failed })).toContain("197 more");
  });

  it("restores a disk-backed record through fresh contexts and retries only failed tabs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-resume-storage-"));
    const file = path.join(root, "workspace.json");
    async function newContext() {
      let saved: unknown;
      try {
        saved = JSON.parse(await readFile(file, "utf8"));
      } catch {
        saved = undefined;
      }
      return {
        workspaceState: {
          get: () => saved,
          update: async (_key: string, next: unknown) => {
            await writeFile(file, JSON.stringify(next ?? null));
            saved = next;
          }
        }
      } as never;
    }
    try {
      await persistRunningCodexSessions(await newContext(), async () => [
        "01a04882-d037-7a42-ad24-9afb61901181",
        "01a04882-d037-7a42-ad24-9afb61901182"
      ]);
      const result = await resumePersistedCodexSessions(await newContext(), async (id) => {
        if (id === "01a04882-d037-7a42-ad24-9afb61901182") throw new Error("Codex unavailable");
      });
      expect(result.opened).toBe(1);
      const retry = vi.fn(async () => undefined);
      expect((await resumePersistedCodexSessions(await newContext(), retry)).opened).toBe(1);
      expect(retry).toHaveBeenCalledWith("01a04882-d037-7a42-ad24-9afb61901182", expect.any(AbortSignal));
      expect(JSON.parse(await readFile(file, "utf8"))).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores tabs before fallible account and dashboard startup", async () => {
    const source = await readFile("src/presentation/workbench/accountsWorkbench.ts", "utf8");
    expect(source.indexOf('measureStep("autoResumeCodexSessions"')).toBeLessThan(
      source.indexOf('measureStep("repo.init"')
    );
    expect(source.indexOf('measureStep("autoResumeCodexSessions"')).toBeLessThan(
      source.indexOf('measureStep("restoreDashboardAfterExtensionHostRestart"')
    );
  });

  it("persists running sessions with Session Integration disabled", async () => {
    const state = createContext();
    const ids = await persistRunningCodexSessions(state.context, async () => [
      "01a04882-d037-7a42-ad24-9afb61901181",
      "01a04882-d037-7a42-ad24-9afb61901184",
      "01a04882-d037-7a42-ad24-9afb61901181"
    ]);

    expect(ids).toEqual(["01a04882-d037-7a42-ad24-9afb61901181", "01a04882-d037-7a42-ad24-9afb61901184"]);
    expect(state.read()).toEqual(ids);
    expect(state.context.workspaceState.update).toHaveBeenCalledWith(AUTO_RESUME_SESSION_IDS_KEY, ids);
  });

  it("bounds the whole restoration and retains unattempted tabs after timeout", async () => {
    vi.useFakeTimers();
    try {
      const state = createContext(["01a04882-d037-7a42-ad24-9afb61901181", "01a04882-d037-7a42-ad24-9afb61901182"]);
      const open = vi.fn((id: string) =>
        id === "01a04882-d037-7a42-ad24-9afb61901181" ? new Promise<void>(() => {}) : Promise.resolve()
      );
      const pending = resumePersistedCodexSessions(state.context, open);
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;
      expect(result.opened).toBe(0);
      expect(result.failed).toHaveLength(2);
      expect(result.failed[0]?.message).toContain("30 seconds");
      expect(open).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the recovery record when metadata discovery fails", async () => {
    const state = createContext(["01a04882-d037-7a42-ad24-9afb61901185"]);
    await expect(
      persistRunningCodexSessions(state.context, async () => {
        throw new Error("read failed");
      })
    ).rejects.toThrow("read failed");
    expect(state.read()).toEqual(["01a04882-d037-7a42-ad24-9afb61901185"]);
  });

  it("retains interrupted recovery even when no process remains after reboot", async () => {
    const state = createContext(["01a04882-d037-7a42-ad24-9afb61901186"]);
    await expect(persistRunningCodexSessions(state.context, async () => [])).resolves.toEqual([
      "01a04882-d037-7a42-ad24-9afb61901186"
    ]);
    expect(state.read()).toEqual(["01a04882-d037-7a42-ad24-9afb61901186"]);
  });

  it("reports storage failure before claiming sessions were preserved", async () => {
    const state = createContext();
    state.context.workspaceState.update.mockRejectedValue(new Error("storage full"));
    await expect(
      persistRunningCodexSessions(state.context, async () => ["01a04882-d037-7a42-ad24-9afb61901181"])
    ).rejects.toThrow("storage full");
  });

  it("does not open sessions when consuming storage fails", async () => {
    const state = createContext(["01a04882-d037-7a42-ad24-9afb61901181"]);
    state.context.workspaceState.update.mockRejectedValue(new Error("storage unavailable"));
    const open = vi.fn();
    await expect(resumePersistedCodexSessions(state.context, open)).rejects.toThrow("storage unavailable");
    expect(open).not.toHaveBeenCalled();
  });

  it("clears stale state without reading sessions when auto resume is disabled", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_key: string, fallback?: unknown) => fallback)
    } as never);
    const state = createContext(["01a04882-d037-7a42-ad24-9afb61901185"]);
    const readSessions = vi.fn();

    await expect(persistRunningCodexSessions(state.context, readSessions)).resolves.toEqual([]);
    expect(readSessions).not.toHaveBeenCalled();
    expect(state.read()).toBeUndefined();
  });

  it("restores stored sessions with Session Integration disabled", async () => {
    const state = createContext(["01a04882-d037-7a42-ad24-9afb61901181"]);
    const openSession = vi.fn();

    await expect(resumePersistedCodexSessions(state.context, openSession)).resolves.toEqual({
      attempted: 1,
      opened: 1,
      failed: []
    });
    expect(openSession).toHaveBeenCalledWith("01a04882-d037-7a42-ad24-9afb61901181", expect.any(AbortSignal));
    expect(state.read()).toBeUndefined();
  });

  it("does not restore stored sessions after Auto Resume is turned off", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_key: string, fallback?: unknown) => fallback)
    } as never);
    const state = createContext(["01a04882-d037-7a42-ad24-9afb61901181"]);
    const openSession = vi.fn();

    await expect(resumePersistedCodexSessions(state.context, openSession)).resolves.toEqual({
      attempted: 0,
      opened: 0,
      failed: []
    });
    expect(openSession).not.toHaveBeenCalled();
    expect(state.read()).toBeUndefined();
  });

  it("acknowledges opened sessions and retains failed sessions for the next activation", async () => {
    const state = createContext(["01a04882-d037-7a42-ad24-9afb61901181", "01a04882-d037-7a42-ad24-9afb61901182"]);
    const openSession = vi.fn(async (sessionId: string) => {
      if (sessionId === "01a04882-d037-7a42-ad24-9afb61901182") throw new Error("editor unavailable");
    });

    await expect(resumePersistedCodexSessions(state.context, openSession)).resolves.toEqual({
      attempted: 2,
      opened: 1,
      failed: [{ sessionId: "01a04882-d037-7a42-ad24-9afb61901182", message: "editor unavailable" }]
    });
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(state.read()).toEqual(["01a04882-d037-7a42-ad24-9afb61901182"]);
    const retry = vi.fn(async () => undefined);
    expect((await resumePersistedCodexSessions(state.context, retry)).opened).toBe(1);
    expect(retry).toHaveBeenCalledWith("01a04882-d037-7a42-ad24-9afb61901182", expect.any(AbortSignal));
    expect(state.read()).toBeUndefined();
  });

  it("serializes duplicate restoration without opening successful tabs twice", async () => {
    const state = createContext(["01a04882-d037-7a42-ad24-9afb61901181"]);
    const open = vi.fn(async (_sessionId: string) => undefined);
    const results = await Promise.all([
      resumePersistedCodexSessions(state.context, open),
      resumePersistedCodexSessions(state.context, open)
    ]);
    expect(results.map((result) => result.opened)).toEqual([1, 1]);
    expect(open).toHaveBeenCalledOnce();
  });

  it("keeps pending sessions durable while opening and when acknowledgement fails", async () => {
    const state = createContext(["01a04882-d037-7a42-ad24-9afb61901181", "01a04882-d037-7a42-ad24-9afb61901182"]);
    const open = vi.fn(async () => {
      expect(state.read()).toEqual(["01a04882-d037-7a42-ad24-9afb61901181", "01a04882-d037-7a42-ad24-9afb61901182"]);
      state.context.workspaceState.update.mockRejectedValueOnce(new Error("storage full"));
    });
    await expect(resumePersistedCodexSessions(state.context, open)).rejects.toThrow("storage full");
    expect(open).toHaveBeenCalledOnce();
    expect(state.read()).toEqual(["01a04882-d037-7a42-ad24-9afb61901181", "01a04882-d037-7a42-ad24-9afb61901182"]);
  });

  it("merges pending recovery with a normalized fresh capture", async () => {
    const state = createContext(["01a04882-d037-7a42-ad24-9afb61901187"]);
    expect(
      await persistRunningCodexSessions(state.context, async () => [
        " 01a04882-d037-7a42-ad24-9afb61901188 ",
        "",
        "01a04882-d037-7a42-ad24-9afb61901188"
      ])
    ).toEqual(["01a04882-d037-7a42-ad24-9afb61901187", "01a04882-d037-7a42-ad24-9afb61901188"]);
  });

  it("aborts a timed out opener and retains its recovery record", async () => {
    vi.useFakeTimers();
    try {
      const state = createContext(["01a04882-d037-7a42-ad24-9afb61901181"]);
      let signal: AbortSignal | undefined;
      const result = resumePersistedCodexSessions(state.context, async (_id, token) => {
        signal = token;
        await new Promise(() => {});
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await result).failed).toHaveLength(1);
      expect(signal?.aborted).toBe(true);
      expect(state.read()).toEqual(["01a04882-d037-7a42-ad24-9afb61901181"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("trims and deduplicates persisted state and produces visible completion copy", async () => {
    const state = createContext([
      "01a04882-d037-7a42-ad24-9afb61901181",
      " 01a04882-d037-7a42-ad24-9afb61901181 ",
      42,
      "",
      null
    ]);
    const open = vi.fn(async (_sessionId: string) => undefined);
    expect((await resumePersistedCodexSessions(state.context, open)).opened).toBe(1);
    expect(open).toHaveBeenCalledOnce();
    expect(formatAutoResumeResult({ attempted: 1, opened: 1, failed: [] })).toBe(
      "Auto resume reopened 1 running VS Code Codex session."
    );
    expect(
      formatAutoResumeResult({
        attempted: 2,
        opened: 1,
        failed: [{ sessionId: "01a04882-d037-7a42-ad24-9afb61901182", message: "editor unavailable" }]
      })
    ).toContain("01a04882-d037-7a42-ad24-9afb61901182 (editor unavailable)");
    expect(formatAutoResumeResult({ attempted: 0, opened: 0, failed: [] })).toBeUndefined();
  });
});
