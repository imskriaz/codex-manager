import * as vscode from "vscode";
import { reloadExtensionHostWithSessionCapture } from "./extensionHostReload";

const HOST_RECOVERY_VERSION_STATE_KEY = "codexManager.lastAutomaticRecoveryVersion";
const scheduledRecoveryVersions = new WeakMap<vscode.ExtensionContext, Set<string>>();

/**
 * Retry an activation failure once per extension version. The durable marker
 * must be committed before restarting; otherwise the replacement host can
 * read the old value and enter a reload loop.
 */
export function scheduleAutomaticExtensionHostRefresh(
  context: vscode.ExtensionContext,
  version: string,
  delayMs = 500
): boolean {
  const previousVersion = context.globalState.get<string>(HOST_RECOVERY_VERSION_STATE_KEY);
  const scheduledVersions = scheduledRecoveryVersions.get(context) ?? new Set<string>();
  scheduledRecoveryVersions.set(context, scheduledVersions);
  if (previousVersion === version || scheduledVersions.has(version)) {
    return false;
  }
  scheduledVersions.add(version);

  void persistRecoveryVersion(context, version).then((persisted) => {
    if (!persisted) {
      return;
    }
    const timer = setTimeout(() => {
      void restartExtensionHostAutomatically();
    }, delayMs);
    timer.unref?.();
  });
  return true;
}

async function persistRecoveryVersion(context: vscode.ExtensionContext, version: string): Promise<boolean> {
  try {
    await context.globalState.update(HOST_RECOVERY_VERSION_STATE_KEY, version);
    return true;
  } catch (error) {
    console.error("[codexManager] could not persist automatic recovery marker", error);
    void vscode.window.showErrorMessage(
      "Codex Manager could not safely retry activation automatically. Run Developer: Reload Window to retry."
    );
    return false;
  }
}

async function restartExtensionHostAutomatically(): Promise<void> {
  try {
    await reloadExtensionHostWithSessionCapture(true);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[codexManager] automatic extension recovery failed", error);
    void vscode.window.showErrorMessage(
      `${detail} Run Developer: Reload Window after storage and pending commands settle.`
    );
  }
}
