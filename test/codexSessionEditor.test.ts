import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareCodexSessionsForExtensionHostRestart, resumePersistedCodexSessions } from "../src/services/codexSessionAutoResume";
import { openCodexSessionInVsCode, readOpenCodexSessionIds } from "../src/services/codexSessionResume";

describe("Codex VS Code session editor", () => {
  let activateExtension: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    activateExtension = vi.fn(async () => undefined);
    const extension = {
      extensionPath: "official-codex",
      activate: activateExtension
    };
    vi.mocked(vscode.extensions.getExtension).mockReturnValue(extension as never);
    const tabs: Array<{ input: unknown; isPreview?: boolean }> = [];
    Object.assign(vscode.window, { tabGroups: { all: [{ tabs }], close: vi.fn(async (closing: unknown[]) => {
      for (const tab of closing) {
        const index = tabs.indexOf(tab as typeof tabs[number]);
        if (index >= 0) tabs.splice(index, 1);
      }
      return true;
    }) } });
    vi.mocked(vscode.commands.executeCommand).mockReset();
    vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command, uri, viewType) => {
      if (command === "vscode.openWith") {
        const existing = tabs.find(
          (tab) => (tab.input as { uri?: { path?: string } }).uri?.path === (uri as { path?: string }).path
        );
        if (existing) existing.isPreview = false;
        else tabs.push({ input: { uri, viewType }, isPreview: false });
      }
      return undefined;
    });
  });

  it("promotes an existing preview tab before acknowledging automatic recovery", async () => {
    const id = "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";
    await openCodexSessionInVsCode(id);
    const tab = vscode.window.tabGroups.all[0]!.tabs[0]!;
    Object.assign(tab, { isPreview: true });
    vi.mocked(vscode.commands.executeCommand).mockClear();
    await openCodexSessionInVsCode(id, new AbortController().signal);
    expect(vscode.commands.executeCommand).toHaveBeenCalledOnce();
    expect(tab.isPreview).toBe(false);
  });

  it("retains recovery when the command resolves without creating a tab", async () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    Object.assign(vscode.window.tabGroups, { onDidChangeTabs: () => ({ dispose }) });
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    try {
      const opening = expect(openCodexSessionInVsCode("01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3")).rejects.toThrow("did not create");
      await vi.advanceTimersByTimeAsync(5_000);
      await opening;
      expect(dispose).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a native tab published after openWith resolves", async () => {
    vi.useFakeTimers();
    const id = "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";
    const tabs = vscode.window.tabGroups.all[0]!.tabs as Array<{ input: unknown; isPreview?: boolean }>;
    let changed: (() => void) | undefined;
    const dispose = vi.fn();
    Object.assign(vscode.window.tabGroups, { onDidChangeTabs: (listener: () => void) => { changed = listener; return { dispose }; } });
    vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command, uri, viewType) => {
      if (command === "vscode.openWith") {
        setTimeout(() => { tabs.push({ input: { uri, viewType }, isPreview: false }); changed?.(); }, 1_000);
      }
      return undefined;
    });
    try {
      const opening = openCodexSessionInVsCode(id, new AbortController().signal);
      const duplicate = openCodexSessionInVsCode(id, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(0);
      changed?.();
      expect(readOpenCodexSessionIds(false)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(Promise.all([opening, duplicate])).resolves.toEqual([undefined, undefined]);
      expect(vscode.commands.executeCommand).toHaveBeenCalledOnce();
      expect(readOpenCodexSessionIds(false)).toEqual([id]);
      expect(dispose).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending tab registration and allows an immediate retry", async () => {
    vi.useFakeTimers();
    const id = "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";
    const dispose = vi.fn();
    Object.assign(vscode.window.tabGroups, { onDidChangeTabs: () => ({ dispose }) });
    vi.mocked(vscode.commands.executeCommand).mockResolvedValueOnce(undefined);
    const controller = new AbortController();
    try {
      const opening = expect(openCodexSessionInVsCode(id, controller.signal)).rejects.toThrow("account changed");
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(new Error("account changed"));
      await opening;
      expect(dispose).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      await expect(openCodexSessionInVsCode(id)).resolves.toBeUndefined();
      expect(readOpenCodexSessionIds(false)).toEqual([id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reopen an already restored native tab during automatic replay", async () => {
    const id = "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";
    await openCodexSessionInVsCode(id);
    vi.mocked(vscode.commands.executeCommand).mockClear();
    activateExtension.mockClear();
    await openCodexSessionInVsCode(id.toUpperCase(), new AbortController().signal);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    expect(activateExtension).not.toHaveBeenCalled();
  });

  it("focuses an existing restored tab without closing its custom document", async () => {
    const id = "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";
    await openCodexSessionInVsCode(id);
    Object.assign(vscode.window.tabGroups.all[0]!.tabs[0]!, { isDirty: true });
    vi.mocked(vscode.commands.executeCommand).mockClear();
    await openCodexSessionInVsCode(id, new AbortController().signal, true);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("vscode.openWith", expect.anything(), "chatgpt.conversationEditor", expect.objectContaining({ preserveFocus: false, preview: false }));
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.focusActiveEditorGroup");
    expect(vscode.window.tabGroups.close).not.toHaveBeenCalled();
    expect(vscode.window.tabGroups.all[0]!.tabs).toHaveLength(1);
  });

  it("preserves the focus request when another open is already pending", async () => {
    let activate: (() => void) | undefined;
    activateExtension.mockImplementationOnce(() => new Promise<void>(resolve => { activate = resolve; }));
    const id = "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";
    const first = openCodexSessionInVsCode(id, new AbortController().signal);
    const focused = openCodexSessionInVsCode(id, new AbortController().signal, true);
    activate?.();
    await Promise.all([first, focused]);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.focusActiveEditorGroup");
    expect(vscode.window.tabGroups.all[0]!.tabs).toHaveLength(1);
  });

  it("coalesces concurrent automatic opens until their native tab exists", async () => {
    let activate: (() => void) | undefined;
    activateExtension.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          activate = resolve;
        })
    );
    const id = "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";
    const first = openCodexSessionInVsCode(id, new AbortController().signal);
    const second = openCodexSessionInVsCode(id, new AbortController().signal);
    activate?.();
    await Promise.all([first, second]);
    expect(vscode.commands.executeCommand).toHaveBeenCalledOnce();
  });

  it("quarantines a late activation until it settles, without dispatching a cancelled open", async () => {
    let activate: (() => void) | undefined;
    activateExtension.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          activate = resolve;
        })
    );
    const id = "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";
    const oldSignal = new AbortController();
    const first = openCodexSessionInVsCode(id, oldSignal.signal);
    const firstFailure = expect(first).rejects.toThrow();
    oldSignal.abort();
    const second = openCodexSessionInVsCode(id, new AbortController().signal);
    activate?.();
    await firstFailure;
    await second;
    expect(vscode.commands.executeCommand).toHaveBeenCalledOnce();
  });

  it("captures and restores both running conversations as distinct persistent native tabs", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) => ["autoResumeEnabled", "autoSwitchEnabled"].includes(key) ? true : key === "autoResumeGoalOnlyEnabled" ? false : fallback
    } as never);
    const ids = ["01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3", "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd4"];
    const saved = new Map<string, unknown>();
    const context = { workspaceState: { get: (key: string) => saved.get(key), update: async (key: string, value: unknown) => { saved.set(key, value); } } } as never;
    await prepareCodexSessionsForExtensionHostRestart(context, true, async () => ids, async () => ids);
    expect(await resumePersistedCodexSessions(context)).toEqual({ attempted: 2, opened: 2, failed: [] });
    expect(readOpenCodexSessionIds(false)).toEqual(ids);
    expect(vscode.window.tabGroups.all[0]?.tabs).toHaveLength(2);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.focusActiveEditorGroup");
  });

  it("opens a local session through the official Codex custom editor", async () => {
    const sessionId = "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";

    await openCodexSessionInVsCode(sessionId);

    expect(activateExtension).toHaveBeenCalledOnce();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "vscode.openWith",
      expect.objectContaining({
        scheme: "openai-codex",
        authority: "route",
        path: `/local/${sessionId}`
      }),
      "chatgpt.conversationEditor",
      {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: false,
        preview: false
      }
    );
  });

  it("does not open a late tab after activation exceeds the auto-resume deadline", async () => {
    const controller = new AbortController();
    activateExtension.mockImplementation(async () => {
      controller.abort();
    });
    await expect(openCodexSessionInVsCode("01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3", controller.signal)).rejects.toThrow();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it("reports activation failure without claiming a tab opened", async () => {
    activateExtension.mockRejectedValue(new Error("extension unavailable"));
    await expect(openCodexSessionInVsCode("01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3")).rejects.toThrow(
      "extension unavailable"
    );
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });
});
