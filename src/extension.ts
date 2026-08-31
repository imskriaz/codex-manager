import * as vscode from "vscode";
import { AccountsWorkbench } from "./presentation/workbench/accountsWorkbench";
import {
  disposeCodexProxyEnvironment,
  getCodexProxyConfigurationError,
  initializeCodexProxyEnvironment
} from "./infrastructure/config/proxyEnvironment";
import { configureCrossWindowOperationCoordinator } from "./utils/crossWindowOperations";
import { disposePersistentLogging, registerPersistentLogging } from "./utils/persistentLog";

let workbench: AccountsWorkbench | undefined;

/**
 * 激活扩展
 *
 * @param context - 扩展上下文
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  try {
    await registerPersistentLogging(context);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[codexManager] persistent logging initialization failed", error);
    void vscode.window.showWarningMessage(
      `Codex Manager could not initialize persistent diagnostics. Operations will continue without file logs: ${detail}`
    );
  }
  // Build the status entry before any asynchronous setup so every window has
  // immediate visual feedback, even while another window holds a startup lock.
  workbench = new AccountsWorkbench(context);
  try {
    await initializeCodexProxyEnvironment();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[codexManager] proxy initialization failed; continuing without proxy integration", error);
    void vscode.window.showWarningMessage(`Codex Manager proxy setup failed. The extension will continue: ${detail}`);
  }
  try {
    await configureCrossWindowOperationCoordinator(context.globalStorageUri.fsPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[codexManager] cross-window coordination initialization failed", error);
    void vscode.window.showWarningMessage(
      `Codex Manager could not initialize multi-window coordination. Avoid account changes in two windows at once: ${detail}`
    );
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
    void vscode.window.showErrorMessage(
      `Codex Manager could not finish loading: ${detail}. Run “Developer: Restart Extension Host” to retry.`
    );
  }
}

/**
 * 停用扩展
 */
export async function deactivate(): Promise<void> {
  workbench?.shutdown();
  workbench = undefined;
  disposeCodexProxyEnvironment();
  await disposePersistentLogging();
}
