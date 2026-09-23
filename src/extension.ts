import * as vscode from "vscode";
import { AccountsWorkbench } from "./presentation/workbench/accountsWorkbench";
import {
  disposeCodexProxyEnvironment,
  getCodexProxyConfigurationError,
  initializeCodexProxyEnvironment
} from "./infrastructure/config/proxyEnvironment";
import { configureCrossWindowOperationCoordinator } from "./utils/crossWindowOperations";
import { disposePersistentLogging, registerPersistentLogging } from "./utils/persistentLog";
import { enableTransientVscodeNotices } from "./utils/notificationMirror";
import { getCodexManagerStorageRoot } from "./utils/storageRoot";
import { scheduleAutomaticExtensionHostRefresh } from "./utils/extensionHostRecovery";
import {
  initializeCrossWindowAccountMode,
  disposeCrossWindowAccountMode
} from "./services/windowAccountMode";

let workbench: AccountsWorkbench | undefined;
let transientNotices: vscode.Disposable | undefined;

/**
 * 激活扩展
 *
 * @param context - 扩展上下文
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const extensionVersion = resolveExtensionVersion(context);
  transientNotices = enableTransientVscodeNotices();
  try {
    await registerPersistentLogging(context);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[codexManager] persistent logging initialization failed", error);
    void vscode.window.showWarningMessage(
      `Codex Manager could not initialize persistent diagnostics. Operations will continue without file logs: ${detail}`
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
    void vscode.window.showWarningMessage(`Parallel window accounts could not initialize: ${detail}`);
  }
  // Build the status entry before the remaining asynchronous setup so every
  // window has immediate visual feedback.
  workbench = new AccountsWorkbench(context);
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
    scheduleAutomaticExtensionHostRefresh(context, extensionVersion);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    workbench.showActivationFailure(error);
    console.error("[codexManager] activation did not complete", error);
    void vscode.window.showErrorMessage(
      `Codex Manager could not finish loading: ${detail}. It will retry automatically.`
    );
    scheduleAutomaticExtensionHostRefresh(context, extensionVersion, 500, true);
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
  workbench?.shutdown();
  workbench = undefined;
  transientNotices?.dispose();
  transientNotices = undefined;
  disposeCodexProxyEnvironment();
  await disposeCrossWindowAccountMode();
  await disposePersistentLogging();
}
