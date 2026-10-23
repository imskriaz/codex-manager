import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { renderShell } = vi.hoisted(() => ({ renderShell: vi.fn(() => "<html>dashboard</html>") }));
vi.mock("../src/presentation/dashboard/shell", () => ({ renderDashboardShell: renderShell }));
vi.mock("../src/presentation/dashboard/actionHandlers", () => ({ executeDashboardActionMessage: vi.fn() }));
vi.mock("../src/application/dashboard/buildDashboardState", () => ({ buildDashboardState: vi.fn() }));

function panel() {
  let disposed: (() => void) | undefined;
  return {
    title: "old dashboard",
    webview: { html: "old", options: {}, onDidReceiveMessage: vi.fn(), postMessage: vi.fn(async () => true) },
    reveal: vi.fn(),
    onDidDispose: vi.fn((listener: () => void) => { disposed = listener; }),
    dispose: vi.fn(() => { disposed?.(); })
  };
}

const subscriptions:Array<{dispose():void}>=[];
const key = "codexManager.reopenDashboardAfterHostRestart";
function context(initial = false) {
  let pending = initial;
  return {
    extensionUri: { fsPath: "/fixture" },
    subscriptions,
    workspaceState: {
      get: vi.fn((_key: string) => pending),
      update: vi.fn(async (_key: string, next: boolean) => { pending = next; })
    }
  };
}

describe("dashboard tab persistence", () => {
  let deserialize: (value: ReturnType<typeof panel>, state?: unknown) => Promise<void>;
  let created: ReturnType<typeof panel>;
  beforeEach(() => {
    vi.resetModules();
    renderShell.mockReset().mockReturnValue("<html>dashboard</html>");
    created = panel();
    Object.assign(vscode.Uri, { joinPath: vi.fn(() => ({ fsPath: "/fixture/media" })) });
    Object.assign(vscode.window, {
      tabGroups: { all: [], close: vi.fn(async () => true) },
      createWebviewPanel: vi.fn(() => panel()).mockReturnValueOnce(created),
      registerWebviewPanelSerializer: vi.fn((_type: string, serializer: { deserializeWebviewPanel: typeof deserialize }) => {
        deserialize = serializer.deserializeWebviewPanel;
        return { dispose: vi.fn() };
      })
    });
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (_key: string, fallback: unknown) => fallback } as never);
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockReturnValue({ dispose: vi.fn() });
  });
  afterEach(() => { for(const item of subscriptions.splice(0))item.dispose();vi.unstubAllGlobals(); });

  it("closes a native restored panel and creates a fresh dashboard without trusting its state", async () => {
    const module = await import("../src/presentation/dashboard/panel");
    const state = context();
    module.registerDashboardPanelSerializer(state as never, {} as never);
    const restored = panel();
    await deserialize(restored, { forgedAccountId: "ignored" });
    expect(restored.dispose).toHaveBeenCalledOnce();
    expect(restored.webview.html).toBe("old");
    expect(created.webview.html).toBe("<html>dashboard</html>");
    expect(created.webview.onDidReceiveMessage).toHaveBeenCalledOnce();
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledOnce();
    expect(state.workspaceState.get(key)).toBe(false);
  });

  it("restores the dashboard without stealing focus from recovering conversations", async () => {
    const module = await import("../src/presentation/dashboard/panel");
    const state = context(true);
    await module.restoreQuotaSummaryPanelAfterExtensionHostRestart(state as never, {} as never);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith("codexQuotaSummary", expect.any(String), expect.objectContaining({ preserveFocus: true }), expect.any(Object));
    await module.openQuotaSummaryPanel(state as never, {} as never);
    expect(created.dispose).toHaveBeenCalledOnce();
    expect(vscode.window.createWebviewPanel).toHaveBeenLastCalledWith("codexQuotaSummary", expect.any(String), expect.objectContaining({preserveFocus:false}), expect.any(Object));
  });

  it("discards a late restored duplicate and keeps the already-open dashboard", async () => {
    const module = await import("../src/presentation/dashboard/panel");
    const state = context(true);
    module.registerDashboardPanelSerializer(state as never, {} as never);
    await module.restoreQuotaSummaryPanelAfterExtensionHostRestart(state as never, {} as never);
    const duplicate = panel();
    await deserialize(duplicate);
    expect(duplicate.dispose).toHaveBeenCalledOnce();
    expect(created.dispose).not.toHaveBeenCalled();
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledOnce();
  });

  it("retains managed recovery when rendering fails and allows a fresh retry", async () => {
    const module = await import("../src/presentation/dashboard/panel");
    const state = context(true);
    renderShell.mockImplementationOnce(() => { throw new Error("assets unavailable"); });
    await expect(module.restoreQuotaSummaryPanelAfterExtensionHostRestart(state as never, {} as never))
      .rejects.toThrow("assets unavailable");
    expect(state.workspaceState.update).not.toHaveBeenCalled();
    expect(created.dispose).toHaveBeenCalledOnce();
    await module.restoreQuotaSummaryPanelAfterExtensionHostRestart(state as never, {} as never);
    expect(state.workspaceState.update).toHaveBeenCalledWith(key, false);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
  });

  it("keeps serializer recovery pending if its initial rendering fails", async () => {
    const module = await import("../src/presentation/dashboard/panel");
    const state = context(true);
    module.registerDashboardPanelSerializer(state as never, {} as never);
    const restored = panel();
    renderShell.mockImplementationOnce(() => { throw new Error("partial initialization"); });
    await expect(deserialize(restored)).rejects.toThrow("partial initialization");
    expect(state.workspaceState.update).not.toHaveBeenCalled();
    await deserialize(restored);
    expect(restored.dispose).toHaveBeenCalledTimes(2);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
    expect(state.workspaceState.update).toHaveBeenCalledWith(key, false);
  });

  it("closes immediately and saves managed recovery for reopening", async () => {
    const module = await import("../src/presentation/dashboard/panel");
    const state = context();
    await module.openQuotaSummaryPanel(state as never, {} as never);
    expect(await module.prepareQuotaSummaryPanelForExtensionHostRestart()).toBe(true);
    expect(state.workspaceState.update).toHaveBeenCalledWith(key, true);
  });

  it("closes every restored Manager tab across editor groups and reopens only one dashboard", async () => {
    const module = await import("../src/presentation/dashboard/panel");
    const state = context();
    const first = { input: { viewType: "codexQuotaSummary" } };
    const second = { input: { viewType: "mainThreadWebview-codexQuotaSummary" } };
    const other = { input: { viewType: "another.extension" } };
    const groups = [{ tabs: [first, other] }, { tabs: [second] }];
    Object.assign(vscode.window.tabGroups, { all: groups });
    vi.mocked(vscode.window.tabGroups.close).mockImplementation(async closing => {
      expect(state.workspaceState.update).toHaveBeenCalledWith(key, true);
      for (const group of groups) group.tabs = group.tabs.filter(tab => !(closing as unknown[]).includes(tab));
      return true;
    });
    await module.closeQuotaSummaryTabsForExtensionHostRestart(state as never);
    expect(groups.flatMap(group => group.tabs)).toEqual([other]);
    await module.restoreQuotaSummaryPanelAfterExtensionHostRestart(state as never, {} as never);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledOnce();
  });

  it.each(["dirty", "new dirty", "new tab", "refused", "storage full", "cancelled"])("reports %s during restored Manager tab cleanup", async failure => {
    const module = await import("../src/presentation/dashboard/panel");
    const state = context();
    const controller = new AbortController();
    const tabs: Array<{ input: { viewType: string }; isDirty?: boolean }> = [{ input: { viewType: "codexQuotaSummary" } }];
    Object.assign(vscode.window.tabGroups, { all: [{ tabs }] });
    if (failure === "dirty") tabs[0]!.isDirty = true;
    if (failure === "new dirty") state.workspaceState.update.mockImplementationOnce(async () => { tabs[0]!.isDirty = true; });
    if (failure === "new tab") state.workspaceState.update.mockImplementationOnce(async () => { tabs.push({ input: { viewType: "codexQuotaSummary" } }); });
    if (failure === "storage full") state.workspaceState.update.mockRejectedValueOnce(new Error("storage full"));
    if (failure === "cancelled") state.workspaceState.update.mockImplementationOnce(async () => { controller.abort(new Error("cancelled")); });
    if (failure === "refused") vi.mocked(vscode.window.tabGroups.close).mockResolvedValue(false);
    await expect(module.closeQuotaSummaryTabsForExtensionHostRestart(state as never, controller.signal)).rejects.toThrow();
    if (failure !== "refused") expect(vscode.window.tabGroups.close).not.toHaveBeenCalled();
  });

  it("does not create a dashboard when no managed recovery exists", async () => {
    const module = await import("../src/presentation/dashboard/panel");
    await module.restoreQuotaSummaryPanelAfterExtensionHostRestart(context() as never, {} as never);
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
  });

  it("keeps a dashboard closed after the user closes it before reload", async () => {
    const module = await import("../src/presentation/dashboard/panel");
    const state = context(true);
    await module.openQuotaSummaryPanel(state as never, {} as never);
    created.dispose();
    expect(state.workspaceState.get(key)).toBe(false);
    expect(await module.prepareQuotaSummaryPanelForExtensionHostRestart()).toBe(false);
    await module.restoreQuotaSummaryPanelAfterExtensionHostRestart(state as never, {} as never);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledOnce();
  });

  it("closes before a slow save and never closes the replacement after late cancellation", async () => {
    const module = await import("../src/presentation/dashboard/panel");
    const state = context();
    await module.openQuotaSummaryPanel(state as never, {} as never);
    let finish!: () => void;
    state.workspaceState.update.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const pending = module.prepareQuotaSummaryPanelForExtensionHostRestart(controller.signal);
    expect(created.dispose).toHaveBeenCalledOnce();
    const checked = expect(pending).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    const replacement = panel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(replacement as never);
    await module.restoreQuotaSummaryPanelAfterExtensionHostRestart(state as never, {} as never);
    finish();
    await checked;
    expect(replacement.dispose).not.toHaveBeenCalled();
  });

  it("closes despite storage failure and can restore within the current host", async () => {
    const module = await import("../src/presentation/dashboard/panel");
    const state = context();
    await module.openQuotaSummaryPanel(state as never, {} as never);
    state.workspaceState.update.mockRejectedValueOnce(new Error("storage full"));
    await expect(module.prepareQuotaSummaryPanelForExtensionHostRestart()).rejects.toThrow("reopen state could not be saved");
    expect(created.dispose).toHaveBeenCalledOnce();
    await module.restoreQuotaSummaryPanelAfterExtensionHostRestart(state as never, {} as never);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
  });

  it("leaves an open panel alone when preparation was already cancelled", async () => {
    const module = await import("../src/presentation/dashboard/panel");
    await module.openQuotaSummaryPanel(context() as never, {} as never);
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(module.prepareQuotaSummaryPanelForExtensionHostRestart(controller.signal)).rejects.toThrow("cancelled");
    expect(created.dispose).not.toHaveBeenCalled();
  });

  it("restores only one panel after a managed close, including repeated recovery calls", async () => {
    const module = await import("../src/presentation/dashboard/panel");
    const state = context();
    await module.openQuotaSummaryPanel(state as never, {} as never);
    await module.prepareQuotaSummaryPanelForExtensionHostRestart();
    expect(created.dispose).toHaveBeenCalledOnce();
    await module.restoreQuotaSummaryPanelAfterExtensionHostRestart(state as never, {} as never);
    await module.restoreQuotaSummaryPanelAfterExtensionHostRestart(state as never, {} as never);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(2);
    expect(state.workspaceState.get(key)).toBe(false);
  });

  it("coalesces concurrent opens while all stale tabs close before creating a panel", async () => {
    const module = await import("../src/presentation/dashboard/panel"), state = context();
    const old={input:{viewType:'codexQuotaSummary'}}, other={input:{viewType:'other.extension'}};
    const group={tabs:[old,other]}; Object.assign(vscode.window.tabGroups,{all:[group]});
    let finish!:(value:boolean)=>void;
    vi.mocked(vscode.window.tabGroups.close).mockImplementation(()=>new Promise(resolve=>{finish=()=>{group.tabs=[other];resolve(true);};}));
    const one=module.openQuotaSummaryPanel(state as never,{} as never), two=module.openQuotaSummaryPanel(state as never,{} as never);
    await vi.waitFor(()=>expect(vscode.window.tabGroups.close).toHaveBeenCalledOnce());
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();finish(true);await Promise.all([one,two]);
    expect(group.tabs).toEqual([other]);expect(vscode.window.createWebviewPanel).toHaveBeenCalledOnce();
  });

  it.each(['dirty','refused','storage'])('does not open over stale tabs when cleanup is %s', async failure=>{
    const module=await import("../src/presentation/dashboard/panel"), state=context();
    const old={input:{viewType:'codexQuotaSummary'},isDirty:failure==='dirty'};
    Object.assign(vscode.window.tabGroups,{all:[{tabs:[old]}]});
    vi.mocked(vscode.window.tabGroups.close).mockResolvedValue(false);
    if(failure==='storage')state.workspaceState.update.mockRejectedValueOnce(new Error('storage full'));
    await expect(module.openQuotaSummaryPanel(state as never,{} as never)).rejects.toThrow();
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
  });

  it('keeps a timed-out close exclusive until it settles, then permits a fresh reopen',async()=>{
    vi.useFakeTimers();
    try {
      const module=await import("../src/presentation/dashboard/panel"),state=context();
      const group={tabs:[{input:{viewType:'codexQuotaSummary'}}]};Object.assign(vscode.window.tabGroups,{all:[group]});
      let finish!:(value:boolean)=>void;
      vi.mocked(vscode.window.tabGroups.close).mockImplementation(()=>new Promise(resolve=>{finish=()=>{group.tabs=[];resolve(true);};}));
      const first=module.openQuotaSummaryPanel(state as never,{} as never);
      const checked=expect(first).rejects.toThrow('still closing');await vi.advanceTimersByTimeAsync(5001);await checked;
      const retry=module.openQuotaSummaryPanel(state as never,{} as never);
      expect(vscode.window.tabGroups.close).toHaveBeenCalledOnce();finish(true);await retry;
      expect(vscode.window.createWebviewPanel).toHaveBeenCalledOnce();
    }finally{vi.useRealTimers();}
  });

  it('retains dirty restored tabs and reports the failure in VS Code',async()=>{
    const module=await import("../src/presentation/dashboard/panel"),state=context(),restored=panel();
    Object.assign(vscode.window.tabGroups,{all:[{tabs:[{input:{viewType:'codexQuotaSummary'},isDirty:true}]}]});
    module.registerDashboardPanelSerializer(state as never,{} as never);
    await expect(deserialize(restored)).rejects.toThrow('unsaved');
    expect(restored.dispose).not.toHaveBeenCalled();expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('fresh dashboard'));
  });

  it("records only a minimal native dashboard marker without account data", async () => {
    const setState = vi.fn();
    vi.stubGlobal("acquireVsCodeApi", () => ({ postMessage: vi.fn(), setState }));
    await import("../webview-src/dashboard/host");
    expect(setState).toHaveBeenCalledOnce();
    expect(setState).toHaveBeenCalledWith({ dashboardOpen: true });
  });

  it("loads in the browser host when native persistence is unavailable", async () => {
    vi.stubGlobal("acquireVsCodeApi", () => ({ postMessage: vi.fn() }));
    await expect(import("../webview-src/dashboard/host")).resolves.toBeDefined();
  });
});
