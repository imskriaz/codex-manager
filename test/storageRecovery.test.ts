import * as vscode from "vscode";
import { beforeEach, expect, it, vi } from "vitest";
import { showStorageRecovery } from "../src/presentation/storageRecovery";
let handlers: Map<string, () => void>, message: (value: { action: string }) => void;
let panel: { reveal: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; onDidDispose: ReturnType<typeof vi.fn>; webview: { html: string; postMessage: ReturnType<typeof vi.fn>; onDidReceiveMessage: ReturnType<typeof vi.fn> } };
beforeEach(() => {
  handlers = new Map();
  panel = { reveal: vi.fn(), dispose: vi.fn(), onDidDispose: vi.fn(() => ({ dispose() {} })), webview: { html: "", postMessage: vi.fn(async () => true), onDidReceiveMessage: vi.fn(listener => { message = listener; return { dispose() {} }; }) } };
  Object.assign(vscode.window, { createWebviewPanel: vi.fn(() => panel), createStatusBarItem: vi.fn(() => ({ show() {}, dispose() {} })) });
  Object.assign(vscode.commands, { registerCommand: vi.fn((id, handler) => { handlers.set(id, handler); return { dispose() {} }; }) });
  Object.assign(vscode.env, { clipboard: { writeText: vi.fn(async () => undefined) } });
  vi.mocked(vscode.commands.executeCommand).mockReset().mockResolvedValue(undefined);
});
const context = () => ({ subscriptions: [], extension: { packageJSON: { contributes: { commands: [{ command: "codexManager.showQuotaSummary" }] } } } }) as unknown as vscode.ExtensionContext;
it("keeps contributed commands and recovery UI available without opening or replacing storage", async () => {
  showStorageRecovery(context(), new Error("Storage <script>bad</script> could not open"));
  handlers.get("codexManager.showQuotaSummary")!();
  expect(panel.webview.html).toContain("Your existing data has been kept."); expect(panel.webview.html).toContain("&lt;script&gt;bad&lt;/script&gt;");
  message({ action: "copy" }); await vi.waitFor(() => expect(panel.webview.postMessage).toHaveBeenCalledWith({ message: "Details copied." }));
  message({ action: "retry" }); expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow");
});
it("gives update guidance for unsupported runtimes and reports retry failures in the initiating UI", async () => {
  showStorageRecovery(context(), new Error("No such built-in module: node:sqlite")); handlers.get("codexManager.showQuotaSummary")!();
  expect(panel.webview.html).toContain("Update VS Code and Codex Manager");
  vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error("Reload refused")); message({ action: "retry" });
  await vi.waitFor(() => expect(panel.webview.postMessage).toHaveBeenCalledWith({ message: expect.stringContaining("Reload refused") }));
});
