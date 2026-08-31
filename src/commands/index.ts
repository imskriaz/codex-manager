import * as vscode from "vscode";
import { AccountsCommandService } from "../application/accounts/commandService";
export { refreshImportedAccountQuota } from "../application/accounts/quota";
import { CodexManagerAccountRecord } from "../core/types";
import { AccountsRepository } from "../storage";
import type { EncryptedSyncManager } from "../services/encryptedSync";
import { getCodexManagerConfiguration } from "../infrastructure/config/extensionSettings";
import {
  CrossWindowOperationBusyError,
  runCrossWindowExclusive
} from "../utils/crossWindowOperations";
import { shouldSuppressDashboardNotifications } from "../utils/notificationPolicy";
import { runWithPersistentOperation } from "../utils/persistentLog";

export function runRegisteredCommand<T>(
  label: string,
  action: () => T | Thenable<T>,
  operationKey?: string,
  options: { announceBusy?: boolean; retryBusy?: boolean } = {}
): Thenable<T> {
  const run = async (): Promise<T> => {
    const maxBusyRetries = options.retryBusy ? 20 : 0;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await (operationKey
          ? runCrossWindowExclusive(operationKey, label, async () => action())
          : action());
      } catch (error) {
        if (!(error instanceof CrossWindowOperationBusyError) || attempt >= maxBusyRetries) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }
    }
  };
  return runWithPersistentOperation(
    `command:${label}`,
    () =>
      Promise.resolve()
        .then(run)
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          if (shouldSuppressDashboardNotifications()) {
            throw error;
          }
          void (error instanceof CrossWindowOperationBusyError
            ? options.announceBusy === false
              ? Promise.resolve(undefined)
              : vscode.window.showWarningMessage(detail)
            : /cancel(?:led|lation)/i.test(detail)
            ? vscode.window.showInformationMessage(`${label} cancelled.`)
            : vscode.window.showErrorMessage(`${label} failed: ${detail}`));
          throw error;
        }),
    { operationKey, retryBusy: options.retryBusy === true }
  );
}

/**
 * 注册所有命令
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  repo: AccountsRepository,
  view: { refresh(): void; markObservedAuthIdentity?: (accountId?: string) => void },
  sync?: EncryptedSyncManager
): void {
  const service = new AccountsCommandService(
    context,
    repo,
    view,
    (accountId) => sync?.canRefreshAccount(accountId) ?? true,
    sync
      ? async () => {
          const enabled = getCodexManagerConfiguration().get<boolean>("encryptedSyncEnabled", false);
          if (!enabled) return undefined;
          try {
            return await sync.syncNow(true, false);
          } catch (error) {
            if (error instanceof CrossWindowOperationBusyError) {
              sync.queueBackgroundSync();
              return undefined;
            }
            throw error;
          }
        }
      : undefined
  );

  const runCommand = runRegisteredCommand;
  const runAccountCommand = <T>(
    label: string,
    action: () => T | Thenable<T>
  ): Thenable<T> =>
    runCommand(
      label,
      async () => {
        try {
          return await action();
        } finally {
          await repo.flush();
        }
      },
      undefined
    );
  const runSyncCommand = <T>(
    label: string,
    action: () => T | Thenable<T>,
    announceBusy = true
  ): Thenable<T> =>
    runCommand(
      label,
      async () => {
        try {
          return await action();
        } finally {
          await repo.flush();
        }
      },
      undefined,
      { announceBusy }
    );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexManager.addAccount", () =>
      runAccountCommand("Add account", () => service.addAccount())
    ),
    vscode.commands.registerCommand("codexManager.importCurrentAuth", () =>
      runAccountCommand("Import current account", () => service.importCurrentAuth())
    ),
    vscode.commands.registerCommand("codexManager.reauthorizeAccount", (item?: CodexManagerAccountRecord) =>
      runAccountCommand("Reauthorize account", () => service.reauthorizeAccount(item))
    ),
    vscode.commands.registerCommand("codexManager.switchAccount", (item?: CodexManagerAccountRecord) =>
      runAccountCommand("Switch account", () => service.switchAccount(item))
    ),
    vscode.commands.registerCommand("codexManager.autoSelectAccount", () =>
      runAccountCommand("Auto-select account", () => service.autoSelectAccount())
    ),
    vscode.commands.registerCommand("codexManager.consumeResetCredit", (item?: CodexManagerAccountRecord) =>
      runAccountCommand("Reset rate limit", () => service.consumeResetCredit(item))
    ),
    vscode.commands.registerCommand("codexManager.refreshQuota", (item?: CodexManagerAccountRecord) =>
      runAccountCommand("Refresh quota", () => service.refreshQuota(item))
    ),
    vscode.commands.registerCommand(
      "codexManager.refreshAllQuotas",
      (options?: { silent?: boolean; forceRefresh?: boolean; excludeCurrent?: boolean }) =>
        runAccountCommand("Refresh all quotas", () => service.refreshAllQuotas(options))
    ),
    vscode.commands.registerCommand("codexManager.restoreAccountsFromBackup", () =>
      runAccountCommand("Restore accounts from backup", () => service.restoreAccountsFromBackup())
    ),
    vscode.commands.registerCommand("codexManager.restoreAccountsFromAuthJson", () =>
      runAccountCommand("Restore accounts from auth.json", () => service.restoreAccountsFromAuthJson())
    ),
    vscode.commands.registerCommand("codexManager.restoreAccountsFromSharedJson", () =>
      runAccountCommand("Restore accounts from shared JSON", () => service.restoreAccountsFromSharedJson())
    ),
    vscode.commands.registerCommand("codexManager.removeAccount", (item?: CodexManagerAccountRecord) =>
      runAccountCommand("Remove account", () => service.removeAccount(item))
    ),
    vscode.commands.registerCommand("codexManager.toggleStatusBarAccount", (item?: CodexManagerAccountRecord) =>
      runAccountCommand("Toggle status bar account", () => service.toggleStatusBarAccount(item))
    ),
    vscode.commands.registerCommand("codexManager.toggleAccountEnabled", (item?: CodexManagerAccountRecord) =>
      runAccountCommand("Toggle account", () => service.toggleAccountEnabled(item))
    ),
    vscode.commands.registerCommand(
      "codexManager.openDetails",
      (item?: CodexManagerAccountRecord, options?: { privacyMode?: boolean }) =>
        runCommand("Open account details", () => service.openDetails(item, options))
    ),
    vscode.commands.registerCommand("codexManager.openCodexHome", () =>
      runCommand("Open Codex home", () => service.openCodexHome())
    ),
    vscode.commands.registerCommand("codexManager.showQuotaSummary", () =>
      runCommand("Open quota summary", () => service.showQuotaSummary())
    ),
    vscode.commands.registerCommand("codexManager.showShortcuts", () =>
      runCommand("Show keyboard shortcuts", async () => {
        const choice = await vscode.window.showInformationMessage(
          "Codex Manager keyboard shortcuts and quick access",
          {
            modal: true,
            detail:
              "Click the Codex Manager status item — open quota dashboard\n\n" +
              "Ctrl+Shift+P — open Command Palette, then type ‘Codex Manager’\n\n" +
              "Ctrl+K Ctrl+S — open Keyboard Shortcuts and assign your preferred keys\n\n" +
              "No custom key combinations are forced by default, so the extension does not conflict with your existing shortcuts."
          },
          "Open Keyboard Shortcuts"
        );
        if (choice === "Open Keyboard Shortcuts") {
          await vscode.commands.executeCommand(
            "workbench.action.openGlobalKeybindings",
            "@ext:imskriaz.codex-manager"
          );
        }
      })
    ),
    vscode.commands.registerCommand(
      "codexManager.configureEncryptedSync",
      (options?: { passphrase?: string; confirmation?: string; deferSync?: boolean }) =>
        runSyncCommand("Configure encrypted sync", () => sync?.configure(options))
    ),
    vscode.commands.registerCommand(
      "codexManager.syncNow",
      (options?: { announceSuccess?: boolean; backgroundIfBusy?: boolean }) => {
        const backgroundIfBusy = options?.backgroundIfBusy === true;
        const task = runSyncCommand(
          "Encrypted account sync",
          () => sync?.syncNow(true, options?.announceSuccess ?? true),
          !backgroundIfBusy
        );
        if (!backgroundIfBusy) return task;
        return Promise.resolve(task).catch((error: unknown) => {
          if (!(error instanceof CrossWindowOperationBusyError)) throw error;
          sync?.queueBackgroundSync();
          return true;
        });
      }
    ),
    vscode.commands.registerCommand("codexManager.setEncryptedSyncRegistryOverride", (enabled: boolean) =>
      runSyncCommand("Set encrypted sync rescue override", () => sync?.setRegistryOverrideEnabled(enabled))
    )
  );
}
