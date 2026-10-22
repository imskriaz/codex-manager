import { moveProjectTask, startProjectTaskSession } from '../../services/projectTaskMovement';
import { clearPersistentLogs, exportPersistentLogs } from "../../utils/persistentLog";
import { getMaintenanceJob, readMaintenancePage, inspectMaintenanceStorage, previewMaintenance, runMaintenance } from "../../services/maintenance";
import { resumeCodexSessionWork } from "../../services/codexSessionRecovery";
import { normalizeNativePath } from "../../utils/nativePaths";
import { runAccountBatch } from "../../application/accounts/batch";
import * as vscode from "vscode";
import { readWorkspaceTerminalActivity } from "../../services/dashboardRealtime";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { resolveAccountHealth } from "../../application/accounts/health";
import { refreshImportedAccountQuota, refreshSingleQuota } from "../../application/accounts/quota";
import type { QuotaRefreshResult } from "../../services/quota";
import { redeemAccountResetCredit } from "../../application/accounts/resetCreditRedemption";
import { fetchResetCredits } from "../../services/quota";
import { fetchAccountDailyUsage } from "../../services/usage";
import {
  archiveCodexCliSession,
  cancelCodexCliSessionTurn,
  CodexCliTurnCancelledError,
  deleteCodexCliSession,
  forkCodexCliSession,
  openCodexSessionInVsCode,
  openNewCodexWebview,
  readCodexCliComposerConfig,
  readCodexCliSessionSummary,
  resolveCodexHome,
  resolveRecordedSessionProject,
  readNewCodexCliSessionSummary,
  readCodexCliSessions,
  getCodexSessionReadNotice,
  isCodexCliAvailable,
  readCodexCliSessionMessages,
  renameCodexCliSession,
  setCodexSessionGoalStatus,
  setCodexSessionAutoResume,
  setCodexSessionQueue,
  startCodexCliSession,
  sendCodexCliSessionMessage,
  steerCodexCliSessionTurn,
  unarchiveCodexCliSession
} from "../../services/codexSessionResume";
import { getCodexManagerConfiguration } from "../../infrastructure/config/extensionSettings";
import { isCodexSessionAutoResumeEnabled } from "../../services/codexSessionPreferences";
import { respondCodexAppServerPrompt } from "../../services/codexAppServerPrompts";
import { getCodexSessionLiveState } from "../../services/codexSessionLive";
import { unloadAuthFile, runCodexHomeOperation } from "../../codex";
import { queryDashboardUsage, saveDashboardUsageHistory } from "../../services/dashboardUsageHistory";
import { loadDailyTokenUsage } from "../../services/dailyTokenUsage";
import {
  cancelWorkspaceTerminalCommand,
  closeWorkspaceTerminal,
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
import { stabilizeSessionProjectPaths } from "../../services/sessionProjectBindings";
import { getEncryptedSyncSettingsFailure } from "../../services/encryptedSync";
import type {
  DashboardActionName,
  DashboardActionPayload,
  DashboardBatchResultFailure,
  DashboardBatchResult,
  DashboardCliSessionSummary,
  DashboardClientMessage,
  DashboardHostMessage,
  DashboardNotice
} from "../../domain/dashboard/types";
import type { CodexManagerAccountRecord, CodexManagerBackup } from "../../core/types";
import type { DashboardLanguage } from "../../localization/languages";
import { getErrorMessage } from "../../core";
import type { SwitchAccountCommandResult } from "../../application/accounts/commandService";
import { AccountsRepository } from "../../storage";
import { normalizeAccountTags } from '../../domain/accountTags';
import { waitWithin } from "../../utils/concurrency";
import { t } from "../../utils";
import { appendImportedDebugLogs, getDebugLogSnapshot, showNetworkDebugLogs } from "../../utils/debug";
import { updateAutoSwitchLock } from "../workbench/autoSwitchState";
import { getTokenAutomationSnapshot } from "../workbench/tokenAutomationState";
import { createDashboardApiToken, listDashboardApiTokens, revokeDashboardApiToken } from '../../services/dashboardApiToken';
import { readProjectBoard, readSavedProjectBoard, readProjectTaskDetails } from '../../services/projectBoard';
import { saveProjectTaskWithAttachments, addProjectCommentWithAttachments, readProjectAttachment, createProjectShare, revokeProjectShares, resetProjectTaskStart } from '../../services/projectTasks';
import { resolveWorkspaceProjectPathAsync } from '../../services/workspaceTools';
import {
  clearQueuedAccountSwitch,
  getCurrentWindowRuntimeAccountKey,
  setCurrentWindowRuntimeAccountId
} from "../workbench/windowRuntimeAccount";
import { parseSharedJsonInput, toFailureMessage, toImportActionPayload } from "./actionUtils";
import { homedir } from "node:os";

const COMMAND_ROUTED_ACTIONS = new Set<DashboardActionName>([
  "addAccount",
  "generateApiToken", "listApiTokens", "revokeApiToken", "getProjectBoard", "getProjectTaskDetails", "saveProjectTask", "addProjectComment", "startProjectTask", "startProjectSubtask", "moveProjectTask", "resetProjectTaskStart", "shareProjectBoard", "revokeProjectShares",
  "setPrivacyMode",
  "setCrossPcSyncEnabled",
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
  "shareTokens",
  "exportBackup",
  "downloadLogs",
  "viewLogs",
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
  "getUsageGraph",
  "clearUsageHistory",
  "openNewCodexWebview",
  "resumeCodexSessions",
  "setCodexSessionGoalStatus",
  "setCodexSessionAutoResume",
  "setCodexSessionQueue",
  "startCodexCliSession",
  "listCodexCliSessions",
  "getCodexCliSessionMessages",
  "getCodexSubAgentMessages",
  "sendCodexCliSessionMessage",
  "steerCodexCliSessionTurn",
  "cancelCodexCliSessionTurn",
  "respondCodexServerRequest",
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
  "closeWorkspaceTerminal",
  "commitWorkspaceChanges",
  "pushWorkspaceBranch"
]);
import type { DashboardOAuthCoordinator } from "./oauthCoordinator";
import { ExtensionSettingsStore } from "../../infrastructure/config/extensionSettings";
import { handleDashboardSettingUpdate } from "./settings";
import {
  deferWindowReloadForAccount,
  handleCodexAppRestartPreference,
  promptWindowReloadForAccount
} from "../../application/accounts/switchEffects";
import { consumeDashboardActionNotice, shouldSuppressDashboardNotifications } from "../../utils/notificationPolicy";
import { runWithPersistentOperation } from "../../utils/persistentLog";
import { markOnboardingCompleted } from "../../services/onboarding";
import { cancelCodexSessionAutoResume, withCodexSessionRecovery } from "../../services/codexSessionAutoResume";
import { filterCliSessionsBySection } from "../../domain/codexSessionState";
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
  /** Browser actions must never open VS Code-owned prompts or confirmations. */
  hostKind?: "webview" | "browser";
  configureEncryptedSync?: (passphrase: string, confirmation: string, currentPassphrase?: string) => Promise<boolean>;
  syncEncryptedAccounts?: () => Promise<boolean>;
  setEncryptedSyncRegistryOverride?: (enabled: boolean, passphrase?: string) => Promise<boolean>;
  getRemoteCliSessions?: () => DashboardCliSessionSummary[];
};

const ACCOUNT_REQUIRED_ACTIONS = new Set<DashboardActionName>([
  "exportAuthFile",
  "setAutoSwitchLock",
  "reauthorize",
  "resyncProfile",
  "dismissHealthIssue",
  "details",
  "refresh",
  "remove",
  "toggleAccountEnabled",
  "setAccountQueuePriority",
  "setAccountTags",
  "setAccountTokenRefreshEnabled",
  "setAccountAutoResetAllowed",
  "refreshToken",
  "getResetCredits",
  "getDailyUsage",
  "consumeResetCredit"
]);

type SessionActionResult = Awaited<ReturnType<typeof executeDashboardActionMessageCore>>;
const sessionActionRequestsByContext = new WeakMap<vscode.ExtensionContext, Map<string, {
  fingerprint: string; expiresAt: number; pending: boolean; result: Promise<SessionActionResult>;
}>>();
const SESSION_REQUEST_TTL_MS = 10 * 60_000;
const MAX_SESSION_REQUESTS = 128;

export async function executeDashboardActionMessage(
  ctx: DashboardActionContext,
  message: Extract<DashboardClientMessage, { type: "dashboard:action" }>
): Promise<{
  status: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["status"];
  payload?: Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"];
  errorMessage?: string;
}> {
  if (["startCodexCliSession", "sendCodexCliSessionMessage", "steerCodexCliSessionTurn", "cancelCodexCliSessionTurn",
    "openNewCodexWebview", "resumeCodexSessions", "setCodexSessionGoalStatus", "renameCodexCliSession",
    "forkCodexCliSession", "archiveCodexCliSession", "unarchiveCodexCliSession", "deleteCodexCliSession"].includes(message.action) ||
    (message.action === "openCodexCliSession" && (ctx.hostKind !== "browser" || message.payload?.openInVsCode === true)))
    cancelCodexSessionAutoResume("Auto Resume was cancelled for this manual action.");
  // Routine reads and the console itself must not generate audit traffic.
  if (["viewLogs", "downloadLogs", "clearLogs", "getMaintenanceStatus", "getMaintenancePage",
    "getUsageGraph", "listCodexCliSessions", "getCodexCliSessionMessages", "getCodexSubAgentMessages",
    "getWorkspaceEnvironment", "listWorkspaceFiles", "readWorkspaceFile", "listWorkspaceTerminals"
  ].includes(message.action)) return executeDashboardActionMessageCore(ctx, message);
  const execute = () => runWithPersistentOperation(
    `dashboard:${message.action}`,
    () => executeDashboardActionMessageCore(ctx, message),
    { hostKind: ctx.hostKind ?? "webview" },
    (result) => ({ status: result.status, errorMessage: result.errorMessage })
  );
  if (!["startCodexCliSession", "sendCodexCliSessionMessage", "steerCodexCliSessionTurn", "resumeCodexSessions"].includes(message.action)) return execute();
  if (typeof message.requestId !== "string" || !message.requestId.trim() || message.requestId.length > 256)
    return { status: "failed", errorMessage: "The session request identifier is invalid. Refresh the session and try again." };
  let sessionActionRequests = sessionActionRequestsByContext.get(ctx.context);
  if (!sessionActionRequests) {
    sessionActionRequests = new Map();
    sessionActionRequestsByContext.set(ctx.context, sessionActionRequests);
  }
  const now = Date.now();
  for (const [id, request] of sessionActionRequests) {
    if (!request.pending && request.expiresAt <= now) sessionActionRequests.delete(id);
  }
  const fingerprint = createHash("sha256").update(JSON.stringify([message.action, message.accountId, message.payload])).digest("hex");
  const existing = sessionActionRequests.get(message.requestId);
  if (existing) return existing.fingerprint === fingerprint ? existing.result : {
    status: "failed", errorMessage: "This request identifier was already used for a different session action. Refresh and try again."
  };
  if (sessionActionRequests.size >= MAX_SESSION_REQUESTS) return {
    status: "failed", errorMessage: "The session request queue is full. Wait for recent requests to expire before retrying."
  };
  const request = { fingerprint, expiresAt: now + SESSION_REQUEST_TTL_MS, pending: true, result: Promise.resolve({ status: "failed" } as SessionActionResult) };
  sessionActionRequests.set(message.requestId, request);
  request.result = Promise.resolve().then(execute).then((result) => {
    request.pending = false;
    request.expiresAt = Date.now() + SESSION_REQUEST_TTL_MS;
    // Retain the outcome, without retaining transcripts, attachments or live snapshots.
    request.result = Promise.resolve({ status: result.status, errorMessage: result.errorMessage,
      payload: result.payload ? { cliSession: result.payload.cliSession, notice: result.payload.notice } : undefined });
    return result;
  }, (error: unknown) => {
    const result: SessionActionResult = { status: "failed", errorMessage: getErrorMessage(error) };
    request.pending = false;
    request.expiresAt = Date.now() + SESSION_REQUEST_TTL_MS;
    request.result = Promise.resolve(result);
    return result;
  });
  return request.result;
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
        message.action === "consumeResetCredit");
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
    if (!["viewLogs", "downloadLogs", "clearLogs"].includes(message.action))
      console.error(`[codexManager] dashboard action failed: ${message.action}`, error);
    if (!shouldSuppressDashboardNotifications() && (message.action === "switch" || message.action === "refreshToken")) {
      void vscode.window.showErrorMessage(
        `Unable to ${message.action === "switch" ? "switch account" : "refresh token"}: ${errorMessage}`
      );
    }
  }

  const notice = consumeDashboardActionNotice();
  if (notice && !payload?.notice && !payload?.batchResult?.failedCount) payload = { ...payload, notice };
  return { status, payload, errorMessage };
}

async function runDashboardAction(
  ctx: DashboardActionContext,
  action: DashboardActionName,
  payload: DashboardActionPayload | undefined,
  account?: Awaited<ReturnType<AccountsRepository["getAccount"]>>
): Promise<Extract<DashboardHostMessage, { type: "dashboard:action-result" }>["payload"] | undefined> {
  const translate = t(ctx.resolveLanguage());
  if (payload?.sessionId && ["getWorkspaceEnvironment", "listWorkspaceFiles", "readWorkspaceFile", "saveWorkspaceFile", "deleteWorkspaceFile", "createWorkspaceTerminal", "runWorkspaceTerminalCommand", "commitWorkspaceChanges", "pushWorkspaceBranch"].includes(action)) {
    payload = { ...payload, projectPath: await waitWithin(resolveRecordedSessionProject(payload.sessionId, payload.projectPath),
      5_000, "This session's project folder is unavailable. Retry when it is connected.") };
  }

  switch (action) {
    case "setCrossPcSyncEnabled": {
      if (typeof payload?.enabled !== "boolean") {
        throw new Error("The cross-PC sync request is invalid. Refresh the dashboard and try again.");
      }
      await handleDashboardSettingUpdate("encryptedSyncEnabled", payload.enabled, vscode.ConfigurationTarget.Global);
      ctx.schedulePublishState();
      return {
        notice: {
          level: "info",
          message: payload.enabled
            ? "Auto Sync enabled. Full account and token sync remains controlled by its separate setting."
            : "Auto Sync disabled. Cross-PC account and token sync is inactive on this PC."
        }
      };
    }
    case "addAccount":
      await vscode.commands.executeCommand("codexManager.addAccount");
      return undefined;
    case "generateApiToken":
      if (!getCodexManagerConfiguration().get<boolean>("apiAccessEnabled", false)) {
        throw new Error("Enable API access in Settings before generating a token.");
      }
      if (payload?.tokenProjectPaths !== undefined && (!Array.isArray(payload.tokenProjectPaths) || !payload.tokenProjectPaths.length || payload.tokenProjectPaths.length > 32 || payload.tokenProjectPaths.some(item => typeof item !== 'string' || !item.trim()))) throw new Error('Choose between 1 and 32 project folders.');
      return { apiToken: (await createDashboardApiToken(ctx.context, { name: payload?.tokenName, permissions: payload?.tokenPermissions, projectPaths: payload?.tokenProjectPaths ? await Promise.all(payload.tokenProjectPaths.map(project => resolveWorkspaceProjectPathAsync(project))) : undefined, projectPath: payload?.projectPath ? await resolveWorkspaceProjectPathAsync(payload.projectPath) : undefined })).token,
        apiTokens: await listDashboardApiTokens(ctx.context), apiEndpoint: '/api/message (POST)' };
    case 'listApiTokens':
      return { apiTokens: await listDashboardApiTokens(ctx.context) };
    case 'revokeApiToken':
      await revokeDashboardApiToken(ctx.context, payload?.tokenId);
      return { apiTokens: await listDashboardApiTokens(ctx.context), notice: { level: 'info', message: 'API token revoked.' } };
    case 'getProjectBoard':
      return { projectBoard: payload?.taskSavedOnly === true ? readSavedProjectBoard(await resolveWorkspaceProjectPathAsync(payload.projectPath)) : await readProjectBoard(payload?.projectPath) };
    case 'getProjectTaskDetails':
      if (!payload?.taskId) throw new Error('Choose a task first.');
      return { projectTaskDetails: await readProjectTaskDetails(await resolveWorkspaceProjectPathAsync(payload.projectPath), payload.taskId, payload.taskView, payload.taskBefore) };
    case 'saveProjectTask': {
      if (!payload?.task) throw new Error('The task draft is missing.');
      const project = await resolveWorkspaceProjectPathAsync(payload.projectPath);
      await saveProjectTaskWithAttachments(project, payload.task);
      return { projectBoard: readSavedProjectBoard(project), notice: { level: 'info', message: payload.task.hidden === true ? 'Session hidden from boards.' : payload.task.hidden === false ? 'Session restored to boards.' : 'Task saved.' } };
    }
    case 'addProjectComment': {
      if (!payload?.comment) throw new Error('The comment is missing.');
      const project = await resolveWorkspaceProjectPathAsync(payload.projectPath);
      await addProjectCommentWithAttachments(project, payload.comment);
      return { projectBoard: readSavedProjectBoard(project), notice: { level: 'info', message: 'Comment added.' } };
    }
    case 'moveProjectTask': {
      ensureCliIntegrationEnabled();
      const project = await resolveWorkspaceProjectPathAsync(payload?.projectPath);
      if (!payload?.taskId) throw new Error('Choose a task to move.');
      return { projectBoard: await moveProjectTask(project, payload.taskId, payload.taskRevision, payload.taskStage, payload.taskToBoard === true), notice: { level: 'info', message: 'Task move confirmed.' } };
    }
    case 'startProjectSubtask':
    case 'startProjectTask': {
      ensureCliIntegrationEnabled();
      const project = await resolveWorkspaceProjectPathAsync(payload?.projectPath);
      if (!payload?.taskId) throw new Error('Choose a custom task before starting a session.');
      if (action === 'startProjectSubtask' && typeof payload.text !== 'string') throw new Error('Write an initial prompt for this session subtask.');
      return { projectBoard: await startProjectTaskSession(project, payload.taskId, payload.taskRevision, action === 'startProjectSubtask' ? payload.text : undefined), notice: { level: 'info', message: action === 'startProjectSubtask' ? 'Subtask session created and started.' : 'Task started in Codex.' } };
    }
    case 'shareProjectBoard':
      return { projectShare: createProjectShare(await resolveWorkspaceProjectPathAsync(payload?.projectPath), payload?.sharePermissions, payload?.shareDays) };
    case 'resetProjectTaskStart': {
      if (!payload?.taskId || payload.confirmed !== true) throw new Error('Review the session list and confirm that the previous start was not accepted before allowing a retry.');
      const project = await resolveWorkspaceProjectPathAsync(payload.projectPath);
      resetProjectTaskStart(project, payload.taskId, payload.taskRevision);
      return { projectBoard: readSavedProjectBoard(project), notice: { level: 'info', message: 'Task startup was reset after your review.' } };
    }
    case 'revokeProjectShares':
      revokeProjectShares(await resolveWorkspaceProjectPathAsync(payload?.projectPath));
      return { notice: { level: 'info', message: 'All public links for this project were revoked.' } };
    case "setPrivacyMode": {
      if (typeof payload?.privacyMode !== "boolean") {
        throw new Error("The privacy mode request is invalid. Refresh the dashboard and try again.");
      }
      if (
        !(await handleDashboardSettingUpdate("privacyMode", payload.privacyMode, vscode.ConfigurationTarget.Global))
      ) {
        throw new Error("Privacy mode could not be updated. Try again.");
      }
      ctx.schedulePublishState();
      return {
        notice: {
          level: "info" as const,
          message: payload.privacyMode
            ? "Privacy mode enabled across Codex Manager."
            : "Privacy mode disabled across Codex Manager."
        }
      };
    }
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
      return { batchResult: await vscode.commands.executeCommand<DashboardBatchResult>("codexManager.refreshAllQuotas") };
    case "shareTokens":
      return handleShareTokens(ctx.repo, payload, translate);
    case "viewLogs": {
      const logs = await exportPersistentLogs();
      return { logDownload: { filename: logs.filename, text: logs.text }, notice: { level: "info" as const, message: "Logs refreshed." } };
    }
    case "clearLogs":
      await clearPersistentLogs();
      return { notice: { level: "info" as const, message: "System log cleared." } };
    case "previewMaintenance":
      return { maintenancePreview: await previewMaintenance(payload?.maintenanceTool) };
    case "inspectMaintenanceStorage":
      return { maintenanceReport: await inspectMaintenanceStorage(payload?.maintenanceInspection) };
    case "runMaintenance":
      return { maintenanceJob: runMaintenance(payload?.maintenanceToken ?? "", payload?.confirmed === true, payload?.maintenanceIds, payload?.maintenanceOperation), notice: { level: "info" as const, message: "Operation started. Progress is shown in Tools." } };
    case "getMaintenancePage":
      return { maintenancePage: readMaintenancePage(payload?.maintenanceToken ?? "", payload?.maintenanceQuery, payload?.maintenanceOffset) };
    case "getMaintenanceStatus":
    case "cancelMaintenance":
      return { maintenanceJob: getMaintenanceJob(payload?.maintenanceJobId ?? "", action === "cancelMaintenance", payload?.maintenanceToken) };
    case "downloadLogs": {
      const logs = await exportPersistentLogs();
      const notice = { level: logs.limited ? "warning" as const : "info" as const,
        message: logs.limited ? "Recent logs prepared; older records exceeded the download limit." : "Logs prepared for download." };
      if (ctx.hostKind === "browser") return { logDownload: { filename: logs.filename, text: logs.text }, notice };
      const saved = await handleDownloadJsonFile({ filename: logs.filename, text: logs.text });
      return saved?.notice ? saved : { notice: { ...notice, message: logs.limited ? "Recent logs saved; older records exceeded the download limit." : "Logs saved." } };
    }
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
        if (
          !(await ctx.configureEncryptedSync(
            payload.passphrase,
            payload.passphraseConfirmation,
            payload.currentPassphrase
          ))
        ) {
          throw new Error("Encrypted sync was not configured. Check the password and try again.");
        }
        ctx.schedulePublishState();
        return { notice: { level: "info" as const, message: "Shared sync password saved." } };
      }
      if (payload?.passphrase && payload.passphraseConfirmation) {
        if (
          !(await vscode.commands.executeCommand<boolean>("codexManager.configureEncryptedSync", {
            passphrase: payload.passphrase,
            confirmation: payload.passphraseConfirmation,
            currentPassphrase: payload.currentPassphrase,
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
              ? "Shared sync password saved. Initial sync is continuing in the background."
              : "Shared sync password saved."
          }
        };
      }
      // Passwords must be collected by the dashboard modal. Never fall back
      // to a VS Code showInputBox, which is easy to miss and breaks the
      // shared in-screen password flow.
      ctx.schedulePublishState();
      throw new Error("Enter and confirm the shared password in the dashboard.");
    case "syncNow":
      if (ctx.hostKind === "browser" && ctx.syncEncryptedAccounts) {
        if (!(await ctx.syncEncryptedAccounts())) {
          throw new Error(
            getEncryptedSyncSettingsFailure() ??
              "Cross-PC claim sync did not complete. Connect an authenticated peer WebSocket or sign in to VS Code Settings Sync, then try again."
          );
        }
        ctx.schedulePublishState();
        return { notice: { level: "info" as const, message: "Cross-PC claim sync completed." } };
      }
      if ((await vscode.commands.executeCommand<boolean>("codexManager.syncNow")) !== true) {
        ctx.schedulePublishState();
        throw new Error(
          getEncryptedSyncSettingsFailure() ??
            "Cross-PC claim sync did not complete. Connect an authenticated peer WebSocket or sign in to VS Code Settings Sync, then try again."
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
              ? "Rescue override enabled on this PC. Automation resumed for enabled accounts and quota refresh started; foreign-PC claims are warning-only."
              : "Rescue override disabled. The synchronized registry is enforced again."
          }
        };
      }
      if (
        (await vscode.commands.executeCommand<boolean>(
          "codexManager.setEncryptedSyncRegistryOverride",
          payload.enabled,
          { passphrase: payload.passphrase }
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
      if (ctx.hostKind === "browser") throw new Error("Open links from this browser. Reload the dashboard and try again.");
      return handleOpenExternalUrl(payload);
    case "downloadJsonFile":
      if (ctx.hostKind === "browser") {
        if (!payload?.text) throw new Error("There is no data to download.");
        return { fileDownload: { filename: path.basename(payload.filename?.trim() || "codex-manager-export.json"), text: payload.text },
          notice: { level: "info" as const, message: "Download prepared for this browser." } };
      }
      return handleDownloadJsonFile(payload);
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
    case "unloadAuth": {
      return runCodexHomeOperation("Sign out", async () => {
      const activeAccount = (await ctx.repo.listAccounts()).find((candidate) => candidate.isActive);
      await unloadAuthFile();
      let releaseWarning: string | undefined;
      if (activeAccount) {
        try {
          // Unloading is also an explicit release on this PC. Use the normal
          // enablement path so encrypted sync publishes the disabled record
          // and another PC can safely claim the session.
          await ctx.repo.setAccountEnabled(activeAccount.id, false);
        } catch (error) {
          releaseWarning = getErrorMessage(error);
        }
      }
      await ctx.repo.syncActiveAccountFromAuthFile();
      await ctx.context.workspaceState.update(getCurrentWindowRuntimeAccountKey(), undefined);
      setCurrentWindowRuntimeAccountId(undefined);
      clearQueuedAccountSwitch();
      ctx.schedulePublishState();
      return {
        notice: {
          level: releaseWarning ? ("warning" as const) : ("info" as const),
          message: releaseWarning
            ? `Codex auth was unloaded, but the account's shared claim could not be released: ${releaseWarning}. Disable it manually and run Sync Now.`
            : activeAccount
              ? "Codex auth unloaded and the account was disabled on this PC. Its sync release is queued; reloading now."
              : "Codex auth unloaded. Reloading; Codex will stay signed out until you log in or switch an account."
        }
      };
          });
    }
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
        await vscode.commands.executeCommand("codexManager.openDetails", account);
      }
      return undefined;
    case "switch":
      let rescueEnabledForSwitch = false;
      if (payload?.passphrase) {
        const enabled =
          ctx.hostKind === "browser"
            ? await ctx.setEncryptedSyncRegistryOverride?.(true, payload.passphrase)
            : await vscode.commands.executeCommand<boolean>("codexManager.setEncryptedSyncRegistryOverride", true, {
                passphrase: payload.passphrase
              });
        if (enabled !== true) {
          ctx.schedulePublishState();
          throw new Error("The claimed account was not switched. Check the shared password and try again.");
        }
        rescueEnabledForSwitch = true;
      }
      if (ctx.hostKind === "browser") {
        if (!account) {
          throw new Error("Choose an account in the browser dashboard, then try again.");
        }
        const currentAccount = await ctx.repo.getAccount(account.id);
        if (!currentAccount) {
          throw new Error("That account no longer exists. Refresh the dashboard and try again.");
        }
        if (currentAccount.isActive) {
          await ctx.repo.recordManualAccountSelection?.(currentAccount.id);
          const held = await ctx.repo.isAutoSwitchManuallyHeld?.(currentAccount.id);
          const reloadNeeded = deferWindowReloadForAccount(currentAccount.id);
          const reloadScheduled = reloadNeeded && getCodexManagerConfiguration().get<boolean>("autoSwitchReloadWindowEnabled", false);
          ctx.schedulePublishState();
          return {
            notice: {
              level: "info" as const,
              message: `${currentAccount.email} is already active.${held ? " Auto Switch is paused. Select an account with available quota to resume." : ""}${reloadNeeded ? reloadScheduled ? " Reloading Codex…" : " Reload VS Code to apply this account." : ""}`
            },
            reloadScheduled
          };
        }
        await ctx.repo.switchAccount(currentAccount.id, {
          forceTokenRefresh:
            currentAccount.tokenRefreshEnabled === true
        });
        const held = await ctx.repo.isAutoSwitchManuallyHeld?.(currentAccount.id);
        clearTokenAutomationError(currentAccount.id);
        void handleCodexAppRestartPreference({ allowManualPrompt: false });
        const reloadRequired = deferWindowReloadForAccount(currentAccount.id);
        const reloadScheduled = reloadRequired && getCodexManagerConfiguration().get<boolean>("autoSwitchReloadWindowEnabled", false);
        ctx.schedulePublishState();
        return {
          notice: {
            level: "info" as const,
            message: `Switched to ${currentAccount.email}.${held ? " Auto Switch is paused. Select an account with available quota to resume." : ""}${rescueEnabledForSwitch && !held ? " Rescue override is enabled on this PC; automation resumed for enabled accounts." : ""}${reloadRequired ? reloadScheduled ? " Reloading Codex…" : " Reload VS Code to apply this account." : ""}`
          },
          reloadScheduled
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
        if ((result?.status === "switched" || result?.status === "already-active") && result.account) {
          const reloadRequired =
            result.reloadNeeded && !result.reloaded ? deferWindowReloadForAccount(result.account.id) : false;
          const reloadScheduled = reloadRequired && getCodexManagerConfiguration().get<boolean>("autoSwitchReloadWindowEnabled", false);
          const held = await ctx.repo.isAutoSwitchManuallyHeld?.(result.account.id);
          return {
            notice: {
              level: "info" as const,
              message: `${result.status === "already-active" ? `${result.account.email} is already active.` : `Switched to ${result.account.email}.`}${held ? " Auto Switch is paused. Select an account with available quota to resume." : ""}${rescueEnabledForSwitch && !held ? " Rescue override is enabled; automation resumed for enabled accounts." : ""}${reloadRequired ? reloadScheduled ? " Reloading Codex…" : " Reload VS Code to apply this account." : ""}`
            },
            reloadScheduled
          };
        }
      }
      return undefined;
    case "refresh":
      if (account) {
        const result = await vscode.commands.executeCommand<QuotaRefreshResult>("codexManager.refreshQuota", account);
        if (result?.error || result?.skipped) throw new Error(result.error?.message ?? "Quota refresh was skipped.");
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
        return {
          notice: {
            level: "info" as const,
            message: enabled
              ? `${account.email} was enabled on this PC. Sync is queued.`
              : account.isActive
                ? `${account.email} was disabled on this PC. It stays loaded until you manually choose Unload. Sync is queued.`
                : `${account.email} was disabled on this PC. Sync is queued.`
          }
        };
      }
      return undefined;
    case "setAccountQueuePriority":
      if (account) {
        await ctx.repo.setAccountQueuePriority(account.id, payload?.queuePriority === true);
        ctx.schedulePublishState();
      }
      return undefined;
    case 'manageAccountTag': {
      const tag = normalizeAccountTags([payload?.tagName])[0];
      const operation = payload?.tagOperation;
      if (!tag || !['rename', 'remove', 'enable', 'disable'].includes(operation ?? '') || payload?.confirmed !== true) throw new Error('Review a tag and confirm its action first.');
      const replacement = operation === 'rename' ? normalizeAccountTags([payload?.tagReplacement])[0] : undefined;
      if (operation === 'rename' && !replacement) throw new Error('Enter a replacement tag.');
      const reviewed = payload?.accountIds;
      if (!Array.isArray(reviewed) || !reviewed.length || reviewed.length > 1000 || reviewed.some(id => typeof id !== 'string' || !id || id.length > 256) || new Set(reviewed).size !== reviewed.length) throw new Error('Review between 1 and 1,000 tagged accounts.');
      const matches = (account: { tags?: string[] }) => (account.tags ?? []).some(value => value.toLowerCase() === tag.toLowerCase());
      const accounts = (await ctx.repo.listAccounts()).filter(matches);
      if (JSON.stringify(accounts.map(account => account.id).sort()) !== JSON.stringify([...reviewed].sort())) throw new Error('Tagged accounts changed. Refresh tags and review the action again.');
      const changed: NonNullable<import('../../domain/dashboard/types').DashboardActionResultPayload['tagResult']>['accounts'] = [], errors: string[] = [];
      let failedCount = 0;
      const deadline = Date.now() + 15_000;
      for (const account of accounts) {
        if (Date.now() >= deadline) { failedCount = accounts.length - changed.length; if (errors.length < 20) errors.push('The action reached its time limit. Remaining accounts were kept unchanged.'); break; }
        try {
          const updated = await waitWithin((async () => {
            if (operation === 'enable' || operation === 'disable') {
              const current = await ctx.repo.getAccount(account.id);
              if (!current || !matches(current)) throw new Error('Tag membership changed; this account was kept unchanged.');
              if (operation === 'enable') {
                const tokens = await ctx.repo.getTokens(account.id);
                const health = resolveAccountHealth(current, tokens, getTokenAutomationSnapshot());
                if (!tokens?.accessToken?.trim() || !tokens.idToken?.trim() || health.kind === 'reauthorize' || health.kind === 'disabled') throw new Error('An account needs valid credentials before it can be enabled.');
              }
              return ctx.repo.setAccountEnabled(account.id, operation === 'enable');
            }
            const tags = (account.tags ?? []).flatMap(value => value.toLowerCase() === tag.toLowerCase() ? replacement ? [replacement] : [] : [value]);
            return ctx.repo.setAccountTags(account.id, tags, account.tags ?? []);
          })(), 5_000, 'An account update was not confirmed. Check the accounts before retrying.');
          changed.push({ accountId: updated.id, tags: updated.tags ?? [], updatedAt: updated.updatedAt, ...(operation === 'enable' || operation === 'disable' ? { enabled: updated.enabled !== false } : {}) });
        } catch (error) {
          failedCount++; const reason = toFailureMessage(error);
          if (errors.length < 20) errors.push(reason.slice(0, 300));
          if (reason.includes('update was not confirmed')) { failedCount = accounts.length - changed.length; break; }
        }
      }
      ctx.schedulePublishState();
      const message = `${changed.length} account${changed.length === 1 ? '' : 's'} updated${failedCount ? `; ${failedCount} failed or unconfirmed` : ''}.${operation === 'disable' && accounts.some(account => account.isActive) ? ' The current account stays loaded until you unload it.' : ''}`;
      return { tagResult: { successCount: changed.length, failedCount, errors, accounts: changed }, notice: { level: failedCount ? 'warning' : 'info', message } };
    }
    case 'setAccountTags': {
      if (!payload?.tags) throw new Error('Enter tags as a list of text labels.');
      const updated = await ctx.repo.setAccountTags(account!.id, payload.tags, payload.expectedTags);
      ctx.schedulePublishState();
      return { accountTags: { accountId: updated.id, tags: updated.tags ?? [], updatedAt: updated.updatedAt }, notice: { level: 'info', message: updated.tags?.length ? 'Account tags saved.' : 'Account tags removed.' } };
    }
    case "setAccountTokenRefreshEnabled":
      if (account) {
        await ctx.repo.setAccountTokenRefreshEnabled(account.id, payload?.tokenRefreshEnabled !== false);
        ctx.schedulePublishState();
      }
      return undefined;
    case 'setAccountAutoResetAllowed':
      if (!account || typeof payload?.autoResetAllowed !== 'boolean') throw new Error('Choose an account and a valid Auto Reset option.');
      await ctx.repo.setAccountAutoResetAllowed(account.id, payload.autoResetAllowed);
      ctx.schedulePublishState();
      return { notice: { level: 'info', message: payload.autoResetAllowed ? 'Auto Reset allowed for this account after all eligible accounts exhaust weekly quota. Auto Switch must be enabled.' : 'Account Auto Reset override disabled. The global Auto Reset setting still applies.' } };
    case "refreshToken":
      return handleRefreshToken(ctx.repo, account, ctx.schedulePublishState, ctx.resolveLanguage());
    case "getResetCredits":
      return handleGetResetCredits(ctx.repo, account);
    case "getDailyUsage":
      if (payload?.automatic === true && !getCodexManagerConfiguration().get<boolean>("dailyTokenUsageEnabled", true)) {
        return { notice: { level: "warning", message: "Automatic token history is disabled. Saved history remains available." } };
      }
      return handleGetDailyUsage(ctx.context, ctx.repo, account, payload?.days, payload?.automatic !== true);
    case "clearUsageHistory":
      await saveDashboardUsageHistory(ctx.context, []);
      ctx.schedulePublishState();
      return { notice: { level: "info", message: "Quota graph history cleared. New snapshots continue recording." } };
    case "getUsageGraph":
      return { usageGraph: queryDashboardUsage(ctx.context, payload?.usageGraph) };
    case "openNewCodexWebview":
      return handleOpenNewCodexWebview();
    case "resumeCodexSessions":
      return handleResumeCodexSessions(ctx.context, payload?.sessionId);
    case "startCodexCliSession":
      return handleStartCodexCliSession(payload);
    case "listCodexCliSessions":
      return handleListCodexCliSessions(ctx.context, ctx.getRemoteCliSessions, payload?.automatic !== true);
    case "getCodexSubAgentMessages": {
      ensureCliIntegrationEnabled();
      if (!payload?.sessionId) throw new Error("Choose a sub-agent from the parent session first.");
      const agent = await readCodexCliSessionSummary(payload.sessionId);
      if (!agent?.subAgent) throw new Error("This sub-agent was not found. Refresh the parent session and try again.");
      return { cliSubAgentSession: agent, cliSubAgentMessages: await readCodexCliSessionMessages(agent.id) };
    }
    case "getCodexCliSessionMessages":
      return handleGetCodexCliSessionMessages(payload?.sessionId, payload?.projectPath);
    case "sendCodexCliSessionMessage":
      return handleSendCodexCliSessionMessage(payload);
    case "steerCodexCliSessionTurn":
      return handleSteerCodexCliSessionTurn(payload);
    case "cancelCodexCliSessionTurn":
      return handleCancelCodexCliSessionTurn(payload?.sessionId);
    case "respondCodexServerRequest":
      if (!payload?.codexRequestId || !payload.codexDecision) throw new Error("Choose a Codex prompt response before continuing.");
      respondCodexAppServerPrompt(payload.codexRequestId, payload.codexDecision, payload.codexAnswers);
      return { notice: { level: "info" as const, message: payload.codexDecision === "approve" ? "Response sent to Codex." : "Codex request declined." } };
    case "openCodexCliSession":
      return handleOpenCodexCliSession(payload?.sessionId, ctx.hostKind === "browser" && payload?.openInVsCode !== true);
    case "renameCodexCliSession":
      return handleRenameCodexCliSession(payload?.sessionId, payload?.text);
    case "setCodexSessionGoalStatus":
      return handleSetCodexSessionGoalStatus(ctx.context, payload);
    case "setCodexSessionAutoResume":
      return handleSetCodexSessionAutoResume(payload);
    case "setCodexSessionQueue":
      return handleSetCodexSessionQueue(payload);
    case "forkCodexCliSession":
      return handleForkCodexCliSession(payload?.sessionId);
    case "archiveCodexCliSession":
      return handleArchiveCodexCliSession(payload?.sessionId);
    case "unarchiveCodexCliSession":
      return handleUnarchiveCodexCliSession(payload?.sessionId);
    case "deleteCodexCliSession":
      return handleDeleteCodexCliSession(payload);
    case "getWorkspaceEnvironment":
      return { workspaceEnvironment: await readWorkspaceEnvironment(payload?.projectPath, payload?.includeBranchDiff === true, payload?.gitHistory) };
    case "listWorkspaceFiles":
      return { workspaceFiles: await listWorkspaceFiles(payload?.projectPath) };
    case "readWorkspaceFile":
      if (payload?.filePath?.startsWith('@manager-attachment/')) {
        if (!payload.taskId) throw new Error('Choose the task that owns this attachment.');
        return { workspaceFile: await readProjectAttachment(await resolveWorkspaceProjectPathAsync(payload.projectPath), payload.taskId, payload.filePath) };
      }
      return { workspaceFile: await readWorkspaceFile(payload?.projectPath, payload?.filePath) };
    case "saveWorkspaceFile":
      return {
        workspaceFile: await saveWorkspaceFile(
          payload?.projectPath,
          payload?.filePath,
          payload?.fileContent,
          payload?.fileRevision
        ),
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
      return { workspaceTerminals: listWorkspaceTerminals(), ...readWorkspaceTerminalActivity() };
    case "createWorkspaceTerminal":
      return {
        workspaceTerminal: await createWorkspaceTerminal(
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
        workspaceTerminals: listWorkspaceTerminals().map(terminal => ({ ...terminal, isActive: terminal.id === terminalResult.terminalId })),
        notice: terminalResult.status === "untracked"
          ? { level: "warning" as const, message: "Command sent to VS Code, but this shell does not expose live output. View the terminal tab for status." }
          : { level: "info" as const, message: terminalResult.status === "running" ? "Terminal command started; output is streaming live." : "Terminal command completed." }
      };
    }
    case "cancelWorkspaceTerminalCommand":
      if (!cancelWorkspaceTerminalCommand(payload?.terminalId)) {
        throw new Error("There is no running command to stop in this terminal.");
      }
      return { notice: { level: "warning" as const, message: "Stopping the terminal command…" } };
    case "closeWorkspaceTerminal":
      if (!closeWorkspaceTerminal(payload?.terminalId)) throw new Error("That VS Code terminal is no longer open. Refresh the terminal list.");
      return { workspaceTerminals: listWorkspaceTerminals().filter(terminal => terminal.id !== payload?.terminalId), notice: { level: "info" as const, message: "VS Code terminal closed." } };
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
    // Token refresh is an explicit recovery action; bypass the short-lived
    // repository cache so a rotation performed by another window cannot
    // replay an already-invalid refresh token.
    const tokens = await repo.getTokens(account.id, { bypassCache: true });
    if (!tokens?.refreshToken?.trim()) {
      throw new Error("No refresh token is available. Reauthorize this account.");
    }

    await repo.refreshAccountTokens(account.id, { force: true });
    markTokenAutomationRefreshSuccess(account.id);
    schedulePublishState();

    const zh = lang === "zh" || lang === "zh-hant";
    if (!shouldSuppressDashboardNotifications()) void vscode.window.showInformationMessage(
      zh ? `${account.email} 的令牌已刷新。` : `Token refreshed for ${account.email}.`
    );
    return { notice: { level: 'info' as const, message: zh ? '令牌已刷新。' : 'Account token refreshed.' } };
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
        key !== "persistentLoggingEnabled" &&
        key !== "persistentLogRetentionDays" &&
        key !== "persistentLogLevel" &&
        key !== "encryptedSyncEnabled" &&
        key !== "encryptedSyncClaimAllAccountsEnabled" &&
        key !== "encryptedSyncVsCodeHeartbeatMinutes" &&
        key !== "fullCrossPcAccountSyncEnabled" &&
        key !== "crossWindowAccountModeEnabled" &&
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

async function handleDownloadJsonFile(payload: DashboardActionPayload | undefined) {
  const text = payload?.text ?? "";
  const defaultName = payload?.filename?.trim() ?? "codex-manager-share.json";
  if (!text) {
    throw new Error("There is no data to save.");
  }

  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(homedir(), defaultName)),
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
    const attemptedCount = Array.isArray(accountInput) ? accountInput.length : 1;
    const importedCount = "successCount" in result ? result.successCount : result.restoredCount;
    if (importedCount === 0) {
      throw new Error(
        "failures" in result && result.failures[0]
          ? `No accounts were imported. First error: ${result.failures[0].message}`
          : attemptedCount === 0
            ? "The JSON file contains no accounts to import."
            : "No accounts were imported. Check that the file contains valid account tokens."
      );
    }
    if (backup && payload?.recoveryMode === true) {
      await applyBackupSettings(backup.settings);
      appendImportedDebugLogs(backup.logs);
      if (backup.activeAccountId && (await repo.getAccount(backup.activeAccountId))) {
        await repo.switchAccount(backup.activeAccountId);
      }
    }
    schedulePublishState();
    const response = toImportActionPayload(result);
    if ("failedCount" in result && result.failedCount > 0) {
      const warning = `Imported ${result.successCount} account${result.successCount === 1 ? "" : "s"}; ${result.failedCount} failed. First error: ${result.failures[0]?.message ?? "unknown error"}`;
      response.notice = { level: "warning", message: warning };
      void vscode.window.showWarningMessage(warning);
    } else {
      void vscode.window.showInformationMessage(
        translate(payload?.recoveryMode ? "message.restoreFromSharedSuccess" : "message.importSharedJsonSuccess", {
          count: importedCount
        })
      );
    }
    return response;
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
  const importPreview = await repo.previewSharedAccountsImport(
    backup ? backup.accounts : (parsed as Exclude<ReturnType<typeof parseSharedJsonInput>, CodexManagerBackup>)
  );
  return {
    importPreview: {
      ...importPreview,
      backupSettingsAvailable: Boolean(backup),
      restoreSettings: Boolean(backup && payload?.recoveryMode === true),
      activeAccountAvailable: Boolean(backup?.activeAccountId),
      restoreActiveAccount: Boolean(backup?.activeAccountId && payload?.recoveryMode === true)
    }
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
    "autoRefreshMinutes",
    "autoRefreshCurrentMinutes",
    "usageHistoryRetentionDays",
    "tokenHistoryRetentionDays",
    "dailyTokenUsageEnabled",
    "dailyTokenUsageIntervalMinutes",
    "autoSwitchEnabled",
    "autoSwitchWaitForSessionsEnabled",
    "autoSwitchReloadWindowEnabled",
    "autoResumeEnabled",
    "crossWindowAccountModeEnabled",
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

async function handleAutoSwitchLock(
  payload: DashboardActionPayload | undefined,
  account: CodexManagerAccountRecord | undefined,
  schedulePublishState: () => void
) {
  const lockAccountId = account?.id ?? payload?.accountIds?.[0];
  const lockMinutes = typeof payload?.lockMinutes === "number" ? payload.lockMinutes : Number.NaN;
  if (!lockAccountId) {
    throw new Error("This action requires an account. Refresh the dashboard and try again.");
  }

  if (!Number.isFinite(lockMinutes) || !Number.isInteger(lockMinutes) || lockMinutes < 0 || lockMinutes > 120) {
    throw new Error("Choose an unlock action or a whole lock duration from 1 to 120 minutes.");
  }

  await updateAutoSwitchLock(lockAccountId, lockMinutes);
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
  const batchResult = await runAccountBatch(repo, payload?.accountIds ?? [], async id => {
        const result = await refreshSingleQuota(repo, { refresh() {} }, id, {
          announce: false, forceRefresh: true, refreshView: false, warnQuota: false
        });
        if (result.error || result.skipped) throw new Error(result.error?.message ?? "Quota refresh was skipped.");
  }, { kind: "batch_refresh", onComplete: schedulePublishState });
  const success = batchResult.successCount;
  const failed = batchResult.failedCount;
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
  return { batchResult };
}

async function handleBatchResync(
  repo: AccountsRepository,
  schedulePublishState: () => void,
  payload: DashboardActionPayload | undefined,
  translate: ReturnType<typeof t>
) {
  const batchResult = await runAccountBatch(repo, payload?.accountIds ?? [], async id => {
        await resyncAccountInfo(repo, id);
  }, { kind: "batch_resync", onComplete: schedulePublishState });
  const success = batchResult.successCount;
  const failed = batchResult.failedCount;
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
  return { batchResult };
}

async function resyncAccountInfo(repo: AccountsRepository, accountId: string): Promise<void> {
  await repo.refreshAccountProfileMetadata(accountId);
  const result = await refreshSingleQuota(repo, { refresh() {} }, accountId, {
    announce: false,
    awaitSubscriptionRefresh: true,
    forceRefresh: true,
    refreshView: false,
    warnQuota: false
  });
  if (result.error || result.skipped) throw new Error(result.error?.message ?? "Quota refresh was skipped.");
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
      const tokens = await repo.getTokens(account.id);
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
  if (browserHost && payload?.confirmed !== true) {
    throw new Error("Confirm the reload in the browser dashboard, then try again.");
  }
  if (payload?.confirmed === true || payload?.forceReload || !account) {
    return {
      reloadScheduled: true,
      notice: { level: "info" as const, message: "Reloading VS Code…" }
    };
  }
  const reloaded = await promptWindowReloadForAccount(account);
  return reloaded
    ? { notice: { level: "info" as const, message: "Reloading VS Code…" } }
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
  const snapshot = await fetchResetCredits(
    tokens.accessToken,
    accountId,
    account.quotaSummary?.resetCreditsExcludedIds ?? []
  );
  return { resetCredits: snapshot };
}

async function handleGetDailyUsage(
  context: vscode.ExtensionContext,
  repo: AccountsRepository,
  account: Awaited<ReturnType<AccountsRepository["getAccount"]>>,
  requestedDays: number | undefined,
  manual = false
) {
  if (!account) {
    throw new Error("Account not found");
  }
  const days = Math.min(30, Math.max(1, Math.round(typeof requestedDays === "number" && Number.isFinite(requestedDays) ? requestedDays : 30)));
  const entry = await loadDailyTokenUsage(context, account.id, signal => fetchAccountDailyUsage(repo, account, days, signal), { manual, accountLabel: account.email });
  return { dailyUsage: entry.usage, dailyUsageFetchedAt: entry.fetchedAt };
}

function ensureCliIntegrationEnabled(): void {
  if (!getCodexManagerConfiguration().get<boolean>("cliIntegrationEnabled", false)) {
    throw new Error("Session Integration is disabled. Enable it in Settings before opening sessions.");
  }
}

/** Keep a just-created/just-updated session visible even when Codex has not
 * flushed its session index to disk by the time the action response is read. */
export function upsertCliSessionInList(
  sessions: DashboardCliSessionSummary[],
  session: DashboardCliSessionSummary
): DashboardCliSessionSummary[] {
  const withoutSession = sessions.filter((candidate) => candidate.id !== session.id);
  return [session, ...withoutSession].sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
  );
}

async function handleListCodexCliSessions(
  context: vscode.ExtensionContext,
  getRemoteCliSessions?: () => DashboardCliSessionSummary[],
  force = false
) {
  ensureCliIntegrationEnabled();
  const [localSessions, cliComposerConfig] = await Promise.all([readCodexCliSessions(undefined, undefined, force), readCodexCliComposerConfig()]);
  const remoteSessions = getRemoteCliSessions?.() ?? [];
  const stabilizedLocalSessions = await stabilizeSessionProjectPaths(
    context,
    withCodexSessionRecovery(context, localSessions),
    cliComposerConfig.projects
  );
  return {
    cliSessions: [...stabilizedLocalSessions, ...remoteSessions].sort((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
    ),
    cliComposerConfig,
    notice: getCodexSessionReadNotice(localSessions)
  };
}

async function handleStartCodexCliSession(
  payload: DashboardActionPayload | undefined
) {
  ensureCliIntegrationEnabled();
  if (!(await isCodexCliAvailable())) {
    throw new Error("Codex CLI is not available on this PC. Install it or set CODEX_CLI_PATH, then try again.");
  }
  const sessionId = await startCodexCliSession({
    text: payload?.text ?? "",
    attachments: payload?.attachments,
    model: payload?.model,
    reasoningEffort: payload?.reasoningEffort,
    sandboxMode: payload?.sandboxMode,
    projectPath: payload?.projectPath
  });
  // Creation already has the accepted thread identity. Do not hold its terminal
  // feedback behind unrelated session-list and model-catalog round trips.
  const existingSession = readNewCodexCliSessionSummary(sessionId) ?? await readCodexCliSessionSummary(sessionId);
  const visibleSession = existingSession ? {
    ...existingSession,
    projectPath: existingSession.projectPath ?? payload?.projectPath?.trim()
  } : {
    id: sessionId,
    title: "New Codex chat",
    status: "idle" as const,
    archived: false,
    ...(payload?.projectPath?.trim() ? { projectPath: payload.projectPath.trim() } : {})
  };
  return {
    cliSession: visibleSession,
    cliSessionMessages: payload?.text?.trim() ? await readCodexCliSessionMessages(sessionId).catch((error: unknown) => [
      { id: `initial-${sessionId}`, kind: "message" as const, role: "user" as const, text: payload.text! },
      { id: `initial-error-${sessionId}`, kind: "error" as const, status: "failed" as const, text: error instanceof Error ? error.message : String(error) }
    ]) : [],
    notice: { level: "info" as const, message: "New Codex chat is ready." }
  };
}

async function handleGetCodexCliSessionMessages(sessionId: string | undefined, requestedProjectPath?: string) {
  ensureCliIntegrationEnabled();
  if (!sessionId) throw new Error("Choose a session first.");
  const cliSession = await readCodexCliSessionSummary(sessionId);
  if (!cliSession) throw new Error("This Codex session was not found. Refresh the session list and try again.");
  if (
    requestedProjectPath?.trim() &&
    cliSession.projectPath?.trim() &&
    (await canonicalProjectPath(requestedProjectPath)) !== (await canonicalProjectPath(cliSession.projectPath))
  ) {
    throw new Error("This session belongs to a different project. Open it from that project’s workspace.");
  }
  if (cliSession.archived) throw new Error("Archived sessions cannot be opened. Restore the session first.");
  const cliSessionMessages = await readCodexCliSessionMessages(sessionId);
  return { cliSession, cliSessionMessages, cliSessionLive: getCodexSessionLiveState(sessionId), notice: getCodexSessionReadNotice([cliSession]) };
}

async function canonicalProjectPath(projectPath: string): Promise<string> {
  const resolved = path.resolve(normalizeNativePath(projectPath.trim()));
  const canonical = await realpath(resolved).catch(() => resolved);
  return process.platform === "win32" ? canonical.toLocaleLowerCase("en-US") : canonical;
}

async function handleSendCodexCliSessionMessage(payload: DashboardActionPayload | undefined) {
  ensureCliIntegrationEnabled();
  if (!payload?.sessionId) throw new Error("Choose a session first.");
  const currentSession = await ensureCliSessionIsActive(payload.sessionId);
  if (currentSession.status === "running" || currentSession.locked) {
    throw new Error(`This session has an active writer${currentSession.runningBy ? ` in ${currentSession.runningBy}` : ""}. Wait for the current turn to finish before sending.`);
  }
  if (
    payload.projectPath?.trim() && currentSession.projectPath?.trim() &&
    await canonicalProjectPath(payload.projectPath) !== await canonicalProjectPath(currentSession.projectPath)
  ) throw new Error("This session belongs to a different project. Open it from that project’s workspace.");
  const sessionProjectPath = currentSession.projectPath ?? payload.projectPath;
  await sendCodexCliSessionMessage({
    sessionId: payload.sessionId,
    text: payload.text ?? "",
    attachments: payload.attachments,
    model: payload.model,
    reasoningEffort: payload.reasoningEffort,
    sandboxMode: payload.sandboxMode,
    projectPath: sessionProjectPath,
    clearManualStop: true
  });
  let cliSessionMessages;
  let notice: DashboardNotice = { level: "info", message: "Codex completed the turn." };
  try {
    cliSessionMessages = await waitWithin(readCodexCliSessionMessages(payload.sessionId), 500, "Conversation history is still loading");
  } catch (error) {
    notice = { level: "warning", message: `Codex completed the turn, but conversation history could not refresh: ${toFailureMessage(error)}. Refresh the chat; do not resend the message.` };
  }
  const visibleSession = {
    ...currentSession,
    status: "idle" as const,
    locked: false,
    canStop: false,
    ...(sessionProjectPath?.trim() ? { projectPath: sessionProjectPath.trim() } : {})
  };
  return {
    cliSession: visibleSession,
    cliSessionMessages,
    cliSessionLive: getCodexSessionLiveState(payload.sessionId),
    notice
  };
}

async function handleSteerCodexCliSessionTurn(payload: DashboardActionPayload | undefined) {
  ensureCliIntegrationEnabled();
  if (!payload?.sessionId) throw new Error("Choose a session first.");
  if (typeof payload.expectedTurnId !== "string" || !payload.expectedTurnId.trim() || payload.expectedTurnId.length > 256)
    throw new Error("The active turn changed. Refresh this session before sending a follow-up.");
  const session = await ensureCliSessionIsActive(payload.sessionId);
  if (payload.projectPath?.trim() && session.projectPath?.trim() &&
    await canonicalProjectPath(payload.projectPath) !== await canonicalProjectPath(session.projectPath))
    throw new Error("This session belongs to a different project. Open it from that project’s workspace.");
  await steerCodexCliSessionTurn({ sessionId: payload.sessionId, expectedTurnId: payload.expectedTurnId,
    text: payload.text ?? "", attachments: payload.attachments });
  return { cliSessionLive: getCodexSessionLiveState(payload.sessionId),
    notice: { level: "info" as const, message: "Follow-up sent to the active Codex turn." } };
}

async function handleCancelCodexCliSessionTurn(sessionId: string | undefined) {
  ensureCliIntegrationEnabled();
  if (!sessionId) throw new Error("Choose a session first.");
  if (!(await cancelCodexCliSessionTurn(sessionId))) {
    throw new Error("There is no dashboard-started Codex turn to stop in this session.");
  }
  return {
    notice: {
      level: "warning" as const,
      message: "Stop requested. Waiting for Codex to end the turn."
    }
  };
}

async function handleOpenCodexCliSession(sessionId: string | undefined, openInBrowser: boolean) {
  ensureCliIntegrationEnabled();
  if (!sessionId) throw new Error("Choose a session first.");
  const session = await ensureCliSessionIsActive(sessionId);
  if (openInBrowser) {
    return {
      cliSession: session,
      cliSessionMessages: await readCodexCliSessionMessages(sessionId),
      cliSessionLive: getCodexSessionLiveState(sessionId),
      notice: { level: "info" as const, message: "Opened the session in the browser dashboard." }
    };
  }
  await openCodexSessionInVsCode(sessionId, undefined, true);
  return { notice: { level: "info" as const, message: "Opened the session in the Codex extension." } };
}

async function handleOpenNewCodexWebview() {
  ensureCliIntegrationEnabled();
  await openNewCodexWebview();
  return { notice: { level: "info" as const, message: "Opened a new chat in the Codex Webview." } };
}

async function handleResumeCodexSessions(context: vscode.ExtensionContext, sessionId?: string) {
  ensureCliIntegrationEnabled();
  const sessions = sessionId ? [await ensureCliSessionIsActive(sessionId)] :
    filterCliSessionsBySection(withCodexSessionRecovery(context, await readCodexCliSessions(), true), "active")
      .filter(session => session.status === "running" || session.interrupted);
  if (!sessions.length) return { notice: { level: "info" as const, message: "No running or interrupted sessions to reopen." } };
  const deadline = Date.now() + 60_000;
  const failures: string[] = [];
  let opened = 0;
  let continuationPrompts = 0;
  for (const session of sessions) {
    if (session.subAgent || session.parentSessionId || session.archived || session.status === "unknown") { failures.push(session.title); continue; }
    if (Date.now() >= deadline) { failures.push("Remaining sessions timed out"); break; }
    const controller = new AbortController();
    try {
      await waitWithin(openCodexSessionInVsCode(session.id, controller.signal, true), Math.min(45_000, deadline - Date.now()), "Opening the conversation timed out", controller.signal);
      opened++;
      if (await waitWithin(resumeCodexSessionWork(session.id, controller.signal, "user"), Math.min(25_000, Math.max(1, deadline - Date.now())), "Resuming the conversation was not confirmed", controller.signal) === "continued") continuationPrompts++;
    } catch (error) {
      failures.push(`${session.title}: ${toFailureMessage(error)}`);
    } finally { controller.abort(); }
  }
  return { notice: { level: failures.length ? "warning" as const : "info" as const,
    message: `${opened} conversation${opened === 1 ? "" : "s"} opened in VS Code.${continuationPrompts ? ` ${continuationPrompts} continuation prompt${continuationPrompts === 1 ? " was" : "s were"} sent for interrupted non-goal session${continuationPrompts === 1 ? "" : "s"}.` : ""}${failures.length ? ` Some could not open or resume; recovery was kept. ${failures[0]}` : ""}` } };
}

async function handleSetCodexSessionGoalStatus(context: vscode.ExtensionContext, payload?: DashboardActionPayload) {
  ensureCliIntegrationEnabled();
  if (!payload?.sessionId || !["active", "paused"].includes(payload.goalStatus ?? "")) throw new Error("Choose a session and Pause or Resume for its goal.");
  const status = payload.goalStatus!;
  const session = await ensureCliSessionIsActive(payload.sessionId);
  if (session.subAgent || session.parentSessionId || !session.goal || !["active", "paused", "blocked", "usage_limited"].includes(session.goal.status))
    throw new Error("This goal cannot be paused or resumed here. Refresh its current state in Codex.");
  await setCodexSessionGoalStatus(session.id, status);
  let notice = { level: "info" as "info" | "warning", message: status === "paused" ? "Goal paused. The current turn can finish." : "Goal resumed." };
  if (status === "active") {
    const resumed = await handleResumeCodexSessions(context, session.id).catch(error => ({ notice: { level: "warning" as const, message: toFailureMessage(error) } }));
    notice = { level: resumed.notice.level === "warning" ? "warning" : "info", message: `Goal resumed. ${resumed.notice.message}` };
  }
  return { cliSession: { ...session, goal: { ...session.goal, status } }, notice };
}

async function handleSetCodexSessionAutoResume(payload?: DashboardActionPayload) {
  ensureCliIntegrationEnabled();
  if (!payload?.sessionId || typeof payload.autoResumeEnabled !== "boolean") throw new Error("Choose a session and Auto Resume state.");
  const session = await ensureCliSessionIsActive(payload.sessionId);
  setCodexSessionAutoResume(session.id, payload.autoResumeEnabled);
  const enabled = payload.autoResumeEnabled && isCodexSessionAutoResumeEnabled(resolveCodexHome(), session.id);
  return { cliSession: { ...session, autoResumeEnabled: enabled }, notice: { level: "info" as const, message: enabled ? "Auto Resume enabled for this session." : "Auto Resume disabled for this session." } };
}

async function handleSetCodexSessionQueue(payload?: DashboardActionPayload) {
  ensureCliIntegrationEnabled();
  if (!payload?.sessionId || typeof payload.queueEnabled !== "boolean") throw new Error("Choose a session and queue state.");
  const priority = payload.queueEnabled ? payload.sessionQueuePriority ?? 3 : 3;
  const session = await ensureCliSessionIsActive(payload.sessionId);
  setCodexSessionQueue(session.id, payload.queueEnabled, priority);
  return { cliSession: { ...session, queueEnabled: payload.queueEnabled, ...(payload.queueEnabled ? { queuePriority: priority } : { queuePriority: undefined }) }, notice: { level: "info" as const, message: payload.queueEnabled ? `Session queued at priority ${priority}.` : "Session removed from the recovery queue." } };
}

async function handleRenameCodexCliSession(sessionId: string | undefined, name: string | undefined) {
  ensureCliIntegrationEnabled();
  if (!sessionId) throw new Error("Choose a session first.");
  const session = await ensureCliSessionIsActive(sessionId);
  await renameCodexCliSession(sessionId, name ?? "");
  const refreshed = await refreshSessionListAfterMutation();
  return {
    ...refreshed,
    cliSession: { ...(refreshed.cliSessions?.find((candidate) => candidate.id === sessionId) ?? session), title: name!.trim().replace(/\s+/g, ' ') },
    notice: refreshed.notice ?? { level: "info" as const, message: "Session renamed." }
  };
}

async function handleForkCodexCliSession(sessionId: string | undefined) {
  ensureCliIntegrationEnabled();
  if (!sessionId) throw new Error("Choose a session first.");
  const sourceSession = await ensureCliSessionIsActive(sessionId);
  const forkedId = await forkCodexCliSession(sessionId);
  const refreshed = await refreshSessionListAfterMutation();
  const cliSessions = refreshed.cliSessions;
  const forkedSession = cliSessions?.find((session) => session.id === forkedId) ?? {
    id: forkedId,
    title: `${sourceSession.title} (fork)`,
    status: "idle" as const,
    archived: false,
    ...(sourceSession.projectPath ? { projectPath: sourceSession.projectPath } : {})
  };
  return {
    ...(cliSessions ? { cliSessions: cliSessions.some((session) => session.id === forkedId) ? cliSessions : [forkedSession, ...cliSessions] } : {}),
    cliSession: forkedSession,
    notice: refreshed.notice ?? { level: "info" as const, message: "Session fork created." }
  };
}

async function handleArchiveCodexCliSession(sessionId: string | undefined) {
  ensureCliIntegrationEnabled();
  if (!sessionId) throw new Error("Choose a session first.");
  await ensureCliSessionIsActive(sessionId);
  await archiveCodexCliSession(sessionId);
  const refreshed = await refreshSessionListAfterMutation();
  return {
    ...refreshed,
    notice: refreshed.notice ?? { level: "info" as const, message: "Codex session archived." }
  };
}

async function handleUnarchiveCodexCliSession(sessionId: string | undefined) {
  ensureCliIntegrationEnabled();
  if (!sessionId) throw new Error("Choose a session first.");
  const session = await findCliSession(sessionId);
  if (!session.archived) throw new Error("This session is already active.");
  await unarchiveCodexCliSession(sessionId);
  const refreshed = await refreshSessionListAfterMutation();
  return {
    ...refreshed,
    notice: refreshed.notice ?? { level: "info" as const, message: "Codex session restored to Active." }
  };
}

async function handleDeleteCodexCliSession(payload: DashboardActionPayload | undefined) {
  ensureCliIntegrationEnabled();
  if (!payload?.sessionId) throw new Error("Choose a session first.");
  if (payload.confirmed !== true) throw new Error("Confirm permanent deletion, then try again.");
  await deleteCodexCliSession(payload.sessionId);
  const refreshed = await refreshSessionListAfterMutation();
  return {
    ...refreshed,
    notice: refreshed.notice ?? { level: "info" as const, message: "Codex session permanently deleted." }
  };
}

async function refreshSessionListAfterMutation() {
  try {
    return { cliSessions: await waitWithin(readCodexCliSessions(undefined, undefined, true), 500, "Session discovery is still pending") };
  } catch (error) {
    return { notice: { level: "warning" as const, message: `The session action completed, but the session list could not refresh: ${toFailureMessage(error)}. Refresh the list before retrying the action.` } };
  }
}

async function findCliSession(sessionId: string) {
  const session = await readCodexCliSessionSummary(sessionId);
  if (!session) throw new Error("This Codex session was not found. Refresh the session list and try again.");
  return session;
}

async function ensureCliSessionIsActive(sessionId: string) {
  const session = await findCliSession(sessionId);
  if (session.archived) throw new Error("Restore this archived session before opening or continuing it.");
  if (session.status === "unknown") throw new Error(`Session running state could not be verified. Refresh before retrying. ${session.statusError ?? ""}`.trim());
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
    const choice = await vscode.window.showWarningMessage(`${title}

${body}`, { modal: true }, confirmBtn);
    if (choice !== confirmBtn) {
      return { notice: { level: "info" as const, message: "Quota reset cancelled." } };
    }
  }

  let redeemed = false;
  try {
    redeemed = await redeemAccountResetCredit(repo, account.id, undefined, async () => {
    const refreshed = await refreshSingleQuota(repo, { refresh() { schedulePublishState?.(); } }, account.id, {
      announce: false, refreshView: true, warnQuota: false, forceRefresh: true, reconcileResetAttempt: false
    });
    schedulePublishState?.();
    if (refreshed.error || refreshed.skipped) throw new Error("Reset was submitted, but quota refresh failed. Refresh quota before retrying.");
    return refreshed;
    });
  } finally {
    schedulePublishState?.();
  }
  if (!redeemed) throw new Error("Quota reset cancelled because the account or reset credit changed. Refresh quota and try again.");
  const successMessage = isZh ? "速率限制已重置，你可以继续工作了。" : "Rate limit has been reset. You can continue working.";
  if (!browserHost) void vscode.window.showInformationMessage(successMessage);
  return { notice: { level: "info" as const, message: successMessage } };

}
