import * as vscode from "vscode";
import type { ExtensionSettingsStore } from "../../infrastructure/config/extensionSettings";

export function renderDashboardShell(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  settingsStore: Pick<ExtensionSettingsStore, "resolveLanguage">
): string {
  const assetVersion = String(Date.now());
  const sharedStyles = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "webview", "shared.css").with({ query: assetVersion })
  );
  const pageStyles = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "webview", "quotaSummary.css").with({ query: assetVersion })
  );
  const script = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "media", "webview", "dashboard", "dashboard.js").with({ query: assetVersion })
  );

  return `<!DOCTYPE html>
<html lang="${settingsStore.resolveLanguage()}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#0d1117" />
  <title>Codex Manager</title>
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} https: data:; media-src data:; frame-src 'self' data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};"
  />
  <link rel="stylesheet" href="${sharedStyles.toString()}" />
  <link rel="stylesheet" href="${pageStyles.toString()}" />
</head>
<body>
  <div id="app"></div>
  <script src="${script.toString()}"></script>
</body>
</html>`;
}
