import * as vscode from "vscode";

const HOST_VERSION_STATE_KEY = "codexManager.lastActivatedHostVersion";

/**
 * A VSIX update can leave the existing extension host alive long enough for a
 * contributed command to target stale registrations. Restart that host once
 * for the newly activated package so users do not need Developer commands.
 */
export function scheduleAutomaticExtensionHostRefresh(
  context: vscode.ExtensionContext,
  version: string,
  delayMs = 500,
  force = false
): void {
  const previousVersion = context.globalState.get<string>(HOST_VERSION_STATE_KEY);
  if (!force && previousVersion === version) {
    return;
  }

  void persistHostVersion(context, version);

  const timer = setTimeout(() => {
    void restartExtensionHostAutomatically();
  }, delayMs);
  timer.unref?.();
}

async function persistHostVersion(context: vscode.ExtensionContext, version: string): Promise<void> {
  try {
    await context.globalState.update(HOST_VERSION_STATE_KEY, version);
  } catch (error) {
    console.warn("[codexManager] could not persist extension host version:", error);
  }
}

async function restartExtensionHostAutomatically(): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.action.restartExtensionHost");
  } catch (restartError) {
    console.warn("[codexManager] extension host restart failed; reloading the window", restartError);
    try {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    } catch (reloadError) {
      console.error("[codexManager] automatic extension recovery failed", reloadError);
      void vscode.window.showErrorMessage(
        "Codex Manager could not refresh its updated extension host automatically. Please reload the VS Code window."
      );
    }
  }
}
