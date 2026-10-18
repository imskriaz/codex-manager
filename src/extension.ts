import { prepareQuotaSummaryPanelForExtensionHostRestart } from "./presentation/dashboard/panel";
import { waitWithin } from "./utils/concurrency";
import { maintainManagerDatabases } from "./storage/storageCleanup";
import { getSqliteStateStore } from "./storage/sqliteState";
import { registerSessionRecording, disposeSessionRecording } from "./services/sessionRecording";
import { disposeNativeCodexSessionStatus } from "./services/codexNativeSessionStatus";
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
import { disposeSqliteContext, initializeSqliteContextWithRetry } from "./storage/sqliteContext";
import { showStorageRecovery } from "./presentation/storageRecovery";

let workbench: AccountsWorkbench | undefined;
let transientNotices: vscode.Disposable | undefined;

/**
 * 激活扩展
 *
 * @param context - 扩展上下文
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try { context = await initializeSqliteContextWithRetry(context); } catch (error) {
    console.error("[codexManager] storage initialization failed; recovery controls remain available", error);
    showStorageRecovery(context, error);
    return;
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
  const cleanup = () => {
    void runCrossWindowExclusive("background:storage-cleanup", "Storage cleanup", async () => {
      const store = getSqliteStateStore();
      if (store) await maintainManagerDatabases(store);
    }, { background: true }).catch(error => {
      if (!(error instanceof CrossWindowOperationBusyError)) console.warn("[codexManager] storage cleanup postponed",error);
    });
  };
  const cleanupTimer = setTimeout(cleanup, 30_000);
  const cleanupInterval = setInterval(cleanup, 30 * 60_000);
  cleanupTimer.unref?.();
  cleanupInterval.unref?.();
  context.subscriptions.push({dispose:()=>{ clearTimeout(cleanupTimer); clearInterval(cleanupInterval); }});
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
  try { await waitWithin(prepareQuotaSummaryPanelForExtensionHostRestart(), 500, "Dashboard reopen state could not be confirmed before shutdown."); }
  catch (error) { console.warn("[codexManager] dashboard recovery state was retained where available", error); }
  try { await workbench?.shutdown(); }
  catch (error) { console.error("[codexManager] final account save failed during shutdown", error); }
  workbench = undefined;
  transientNotices?.dispose();
  transientNotices = undefined;
  disposeCodexProxyEnvironment();
  await disposeCrossWindowAccountMode();
  disposeNativeCodexSessionStatus();
  disposeSessionRecording();
  await disposePersistentLogging(true);
  disposeSqliteContext();
}
