import * as vscode from "vscode";
import { resolveAccountHealth } from "../../application/accounts/health";
import { refreshImportedAccountQuota, refreshSingleQuota } from "../../application/accounts/quota";
import { fetchResetCredits, consumeResetCredit } from "../../services/quota";
import { fetchDailyUsageBreakdown } from "../../services/usage";
import {
  archiveCodexCliSession,
  cancelCodexCliSessionTurn,
  CodexCliTurnCancelledError,
  deleteCodexCliSession,
  forkCodexCliSession,
  openCodexCliSessionInVsCode,
  readCodexCliComposerConfig,
  readCodexCliSessionSummary,
  readCodexCliSessions,
  isCodexCliAvailable,
  readCodexCliSessionMessages,
  renameCodexCliSession,
  startCodexCliSession,
  sendCodexCliSessionMessage,
  unarchiveCodexCliSession
} from "../../services/codexSessionResume";
import { getCodexManagerConfiguration } from "../../infrastructure/config/extensionSettings";
import { unloadAuthFile } from "../../codex";
import { upsertDashboardDailyUsageCache } from "../../services/dashboardUsageHistory";
import {
  cancelWorkspaceTerminalCommand,
  commitWorkspaceChanges,
  pushWorkspaceBranch,
  deleteWorkspaceFile,
  listWorkspaceTerminals,
  createWorkspaceTerminal,
  focusWorkspaceTerminal,
  listWorkspaceFiles,
  readWorkspaceFile,
  readWorkspaceEnvironment,
  runWorkspaceTerminalCommand,
  saveWorkspaceFile,
  WorkspaceTerminalCommandError
} from "../../services/workspaceTools";
import { getDashboardCopy } from "../../application/dashboard/copy";
import { stabilizeSessionProjectPaths } from "../../services/sessionProjectBindings";
import type {
  DashboardActionName,
  DashboardActionPayload,
  DashboardBatchResultFailure,
  DashboardCliSessionSummary,
  DashboardClientMessage,
  DashboardHostMessage
} from "../../domain/dashboard/types";
import type { CodexManagerAccountRecord, CodexManagerBackup } from "../../core/types";
import type { SwitchAccountCommandResult } from "../../application/accounts/commandService";
import type { DashboardLanguage } from "../../localization/languages";
import { AccountsRepository } from "../../storage";
import { AnnouncementService, type AnnouncementOptions } from "../../services/announcements";
import { runWithConcurrencyLimit } from "../../utils/concurrency";
import { t } from "../../utils";
import { appendImportedDebugLogs, getDebugLogSnapshot, showNetworkDebugLogs } from "../../utils/debug";
import { clearAutoSwitchLock, setAutoSwitchLock } from "../workbench/autoSwitchState";
import { getTokenAutomationSnapshot } from "../workbench/tokenAutomationState";
import {
  clearQueuedAccountSwitch,
  CURRENT_WINDOW_RUNTIME_ACCOUNT_KEY,
  setCurrentWindowRuntimeAccountId
} from "../workbench/windowRuntimeAccount";
import { promptForTags } from "../tagEditor";
import { parseSharedJsonInput, toFailureMessage, toImportActionPayload } from "./actionUtils";

const COMMAND_ROUTED_ACTIONS = new Set<DashboardActionName>([
  "addAccount",
  "importCurrent",
  "inspectCurrentAuth",
  "completeOnboarding",
  "refreshAll",
  "configureEncryptedSync",
  "syncNow",
  "setEncryptedSyncRegistryOverride",
  "openDashboard",
  "openWebDashboard",
  "reauthorize",
  "details",
  "refresh",
  "remove",
  "prepareOAuthSession",
  // These actions are read-only, window-local, or navigation-only. They must
  // remain usable while another window owns an account mutation or is already
  // reloading. Actions that delegate to registered commands rely on the
  // command's narrower operation lock instead of taking a second one here.
  "refreshAnnouncements",
  "shareTokens",
  "exportBackup",
  "openNetworkLogs",
  "exportAuthFile",
  "copyText",
  "openExternalUrl",
  "downloadJsonFile",
  "previewImportSharedJson",
  "cancelOAuthSession",
  "refreshView",
  "reloadPrompt",
  "getResetCredits",
  "getDailyUsage",
  "startCodexCliSession",
  "listCodexCliSessions",
  "getCodexCliSessionMessages",
  "sendCodexCliSessionMessage",
  "cancelCodexCliSessionTurn",
  "openCodexCliSession",
  "renameCodexCliSession",
  "forkCodexCliSession",
  "archiveCodexCliSession",
  "unarchiveCodexCliSession",
  "deleteCodexCliSession",
  "getWorkspaceEnvironment",
  "listWorkspaceFiles",
  "readWorkspaceFile",
  "saveWorkspaceFile",
  "deleteWorkspaceFile",
  "listWorkspaceTerminals",
  "createWorkspaceTerminal",
  "focusWorkspaceTerminal",
  "runWorkspaceTerminalCommand",
  "cancelWorkspaceTerminalCommand",
  "commitWorkspaceChanges",
  "pushWorkspaceBranch"
]);
import type { DashboardOAuthCoordinator } from "./oauthCoordinator";
import { ExtensionSettingsStore } from "../../infrastructure/config/extensionSettings";
import { handleDashboardSettingUpdate } from "./settings";
import {
  deferWindowReloadForAccount,
  handleCodexAppRestartPreference,
  promptWindowReloadForAccount,
  reloadWindowNow
} from "../../application/accounts/switchEffects";
import { refreshTokens } from "../../auth/oauth";
import { shouldSuppressDashboardNotifications } from "../../utils/notificationPolicy";
import { runWithPersistentOperation } from "../../utils/persistentLog";
import { markOnboardingCompleted } from "../../services/onboarding";
import {
  clearTokenAutomationError,
  markTokenAutomationRefreshFailure,
  markTokenAutomationRefreshSuccess
} from "../workbench/tokenAutomationState";

export type DashboardActionContext = {
  context: vscode.ExtensionContext;
  repo: AccountsRepository;
  resolveLanguage: () => DashboardLanguage;
  schedulePublishState: () => void;
  publishState: (force?: boolean) => Promise<void>;
  oauth: DashboardOAuthCoordinator;
  announcements: AnnouncementService;
  getAnnouncementOptions: () => AnnouncementOptions;
  /** Browser actions must never open VS Code-owned prompts or confirmations. */
  hostKind?: "webview" | "browser";
  configureEncryptedSync?: (passphrase: string, confirmation: string) => Promise<boolean>;
  syncEncryptedAccounts?: () => Promise<boolean>;
  setEncryptedSyncRegistryOverride?: (enabled: boolean, passphrase?: string) => Promise<boolean>;
  getRemoteCliSessions?: () => DashboardCliSessionSummary[];
};

const CODEX_BATCH_REFRESH_CONCURRENCY = 1;
const CODEX_BATCH_REFRESH_DELAY_MS = 300;
const ACCOUNT_REQUIRED_ACTIONS = new Set<DashboardActionName>([
  "exportAuthFile",
  "setAutoSwitchLock",
  "reloadPrompt",
  "reauthorize",
  "resyncProfile",
  "dismissHealthIssue",
  "details",
  "refresh",
  "remove",
  "toggleAccountEnabled",
  "setAccountQueuePriority",
  "setAccountTokenRefreshEnabled",
  "refreshToken",
  "getResetCredits",
  "getDailyUsage",
  "consumeResetCredit"
]);

export async function executeDashboardActionMessage(
  ctx: DashboardActionContext,
  message: Extract<DashboardClientMessage, { type: "dashboard:action" }>
): Promise<{
  status: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["status"];
  payload?: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"];
  errorMessage?: string;
}> {
  return runWithPersistentOperation(
    `dashboard:${message.action}`,
    () => executeDashboardActionMessageCore(ctx, message),
    { hostKind: ctx.hostKind ?? "webview" },
    (result) => ({ status: result.status, errorMessage: result.errorMessage })
  );
}

async function executeDashboardActionMessageCore(
  ctx: DashboardActionContext,
  message: Extract<DashboardClientMessage, { type: "dashboard:action" }>
): Promise<{
  status: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["status"];
  payload?: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"];
  errorMessage?: string;
}> {
  let status: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["status"] = "completed";
  let payload: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"];
  let errorMessage: string | undefined;

  try {
    if (ACCOUNT_REQUIRED_ACTIONS.has(message.action) && !message.accountId) {
      throw new Error("This action requires an account. Refresh the dashboard and try again.");
    }
    const account = message.accountId ? await ctx.repo.getAccount(message.accountId) : undefined;
    if (message.accountId && !account) {
      throw new Error("That account no longer exists. Refresh the dashboard and try again.");
    }
    const execute = () => runDashboardAction(ctx, message.action, message.payload, account);
    const executeAndFlush = async () => {
      try {
        return await execute();
      } finally {
        await ctx.repo.flush?.();
      }
    };
    const browserDirectMutation =
      ctx.hostKind === "browser" &&
      (message.action === "switch" ||
        message.action === "remove" ||
        message.action === "batchRemove" ||
        message.action === "consumeResetCredit" ||
        message.action === "updateTags");
    payload =
      COMMAND_ROUTED_ACTIONS.has(message.action) && !browserDirectMutation ? await execute() : await executeAndFlush();
  } catch (error) {
    status =
      error instanceof CodexCliTurnCancelledError ||
      (error instanceof WorkspaceTerminalCommandError && error.result.status === "cancelled")
        ? "cancelled"
        : "failed";
    if (error instanceof WorkspaceTerminalCommandError) payload = { terminalResult: error.result };
    errorMessage = toFailureMessage(error);
    console.error(`[codexManager] dashboard action failed: ${message.action}`, error);
    if (!shouldSuppressDashboardNotifications() && (message.action === "switch" || message.action === "refreshToken")) {
      void vscode.window.showErrorMessage(
        `Unable to ${message.action === "switch" ? "switch account" : "refresh token"}: ${errorMessage}`
      );
    }
  }

  return {
    status,
    payload,
    errorMessage
  };
}

async function runDashboardAction(
  ctx: DashboardActionContext,
  action: DashboardActionName,
  payload: DashboardActionPayload | undefined,
  account?: Awaited<ReturnType<AccountsRepository["getAccount"]>>
): Promise<Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"] | undefined> {
  const translate = t(ctx.resolveLanguage());

  switch (action) {
    case "addAccount":
      await vscode.commands.executeCommand("codexManager.addAccount");
      return undefined;
    case "importCurrent":
      if (ctx.hostKind === "browser") {
        const imported = await ctx.repo.importCurrentAuth();
        const quotaResult = await refreshImportedAccountQuota(ctx.repo, imported.id);
        const reloadRequired = deferWindowReloadForAccount(imported.id);
        ctx.schedulePublishState();
        return {
          email: imported.email,
          reloadRequired,
          reloadAccountId: imported.id,
          notice: {
            level: quotaResult.error ? ("warning" as const) : ("info" as const),
            message: quotaResult.error
              ? `Imported ${imported.email}, but quota refresh failed: ${quotaResult.error.message}`
              : `Imported ${imported.email}.`
          }
        };
      }
      await vscode.commands.executeCommand("codexManager.importCurrentAuth");
      {
        const imported = (await ctx.repo.listAccounts()).find((candidate) => candidate.isActive);
        if (!imported) return undefined;
        const reloadRequired = deferWindowReloadForAccount(imported.id);
        return { reloadRequired, reloadAccountId: imported.id, email: imported.email };
      }
    case "inspectCurrentAuth": {
      const identity = await ctx.repo.inspectCurrentAuth();
      return {
        currentAuthEmail: identity.email,
        currentAuthAlreadyAdded: identity.alreadyAdded
      };
    }
    case "completeOnboarding":
      await markOnboardingCompleted(ctx.context);
      ctx.schedulePublishState();
      return {
        notice: {
          level: "info" as const,
          message: "Setup completed. Onboarding will stay dismissed after extension updates."
        }
      };
    case "refreshAll":
      await vscode.commands.executeCommand("codexManager.refreshAllQuotas");
      return undefined;
    case "refreshAnnouncements":
      await ctx.announcements.forceRefresh(ctx.getAnnouncementOptions());
      ctx.schedulePublishState();
      return undefined;
    case "markAnnouncementRead":
      await ctx.announcements.markAsRead(payload?.announcementId ?? "");
      ctx.schedulePublishState();
      return undefined;
    case "markAllAnnouncementsRead":
      await ctx.announcements.markAllAsRead(ctx.getAnnouncementOptions());
      ctx.schedulePublishState();
      return undefined;
    case "shareTokens":
      return handleShareTokens(ctx.repo, payload, translate);
    case "exportBackup":
      return handleExportBackup(ctx.repo);
    case "configureEncryptedSync":
      if (ctx.hostKind === "browser") {
        if (!payload?.passphrase || !payload.passphraseConfirmation) {
          throw new Error("Enter and confirm the shared password in the browser dashboard.");
        }
        if (!ctx.configureEncryptedSync) {
          throw new Error("Encrypted sync is unavailable in the browser dashboard host.");
        }
        if (!(await ctx.configureEncryptedSync(payload.passphrase, payload.passphraseConfirmation))) {
          throw new Error("Encrypted sync was not configured. Check the password and try again.");
        }
        ctx.schedulePublishState();
        return { notice: { level: "info" as const, message: "Encrypted sync is configured." } };
      }
      if (payload?.passphrase && payload.passphraseConfirmation) {
        if (
          !(await vscode.commands.executeCommand<boolean>("codexManager.configureEncryptedSync", {
            passphrase: payload.passphrase,
            confirmation: payload.passphraseConfirmation,
            deferSync: payload.deferSync === true
          }))
        ) {
          throw new Error("Encrypted sync was not configured. Check the password and try again.");
        }
        ctx.schedulePublishState();
        return {
          notice: {
            level: "info" as const,
            message: payload.deferSync
              ? "Encrypted sync is configured. Initial sync is continuing in the background."
              : "Encrypted sync is configured."
          }
        };
      }
      if ((await vscode.commands.executeCommand<boolean>("codexManager.configureEncryptedSync")) !== true) {
        ctx.schedulePublishState();
        throw new Error("The password was not set. Try again and complete the password prompts.");
      }
      ctx.schedulePublishState();
      return undefined;
    case "syncNow":
      if (ctx.hostKind === "browser" && ctx.syncEncryptedAccounts) {
        if (!(await ctx.syncEncryptedAccounts())) {
          throw new Error(
            "Encrypted account sync did not complete. Make sure VS Code Settings Sync is active on this PC, then try again."
          );
        }
        ctx.schedulePublishState();
        return { notice: { level: "info" as const, message: "Encrypted account sync completed." } };
      }
      if ((await vscode.commands.executeCommand<boolean>("codexManager.syncNow")) !== true) {
        ctx.schedulePublishState();
        throw new Error(
          "Encrypted account sync did not complete. Make sure VS Code Settings Sync is active on this PC, then try again."
        );
      }
      ctx.schedulePublishState();
      return undefined;
    case "setEncryptedSyncRegistryOverride":
      if (typeof payload?.enabled !== "boolean") {
        throw new Error("The rescue override request is invalid.");
      }
      if (ctx.hostKind === "browser") {
        if (!ctx.setEncryptedSyncRegistryOverride) {
          throw new Error("The rescue override is unavailable in the browser dashboard host.");
        }
        if (payload.enabled && !payload.passphrase) {
          throw new Error("Enter the shared password in the browser dashboard.");
        }
        if (!(await ctx.setEncryptedSyncRegistryOverride(payload.enabled, payload.passphrase))) {
          throw new Error(
            payload.enabled
              ? "Rescue override was not enabled. Check the shared password and try again."
              : "Rescue override could not be disabled. Try again."
          );
        }
        ctx.schedulePublishState();
        return {
          notice: {
            level: payload.enabled ? ("warning" as const) : ("info" as const),
            message: payload.enabled
              ? "Rescue override enabled on this PC. Foreign-PC claims are warning-only."
              : "Rescue override disabled. The synchronized registry is enforced again."
          }
        };
      }
      if (
        (await vscode.commands.executeCommand<boolean>(
          "codexManager.setEncryptedSyncRegistryOverride",
          payload.enabled
        )) !== true
      ) {
        ctx.schedulePublishState();
        throw new Error(
          payload.enabled
            ? "Rescue override was not enabled. Verify the shared password and try again."
            : "Rescue override could not be disabled. Try again."
        );
      }
      ctx.schedulePublishState();
      return undefined;
    case "openNetworkLogs":
      showNetworkDebugLogs();
      return undefined;
    case "exportAuthFile":
      return handleExportAuthFile(ctx.repo, account);
    case "restoreFromBackup":
      return handleRestoreFromBackup(ctx.repo, ctx.schedulePublishState, translate);
    case "restoreFromAuthJson":
      return handleRestoreFromAuthJson(ctx.repo, ctx.schedulePublishState, translate);
    case "copyText":
      return handleCopyText(payload);
    case "openDashboard":
      await vscode.commands.executeCommand("codexManager.showQuotaSummary");
      return undefined;
    case "openWebDashboard": {
      const openResult = await vscode.commands.executeCommand<"opened" | "cancelled" | "unavailable">(
        "codexManager.openWebDashboard",
        { pathname: payload?.path }
      );
      return {
        notice:
          openResult === "opened"
            ? {
                level: "info" as const,
                message:
                  payload?.path === "/workspace"
                    ? "Opened the Codex workspace in the Web Dashboard."
                    : "Opened the Web Dashboard."
              }
            : openResult === "cancelled"
              ? { level: "warning" as const, message: "Opening the Web Dashboard was cancelled." }
              : {
                  level: "warning" as const,
                  message: "The Web Dashboard is unavailable. Enable it and configure Encrypted Sync, then try again."
                }
      };
    }
    case "openExternalUrl":
      return handleOpenExternalUrl(payload);
    case "downloadJsonFile":
      return handleDownloadJsonFile(ctx.context, payload);
    case "importSharedJson":
      return handleImportSharedJson(ctx.repo, ctx.schedulePublishState, payload, translate);
    case "previewImportSharedJson":
      return handlePreviewImportSharedJson(ctx.repo, payload, translate);
    case "prepareOAuthSession":
      return ctx.oauth.prepareSession(translate, account?.id);
    case "cancelOAuthSession":
      ctx.oauth.cancelSession(payload?.oauthSessionId);
      return undefined;
    case "startOAuthAutoFlow":
      return ctx.oauth.startAutoFlow(payload?.oauthSessionId, translate);
    case "completeOAuthSession":
      return ctx.oauth.completeSession(payload?.oauthSessionId, payload?.callbackUrl, translate);
    case "refreshView":
      await ctx.publishState(true);
      return undefined;
    case "updateTags":
      return handleUpdateTags(
        ctx.repo,
        ctx.resolveLanguage,
        ctx.schedulePublishState,
        payload,
        account,
        translate,
        ctx.hostKind === "browser"
      );
    case "setAutoSwitchLock":
      return handleAutoSwitchLock(payload, account, ctx.schedulePublishState);
    case "batchRefresh":
      return handleBatchRefresh(ctx.repo, ctx.schedulePublishState, payload, translate);
    case "batchResyncProfile":
      return handleBatchResync(ctx.repo, ctx.schedulePublishState, payload, translate);
    case "batchRemove":
      return handleBatchRemove(ctx.repo, payload, translate, ctx.schedulePublishState, ctx.hostKind === "browser");
    case "enableAllValid":
      return handleEnableAllValid(ctx.repo, ctx.schedulePublishState);
    case "disableAll":
      return handleDisableAll(ctx.repo, ctx.schedulePublishState);
    case "unloadAuth":
      await unloadAuthFile();
      await ctx.repo.syncActiveAccountFromAuthFile();
      await ctx.context.workspaceState.update(CURRENT_WINDOW_RUNTIME_ACCOUNT_KEY, undefined);
      setCurrentWindowRuntimeAccountId(undefined);
      clearQueuedAccountSwitch();
      ctx.schedulePublishState();
      return {
        notice: {
          level: "info" as const,
          message: "Codex auth unloaded. Reloading; Codex will stay signed out until you log in or switch an account."
        }
      };
    case "reloadPrompt":
      return handleReloadPrompt(account, payload, ctx.hostKind === "browser");
    case "reauthorize":
      if (account) {
        await vscode.commands.executeCommand("codexManager.reauthorizeAccount", account);
      }
      return undefined;
    case "resyncProfile":
      if (account) {
        await resyncAccountInfo(ctx.repo, account.id);
        ctx.schedulePublishState();
      }
      return undefined;
    case "dismissHealthIssue":
      if (account) {
        await ctx.repo.dismissHealthIssue(account.id, payload?.issueKey);
        ctx.schedulePublishState();
      }
      return undefined;
    case "details":
      if (account) {
        await vscode.commands.executeCommand("codexManager.openDetails", account, {
          privacyMode: payload?.privacyMode === true
        });
      }
      return undefined;
    case "switch":
      if (ctx.hostKind === "browser") {
        if (!account) {
          throw new Error("Choose an account in the browser dashboard, then try again.");
        }
        const currentAccount = await ctx.repo.getAccount(account.id);
        if (!currentAccount) {
          throw new Error("That account no longer exists. Refresh the dashboard and try again.");
        }
        if (currentAccount.isActive) {
          ctx.schedulePublishState();
          return {
            notice: {
              level: "info" as const,
              message: `${currentAccount.email} is already active.`
            }
          };
        }
        await ctx.repo.switchAccount(currentAccount.id, {
          forceTokenRefresh:
            getCodexManagerConfiguration().get<boolean>("backgroundTokenRefreshEnabled", false) &&
            currentAccount.tokenRefreshEnabled === true
        });
        clearTokenAutomationError(currentAccount.id);
        await handleCodexAppRestartPreference({ allowManualPrompt: false });
        const reloadRequired = deferWindowReloadForAccount(currentAccount.id);
        ctx.schedulePublishState();
        return {
          notice: {
            level: "info" as const,
            message: `Switched to ${currentAccount.email}.${reloadRequired ? " Reloading Codex…" : ""}`
          },
          reloadScheduled: reloadRequired
        };
      }
      {
        const result = await vscode.commands.executeCommand<SwitchAccountCommandResult>(
          "codexManager.switchAccount",
          account
        );
        if (account) {
          clearTokenAutomationError(account.id);
        }
        ctx.schedulePublishState();
        if (result?.status === "cancelled") {
          return { notice: { level: "warning" as const, message: "Account switch cancelled." } };
        }
        if (result?.status === "already-active") {
          return {
            notice: {
              level: "info" as const,
              message: `${result.account?.email ?? "That account"} is already active.`
            }
          };
        }
        if (result?.status === "switched" && result.account) {
          const reloadRequired =
            result.reloadNeeded && !result.reloaded ? deferWindowReloadForAccount(result.account.id) : false;
          return {
            notice: {
              level: "info" as const,
              message: reloadRequired
                ? `Switched to ${result.account.email}. Reloading Codex…`
                : `Switched to ${result.account.email}.`
            },
            reloadScheduled: reloadRequired
          };
        }
      }
      return undefined;
    case "refresh":
      if (account) {
        await vscode.commands.executeCommand("codexManager.refreshQuota", account);
      }
      return undefined;
    case "remove":
      if (account) {
        if (payload?.confirmed === true) {
          await ctx.repo.removeAccount(account.id);
          ctx.schedulePublishState();
          return {
            notice: { level: "info" as const, message: `Removed account ${account.email}.` }
          };
        }
        if (ctx.hostKind === "browser") {
          throw new Error("Confirm account removal in the browser dashboard, then try again.");
        }
        await vscode.commands.executeCommand("codexManager.removeAccount", account);
      }
      return undefined;
    case "toggleAccountEnabled":
      if (account) {
        const enabled = typeof payload?.enabled === "boolean" ? payload.enabled : account.enabled === false;
        try {
          await ctx.repo.setAccountEnabled(account.id, enabled);
        } finally {
          ctx.schedulePublishState();
        }
        return undefined;
      }
      return undefined;
    case "setAccountQueuePriority":
      if (account) {
        await ctx.repo.setAccountQueuePriority(account.id, payload?.queuePriority === true);
        ctx.schedulePublishState();
      }
      return undefined;
    case "setAccountTokenRefreshEnabled":
      if (account) {
        await ctx.repo.setAccountTokenRefreshEnabled(account.id, payload?.tokenRefreshEnabled !== false);
        ctx.schedulePublishState();
      }
      return undefined;
    case "refreshToken":
      return handleRefreshToken(ctx.repo, account, ctx.schedulePublishState, ctx.resolveLanguage());
    case "getResetCredits":
      return handleGetResetCredits(ctx.repo, account);
    case "getDailyUsage":
      return handleGetDailyUsage(ctx.context, ctx.repo, account, payload?.days);
    case "startCodexCliSession":
      return handleStartCodexCliSession(payload, ctx.getRemoteCliSessions);
    case "listCodexCliSessions":
      return handleListCodexCliSessions(ctx.context, ctx.getRemoteCliSessions);
    case "getCodexCliSessionMessages":
      return handleGetCodexCliSessionMessages(payload?.sessionId);
    case "sendCodexCliSessionMessage":
      return handleSendCodexCliSessionMessage(payload);
    case "cancelCodexCliSessionTurn":
      return handleCancelCodexCliSessionTurn(payload?.sessionId);
    case "openCodexCliSession":
      return handleOpenCodexCliSession(payload?.sessionId);
    case "renameCodexCliSession":
      return handleRenameCodexCliSession(payload?.sessionId, payload?.text);
    case "forkCodexCliSession":
      return handleForkCodexCliSession(payload?.sessionId);
    case "archiveCodexCliSession":
      return handleArchiveCodexCliSession(payload?.sessionId);
    case "unarchiveCodexCliSession":
      return handleUnarchiveCodexCliSession(payload?.sessionId);
    case "deleteCodexCliSession":
      return handleDeleteCodexCliSession(payload);
    case "getWorkspaceEnvironment":
      return { workspaceEnvironment: await readWorkspaceEnvironment(payload?.projectPath) };
    case "listWorkspaceFiles":
      return { workspaceFiles: await listWorkspaceFiles(payload?.projectPath) };
    case "readWorkspaceFile":
      return { workspaceFile: await readWorkspaceFile(payload?.projectPath, payload?.filePath) };
    case "saveWorkspaceFile":
      return {
        workspaceFile: await saveWorkspaceFile(payload?.projectPath, payload?.filePath, payload?.fileContent),
        notice: { level: "info" as const, message: "File saved." }
      };
    case "deleteWorkspaceFile": {
      const deletedPath = await deleteWorkspaceFile(payload?.projectPath, payload?.filePath);
      return {
        deletedWorkspaceFilePath: deletedPath,
        workspaceFiles: await listWorkspaceFiles(payload?.projectPath),
        notice: { level: "info" as const, message: `Deleted ${deletedPath}.` }
      };
    }
    case "listWorkspaceTerminals":
      return { workspaceTerminals: listWorkspaceTerminals() };
    case "createWorkspaceTerminal":
      return {
        workspaceTerminal: createWorkspaceTerminal(
          payload?.projectPath,
          payload?.terminalProfile,
          payload?.terminalName
        ),
        workspaceTerminals: listWorkspaceTerminals(),
        notice: { level: "info" as const, message: "VS Code terminal opened." }
      };
    case "focusWorkspaceTerminal":
      return {
        workspaceTerminal: focusWorkspaceTerminal(payload?.terminalId),
        workspaceTerminals: listWorkspaceTerminals(),
        notice: { level: "info" as const, message: "VS Code terminal focused." }
      };
    case "runWorkspaceTerminalCommand": {
      const terminalResult = await runWorkspaceTerminalCommand(payload ?? {});
      return {
        terminalResult,
        notice: { level: "info" as const, message: "Terminal command completed." }
      };
    }
    case "cancelWorkspaceTerminalCommand":
      if (!cancelWorkspaceTerminalCommand(payload?.terminalId)) {
        throw new Error("There is no running command to stop in this terminal.");
      }
      return { notice: { level: "warning" as const, message: "Stopping the terminal command…" } };
    case "commitWorkspaceChanges":
      return {
        workspaceEnvironment: await commitWorkspaceChanges(
          payload?.projectPath,
          payload?.commitMessage,
          payload?.confirmed
        ),
        notice: { level: "info" as const, message: "Workspace changes committed." }
      };
    case "pushWorkspaceBranch":
      return {
        workspaceEnvironment: await pushWorkspaceBranch(payload?.projectPath, payload?.confirmed),
        notice: { level: "info" as const, message: "Current branch pushed." }
      };
    case "consumeResetCredit":
      return handleConsumeResetCredit(
        ctx.repo,
        account,
        ctx.schedulePublishState,
        ctx.resolveLanguage(),
        ctx.hostKind === "browser",
        payload
      );
    default:
      throw new Error(`Unsupported dashboard action: ${String(action)}`);
  }
}

async function handleRefreshToken(
  repo: AccountsRepository,
  account: Awaited<ReturnType<AccountsRepository["getAccount"]>>,
  schedulePublishState: () => void,
  lang: DashboardLanguage
) {
  if (!account) {
    throw new Error("Account not found");
  }

  try {
    const tokens = await repo.getTokens(account.id);
    if (!tokens?.refreshToken?.trim()) {
      throw new Error("No refresh token is available. Reauthorize this account.");
    }

    const refreshed = await refreshTokens(tokens.refreshToken, tokens.idToken);
    await repo.updateTokens(account.id, {
      ...refreshed,
      accountId: refreshed.accountId ?? account.accountId ?? tokens.accountId
    });
    markTokenAutomationRefreshSuccess(account.id);
    schedulePublishState();

    const zh = lang === "zh" || lang === "zh-hant";
    void vscode.window.showInformationMessage(
      zh ? `${account.email} 的令牌已刷新。` : `Token refreshed for ${account.email}.`
    );
    return undefined;
  } catch (error) {
    markTokenAutomationRefreshFailure(account.id, toFailureMessage(error));
    schedulePublishState();
    throw error;
  }
}

async function handleShareTokens(
  repo: AccountsRepository,
  payload: DashboardActionPayload | undefined,
  translate: ReturnType<typeof t>
) {
  try {
    const accountIds = payload?.accountIds ?? [];
    const shared = await repo.exportSharedAccounts(accountIds);
    if (shared.length === 0) {
      const message = translate("message.shareTokensFailed", { message: "No accounts selected" });
      void vscode.window.showErrorMessage(message);
      throw new Error(message);
    }

    void vscode.window.showInformationMessage(
      translate("message.shareTokensReady", {
        count: shared.length
      })
    );
    return {
      sharedJson: JSON.stringify(shared, null, 2)
    };
  } catch (error) {
    const message = translate("message.shareTokensFailed", {
      message: toFailureMessage(error)
    });
    void vscode.window.showErrorMessage(message);
    throw new Error(message);
  }
}

async function handleExportBackup(repo: AccountsRepository) {
  const accounts = await repo.listAccounts();
  const shared = await repo.exportSharedAccounts(accounts.map((account) => account.id));
  const currentSettings = new ExtensionSettingsStore().getDashboardSettings();
  const settings = Object.fromEntries(
    Object.entries(currentSettings).filter(
      ([key, value]) =>
        key !== "resolvedCodexAppPath" &&
        key !== "encryptedSyncEnabled" &&
        key !== "encryptedSyncRegistryOverrideEnabled" &&
        ["string", "number", "boolean"].includes(typeof value)
    )
  ) as CodexManagerBackup["settings"];
  const backup: CodexManagerBackup = {
    format: "codex-manager-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts: shared,
    activeAccountId: accounts.find((account) => account.isActive)?.id,
    settings,
    logs: getDebugLogSnapshot()
  };
  return { sharedJson: JSON.stringify(backup, null, 2) };
}

async function handleExportAuthFile(
  repo: AccountsRepository,
  account: Awaited<ReturnType<AccountsRepository["getAccount"]>>
) {
  if (!account) {
    throw new Error("Account not found");
  }
  const authJson = await repo.exportAuthFile(account.id);
  if (!authJson) {
    throw new Error("Account tokens are unavailable");
  }
  return { authJson };
}

async function handleRestoreFromBackup(
  repo: AccountsRepository,
  schedulePublishState: () => void,
  translate: ReturnType<typeof t>
) {
  try {
    const restored = await repo.restoreIndexFromLatestBackup();
    schedulePublishState();
    void vscode.window.showInformationMessage(
      translate("message.restoreFromBackupSuccess", {
        count: restored.restoredCount
      })
    );
    return {
      restoredCount: restored.restoredCount
    };
  } catch (error) {
    const message = translate("message.restoreFromBackupFailed", {
      message: toFailureMessage(error)
    });
    void vscode.window.showErrorMessage(message);
    throw new Error(message);
  }
}

async function handleRestoreFromAuthJson(
  repo: AccountsRepository,
  schedulePublishState: () => void,
  translate: ReturnType<typeof t>
) {
  try {
    const restored = await repo.restoreAccountsFromAuthFile();
    schedulePublishState();
    void vscode.window.showInformationMessage(
      translate("message.restoreFromAuthSuccess", {
        count: restored.restoredCount
      })
    );
    return {
      restoredCount: restored.restoredCount
    };
  } catch (error) {
    const message = translate("message.restoreFromAuthFailed", {
      message: toFailureMessage(error)
    });
    void vscode.window.showErrorMessage(message);
    throw new Error(message);
  }
}

async function handleCopyText(payload: DashboardActionPayload | undefined) {
  const text = payload?.text ?? "";
  if (!text) {
    throw new Error("There is no text to copy.");
  }
  await vscode.env.clipboard.writeText(text);
  return undefined;
}

async function handleOpenExternalUrl(payload: DashboardActionPayload | undefined) {
  const url = payload?.url?.trim();
  if (!url) {
    throw new Error("There is no URL to open.");
  }
  if (!isSafeExternalUrl(url)) {
    throw new Error("Only HTTPS links or local HTTP links without embedded credentials can be opened.");
  }
  const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
  if (!opened) {
    throw new Error("VS Code could not open the requested URL.");
  }
  return undefined;
}

/** Restrict externally opened links to normal web URLs. */
export function isSafeExternalUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const isLocalHttp =
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
    return (parsed.protocol === "https:" || isLocalHttp) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

async function handleDownloadJsonFile(context: vscode.ExtensionContext, payload: DashboardActionPayload | undefined) {
  const text = payload?.text ?? "";
  const defaultName = payload?.filename?.trim() ?? "codex-manager-share.json";
  if (!text) {
    throw new Error("There is no data to save.");
  }

  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(context.globalStorageUri, defaultName),
    filters: {
      JSON: ["json"]
    },
    saveLabel: "Save JSON"
  });
  if (!target) {
    return { notice: { level: "info" as const, message: "Download cancelled." } };
  }

  await vscode.workspace.fs.writeFile(target, Buffer.from(text, "utf8"));
  return undefined;
}

async function handleImportSharedJson(
  repo: AccountsRepository,
  schedulePublishState: () => void,
  payload: DashboardActionPayload | undefined,
  translate: ReturnType<typeof t>
) {
  let parsed: ReturnType<typeof parseSharedJsonInput>;
  try {
    parsed = parseSharedJsonInput(payload?.jsonText ?? "", (message) =>
      translate("message.sharedJsonParseFailed", { message })
    );
  } catch (error) {
    const message = toFailureMessage(error);
    void vscode.window.showErrorMessage(message);
    throw error;
  }

  try {
    const backup = parseAccountsBackup(parsed);
    const accountInput = backup
      ? backup.accounts
      : (parsed as Exclude<ReturnType<typeof parseSharedJsonInput>, CodexManagerBackup>);
    const result = payload?.recoveryMode
      ? await repo.restoreAccountsFromSharedJson(accountInput)
      : await repo.importSharedAccountsWithSummary(accountInput);
    if (backup) {
      await applyBackupSettings(backup.settings);
      appendImportedDebugLogs(backup.logs);
      if (backup.activeAccountId && (await repo.getAccount(backup.activeAccountId))) {
        await repo.switchAccount(backup.activeAccountId);
      }
    }
    schedulePublishState();
    void vscode.window.showInformationMessage(
      translate(payload?.recoveryMode ? "message.restoreFromSharedSuccess" : "message.importSharedJsonSuccess", {
        count: "successCount" in result ? result.successCount : result.restoredCount
      })
    );
    return toImportActionPayload(result);
  } catch (error) {
    const message = translate(
      payload?.recoveryMode ? "message.restoreFromSharedFailed" : "message.importSharedJsonFailed",
      {
        message: toFailureMessage(error)
      }
    );
    void vscode.window.showErrorMessage(message);
    throw new Error(message);
  }
}

async function handlePreviewImportSharedJson(
  repo: AccountsRepository,
  payload: DashboardActionPayload | undefined,
  translate: ReturnType<typeof t>
) {
  const jsonText = payload?.jsonText?.trim();
  if (!jsonText) {
    return {
      importPreview: {
        total: 0,
        valid: 0,
        overwriteCount: 0,
        invalidCount: 0,
        invalidEntries: []
      }
    };
  }

  const parsed = parseSharedJsonInput(jsonText, (message) => translate("message.sharedJsonParseFailed", { message }));
  const backup = parseAccountsBackup(parsed);
  return {
    importPreview: await repo.previewSharedAccountsImport(
      backup ? backup.accounts : (parsed as Exclude<ReturnType<typeof parseSharedJsonInput>, CodexManagerBackup>)
    )
  };
}

export function parseAccountsBackup(value: ReturnType<typeof parseSharedJsonInput>): CodexManagerBackup | undefined {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Partial<CodexManagerBackup>;
  if (candidate.format !== "codex-manager-backup") {
    return undefined;
  }
  if (
    candidate.version !== 1 ||
    typeof candidate.exportedAt !== "string" ||
    Number.isNaN(Date.parse(candidate.exportedAt)) ||
    !Array.isArray(candidate.accounts) ||
    (candidate.activeAccountId !== undefined &&
      (typeof candidate.activeAccountId !== "string" || candidate.activeAccountId.length > 4096)) ||
    !candidate.settings ||
    typeof candidate.settings !== "object" ||
    Array.isArray(candidate.settings) ||
    Object.values(candidate.settings).some((setting) => !["string", "number", "boolean"].includes(typeof setting)) ||
    !Array.isArray(candidate.logs) ||
    candidate.logs.some((line) => typeof line !== "string")
  ) {
    throw new Error("The Codex Manager backup file is invalid or unsupported.");
  }
  return candidate as CodexManagerBackup;
}

async function applyBackupSettings(settings: Record<string, unknown>): Promise<void> {
  const supported = new Set([
    "dashboardTheme",
    "codexAppRestartEnabled",
    "codexAppRestartMode",
    "backgroundTokenRefreshEnabled",
    "autoRefreshMinutes",
    "autoRefreshCurrentMinutes",
    "usageHistoryRetentionDays",
    "autoSwitchEnabled",
    "hourlyQuotaControlEnabled",
    "autoSwitchReloadWindowEnabled",
    "autoSwitchRefreshAllBeforeSwitchEnabled",
    "autoSwitchHourlyThreshold",
    "autoSwitchWeeklyThreshold",
    "autoResetEnabled",
    "autoResetWeeklyThreshold",
    "autoSwitchLockMinutes",
    "quotaWarningEnabled",
    "quotaWarningThreshold",
    "quotaWarningWeeklyThreshold",
    "quotaGreenThreshold",
    "quotaYellowThreshold",
    "debugNetwork",
    "displayLanguage",
    "codexAppPath",
    "codexCliPath"
  ]);
  for (const [key, value] of Object.entries(settings)) {
    if (!supported.has(key) || !["string", "number", "boolean"].includes(typeof value)) {
      continue;
    }
    if (
      (key === "codexAppPath" || key === "codexCliPath") &&
      typeof value === "string" &&
      value &&
      !(await pathExists(value))
    ) {
      continue;
    }
    await handleDashboardSettingUpdate(
      key as Parameters<typeof handleDashboardSettingUpdate>[0],
      value as string | number | boolean,
      vscode.ConfigurationTarget.Global
    );
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return true;
  } catch {
    return false;
  }
}

async function handleUpdateTags(
  repo: AccountsRepository,
  resolveLanguage: () => DashboardLanguage,
  schedulePublishState: () => void,
  payload: DashboardActionPayload | undefined,
  account: CodexManagerAccountRecord | undefined,
  translate: ReturnType<typeof t>,
  browserHost = false
) {
  const targetIds = payload?.accountIds?.length ? payload.accountIds : account ? [account.id] : [];
  if (!targetIds.length) {
    return undefined;
  }
  const dashboardCopy = getDashboardCopy(resolveLanguage());
  const targetAccount = targetIds.length === 1 ? (account ?? (await repo.getAccount(targetIds[0]!))) : undefined;
  const mode = payload?.mode === "add" || payload?.mode === "remove" ? payload.mode : "set";
  const tags =
    payload?.submittedTags ??
    (browserHost
      ? undefined
      : await promptForTags({
          copy: dashboardCopy,
          mode,
          initialTags: targetAccount?.tags ?? [],
          label: targetIds.length === 1 ? targetAccount?.email : undefined
        }));
  if (tags === undefined) {
    if (browserHost) {
      throw new Error("Enter tags in the browser dashboard, then try again.");
    }
    return undefined;
  }

  if (mode === "add") {
    await repo.addAccountTags(targetIds, tags);
  } else if (mode === "remove") {
    await repo.removeAccountTags(targetIds, tags);
  } else if (targetIds.length === 1) {
    await repo.setAccountTags(targetIds[0]!, tags);
  } else {
    await repo.addAccountTags(targetIds, tags);
  }
  schedulePublishState();
  const message = translate("message.batchTagsSummary", {
    count: targetIds.length,
    action:
      mode === "add"
        ? dashboardCopy.addTagsBtn
        : mode === "remove"
          ? dashboardCopy.removeTagsBtn
          : dashboardCopy.editTagsBtn
  });
  if (browserHost) {
    return { notice: { level: "info" as const, message } };
  }
  void vscode.window.showInformationMessage(message);
  return undefined;
}

function handleAutoSwitchLock(
  payload: DashboardActionPayload | undefined,
  account: CodexManagerAccountRecord | undefined,
  schedulePublishState: () => void
) {
  const lockAccountId = account?.id ?? payload?.accountIds?.[0];
  const lockMinutes = typeof payload?.lockMinutes === "number" ? payload.lockMinutes : 0;
  if (!lockAccountId) {
    throw new Error("This action requires an account. Refresh the dashboard and try again.");
  }

  if (lockMinutes > 0) {
    setAutoSwitchLock(lockAccountId, lockMinutes);
  } else {
    clearAutoSwitchLock(lockAccountId);
  }
  schedulePublishState();
  return {
    notice: {
      level: "info" as const,
      message:
        lockMinutes > 0
          ? `Auto-switch locked for ${lockMinutes} minute${lockMinutes === 1 ? "" : "s"}.`
          : "Auto-switch lock removed."
    }
  };
}

async function handleBatchRefresh(
  repo: AccountsRepository,
  schedulePublishState: () => void,
  payload: DashboardActionPayload | undefined,
  translate: ReturnType<typeof t>
) {
  const requestedIds = payload?.accountIds ?? [];
  const accountsById = new Map(
    await Promise.all(requestedIds.map(async (id) => [id, await repo.getAccount(id)] as const))
  );
  const targetIds = requestedIds;
  let success = 0;
  let failed = 0;
  const failures: DashboardBatchResultFailure[] = [];
  await runWithConcurrencyLimit(
    targetIds,
    CODEX_BATCH_REFRESH_CONCURRENCY,
    async (id) => {
      try {
        await refreshSingleQuota(repo, { refresh() {} }, id, {
          announce: false,
          forceRefresh: true,
          refreshView: false,
          warnQuota: false
        });
        success += 1;
      } catch (error) {
        failed += 1;
        failures.push({
          accountId: id,
          email: accountsById.get(id)?.email,
          message: toFailureMessage(error)
        });
        console.warn(`[codexManager] batch quota refresh failed for ${id}:`, error);
      }
    },
    { delayMs: CODEX_BATCH_REFRESH_DELAY_MS }
  );
  schedulePublishState();
  const message = translate("message.batchRefreshSummary", {
    success,
    failed
  });
  if (failed > 0) {
    void vscode.window.showWarningMessage(message);
  } else {
    void vscode.window.showInformationMessage(message);
  }
  return {
    batchResult: {
      kind: "batch_refresh" as const,
      successCount: success,
      failedCount: failed,
      failures
    }
  };
}

async function handleBatchResync(
  repo: AccountsRepository,
  schedulePublishState: () => void,
  payload: DashboardActionPayload | undefined,
  translate: ReturnType<typeof t>
) {
  const targetIds = payload?.accountIds ?? [];
  const accountsById = new Map(
    await Promise.all(targetIds.map(async (id) => [id, await repo.getAccount(id)] as const))
  );
  let success = 0;
  let failed = 0;
  const failures: DashboardBatchResultFailure[] = [];
  await runWithConcurrencyLimit(
    targetIds,
    4,
    async (id) => {
      try {
        await resyncAccountInfo(repo, id);
        success += 1;
      } catch (error) {
        failed += 1;
        failures.push({
          accountId: id,
          email: accountsById.get(id)?.email,
          message: toFailureMessage(error)
        });
        console.warn(`[codexManager] batch profile resync failed for ${id}:`, error);
      }
    },
    { delayMs: CODEX_BATCH_REFRESH_DELAY_MS }
  );
  schedulePublishState();
  const message = translate("message.batchResyncSummary", {
    success,
    failed
  });
  if (failed > 0) {
    void vscode.window.showWarningMessage(message);
  } else {
    void vscode.window.showInformationMessage(message);
  }
  return {
    batchResult: {
      kind: "batch_resync" as const,
      successCount: success,
      failedCount: failed,
      failures
    }
  };
}

async function resyncAccountInfo(repo: AccountsRepository, accountId: string): Promise<void> {
  await repo.refreshAccountProfileMetadata(accountId);
  await refreshSingleQuota(repo, { refresh() {} }, accountId, {
    announce: false,
    awaitSubscriptionRefresh: true,
    forceRefresh: true,
    refreshView: false,
    warnQuota: false
  });
}

async function handleBatchRemove(
  repo: AccountsRepository,
  payload: DashboardActionPayload | undefined,
  translate: ReturnType<typeof t>,
  schedulePublishState: () => void,
  browserHost = false
) {
  const targetIds = payload?.accountIds ?? [];
  if (!targetIds.length) {
    return undefined;
  }
  const accountsById = new Map(
    await Promise.all(targetIds.map(async (id) => [id, await repo.getAccount(id)] as const))
  );
  if (payload?.confirmed !== true && browserHost) {
    throw new Error("Confirm account removal in the browser dashboard, then try again.");
  }
  if (payload?.confirmed !== true) {
    const choice = await vscode.window.showWarningMessage(
      translate("message.batchRemoveConfirm", { count: targetIds.length }),
      { modal: true },
      translate("confirm.removeButton")
    );
    if (choice !== translate("confirm.removeButton")) {
      return undefined;
    }
  }
  let removed = 0;
  let failed = 0;
  const failures: DashboardBatchResultFailure[] = [];
  for (const id of targetIds) {
    try {
      await repo.removeAccount(id);
      removed += 1;
    } catch (error) {
      failed += 1;
      failures.push({
        accountId: id,
        email: accountsById.get(id)?.email,
        message: toFailureMessage(error)
      });
      console.warn(`[codexManager] batch remove failed for ${id}:`, error);
    }
  }
  schedulePublishState();
  const message = translate("message.batchRemoveSummary", {
    count: removed,
    failed
  });
  if (browserHost) {
    // The batch result is rendered as a terminal browser toast.
  } else if (failed > 0) {
    void vscode.window.showWarningMessage(message);
  } else {
    void vscode.window.showInformationMessage(message);
  }
  return {
    batchResult: {
      kind: "batch_remove" as const,
      successCount: removed,
      failedCount: failed,
      failures
    }
  };
}

async function handleDisableAll(repo: AccountsRepository, schedulePublishState: () => void) {
  const accounts = await repo.listAccounts();
  const enabledAccounts = accounts.filter((candidate) => candidate.enabled !== false);
  let success = accounts.length - enabledAccounts.length;
  let failed = 0;
  const failures: DashboardBatchResultFailure[] = [];

  for (const account of enabledAccounts) {
    try {
      await repo.setAccountEnabled(account.id, false);
      success += 1;
    } catch (error) {
      failed += 1;
      failures.push({
        accountId: account.id,
        email: account.email,
        message: toFailureMessage(error)
      });
      console.warn(`[codexManager] disable-all failed for ${account.id}:`, error);
    }
  }

  schedulePublishState();
  return {
    batchResult: {
      kind: "disable_all" as const,
      successCount: success,
      failedCount: failed,
      failures
    },
    ...(failed === 0
      ? {
          notice: {
            level: "info" as const,
            message: `Disabled ${success} account${success === 1 ? "" : "s"}.`
          }
        }
      : {})
  };
}

async function handleEnableAllValid(repo: AccountsRepository, schedulePublishState: () => void) {
  const accounts = await repo.listAccounts();
  const automation = getTokenAutomationSnapshot();
  let success = 0;
  let skipped = 0;
  let failed = 0;
  const failures: DashboardBatchResultFailure[] = [];

  for (const account of accounts) {
    try {
      const tokens = await repo.getTokens(account.id, { syncExternal: false });
      const health = resolveAccountHealth(account, tokens, automation);
      const hasCredentials = Boolean(tokens?.accessToken?.trim() && tokens.idToken?.trim());
      if (!hasCredentials || health.kind === "reauthorize" || health.kind === "disabled") {
        skipped += 1;
        continue;
      }
      if (account.enabled === false) {
        await repo.setAccountEnabled(account.id, true);
      }
      success += 1;
    } catch (error) {
      failed += 1;
      failures.push({
        accountId: account.id,
        email: account.email,
        message: toFailureMessage(error)
      });
      console.warn(`[codexManager] enable-all-valid failed for ${account.id}:`, error);
    }
  }

  schedulePublishState();
  const summary = `Enabled ${success} valid account${success === 1 ? "" : "s"}; skipped ${skipped} invalid account${skipped === 1 ? "" : "s"}.`;
  const firstFailure = failures[0]?.message;
  return {
    batchResult: {
      kind: "enable_all_valid" as const,
      successCount: success,
      failedCount: failed,
      failures
    },
    notice: {
      level: failed > 0 ? ("warning" as const) : ("info" as const),
      message:
        failed > 0
          ? `${summary} ${failed} account${failed === 1 ? "" : "s"} failed.${firstFailure ? ` First error: ${firstFailure}` : ""}`
          : summary
    }
  };
}

async function handleReloadPrompt(
  account: CodexManagerAccountRecord | undefined,
  payload: DashboardActionPayload | undefined,
  browserHost = false
) {
  if (!account) {
    return undefined;
  }
  if (browserHost && payload?.confirmed !== true) {
    throw new Error("Confirm the reload in the browser dashboard, then try again.");
  }
  if (payload?.confirmed === true) {
    const reloaded = await reloadWindowNow();
    return reloaded
      ? { notice: { level: "info" as const, message: "Reloading the VS Code extension host…" } }
      : { notice: { level: "warning" as const, message: "This VS Code window is already using that account." } };
  }
  const reloaded = payload?.forceReload ? await reloadWindowNow() : await promptWindowReloadForAccount(account);
  return reloaded
    ? { notice: { level: "info" as const, message: "Reloading the VS Code extension host…" } }
    : {
        notice: {
          level: "warning" as const,
          message: "Reload was not started. This window is already using that account, or the reload was postponed."
        }
      };
}

async function handleGetResetCredits(
  repo: AccountsRepository,
  account?: Awaited<ReturnType<AccountsRepository["getAccount"]>>
) {
  if (!account) {
    throw new Error("Account not found");
  }

  const tokens = await repo.getTokens(account.id);
  if (!tokens?.accessToken) {
    throw new Error("No access token available");
  }

  const accountId = account.accountId ?? undefined;
  const snapshot = await fetchResetCredits(tokens.accessToken, accountId);
  return { resetCredits: snapshot };
}

async function handleGetDailyUsage(
  context: vscode.ExtensionContext,
  repo: AccountsRepository,
  account: Awaited<ReturnType<AccountsRepository["getAccount"]>>,
  requestedDays: number | undefined
) {
  if (!account) {
    throw new Error("Account not found");
  }
  const tokens = await repo.getTokens(account.id, { bypassCache: true });
  if (!tokens?.accessToken) {
    throw new Error("No access token is available for usage history.");
  }
  const days = Math.min(30, Math.max(1, Math.round(requestedDays ?? 30)));
  const dailyUsage = await fetchDailyUsageBreakdown(tokens, days);
  if (!dailyUsage) {
    throw new Error("The usage endpoint returned no readable data.");
  }
  await upsertDashboardDailyUsageCache(context, account.id, dailyUsage);
  return { dailyUsage };
}

function ensureCliIntegrationEnabled(): void {
  if (!getCodexManagerConfiguration().get<boolean>("cliIntegrationEnabled", false)) {
    throw new Error("Session Integration is disabled. Enable it in Settings before opening sessions.");
  }
}

async function handleListCodexCliSessions(
  context: vscode.ExtensionContext,
  getRemoteCliSessions?: () => DashboardCliSessionSummary[]
) {
  ensureCliIntegrationEnabled();
  if (!(await isCodexCliAvailable())) {
    throw new Error("Codex CLI is not available on this PC. Install it or set CODEX_CLI_PATH, then try again.");
  }
  const [localSessions, cliComposerConfig] = await Promise.all([readCodexCliSessions(), readCodexCliComposerConfig()]);
  const remoteSessions = getRemoteCliSessions?.() ?? [];
  const stabilizedLocalSessions = await stabilizeSessionProjectPaths(
    context,
    localSessions,
    cliComposerConfig.projects
  );
  return {
    cliSessions: [...stabilizedLocalSessions, ...remoteSessions].sort((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
    ),
    cliComposerConfig
  };
}

async function handleStartCodexCliSession(
  payload: DashboardActionPayload | undefined,
  getRemoteCliSessions?: () => DashboardCliSessionSummary[]
) {
  ensureCliIntegrationEnabled();
  if (!(await isCodexCliAvailable())) {
    throw new Error("Codex CLI is not available on this PC. Install it or set CODEX_CLI_PATH, then try again.");
  }
  const sessionId = await startCodexCliSession({
    text: payload?.text ?? "",
    model: payload?.model,
    reasoningEffort: payload?.reasoningEffort,
    sandboxMode: payload?.sandboxMode,
    projectPath: payload?.projectPath
  });
  const [localSessions, cliComposerConfig] = await Promise.all([readCodexCliSessions(), readCodexCliComposerConfig()]);
  const remoteSessions = getRemoteCliSessions?.() ?? [];
  const cliSessions = [...localSessions, ...remoteSessions].sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
  );
  return {
    cliSessions,
    cliSession: cliSessions.find((session) => session.id === sessionId) ?? {
      id: sessionId,
      title: "New Codex chat",
      status: "idle" as const,
      archived: false,
      ...(payload?.projectPath?.trim() ? { projectPath: payload.projectPath.trim() } : {})
    },
    cliSessionMessages: payload?.text?.trim() ? await readCodexCliSessionMessages(sessionId) : [],
    cliComposerConfig,
    notice: { level: "info" as const, message: "New Codex chat is ready." }
  };
}

async function handleGetCodexCliSessionMessages(sessionId: string | undefined) {
  ensureCliIntegrationEnabled();
  if (!sessionId) throw new Error("Choose a session first.");
  const cliSession = await readCodexCliSessionSummary(sessionId);
  if (!cliSession) throw new Error("This Codex session was not found. Refresh the session list and try again.");
  if (cliSession.archived) throw new Error("Archived sessions cannot be opened. Restore the session first.");
  const cliSessionMessages = await readCodexCliSessionMessages(sessionId);
  return { cliSession, cliSessionMessages };
}

async function handleSendCodexCliSessionMessage(payload: DashboardActionPayload | undefined) {
  ensureCliIntegrationEnabled();
  if (!payload?.sessionId) throw new Error("Choose a session first.");
  await ensureCliSessionIsActive(payload.sessionId);
  await sendCodexCliSessionMessage({
    sessionId: payload.sessionId,
    text: payload.text ?? "",
    model: payload.model,
    reasoningEffort: payload.reasoningEffort,
    sandboxMode: payload.sandboxMode,
    projectPath: payload.projectPath
  });
  const [cliSessions, cliSessionMessages] = await Promise.all([
    readCodexCliSessions(),
    readCodexCliSessionMessages(payload.sessionId)
  ]);
  return {
    cliSessions,
    cliSession: cliSessions.find((session) => session.id === payload.sessionId),
    cliSessionMessages,
    notice: { level: "info" as const, message: "Codex completed the turn." }
  };
}

function handleCancelCodexCliSessionTurn(sessionId: string | undefined) {
  ensureCliIntegrationEnabled();
  if (!sessionId) throw new Error("Choose a session first.");
  if (!cancelCodexCliSessionTurn(sessionId)) {
    throw new Error("There is no dashboard-started Codex turn to stop in this session.");
  }
  return {
    notice: {
      level: "warning" as const,
      message: "Stop signal sent. The active turn will report cancellation when the CLI exits."
    }
  };
}

async function handleOpenCodexCliSession(sessionId: string | undefined) {
  ensureCliIntegrationEnabled();
  if (!sessionId) throw new Error("Choose a session first.");
  await ensureCliSessionIsActive(sessionId);
  await openCodexCliSessionInVsCode(sessionId);
  return { notice: { level: "info" as const, message: "Opened the session in the Codex extension." } };
}

async function handleRenameCodexCliSession(sessionId: string | undefined, name: string | undefined) {
  ensureCliIntegrationEnabled();
  if (!sessionId) throw new Error("Choose a session first.");
  await ensureCliSessionIsActive(sessionId);
  await renameCodexCliSession(sessionId, name ?? "");
  const cliSessions = await readCodexCliSessions();
  return {
    cliSessions,
    cliSession: cliSessions.find((session) => session.id === sessionId),
    notice: { level: "info" as const, message: "Session renamed." }
  };
}

async function handleForkCodexCliSession(sessionId: string | undefined) {
  ensureCliIntegrationEnabled();
  if (!sessionId) throw new Error("Choose a session first.");
  const sourceSession = await ensureCliSessionIsActive(sessionId);
  const forkedId = await forkCodexCliSession(sessionId);
  const cliSessions = await readCodexCliSessions();
  const forkedSession = cliSessions.find((session) => session.id === forkedId) ?? {
    id: forkedId,
    title: `${sourceSession.title} (fork)`,
    status: "idle" as const,
    archived: false,
    ...(sourceSession.projectPath ? { projectPath: sourceSession.projectPath } : {})
  };
  return {
    cliSessions: cliSessions.some((session) => session.id === forkedId) ? cliSessions : [forkedSession, ...cliSessions],
    cliSession: forkedSession,
    notice: { level: "info" as const, message: "Session fork created." }
  };
}

async function handleArchiveCodexCliSession(sessionId: string | undefined) {
  ensureCliIntegrationEnabled();
  if (!sessionId) throw new Error("Choose a session first.");
  await ensureCliSessionIsActive(sessionId);
  await archiveCodexCliSession(sessionId);
  return {
    cliSessions: await readCodexCliSessions(),
    notice: { level: "info" as const, message: "Codex session archived." }
  };
}

async function handleUnarchiveCodexCliSession(sessionId: string | undefined) {
  ensureCliIntegrationEnabled();
  if (!sessionId) throw new Error("Choose a session first.");
  const session = await findCliSession(sessionId);
  if (!session.archived) throw new Error("This session is already active.");
  await unarchiveCodexCliSession(sessionId);
  return {
    cliSessions: await readCodexCliSessions(),
    notice: { level: "info" as const, message: "Codex session restored to Active." }
  };
}

async function handleDeleteCodexCliSession(payload: DashboardActionPayload | undefined) {
  ensureCliIntegrationEnabled();
  if (!payload?.sessionId) throw new Error("Choose a session first.");
  if (payload.confirmed !== true) throw new Error("Confirm permanent deletion, then try again.");
  await deleteCodexCliSession(payload.sessionId);
  return {
    cliSessions: await readCodexCliSessions(),
    notice: { level: "info" as const, message: "Codex session permanently deleted." }
  };
}

async function findCliSession(sessionId: string) {
  const session = await readCodexCliSessionSummary(sessionId);
  if (!session) throw new Error("This Codex session was not found. Refresh the session list and try again.");
  return session;
}

async function ensureCliSessionIsActive(sessionId: string) {
  const session = await findCliSession(sessionId);
  if (session.archived) throw new Error("Restore this archived session before opening or continuing it.");
  return session;
}

async function handleConsumeResetCredit(
  repo: AccountsRepository,
  account?: Awaited<ReturnType<AccountsRepository["getAccount"]>>,
  schedulePublishState?: () => void,
  lang?: string,
  browserHost = false,
  payload?: DashboardActionPayload
) {
  if (!account) {
    throw new Error("Account not found");
  }

  const available = account.quotaSummary?.resetCreditsAvailable;
  if (available == null || available <= 0) {
    throw new Error("No reset credits available");
  }

  // 使用 Dashboard 语言设置而非 VS Code UI 语言
  const isZh = (lang ?? vscode.env.language).toLowerCase().startsWith("zh");
  const title = isZh ? "要重置你的使用量吗？" : "Reset your usage?";
  const body = isZh
    ? `重置速率限制后，继续不间断地工作。你还有 ${available} 次重置 可用。`
    : `Reset your rate limit and keep working without interruption. You have ${available} reset(s) available.`;
  const confirmBtn = isZh ? "重置速率限制" : "Reset Rate Limit";

  if (payload?.confirmed !== true && browserHost) {
    throw new Error("Confirm the rate-limit reset in the browser dashboard, then try again.");
  }
  if (payload?.confirmed !== true) {
    const choice = await vscode.window.showWarningMessage(`${title}\n\n${body}`, { modal: true }, confirmBtn);
    if (choice !== confirmBtn) {
      return undefined;
    }
  }

  const tokens = await repo.getTokens(account.id);
  if (!tokens?.accessToken) {
    throw new Error("No access token available");
  }

  const accountId = account.accountId ?? undefined;
  await consumeResetCredit(tokens.accessToken, accountId);

  const successMessage = isZh
    ? "速率限制已重置，你可以继续工作了。"
    : "Rate limit has been reset. You can continue working.";
  if (!browserHost) {
    void vscode.window.showInformationMessage(successMessage);
  }

  if (account) {
    try {
      if (browserHost) {
        await refreshSingleQuota(repo, { refresh() {} }, account.id, {
          announce: false,
          refreshView: false,
          warnQuota: false,
          forceRefresh: true
        });
        schedulePublishState?.();
      } else {
        await vscode.commands.executeCommand("codexManager.refreshQuota", account);
      }
    } catch (error) {
      console.warn("[codexManager] refresh quota after consuming reset credit failed:", error);
      schedulePublishState?.();
    }
  }
  return browserHost ? { notice: { level: "info" as const, message: successMessage } } : undefined;
}
