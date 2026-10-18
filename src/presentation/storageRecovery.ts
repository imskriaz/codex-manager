import * as vscode from "vscode";
import { randomBytes } from "crypto";

/** Keep startup failures actionable without replacing or clearing the user's database. */
export function showStorageRecovery(context: vscode.ExtensionContext, error: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const unsupported = /node:sqlite|unknown built-in module|requires a newer/i.test(detail);
  const explanation = unsupported ? "Update VS Code and Codex Manager, then reload this window." : "Saved data is temporarily unavailable. Close other Manager windows if storage is in use, check free disk space, then retry.";
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let panel: vscode.WebviewPanel | undefined;
  const show = () => {
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel("codexManagerStorageRecovery", "Codex Manager", vscode.ViewColumn.Active, { enableScripts: true });
    const nonce = randomBytes(16).toString("hex");
    panel.webview.html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">body{font:13px/1.6 var(--vscode-font-family,sans-serif);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);margin:0;padding:24px;box-sizing:border-box}main{max-width:560px;margin:10vh auto;border:1px solid var(--vscode-panel-border);border-radius:12px;padding:24px}h1{font-size:20px;margin:0 0 10px}p{color:var(--vscode-descriptionForeground)}button{padding:8px 12px;border:1px solid var(--vscode-button-border,transparent);border-radius:6px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);margin:0 8px 8px 0}button:focus-visible{outline:2px solid var(--vscode-focusBorder)}details{margin-top:18px}pre{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}#feedback{min-height:24px}</style></head><body><main><h1>Codex Manager</h1><strong>Saved data needs attention</strong><p>${explanation}</p><p>Your existing data has been kept.</p><button id="retry">Reload and retry</button><button id="copy">Copy details</button><div id="feedback" role="status" aria-live="polite"></div><details><summary>Technical details</summary><pre>${escape(detail)}</pre></details></main><script nonce="${nonce}">const api=acquireVsCodeApi();document.getElementById('retry').onclick=()=>{document.getElementById('feedback').textContent='Reloading…';api.postMessage({action:'retry'})};document.getElementById('copy').onclick=()=>api.postMessage({action:'copy'});window.addEventListener('message',event=>{document.getElementById('feedback').textContent=event.data.message})</script></body></html>`;
    context.subscriptions.push(panel.onDidDispose(() => { panel = undefined; }));
    context.subscriptions.push(panel.webview.onDidReceiveMessage((message: { action?: string }) => {
      if (!message || typeof message !== "object") return;
      const action = message.action === "retry" ? vscode.commands.executeCommand("workbench.action.reloadWindow") : message.action === "copy" ? vscode.env.clipboard.writeText(detail) : undefined;
      if (!action) return;
      void Promise.resolve(action).then(() => panel?.webview.postMessage({ message: message.action === "copy" ? "Details copied." : "Reload requested." })).catch((failure: unknown) => {
        const message = `Could not complete that action: ${failure instanceof Error ? failure.message : String(failure)}`;
        void panel?.webview.postMessage({ message });
        void vscode.window.showWarningMessage(message);
      });
    }));
  };
  const commands = (context.extension.packageJSON as { contributes?: { commands?: Array<{ command: string }> } }).contributes?.commands ?? [];
  for (const { command } of commands) context.subscriptions.push(vscode.commands.registerCommand(command, () => {
    show();
    if (command !== "codexManager.showQuotaSummary") void vscode.window.showWarningMessage("Saved data is unavailable, so that action could not run. Use the recovery screen to retry.");
  }));
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = "$(database) Codex Manager"; status.tooltip = "Saved data is unavailable. Open Codex Manager to retry."; status.command = "codexManager.showQuotaSummary"; status.show();
  context.subscriptions.push(status, { dispose: () => { panel?.dispose(); } });
  void vscode.window.showErrorMessage("Codex Manager could not open saved data. Open Codex Manager to retry.");
}
