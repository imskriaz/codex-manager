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

const key = "codexManager.reopenDashboardAfterHostRestart";
function context(initial = false) {
  let pending = initial;
  return {
    extensionUri: { fsPath: "/fixture" },
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
      createWebviewPanel: vi.fn(() => created),
      registerWebviewPanelSerializer: vi.fn((_type: string, serializer: { deserializeWebviewPanel: typeof deserialize }) => {
        deserialize = serializer.deserializeWebviewPanel;
        return { dispose: vi.fn() };
      })
    });
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (_key: string, fallback: unknown) => fallback } as never);
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockReturnValue({ dispose: vi.fn() });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("adopts and rebuilds the native restored panel without creating another dashboard", async () => {
    const module = await import("../src/presentation/dashboard/panel");
    const state = context();
    module.registerDashboardPanelSerializer(state as never, {} as never);
    expect(vscode.window.registerWebviewPanelSerializer).toHaveBeenCalledWith("codexQuotaSummary", expect.any(Object));
    const restored = panel();
    await deserialize(restored, { forgedAccountId: "ignored" });
    expect(restored.webview.html).toBe("<html>dashboard</html>");
    expect(restored.webview.options).toMatchObject({ enableScripts: true });
    expect(restored.webview.onDidReceiveMessage).toHaveBeenCalledOnce();
    module.openQuotaSummaryPanel(state as never, {} as never);
    expect(restored.reveal).toHaveBeenCalledOnce();
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
    expect(state.workspaceState.update).not.toHaveBeenCalled();
  });

  it("discards a late restored duplicate and keeps the already-open dashboard", async () => {
    const module = await import("../src/presentation/dashboard/panel");
    const state = context(true);
    module.registerDashboardPanelSerializer(state as never, {} as never);
    await module.restoreQuotaSummaryPanelAfterExtensionHostRestart(state as never, {} as never);
    const duplicate = panel();
    await deserialize(duplicate);
    expect(duplicate.dispose).toHaveBeenCalledOnce();
    expect(created.reveal).toHaveBeenCalledOnce();
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
    expect(restored.webview.html).toBe("<html>dashboard</html>");
    expect(state.workspaceState.update).toHaveBeenCalledWith(key, false);
  });

  it("saves managed recovery before closing and clears it only after reopening", async () => {
    const module = await import("../src/presentation/dashboard/panel");
    const state = context();
    module.openQuotaSummaryPanel(state as never, {} as never);
    created.dispose.mockImplementationOnce(() => {
      expect(state.workspaceState.get(key)).toBe(true);
    });
    expect(await module.prepareQuotaSummaryPanelForExtensionHostRestart()).toBe(true);
    expect(state.workspaceState.update).toHaveBeenCalledWith(key, true);
  });

  it("does not create a dashboard when no managed recovery exists", async () => {
    const module = await import("../src/presentation/dashboard/panel");
    await module.restoreQuotaSummaryPanelAfterExtensionHostRestart(context() as never, {} as never);
    expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
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
