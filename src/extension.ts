import { cleanupManagerStorage } from "./storage/storageCleanup";
import { getSqliteStateStore } from "./storage/sqliteState";
import { registerSessionRecording, disposeSessionRecording } from "./services/sessionRecording";
import { onDidChangeConfiguration } from "./storage/configurationEvents";
import * as vscode from "vscode";
import { AccountsWorkbench } from "./presentation/workbench/accountsWorkbench";
import {
  disposeCodexProxyEnvironment,
  getCodexProxyConfigurationError,
  initializeCodexProxyEnvironment
} from "./infrastructure/config/proxyEnvironment";
import { configureCrossWindowOperationCoordinator, runCrossWindowExclusive, CrossWindowOperationBusyError } from "./utils/crossWindowOperations";
import { disposePersistentLogging, registerPersistentLogging } from "./utils/persistentLog";
import { enableTransientVscodeNotices } from "./utils/notificationMirror";
import { getCodexManagerStorageRoot } from "./utils/storageRoot";
import { scheduleAutomaticExtensionHostRefresh } from "./utils/extensionHostRecovery";
import { scheduleExtensionHostReload } from "./application/accounts/switchEffects";
import {
  initializeCrossWindowAccountMode,
  isCrossWindowAccountModeEnabled,
  disposeCrossWindowAccountMode
} from "./services/windowAccountMode";
import { registerWorkspaceTerminalMonitoring } from "./services/workspaceTools";
import { disposeSqliteContext, initializeSqliteContext } from "./storage/sqliteContext";

let workbench: AccountsWorkbench | undefined;
let transientNotices: vscode.Disposable | undefined;

/**
 * 激活扩展
 *
 * @param context - 扩展上下文
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try { context = await initializeSqliteContext(context); } catch (error) {
    void vscode.window.showErrorMessage(`Codex Manager storage could not open. Existing data was retained: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  registerWorkspaceTerminalMonitoring(context);
  const extensionVersion = resolveExtensionVersion(context);
  transientNotices = enableTransientVscodeNotices();
  try {
    await registerPersistentLogging(context);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[codexManager] persistent logging initialization failed", error);
    void vscode.window.showWarningMessage(
      `Codex Manager could not initialize persistent diagnostics. Operations will continue without persistent logs: ${detail}`
    );
  }
  // Configure the process-safe coordinator before any managed-window registry
  // work. The existing path remains untouched when the setting is disabled.
  try {
    await configureCrossWindowOperationCoordinator(getCodexManagerStorageRoot());
    await initializeCrossWindowAccountMode();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[codexManager] parallel window initialization failed", error);
    if (isCrossWindowAccountModeEnabled()) {
      const message = `Parallel window isolation could not initialize: ${detail}. Account actions were stopped to protect the shared Codex home. Reload the window to retry.`;
      void vscode.window.showErrorMessage(message);
      const manifest = context.extension.packageJSON as { contributes: { commands: Array<{ command: string }> } };
      for (const { command } of manifest.contributes.commands)
        context.subscriptions.push(vscode.commands.registerCommand(command, () => vscode.window.showErrorMessage(message)));
      return;
    }
    void vscode.window.showWarningMessage(`Parallel window accounts could not initialize: ${detail}`);
  }
  context.subscriptions.push(onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("codexManager.crossWindowAccountModeEnabled")) {
      // Configuration changes reach every extension host, including windows
      // without an open dashboard. Apply isolation consistently in all of them.
      scheduleExtensionHostReload(undefined, 300, "Parallel window account mode changed");
    }
  }));
  // Build the status entry before the remaining asynchronous setup so every
  // window has immediate visual feedback.
  workbench = new AccountsWorkbench(context);
  registerSessionRecording(context);
  if (getSqliteStateStore()) {
  const cleanupTimer = setTimeout(() => {
    void runCrossWindowExclusive("background:storage-cleanup", "Storage cleanup", () => {
      const store = getSqliteStateStore();
      if (store) cleanupManagerStorage(store);
      return Promise.resolve();
    }, { background: true }).catch(error => {
      if (!(error instanceof CrossWindowOperationBusyError)) console.warn("[codexManager] storage cleanup postponed",error);
    });
  }, 2_000);
  cleanupTimer.unref?.();
  context.subscriptions.push({dispose:()=>clearTimeout(cleanupTimer)});
  }
  try {
    await initializeCodexProxyEnvironment();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[codexManager] proxy initialization failed; continuing without proxy integration", error);
    void vscode.window.showWarningMessage(`Codex Manager proxy setup failed. The extension will continue: ${detail}`);
  }
  const proxyError = getCodexProxyConfigurationError();
  if (proxyError) {
    void vscode.window.showErrorMessage(`[Codex Manager] ${proxyError.message}`);
  }
  try {
    await workbench.activate();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    workbench.showActivationFailure(error);
    console.error("[codexManager] activation did not complete", error);
    const retryScheduled = scheduleAutomaticExtensionHostRefresh(context, extensionVersion);
    void vscode.window.showErrorMessage(
      retryScheduled
        ? `Codex Manager could not finish loading: ${detail}. It will retry automatically.`
        : `Codex Manager could not finish loading: ${detail}. Run Developer: Reload Window to retry.`
    );
  }
}

function resolveExtensionVersion(context: vscode.ExtensionContext): string {
  const packageJSON = context.extension.packageJSON as { version?: unknown };
  return typeof packageJSON.version === "string" && packageJSON.version.trim() ? packageJSON.version : "0.0.0";
}

/**
 * 停用扩展
 */
export async function deactivate(): Promise<void> {
  try { await workbench?.shutdown(); }
  catch (error) { console.error("[codexManager] final account save failed during shutdown", error); }
  workbench = undefined;
  transientNotices?.dispose();
  transientNotices = undefined;
  disposeCodexProxyEnvironment();
  await disposeCrossWindowAccountMode();
  disposeSessionRecording();
  await disposePersistentLogging(true);
  disposeSqliteContext();
}
