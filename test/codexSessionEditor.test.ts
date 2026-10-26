import * as vscode from "vscode";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
vi.mock("../src/services/codexSessionRecovery", () => ({ resumeCodexSessionWork: vi.fn().mockResolvedValue("idle") }));
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareCodexSessionsForExtensionHostRestart, resumePersistedCodexSessions } from "../src/services/codexSessionAutoResume";
import { closeOpenCodexSessionTabs, openCodexSessionInVsCode, readOpenCodexSessionIds } from "../src/services/codexSessionResume";
import { waitForNativeCodexSessionReady } from "../src/services/codexNativeSessionStatus";

describe("Codex VS Code session editor", () => {
  let activateExtension: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(waitForNativeCodexSessionReady).mockResolvedValue(undefined);
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

  it("retains a loading tab and allows retry once its native conversation is ready", async () => {
    const id = "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";
    vi.mocked(waitForNativeCodexSessionReady).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(openCodexSessionInVsCode(id)).rejects.toThrow("not ready");
    expect(vscode.window.tabGroups.all[0]!.tabs).toHaveLength(1);
    await expect(openCodexSessionInVsCode(id)).resolves.toBeUndefined();
    expect(vscode.window.tabGroups.close).not.toHaveBeenCalled();
  });

  it("passes the longer automatic readiness budget without changing manual opens", async () => {
    const id="01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";
    await openCodexSessionInVsCode(id);
    expect(waitForNativeCodexSessionReady).toHaveBeenLastCalledWith(expect.any(String),id,undefined,40_000);
    await openCodexSessionInVsCode(id,undefined,false,120_000);
    expect(waitForNativeCodexSessionReady).toHaveBeenLastCalledWith(expect.any(String),id,undefined,120_000);
  });

  it.each([false, undefined])("requires verified readiness even for an already restored tab (%s)", async ready => {
    const id = "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";
    await openCodexSessionInVsCode(id);
    vi.mocked(vscode.commands.executeCommand).mockClear();
    vi.mocked(waitForNativeCodexSessionReady).mockResolvedValue(ready);
    await expect(openCodexSessionInVsCode(id, new AbortController().signal, false, 120_000, true)).rejects.toThrow("not ready");
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    vi.mocked(waitForNativeCodexSessionReady).mockResolvedValue(true);
    await expect(openCodexSessionInVsCode(id, new AbortController().signal, false, 120_000, true)).resolves.toBeUndefined();
  });

  it("resolves restored editors across groups, then closes only conversation tabs", async () => {
    const groups = vscode.window.tabGroups.all as unknown as Array<{ tabs: Array<{ input: unknown; isDirty?: boolean; group?: { viewColumn: number } }> }>;
    const native = (id: string, column: number) => ({ input: { viewType: "chatgpt.conversationEditor", uri: { scheme: "openai-codex", authority: "route", path: `/local/${id}` } }, group: { viewColumn: column } });
    const first = native("first", 1), second = native("second", 2), file = { input: { uri: { scheme: "file" } } };
    groups[0]!.tabs.push(first, file); groups.push({ tabs: [second] });
    const resolved: unknown[] = [];
    vi.mocked(vscode.commands.executeCommand).mockImplementation(async (_name, uri) => { resolved.push(uri); });
    vi.mocked(vscode.window.tabGroups.close).mockImplementation(async closing => {
      expect(resolved).toEqual([first.input.uri, second.input.uri]);
      for (const group of groups) group.tabs = group.tabs.filter(tab => !(closing as unknown[]).includes(tab));
      return true;
    });
    await closeOpenCodexSessionTabs();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("vscode.openWith", second.input.uri, "chatgpt.conversationEditor", expect.objectContaining({ viewColumn: 2, preserveFocus: true }));
    expect(groups.flatMap(group => group.tabs)).toEqual([file]);
  });

  it.each(["dirty", "new dirty", "refused", "unchanged", "resolution failed", "cancelled", "new tab"])("preserves recovery when closing is %s", async failure => {
    const id = "01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3";
    await openCodexSessionInVsCode(id);
    const tab = vscode.window.tabGroups.all[0]!.tabs[0]!;
    const controller = new AbortController();
    if (failure === "dirty") Object.assign(tab, { isDirty: true });
    if (failure === "refused") vi.mocked(vscode.window.tabGroups.close).mockResolvedValue(false);
    if (failure === "unchanged") vi.mocked(vscode.window.tabGroups.close).mockResolvedValue(true);
    if (failure === "resolution failed") vi.mocked(vscode.commands.executeCommand).mockRejectedValue(new Error("provider unavailable"));
    if (failure === "cancelled") activateExtension.mockImplementation(async () => { controller.abort(); });
    if (failure === "new dirty") vi.mocked(vscode.commands.executeCommand).mockImplementation(async () => { Object.assign(tab, { isDirty: true }); });
    if (failure === "new tab") vi.mocked(vscode.commands.executeCommand).mockImplementation(async () => { (vscode.window.tabGroups.all[0]!.tabs as unknown[]).push({ input: { viewType: "chatgpt.conversationEditor" } }); });
    await expect(closeOpenCodexSessionTabs(controller.signal)).rejects.toThrow();
    if (!["refused", "unchanged"].includes(failure)) expect(vscode.window.tabGroups.close).not.toHaveBeenCalled();
  });

  it("closes a broken restored custom document so recovery can reopen it", async () => {
    await openCodexSessionInVsCode("01a0ca86-bdf2-7ef3-ab5c-4c3d92072cd3");
    vi.mocked(vscode.commands.executeCommand).mockRejectedValue(new Error("No custom document found"));
    await closeOpenCodexSessionTabs();
    expect(vscode.window.tabGroups.close).toHaveBeenCalledOnce();
    expect(readOpenCodexSessionIds()).toEqual([]);
  });

  it("includes extra Codex webview panels across groups only during reload cleanup", async () => {
    const first = { input: { viewType: "chatgpt.panelView" } };
    const second = { input: { viewType: "mainThreadWebview-chatgpt.panelView" } };
    const other = { input: { viewType: "other.extension" } };
    const groups = [{ tabs: [first, other] }, { tabs: [second] }];
    Object.assign(vscode.window.tabGroups, { all: groups });
    vi.mocked(vscode.window.tabGroups.close).mockImplementation(async closing => {
      for (const group of groups) group.tabs = group.tabs.filter(tab => !(closing as unknown[]).includes(tab));
      return true;
    });
    await closeOpenCodexSessionTabs();
    expect(vscode.window.tabGroups.close).not.toHaveBeenCalled();
    await closeOpenCodexSessionTabs(undefined, true);
    expect(groups.flatMap(group => group.tabs)).toEqual([other]);
    expect(activateExtension).not.toHaveBeenCalled();
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
    const home = await mkdtemp(path.join(tmpdir(), "codex-editor-recovery-"));
    vi.stubEnv("CODEX_HOME", home);
    await mkdir(path.join(home, "sessions"));
    for (const id of ids) await writeFile(path.join(home, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, source: "vscode", cwd: home } }) + "\n");
    const saved = new Map<string, unknown>();
    const context = { workspaceState: { get: (key: string) => saved.get(key), update: async (key: string, value: unknown) => { saved.set(key, value); } } } as never;
    try {
      await prepareCodexSessionsForExtensionHostRestart(context, true, async () => ids, async () => ids);
      expect(await resumePersistedCodexSessions(context, (id, signal) => openCodexSessionInVsCode(id, signal, true))).toEqual({ attempted: 2, opened: 2, failed: [] });
      expect(readOpenCodexSessionIds(false)).toEqual(ids);
      expect(vscode.window.tabGroups.all[0]?.tabs).toHaveLength(2);
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.focusActiveEditorGroup");
    } finally { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
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
