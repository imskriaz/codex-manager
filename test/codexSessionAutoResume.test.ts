import * as vscode from "vscode";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_RESUME_SESSION_IDS_KEY,
  consumePersistedCodexSessionIds,
  formatAutoResumeResult,
  persistRunningCodexSessions,
  resumePersistedCodexSessions
} from "../src/services/codexSessionAutoResume";

function createContext(initial?: unknown) {
  let value = initial;
  return {
    context: {
      workspaceState: {
        get: vi.fn(() => value),
        update: vi.fn(async (_key: string, next: unknown) => {
          value = next;
        })
      }
    } as never,
    read: () => value
  };
}

describe("Codex session auto resume", () => {
  beforeEach(() => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => (key === "autoResumeEnabled" ? true : fallback))
    } as never);
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
      await persistRunningCodexSessions(await newContext(), async () => ["session-1", "session-2"]);
      const result = await resumePersistedCodexSessions(await newContext(), async (id) => {
        if (id === "session-2") throw new Error("Codex unavailable");
      });
      expect(result.opened).toBe(1);
      const retry = vi.fn(async () => undefined);
      expect((await resumePersistedCodexSessions(await newContext(), retry)).opened).toBe(1);
      expect(retry).toHaveBeenCalledWith("session-2", expect.any(AbortSignal));
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
    const ids = await persistRunningCodexSessions(state.context, async () => ["session-1", "session-4", "session-1"]);

    expect(ids).toEqual(["session-1", "session-4"]);
    expect(state.read()).toEqual(ids);
    expect(state.context.workspaceState.update).toHaveBeenCalledWith(AUTO_RESUME_SESSION_IDS_KEY, ids);
  });

  it("reports an editor timeout and continues opening the remaining sessions", async () => {
    vi.useFakeTimers();
    try {
      const state = createContext(["session-1", "session-2"]);
      const open = vi.fn((id: string) => (id === "session-1" ? new Promise<void>(() => {}) : Promise.resolve()));
      const pending = resumePersistedCodexSessions(state.context, open);
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;
      expect(result.opened).toBe(1);
      expect(result.failed[0]?.message).toContain("30 seconds");
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the recovery record when metadata discovery fails", async () => {
    const state = createContext(["stale-session"]);
    await expect(
      persistRunningCodexSessions(state.context, async () => {
        throw new Error("read failed");
      })
    ).rejects.toThrow("read failed");
    expect(state.read()).toEqual(["stale-session"]);
  });

  it("retains interrupted recovery even when no process remains after reboot", async () => {
    const state = createContext(["old-session"]);
    await expect(persistRunningCodexSessions(state.context, async () => [])).resolves.toEqual(["old-session"]);
    expect(state.read()).toEqual(["old-session"]);
  });

  it("reports storage failure before claiming sessions were preserved", async () => {
    const state = createContext();
    state.context.workspaceState.update.mockRejectedValue(new Error("storage full"));
    await expect(persistRunningCodexSessions(state.context, async () => ["session-1"])).rejects.toThrow("storage full");
  });

  it("does not open sessions when consuming storage fails", async () => {
    const state = createContext(["session-1"]);
    state.context.workspaceState.update.mockRejectedValue(new Error("storage unavailable"));
    const open = vi.fn();
    await expect(resumePersistedCodexSessions(state.context, open)).rejects.toThrow("storage unavailable");
    expect(open).not.toHaveBeenCalled();
  });

  it("clears stale state without reading sessions when auto resume is disabled", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_key: string, fallback?: unknown) => fallback)
    } as never);
    const state = createContext(["stale-session"]);
    const readSessions = vi.fn();

    await expect(persistRunningCodexSessions(state.context, readSessions)).resolves.toEqual([]);
    expect(readSessions).not.toHaveBeenCalled();
    expect(state.read()).toBeUndefined();
  });

  it("restores stored sessions with Session Integration disabled", async () => {
    const state = createContext(["session-1"]);
    const openSession = vi.fn();

    await expect(resumePersistedCodexSessions(state.context, openSession)).resolves.toEqual({
      attempted: 1,
      opened: 1,
      failed: []
    });
    expect(openSession).toHaveBeenCalledWith("session-1", expect.any(AbortSignal));
    expect(state.read()).toBeUndefined();
  });

  it("does not restore stored sessions after Auto Resume is turned off", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_key: string, fallback?: unknown) => fallback)
    } as never);
    const state = createContext(["session-1"]);
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
    const state = createContext(["session-1", "session-2"]);
    const openSession = vi.fn(async (sessionId: string) => {
      if (sessionId === "session-2") throw new Error("editor unavailable");
    });

    await expect(resumePersistedCodexSessions(state.context, openSession)).resolves.toEqual({
      attempted: 2,
      opened: 1,
      failed: [{ sessionId: "session-2", message: "editor unavailable" }]
    });
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(state.read()).toEqual(["session-2"]);
    const retry = vi.fn(async () => undefined);
    expect((await resumePersistedCodexSessions(state.context, retry)).opened).toBe(1);
    expect(retry).toHaveBeenCalledWith("session-2", expect.any(AbortSignal));
    expect(state.read()).toBeUndefined();
  });

  it("serializes duplicate restoration without opening successful tabs twice", async () => {
    const state = createContext(["session-1"]);
    const open = vi.fn(async () => undefined);
    const results = await Promise.all([
      resumePersistedCodexSessions(state.context, open),
      resumePersistedCodexSessions(state.context, open)
    ]);
    expect(results.map((result) => result.opened)).toEqual([1, 0]);
    expect(open).toHaveBeenCalledOnce();
  });

  it("keeps pending sessions durable while opening and when acknowledgement fails", async () => {
    const state = createContext(["session-1", "session-2"]);
    const open = vi.fn(async () => {
      expect(state.read()).toEqual(["session-1", "session-2"]);
      state.context.workspaceState.update.mockRejectedValueOnce(new Error("storage full"));
    });
    await expect(resumePersistedCodexSessions(state.context, open)).rejects.toThrow("storage full");
    expect(open).toHaveBeenCalledOnce();
    expect(state.read()).toEqual(["session-1", "session-2"]);
  });

  it("merges pending recovery with a normalized fresh capture", async () => {
    const state = createContext(["pending"]);
    expect(await persistRunningCodexSessions(state.context, async () => [" new ", "", "new"])).toEqual([
      "pending",
      "new"
    ]);
  });

  it("aborts a timed out opener and retains its recovery record", async () => {
    vi.useFakeTimers();
    try {
      const state = createContext(["session-1"]);
      let signal: AbortSignal | undefined;
      const result = resumePersistedCodexSessions(state.context, async (_id, token) => {
        signal = token;
        await new Promise(() => {});
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await result).failed).toHaveLength(1);
      expect(signal?.aborted).toBe(true);
      expect(state.read()).toEqual(["session-1"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("trims and deduplicates persisted state and produces visible completion copy", async () => {
    const state = createContext(["session-1", " session-1 ", 42, "", null]);
    await expect(consumePersistedCodexSessionIds(state.context)).resolves.toEqual(["session-1"]);
    expect(formatAutoResumeResult({ attempted: 1, opened: 1, failed: [] })).toBe(
      "Auto resume reopened 1 running VS Code Codex session."
    );
    expect(
      formatAutoResumeResult({
        attempted: 2,
        opened: 1,
        failed: [{ sessionId: "session-2", message: "editor unavailable" }]
      })
    ).toContain("session-2 (editor unavailable)");
    expect(formatAutoResumeResult({ attempted: 0, opened: 0, failed: [] })).toBeUndefined();
  });
});
