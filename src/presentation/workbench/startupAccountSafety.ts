import * as vscode from "vscode";
import { unloadAuthFile } from "../../codex";
import type { AccountsRepository } from "../../storage";
import { readCurrentAuthAccountStorageId } from "../../utils/accountIdentity";
import {
  CURRENT_WINDOW_RUNTIME_ACCOUNT_KEY,
  setCurrentWindowRuntimeAccountId
} from "./windowRuntimeAccount";

/**
 * A disabled current account may remain loaded only until this VS Code session
 * ends. Enforce that boundary before background automation starts again.
 */
export async function unloadDisabledActiveAccountOnStartup(
  context: vscode.ExtensionContext,
  repo: Pick<AccountsRepository, "listAccounts" | "syncActiveAccountFromAuthFile">,
  unload: () => Promise<void> = unloadAuthFile,
  readLoadedAccountId: () => Promise<string | undefined> = readCurrentAuthAccountStorageId
): Promise<boolean> {
  const loadedAccountId = await readLoadedAccountId();
  if (!loadedAccountId) {
    return false;
  }
  const disabledActive = (await repo.listAccounts()).find(
    (account) => account.id === loadedAccountId && account.enabled === false
  );
  if (!disabledActive) {
    return false;
  }

  try {
    await unload();
    await repo.syncActiveAccountFromAuthFile();
    await context.workspaceState.update(CURRENT_WINDOW_RUNTIME_ACCOUNT_KEY, undefined);
    setCurrentWindowRuntimeAccountId(undefined);
    void vscode.window.showInformationMessage(
      `${disabledActive.email} was disabled and has been automatically unloaded after restart.`
    );
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showWarningMessage(
      `The disabled account ${disabledActive.email} could not be unloaded automatically: ${detail}. Use Unload Codex Auth before continuing.`
    );
    return false;
  }
}
