import * as vscode from "vscode";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as autoResumeSelection from "../src/services/codexSessionAutoResumeSelection";
import * as sessionEditor from "../src/services/codexSessionResume";
import {
  AUTO_RESUME_SESSION_IDS_KEY,
  AUTO_RESUME_OPEN_SESSION_IDS_KEY,
  MAX_AUTO_RESUME_SESSIONS,
  cancelCodexSessionAutoResume,
  closeCodexSessionsForExtensionHostRestart,
  formatAutoResumeResult,
  prepareCodexSessionsForExtensionHostRestart,
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

const readNativeTabs = sessionEditor.readOpenCodexSessionIds;
beforeEach(() => {
  const ids = ["01a04882-d037-7a42-ad24-9afb61901181", "01a04882-d037-7a42-ad24-9afb61901182"];
  Object.assign(vscode.window, { tabGroups: { all: [{ tabs: ids.map(id => ({ input: {
    viewType: "chatgpt.conversationEditor", uri: { scheme: "openai-codex", authority: "route", path: `/local/${id}` }
  } })) }] } });
  vi.spyOn(sessionEditor, "closeOpenCodexSessionTabs").mockReset().mockResolvedValue(undefined);
  vi.spyOn(sessionEditor, "readOpenCodexSessionIds").mockImplementation(readNativeTabs);
  vi.spyOn(sessionEditor, "readRunningCodexSessionIds").mockImplementation(async (_home, _signal, open) => open ?? []).mockClear();
  vi.spyOn(autoResumeSelection, "readAutoResumeGoalCandidateIds").mockResolvedValue([]);
  vi.spyOn(autoResumeSelection, "filterAutoResumeGoalSessionIds").mockImplementation(async (ids) => ids);

});

describe("durable open conversation recovery", () => {
  const first = "01a04882-d037-7a42-ad24-9afb61901181";
  const second = "01a04882-d037-7a42-ad24-9afb61901182";
  it("seals recovery before closing so background tab tracking cannot erase it", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: () => true } as never);
    const state = createContext([first]);
    state.set([second], AUTO_RESUME_OPEN_SESSION_IDS_KEY);
    vi.mocked(sessionEditor.closeOpenCodexSessionTabs).mockImplementationOnce(async () => {
      expect(state.read()).toEqual([first, second]);
    });
    await closeCodexSessionsForExtensionHostRestart(state.context);
    expect(sessionEditor.closeOpenCodexSessionTabs).toHaveBeenCalledWith(undefined, true);
    await persistOpenCodexSessions(state.context, async () => []);
    expect(state.read()).toEqual([first, second]);
  });

  it("closes existing editors with Auto Resume off without adding recovery", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: () => false } as never);
    const state = createContext();
    await closeCodexSessionsForExtensionHostRestart(state.context);
    expect(sessionEditor.closeOpenCodexSessionTabs).toHaveBeenCalledWith(undefined, true);
    expect(state.context.workspaceState.update).not.toHaveBeenCalled();
  });

  it("queues cleanup after an in-flight capture instead of joining it and skipping close", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: () => true } as never);
    const state = createContext();
    let release!: (ids: string[]) => void;
    const capture = persistRunningCodexSessions(state.context, () => new Promise(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const closing = closeCodexSessionsForExtensionHostRestart(state.context);
    expect(sessionEditor.closeOpenCodexSessionTabs).not.toHaveBeenCalled();
    release([first]);
    await Promise.all([capture, closing]);
    expect(sessionEditor.closeOpenCodexSessionTabs).toHaveBeenCalledOnce();
    expect(state.read()).toEqual([first]);
  });

  it("retains existing tabs when recovery cannot be saved before closing", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: () => true } as never);
    const state = createContext([first]);
    state.context.workspaceState.update.mockRejectedValueOnce(new Error("storage full"));
    await expect(closeCodexSessionsForExtensionHostRestart(state.context)).rejects.toThrow("storage full");
    expect(sessionEditor.closeOpenCodexSessionTabs).not.toHaveBeenCalled();
  });

  it("never closes editors after reload cleanup was cancelled", async () => {
    const state = createContext([first]);
    const controller = new AbortController(); controller.abort(new Error("cleanup ended"));
    await expect(closeCodexSessionsForExtensionHostRestart(state.context, controller.signal)).rejects.toThrow("cleanup ended");
    expect(sessionEditor.closeOpenCodexSessionTabs).not.toHaveBeenCalled();
  });
  it("leaves disabled Auto Resume idle with no tab subscription, timer, discovery, or empty storage writes", async () => {
    vi.useFakeTimers();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: () => false } as never);
    const previousTabs = vscode.window.tabGroups;
    const subscribe = vi.fn(() => ({ dispose() {} }));
    Object.assign(vscode.window, { tabGroups: { all: [], onDidChangeTabs: subscribe } });
    const readTabs = vi.spyOn(sessionEditor, "readOpenCodexSessionIds");
    const discover = vi.spyOn(autoResumeSelection, "readAutoResumeCodexSessionIds");
    const state = createContext();
    const tracker = registerCodexSessionAutoResumeTracking(state.context);
    try {
      await resumePersistedCodexSessions(state.context);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(subscribe).not.toHaveBeenCalled();
      expect(readTabs).not.toHaveBeenCalled();
      expect(discover).not.toHaveBeenCalled();
      expect(state.context.workspaceState.update).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      tracker.dispose();
      Object.assign(vscode.window, { tabGroups: previousTabs });
      readTabs.mockRestore(); discover.mockRestore(); vi.useRealTimers();
    }
  });

  it("cancels restoration during initial goal discovery and retains recovery for retry", async () => {
    const state = createContext([first]);
    const open = vi.fn();
    let finish!: (ids: string[]) => void;
    vi.mocked(autoResumeSelection.filterAutoResumeGoalSessionIds).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const work = resumePersistedCodexSessions(state.context, open);
    const checked = expect(work).rejects.toThrow("account is changing");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    cancelCodexSessionAutoResume();
    await checked;
    finish([first]);
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();
    expect(state.read()).toEqual([first]);
  });
  it("retains recovery when reload cancels capture and ignores late discovery", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: () => true } as never);
    const state = createContext([first]);
    const controller = new AbortController();
    let finish!: (ids: string[]) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const work = persistRunningCodexSessions(state.context, async () => {
      started();
      return new Promise<string[]>(resolve => { finish = resolve; });
    }, controller.signal);
    const failed = expect(work).rejects.toThrow("Reload deadline");
    await ready;
    controller.abort(new Error("Reload deadline"));
    await failed;
    finish([second]);
    await Promise.resolve();
    expect(state.read()).toEqual([first]);
    expect(state.context.workspaceState.update).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockReset();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: () => true } as never);
  });

  it("captures running parent tabs and excludes idle tabs before a managed reload", async () => {
    const state = createContext([first]);
    state.set([second], AUTO_RESUME_OPEN_SESSION_IDS_KEY);
    await prepareCodexSessionsForExtensionHostRestart(
      state.context,
      true,
      async () => [first],
      async () => [second]
    );
    expect(state.read()).toEqual([first]);
    expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toBeUndefined();
  });

  it("records a newly active goal without requiring its open tab to change", async () => {
    vi.useFakeTimers();
    const state = createContext();
    vi.spyOn(sessionEditor, "readOpenCodexSessionIds").mockReturnValue([first]);
    vi.spyOn(autoResumeSelection, "readAutoResumeCodexSessionIds").mockResolvedValue([first]);
    let active = false;
    vi.mocked(autoResumeSelection.filterAutoResumeGoalSessionIds).mockImplementation(async (ids) => active ? ids : []);
    const tracker = registerCodexSessionAutoResumeTracking(state.context);
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toBeUndefined();
      active = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toEqual([first]);
      const writes = state.context.workspaceState.update.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(state.context.workspaceState.update.mock.calls.length).toBe(writes);
    } finally { tracker.dispose(); vi.useRealTimers(); }
  });

  it("reuses already verified running IDs when saving open parents", async () => {
    const state = createContext();
    vi.spyOn(sessionEditor, "readOpenCodexSessionIds").mockReturnValue([first]);
    const recent = vi.spyOn(sessionEditor, "readRecentRunningCodexSessionIds").mockReturnValue([first]);
    const selection = vi.spyOn(autoResumeSelection, "readAutoResumeCodexSessionIds")
      .mockImplementation(async (_home, _workspaces, _open, _signal, mode) => {
        if (mode !== "running") throw new Error("Unexpected selection mode");
        return [first];
      });
    try {
      await expect(persistOpenCodexSessions(state.context)).resolves.toEqual([first]);
      expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toEqual([first]);
      expect(selection).toHaveBeenCalledWith(undefined, undefined, [first], expect.any(AbortSignal), "running", true, [first], [first]);
      expect(sessionEditor.readRunningCodexSessionIds).not.toHaveBeenCalled();
    } finally { selection.mockRestore(); recent.mockRestore(); }
  });

  it("saves changed running checks immediately without waiting for a tab event or retry timer", async () => {
    vi.useFakeTimers();
    const state = createContext();
    let running: string[] = [];
    let checked: ((home: string) => void) | undefined;
    const dispose = vi.fn();
    const subscribe = vi.spyOn(sessionEditor, "onDidInspectRunningCodexSessions").mockImplementation(listener => {
      checked = listener; return { dispose };
    });
    const recent = vi.spyOn(sessionEditor, "readRecentRunningCodexSessionIds").mockImplementation(() => [...running]);
    vi.spyOn(autoResumeSelection, "readAutoResumeCodexSessionIds").mockImplementation(async (_home, _workspaces, open, _signal, _mode, _goals, ids) =>
      (ids ?? []).filter(id => open?.includes(id)));
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) => ["autoSwitchEnabled", "autoResumeEnabled"].includes(key) ? true : key === "autoResumeGoalOnlyEnabled" ? false : fallback
    } as never);
    const tracker = registerCodexSessionAutoResumeTracking(state.context);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toBeUndefined();
      running = [first];
      checked?.(path.resolve(sessionEditor.resolveCodexHome()));
      await vi.advanceTimersByTimeAsync(0);
      expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toEqual([first]);
      running = [];
      checked?.(path.resolve(sessionEditor.resolveCodexHome()));
      await vi.advanceTimersByTimeAsync(0);
      expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toBeUndefined();
    } finally {
      tracker.dispose(); subscribe.mockRestore(); recent.mockRestore(); vi.useRealTimers();
    }
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each(["metadata", "goals", "storage", "timeout"])(
    "quietly retains saved tabs and automatically retries a background %s failure", async (failure) => {
      vi.useFakeTimers();
      const state = createContext();
      state.set([first], AUTO_RESUME_OPEN_SESSION_IDS_KEY);
      const detail = new Error(`${failure} unavailable`);
      const selection = vi.spyOn(autoResumeSelection, "readAutoResumeCodexSessionIds").mockResolvedValue([second]);
      const open = vi.spyOn(sessionEditor, "readOpenCodexSessionIds").mockReturnValue([second]);
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const filter = vi.mocked(autoResumeSelection.filterAutoResumeGoalSessionIds);
      if (failure === "metadata") selection.mockRejectedValueOnce(detail);
      if (failure === "goals") filter.mockRejectedValueOnce(detail);
      if (failure === "storage") state.context.workspaceState.update.mockRejectedValueOnce(detail);
      let captureSignal: AbortSignal | undefined;
      let finish: ((ids: string[]) => void) | undefined;
      if (failure === "timeout") selection.mockImplementationOnce((_home, _workspaces, _open, signal) => {
        captureSignal = signal;
        return new Promise(resolve => { finish = resolve; });
      });
      vi.mocked(vscode.window.showWarningMessage).mockClear();
      vi.mocked(vscode.window.showErrorMessage).mockClear();
      vi.mocked(vscode.window.showInformationMessage).mockClear();
      const tracker = registerCodexSessionAutoResumeTracking(state.context);
      try {
        await vi.advanceTimersByTimeAsync(failure === "timeout" ? 30_000 : 0);
        expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toEqual([first]);
        expect(warning).toHaveBeenCalledWith("[codexManager] open Codex tabs could not be saved for auto resume", expect.any(Error));
        if (failure === "timeout") {
          expect(captureSignal?.aborted).toBe(true);
          finish?.([first]);
          await vi.advanceTimersByTimeAsync(0);
        }
        await vi.advanceTimersByTimeAsync(30_000);
        expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toEqual([second]);
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
        expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
      } finally {
        tracker.dispose();
        selection.mockRestore();
        open.mockRestore();
        warning.mockRestore();
        vi.useRealTimers();
      }
    }
  );

  it("filters saved recovery before opening and skips sessions without an active goal", async () => {
    vi.mocked(autoResumeSelection.filterAutoResumeGoalSessionIds).mockImplementation(async (ids) => ids.filter((id) => id === first));
    const state = createContext([first, second]);
    state.set([second], AUTO_RESUME_OPEN_SESSION_IDS_KEY);
    const open = vi.fn(async () => undefined);
    expect((await resumePersistedCodexSessions(state.context, open)).opened).toBe(1);
    expect(open).toHaveBeenCalledWith(first, expect.any(AbortSignal));
    expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toBeUndefined();
    open.mockClear();
    expect((await resumePersistedCodexSessions(createContext([second]).context, open)).attempted).toBe(0);
    expect(open).not.toHaveBeenCalled();
  });

  it("retains both recovery records and existing tabs when goal storage cannot be read", async () => {
    vi.mocked(autoResumeSelection.filterAutoResumeGoalSessionIds).mockRejectedValue(new Error("goal storage unavailable"));
    const state = createContext([first]);
    state.set([second], AUTO_RESUME_OPEN_SESSION_IDS_KEY);
    await expect(resumePersistedCodexSessions(state.context, vi.fn())).rejects.toThrow("goal storage unavailable");
    expect(state.read()).toEqual([first]);
    expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toEqual([second]);
  });

  it("rechecks goals that become inactive during discovery before opening each saved session", async () => {
    const state = createContext([first]);
    vi.mocked(autoResumeSelection.filterAutoResumeGoalSessionIds).mockResolvedValueOnce([first]).mockResolvedValue([]);
    const open = vi.fn();
    expect((await resumePersistedCodexSessions(state.context, open)).opened).toBe(0);
    expect(open).not.toHaveBeenCalled();
    expect(state.read()).toBeUndefined();
  });

  it("records selected running tabs and restores them through a fresh host without a managed reload", async () => {
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

  it.each(["managed capture", "open-tab capture", "restore"])(
    "disables %s when Auto Switch is off even with Auto Resume saved on",
    async (operation) => {
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: (key: string, fallback?: unknown) => key === "autoResumeEnabled" ? true : fallback
      } as never);
      const state = createContext([first]);
      state.set([second], AUTO_RESUME_OPEN_SESSION_IDS_KEY);
      const work = vi.fn(async (_id?: string) => [first]);
      if (operation === "managed capture") await persistRunningCodexSessions(state.context, work);
      else if (operation === "open-tab capture") await persistOpenCodexSessions(state.context, work);
      else await resumePersistedCodexSessions(state.context, async (id) => { await work(id); });
      expect(work).not.toHaveBeenCalled();
      expect(state.read()).toBeUndefined();
      expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toBeUndefined();
    }
  );

  it("reacts immediately to parent off/on changes without rewriting the child preference", async () => {
    vi.useFakeTimers();
    let parent = true;
    const listeners = new Set<(event: vscode.ConfigurationChangeEvent) => unknown>();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) =>
        key === "autoSwitchEnabled" ? parent : key === "autoResumeEnabled" ? true : fallback
    } as never);
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockImplementation(listener => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    });
    const previousTabs = vscode.window.tabGroups;
    Object.assign(vscode.window, { tabGroups: { all: [], onDidChangeTabs: () => ({ dispose() {} }) } });
    const selection = vi.spyOn(autoResumeSelection, "readAutoResumeCodexSessionIds").mockResolvedValue([first]);
    vi.mocked(sessionEditor.readOpenCodexSessionIds).mockReturnValue([first]);
    const state = createContext();
    const tracker = registerCodexSessionAutoResumeTracking(state.context);
    const changed = () => {
      for (const listener of [...listeners]) listener({
        affectsConfiguration: (key: string) => key === "codexManager.autoSwitchEnabled"
      } as vscode.ConfigurationChangeEvent);
    };
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toEqual([first]);
      parent = false;
      changed();
      await vi.advanceTimersByTimeAsync(0);
      expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      expect(selection).toHaveBeenCalledOnce();
      parent = true;
      changed();
      await vi.advanceTimersByTimeAsync(0);
      expect(state.read(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toEqual([first]);
      expect(selection).toHaveBeenCalledTimes(2);
    } finally {
      tracker.dispose();
      Object.assign(vscode.window, { tabGroups: previousTabs });
      selection.mockRestore();
      vi.useRealTimers();
    }
  });

  it("persists selected recovery, closes existing tabs, then opens sessions sequentially", async () => {
    const state = createContext([first]);
    state.set([second], AUTO_RESUME_OPEN_SESSION_IDS_KEY);
    const order: string[] = [];
    const close = vi.mocked(sessionEditor.closeOpenCodexSessionTabs).mockClear().mockImplementation(async () => {
      expect(state.read()).toEqual([first, second]);
      order.push("close");
    });
    const open = vi.fn(async (id: string) => {
      expect(state.read()).toContain(id);
      order.push(id);
    });
    expect((await resumePersistedCodexSessions(state.context, open)).opened).toBe(2);
    expect(order).toEqual(["close", first, second]);
    expect(close).toHaveBeenCalledOnce();
    expect(state.read()).toBeUndefined();
  });

  it("keeps every saved ID and opens none when closing is refused", async () => {
    const state = createContext([first, second]);
    const open = vi.fn();
    const close = vi.fn(async () => { throw new Error("close refused"); });
    const result = await resumePersistedCodexSessions(state.context, open, close);
    expect(result).toMatchObject({ attempted: 2, opened: 0 });
    expect(result.failed).toHaveLength(2);
    expect(open).not.toHaveBeenCalled();
    expect(state.read()).toEqual([first, second]);
  });

  it("bounds a stalled close and never reopens after a late close result", async () => {
    vi.useFakeTimers();
    const state = createContext([first]);
    let finish!: () => void;
    let closeSignal: AbortSignal | undefined;
    const open = vi.fn();
    try {
      const work = resumePersistedCodexSessions(state.context, open, async signal => {
        closeSignal = signal;
        await new Promise<void>(resolve => { finish = resolve; });
      });
      await vi.advanceTimersByTimeAsync(8_000);
      expect((await work).failed).toHaveLength(1);
      expect(closeSignal?.aborted).toBe(true);
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(open).not.toHaveBeenCalled();
      expect(state.read()).toEqual([first]);
    } finally { vi.useRealTimers(); }
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
      get: vi.fn((key: string, fallback?: unknown) =>
        (key === "autoResumeEnabled" || key === "autoSwitchEnabled" ? true : fallback))
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

  it.each([
    ["autoResumeEnabled", "managed"], ["autoSwitchEnabled", "managed"],
    ["autoResumeEnabled", "open"], ["autoSwitchEnabled", "open"]
  ])("cancels %s during %s discovery and rejects its late result", async (setting, operation) => {
    let enabled = true;
    let changed: (() => void) | undefined;
    const dispose = vi.fn();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string) => key === setting ? enabled : true
    } as never);
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockImplementation((listener) => {
      changed = () => listener({ affectsConfiguration: () => true });
      return { dispose };
    });
    const state = createContext([id1]);
    let finish: ((ids: string[]) => void) | undefined;
    const capture = operation === "open" ? persistOpenCodexSessions : persistRunningCodexSessions;
    const captured = capture(
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

  it.each(["autoResumeEnabled", "autoSwitchEnabled"])(
    "aborts restoration immediately when %s turns off and never opens the next tab", async (setting) => {
    let enabled = true;
    let changed: (() => void) | undefined;
    const dispose = vi.fn();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string) => key === setting ? enabled : true
    } as never);
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
      expect(result.opened).toBe(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.message).toContain("8 seconds");
      expect(open).toHaveBeenCalledTimes(2);
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

  it("retains unacknowledged recovery when a successful inspection finds no running sessions", async () => {
    const state = createContext(["01a04882-d037-7a42-ad24-9afb61901186"]);
    await expect(persistRunningCodexSessions(state.context, async () => [])).resolves.toEqual(["01a04882-d037-7a42-ad24-9afb61901186"]);
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

  it("merges unacknowledged recovery with a normalized verified capture as in 1.2.17", async () => {
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
