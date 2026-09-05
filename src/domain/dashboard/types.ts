import type { DashboardLanguage, DashboardLanguageOption } from "../../localization/languages";
import type {
  CodexAnnouncementState,
  CodexDailyUsageBreakdown,
  CodexImportPreviewSummary,
  CodexImportResultSummary,
  CodexIndexHealthSummary
} from "../../core/types";

export type DashboardSettingKey =
  | "dashboardTheme"
  | "privacyMode"
  | "codexAppRestartEnabled"
  | "codexAppRestartMode"
  | "backgroundTokenRefreshEnabled"
  | "cliIntegrationEnabled"
  | "autoRefreshMinutes"
  | "autoRefreshCurrentMinutes"
  | "usageHistoryRetentionDays"
  | "autoSwitchEnabled"
  | "hourlyQuotaControlEnabled"
  | "autoSwitchReloadWindowEnabled"
  | "autoSwitchHourlyThreshold"
  | "autoSwitchWeeklyThreshold"
  | "autoSwitchRefreshAllBeforeSwitchEnabled"
  | "autoResetEnabled"
  | "autoResetWeeklyThreshold"
  | "autoSwitchLockMinutes"
  | "quotaWarningEnabled"
  | "quotaWarningThreshold"
  | "quotaWarningWeeklyThreshold"
  | "quotaGreenThreshold"
  | "quotaYellowThreshold"
  | "debugNetwork"
  | "encryptedSyncEnabled"
  | "webDashboardEnabled"
  | "webDashboardAlwaysOnlineEnabled"
  | "cloudflaredDomain"
  | "displayLanguage";

export interface DashboardSettings {
  dashboardTheme: DashboardThemeOption;
  /** Shared privacy preference used by every dashboard and details surface. */
  privacyMode?: boolean;
  codexAppRestartEnabled: boolean;
  codexAppRestartMode: "auto" | "manual";
  backgroundTokenRefreshEnabled: boolean;
  /** Master gate for local Codex session access. */
  cliIntegrationEnabled?: boolean;
  autoRefreshMinutes: number;
  autoRefreshCurrentMinutes: number;
  usageHistoryRetentionDays: number;
  autoSwitchEnabled: boolean;
  hourlyQuotaControlEnabled: boolean;
  autoSwitchReloadWindowEnabled: boolean;
  autoSwitchHourlyThreshold: number;
  autoSwitchWeeklyThreshold: number;
  /** Refresh every enabled account before evaluating an automatic switch. */
  autoSwitchRefreshAllBeforeSwitchEnabled?: boolean;
  /** Automatically consume a reset credit when all enabled accounts are out of quota. */
  autoResetEnabled?: boolean;
  /** Weekly quota percentage at or below which a reset-credit candidate may be used. */
  autoResetWeeklyThreshold?: number;
  autoSwitchLockMinutes: number;
  codexAppPath: string;
  resolvedCodexAppPath: string;
  /** Optional custom executable/script path used by dashboard-started Codex CLI turns. */
  codexCliPath?: string;
  quotaWarningEnabled: boolean;
  quotaWarningThreshold: number;
  quotaWarningWeeklyThreshold: number;
  quotaGreenThreshold: number;
  quotaYellowThreshold: number;
  debugNetwork: boolean;
  encryptedSyncEnabled: boolean;
  encryptedSyncRegistryOverrideEnabled: boolean;
  webDashboardEnabled: boolean;
  /** Keep a detached Node relay alive after VS Code closes. */
  webDashboardAlwaysOnlineEnabled?: boolean;
  /** Optional public HTTPS origin used when the dashboard is exposed by Cloudflared. */
  cloudflaredDomain?: string;
  displayLanguage: DashboardLanguageOption;
}

export type DashboardThemeOption = "auto" | "dark" | "light";

export interface DashboardCopy {
  panelTitle: string;
  brandSub: string;
  refreshPage: string;
  githubProject: string;
  githubProjectTip: string;
  announcementsTitle: string;
  announcementsTooltip: string;
  announcementsEmpty: string;
  announcementsRefresh: string;
  announcementsRefreshing: string;
  announcementsMarkAllRead: string;
  announcementsGotIt: string;
  announcementsPinned: string;
  announcementsTypeInfo: string;
  announcementsTypeFeature: string;
  announcementsTypeWarning: string;
  announcementsTypeUrgent: string;
  announcementsJustNow: string;
  announcementsMinutesAgo: string;
  announcementsHoursAgo: string;
  announcementsDaysAgo: string;
  addAccount: string;
  importCurrent: string;
  refreshAll: string;
  shareToken: string;
  shareTokenDisabledTip: string;
  shareTokenModeHint: string;
  tokenAutomationTitle: string;
  tokenAutomationSub: string;
  tokenAutomationOn: string;
  tokenAutomationOnDesc: string;
  tokenAutomationOff: string;
  tokenAutomationOffDesc: string;
  tokenAutomationLastCheck: string;
  tokenAutomationLastRefresh: string;
  tokenAutomationNextCheck: string;
  tokenAutomationLastFailure: string;
  tokenAutomationHealthy: string;
  tokenAutomationExpiring: string;
  tokenAutomationRefreshFailed: string;
  tokenAutomationReauthorize: string;
  tokenAutomationDisabled: string;
  tokenAutomationQuota: string;
  resyncProfileBtn: string;
  syncProfileBtn: string;
  editTagsBtn: string;
  addTagsBtn: string;
  removeTagsBtn: string;
  batchActionsTitle: string;
  batchRefreshBtn: string;
  batchResyncBtn: string;
  batchRemoveBtn: string;
  batchExportBtn: string;
  batchSelectedCount: string;
  batchResultTitle: string;
  batchResultSuccess: string;
  batchResultFailed: string;
  batchResultOverwrite: string;
  batchResultFailures: string;
  tagsLabel: string;
  tagsPlaceholder: string;
  tagsHelp: string;
  tagsRequiredError: string;
  tagsTooManyError: string;
  tagsTooLongError: string;
  saveTagsBtn: string;
  clearTagsBtn: string;
  lockAutoSwitchBtn: string;
  unlockAutoSwitchBtn: string;
  autoSwitchLockedUntil: string;
  autoSwitchRuleQuota: string;
  recoveryTitle: string;
  recoveryRestored: string;
  recoveryCorrupted: string;
  recoveryBackups: string;
  recoveryLastError: string;
  recoveryRestoreBackupBtn: string;
  recoveryRestoreAuthBtn: string;
  recoveryImportJsonBtn: string;
  dashboardTitle: string;
  dashboardSub: string;
  empty: string;
  noActiveAccountTitle: string;
  noActiveAccountSub: string;
  primaryAccount: string;
  current: string;
  disabledTag: string;
  authErrorTag: string;
  quotaErrorTag: string;
  reauthorizeBtn: string;
  reloadBtn: string;
  hourlyLabel: string;
  weeklyLabel: string;
  reviewLabel: string;
  userId: string;
  lastRefresh: string;
  accountId: string;
  organization: string;
  savedAccounts: string;
  savedAccountsSub: string;
  teamName: string;
  login: string;
  switchBtn: string;
  refreshBtn: string;
  resetCreditsBtn: string;
  resetCreditsLabel: string;
  detailsBtn: string;
  removeBtn: string;
  settingsTitle: string;
  addAccountModalTitle: string;
  shareTokenModalTitle: string;
  oauthTab: string;
  importJsonTab: string;
  authorizationLink: string;
  copyLink: string;
  openInBrowser: string;
  manualCallbackLabel: string;
  manualCallbackPlaceholder: string;
  authorizedContinue: string;
  cancelOauthConfirm: string;
  continueOauthBtn: string;
  cancelOauthBtn: string;
  oauthReadyHint: string;
  jsonPreview: string;
  copyJson: string;
  copySuccess: string;
  downloadJson: string;
  importJson: string;
  importJsonPlaceholder: string;
  importJsonSessionHint: string;
  importJsonSubmit: string;
  importJsonHint: string;
  importJsonValidate: string;
  importJsonSummaryTitle: string;
  importJsonSummaryTotal: string;
  importJsonSummaryValid: string;
  importJsonSummaryOverwrite: string;
  importJsonSummaryInvalid: string;
  importJsonSummaryFailures: string;
  importJsonResultsTitle: string;
  importJsonResultsSuccess: string;
  importJsonResultsOverwrite: string;
  importJsonResultsFailed: string;
  importJsonExamplesSummary: string;
  importJsonExamplesHint: string;
  importJsonSingleExampleLabel: string;
  importJsonBatchExampleLabel: string;
  importJsonChooseFile: string;
  importJsonFileReadError: string;
  shareSelectedCount: string;
  closeModal: string;
  showSensitive: string;
  hideSensitive: string;
  codexAppRestartTitle: string;
  codexAppRestartSub: string;
  restartModeAuto: string;
  restartModeAutoDesc: string;
  restartModeManual: string;
  restartModeManualDesc: string;
  restartModeNote: string;
  autoRefreshTitle: string;
  autoRefreshSub: string;
  autoRefreshCurrentTitle: string;
  autoRefreshCurrentSub: string;
  autoRefreshCurrentValueDescTemplate: string;
  autoRefreshOn: string;
  autoRefreshOnDesc: string;
  autoRefreshOff: string;
  autoRefreshOffDesc: string;
  autoRefreshValueTemplate: string;
  autoRefreshValueDescTemplate: string;
  hourlyQuotaControlTitle: string;
  hourlyQuotaControlSub: string;
  hourlyQuotaControlOnDesc: string;
  hourlyQuotaControlOffDesc: string;
  autoSwitchTitle: string;
  autoSwitchSub: string;
  autoSwitchOn: string;
  autoSwitchOnDesc: string;
  autoSwitchOff: string;
  autoSwitchOffDesc: string;
  autoSwitchThresholdSuffix: string;
  autoSwitchThresholdDescTemplate: string;
  autoSwitchAnyNote: string;
  autoSwitchReloadTitle: string;
  autoSwitchReloadSub: string;
  autoSwitchLockMinutesTitle: string;
  autoSwitchLockMinutesSub: string;
  autoSwitchLockOff: string;
  autoSwitchLockValueTemplate: string;
  autoSwitchLockValueDescTemplate: string;
  autoSwitchToastSwitched: string;
  autoSwitchToastSwitchedAndReloaded: string;
  autoResetTitle?: string;
  autoResetSub?: string;
  autoResetThresholdDescTemplate?: string;
  autoSwitchRefreshAllTitle?: string;
  autoSwitchRefreshAllSub?: string;
  appPathTitle: string;
  appPathSub: string;
  appPathEmpty: string;
  pickPath: string;
  clearPath: string;
  dashboardSettingsTitle: string;
  dashboardSettingsSub: string;
  showReviewOn: string;
  showReviewOnDesc: string;
  showReviewOff: string;
  showReviewOffDesc: string;
  warningTitle: string;
  warningSub: string;
  warningOn: string;
  warningOnDesc: string;
  warningWeeklyOnlySub: string;
  warningOff: string;
  warningOffDesc: string;
  warningValueDescTemplate: string;
  colorThresholdTitle: string;
  colorThresholdSub: string;
  colorThresholdGreenTitle: string;
  colorThresholdYellowTitle: string;
  colorThresholdGreenDescTemplate: string;
  colorThresholdYellowDescTemplate: string;
  colorThresholdRedNoteTemplate: string;
  debugTitle: string;
  debugSub: string;
  debugOn: string;
  debugOnDesc: string;
  debugOff: string;
  debugOffDesc: string;
  debugNote: string;
  languageTitle: string;
  languageSub: string;
  languageAuto: string;
  languageZh: string;
  languageEn: string;
  languageNote: string;
  statusShort: string;
  selectAccount: string;
  deselectAccount: string;
  statusToggleTip: string;
  statusToggleTipChecked: string;
  statusLimitTip: string;
  accountEnableTip: string;
  accountDisableTip: string;
  accountDisabledTag: string;
  unknown: string;
  never: string;
  resetUnknown: string;
}

type DashboardMetricKey = string;

export interface DashboardMetricViewModel {
  key: DashboardMetricKey;
  label: string;
  period?: "hourly" | "weekly" | "monthly";
  percentage?: number;
  resetAt?: number;
  requestsLeft?: number;
  requestsLimit?: number;
  visible: boolean;
}

export interface DashboardUsageSample {
  at: number;
  accountId: string;
  hourly?: number;
  weekly?: number;
  review?: number;
}

export interface DashboardDailyUsageCacheEntry {
  accountId: string;
  fetchedAt: number;
  usage: CodexDailyUsageBreakdown;
}

export interface DashboardAccountViewModel {
  id: string;
  /** Last durable account-record change, used to order authenticated peer events. */
  updatedAt?: number;
  displayName: string;
  email: string;
  authMode?: "chatgpt" | "oauth";
  accountName?: string;
  tags: string[];
  authProviderLabel: string;
  accountStructureLabel: string;
  workspaceLabel: string;
  isTeamWorkspace: boolean;
  subscriptionText: string;
  subscriptionTitle: string;
  subscriptionColor?: string;
  subscriptionExpiresAt?: number;
  addMethodLabel: string;
  addedAtLabel: string;
  loginAt?: number;
  sessionStartedAt?: number;
  totalUsageMs?: number;
  runningDeviceName?: string;
  runningOnThisDevice?: boolean;
  runningDeviceOnline?: boolean;
  enablementSyncPending?: boolean;
  statusColor?: string;
  planTypeLabel: string;
  creditsText?: string;
  creditsBalance?: number;
  creditsUnlimited?: boolean;
  userId?: string;
  accountId?: string;
  organizationId?: string;
  isActive: boolean;
  switchQueued: boolean;
  isCurrentWindowAccount: boolean;
  enabled: boolean;
  queuePriority: boolean;
  tokenRefreshEnabled: boolean;
  canRefreshToken: boolean;
  showInStatusBar: boolean;
  canToggleStatusBar: boolean;
  statusToggleTitle: string;
  hasQuota402: boolean;
  quotaIssueKind?: "disabled" | "auth" | "quota";
  healthKind: "healthy" | "expiring" | "refresh_failed" | "reauthorize" | "disabled" | "quota";
  healthLabel: string;
  healthMessage?: string;
  healthIssueKey?: string;
  dismissedHealth: boolean;
  lastTokenCheckAt?: number;
  lastTokenRefreshAt?: number;
  lastTokenRefreshError?: string;
  lastQuotaAt?: number;
  resetCreditsAvailable?: number;
  resetCreditsNextExpiresAt?: number;
  autoSwitchLockedUntil?: number;
  metrics: DashboardMetricViewModel[];
}

export interface DashboardTokenAutomationViewModel {
  enabled: boolean;
  lastCheckAt?: number;
  nextCheckAt?: number;
  lastRefreshAt?: number;
  lastFailureMessage?: string;
}

export type DashboardBatchResultKind =
  | "tags_set"
  | "tags_add"
  | "tags_remove"
  | "batch_refresh"
  | "batch_resync"
  | "batch_remove"
  | "enable_all_valid"
  | "disable_all";

export interface DashboardBatchResultFailure {
  accountId?: string;
  email?: string;
  message: string;
}

export interface DashboardBatchResult {
  kind: DashboardBatchResultKind;
  successCount: number;
  failedCount: number;
  overwriteCount?: number;
  failures: DashboardBatchResultFailure[];
}

export interface DashboardState {
  lang: DashboardLanguage;
  panelTitle: string;
  brandSub: string;
  logoUri: string;
  /** Durable extension-owned marker; unlike webview storage, survives extension updates. */
  onboardingCompleted?: boolean;
  settings: DashboardSettings;
  encryptedSyncNeedsConfiguration?: boolean;
  encryptedSyncNeedsSettingsSync?: boolean;
  encryptedSyncLastCompletedAt?: number;
  encryptedSyncSessionCount?: number;
  encryptedSyncEnabledSessionCount?: number;
  copy: DashboardCopy;
  tokenAutomation: DashboardTokenAutomationViewModel;
  announcements: CodexAnnouncementState;
  indexHealth: CodexIndexHealthSummary;
  accounts: DashboardAccountViewModel[];
  /** Recent terminal result shown by the dashboard's top toast. */
  terminalNotice?: DashboardNotice & { createdAt: number };
  /** Shared by the VS Code panel and browser dashboard; omitted by older hosts. */
  usageHistory?: DashboardUsageSample[];
  dailyUsageCache?: DashboardDailyUsageCacheEntry[];
  connectedPeers?: DashboardPeerView[];
  /** Account/card state published by connected PCs over the peer WebSocket. */
  peerAccounts?: Record<string, DashboardAccountViewModel[]>;
}

export interface DashboardPeerView {
  id: string;
  name: string;
  sessionCount: number;
  connected: boolean;
  local?: boolean;
}

export type DashboardActionName =
  | "addAccount"
  | "setPrivacyMode"
  | "setCrossPcSyncEnabled"
  | "importCurrent"
  | "inspectCurrentAuth"
  | "completeOnboarding"
  | "refreshAll"
  | "refreshAnnouncements"
  | "markAnnouncementRead"
  | "markAllAnnouncementsRead"
  | "shareTokens"
  | "exportBackup"
  | "configureEncryptedSync"
  | "syncNow"
  | "setEncryptedSyncRegistryOverride"
  | "openNetworkLogs"
  | "exportAuthFile"
  | "restoreFromBackup"
  | "restoreFromAuthJson"
  | "copyText"
  | "openDashboard"
  | "openWebDashboard"
  | "openExternalUrl"
  | "downloadJsonFile"
  | "previewImportSharedJson"
  | "importSharedJson"
  | "prepareOAuthSession"
  | "cancelOAuthSession"
  | "startOAuthAutoFlow"
  | "completeOAuthSession"
  | "updateTags"
  | "setAutoSwitchLock"
  | "batchRefresh"
  | "batchResyncProfile"
  | "batchRemove"
  | "enableAllValid"
  | "disableAll"
  | "refreshView"
  | "unloadAuth"
  | "reloadPrompt"
  | "reauthorize"
  | "resyncProfile"
  | "dismissHealthIssue"
  | "details"
  | "switch"
  | "refresh"
  | "remove"
  | "toggleAccountEnabled"
  | "setAccountQueuePriority"
  | "setAccountTokenRefreshEnabled"
  | "refreshToken"
  | "getDailyUsage"
  | "startCodexCliSession"
  | "listCodexCliSessions"
  | "getCodexCliSessionMessages"
  | "sendCodexCliSessionMessage"
  | "cancelCodexCliSessionTurn"
  | "openCodexCliSession"
  | "renameCodexCliSession"
  | "forkCodexCliSession"
  | "archiveCodexCliSession"
  | "unarchiveCodexCliSession"
  | "deleteCodexCliSession"
  | "getWorkspaceEnvironment"
  | "listWorkspaceFiles"
  | "readWorkspaceFile"
  | "saveWorkspaceFile"
  | "deleteWorkspaceFile"
  | "listWorkspaceTerminals"
  | "createWorkspaceTerminal"
  | "focusWorkspaceTerminal"
  | "runWorkspaceTerminalCommand"
  | "cancelWorkspaceTerminalCommand"
  | "commitWorkspaceChanges"
  | "pushWorkspaceBranch"
  | "getResetCredits"
  | "consumeResetCredit";

export interface DashboardOAuthSessionDescriptor {
  sessionId: string;
  authUrl: string;
  redirectUri: string;
}

export interface DashboardActionPayload {
  accountIds?: string[];
  jsonText?: string;
  text?: string;
  url?: string;
  path?: string;
  filename?: string;
  oauthSessionId?: string;
  callbackUrl?: string;
  issueKey?: string;
  recoveryMode?: boolean;
  tags?: string[];
  mode?: "set" | "add" | "remove";
  lockMinutes?: number;
  announcementId?: string;
  privacyMode?: boolean;
  queuePriority?: boolean;
  tokenRefreshEnabled?: boolean;
  enabled?: boolean;
  days?: number;
  sessionId?: string;
  model?: string;
  reasoningEffort?: string;
  sandboxMode?: DashboardCliSandboxMode;
  projectPath?: string;
  filePath?: string;
  fileContent?: string;
  fileRevision?: string;
  command?: string;
  terminalId?: string;
  terminalName?: string;
  terminalProfile?: "default" | "powershell" | "cmd" | "bash";
  commitMessage?: string;
  /** Browser-dashboard confirmation supplied by an in-page modal. */
  confirmed?: boolean;
  /** Explicit dashboard Reload button intent; bypasses stale runtime markers. */
  forceReload?: boolean;
  /** Tags collected by the browser dashboard instead of a VS Code input box. */
  submittedTags?: string[];
  /** Secret collected by a browser passphrase modal. Never persisted in dashboard state. */
  passphrase?: string;
  passphraseConfirmation?: string;
  /** Existing shared password required when rotating to a new value. */
  currentPassphrase?: string;
  /** Save sync configuration now and perform the initial network sync in the background. */
  deferSync?: boolean;
  /** Target PC for a hub-routed action; omitted for local execution. */
  targetDeviceId?: string;
}

export interface DashboardCliSessionSummary {
  id: string;
  title: string;
  updatedAt?: string;
  status: "running" | "idle";
  archived?: boolean;
  /** The PC that owns this session. Local sessions omit this metadata. */
  deviceId?: string;
  deviceName?: string;
  /** Project working directory associated with this session, when known. */
  projectPath?: string;
  /** Surface that originally created the session, when recorded by Codex. */
  sessionSurface?: "cli" | "vscode" | "other";
  /** Human-readable owner shown while another surface holds the session lock. */
  runningBy?: string;
  /** Whether this Codex Manager process owns the running turn and can stop it. */
  canStop?: boolean;
  remote?: boolean;
}

export interface DashboardCliSessionMessage {
  id: string;
  kind?:
    | "message"
    | "reasoning"
    | "plan"
    | "command"
    | "file-change"
    | "tool-call"
    | "collaboration"
    | "web-search"
    | "image"
    | "review"
    | "compaction"
    | "error";
  role?: "user" | "assistant";
  text: string;
  title?: string;
  subtitle?: string;
  status?: "inProgress" | "completed" | "failed" | "declined" | "interrupted" | "unknown";
  command?: string;
  cwd?: string;
  output?: string;
  exitCode?: number;
  durationMs?: number;
  arguments?: string;
  result?: string;
  /** Raw provider payload retained behind the optional Debug details disclosure. */
  debug?: string;
  changes?: Array<{
    path: string;
    kind: string;
    diff?: string;
  }>;
  images?: Array<{
    src: string;
    alt?: string;
  }>;
  timestamp?: string;
}

export type DashboardCliSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface DashboardCliModelOption {
  id: string;
  label: string;
  description?: string;
  defaultReasoningEffort?: string;
  reasoningEfforts: string[];
}

export interface DashboardCliComposerConfig {
  models: DashboardCliModelOption[];
  /** Workspace folders available as the Codex project working directory. */
  projects?: DashboardCliProject[];
  defaultModel?: string;
  defaultReasoningEffort?: string;
  defaultSandboxMode: DashboardCliSandboxMode;
}

export interface DashboardCliProject {
  id: string;
  label: string;
  path: string;
}

export interface DashboardWorkspaceEnvironment {
  projectPath: string;
  projectName: string;
  isGitRepository: boolean;
  branch?: string;
  upstream?: string;
  changes: number;
  additions: number;
  deletions: number;
  ahead: number;
  behind: number;
  hasRemote: boolean;
}

export interface DashboardWorkspaceFileEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  depth: number;
}

export interface DashboardWorkspaceFile {
  path: string;
  content: string;
  language: string;
  kind: "text" | "image" | "audio" | "video" | "pdf" | "document";
  mimeType: string;
  size: number;
  revision: string;
  dataUrl?: string;
}

export interface DashboardWorkspaceTerminalResult {
  id: string;
  terminalId: string;
  command: string;
  cwd: string;
  output: string;
  exitCode?: number;
  durationMs: number;
  status: "completed" | "failed" | "cancelled" | "timedOut";
  finishedAt: string;
}

export interface DashboardWorkspaceTerminalInfo {
  id: string;
  name: string;
  state: "running" | "idle";
  cwd?: string;
  shellPath?: string;
  processId?: number;
  isActive?: boolean;
}

export interface DashboardActionResultPayload {
  notice?: DashboardNotice;
  /** Choice prompts raised while a dashboard action was running. */
  actionPrompts?: DashboardActionPrompt[];
  sharedJson?: string;
  authJson?: string;
  oauthSession?: DashboardOAuthSessionDescriptor;
  importPreview?: CodexImportPreviewSummary;
  importResult?: CodexImportResultSummary;
  batchResult?: DashboardBatchResult;
  importedCount?: number;
  importedEmails?: string[];
  currentAuthEmail?: string;
  currentAuthAlreadyAdded?: boolean;
  email?: string;
  restoredCount?: number;
  resetCredits?: import("../../core/types").CodexResetCreditsSnapshot;
  dailyUsage?: CodexDailyUsageBreakdown;
  cliSessions?: DashboardCliSessionSummary[];
  cliSession?: DashboardCliSessionSummary;
  cliSessionMessages?: DashboardCliSessionMessage[];
  cliComposerConfig?: DashboardCliComposerConfig;
  workspaceEnvironment?: DashboardWorkspaceEnvironment;
  workspaceFiles?: DashboardWorkspaceFileEntry[];
  workspaceFile?: DashboardWorkspaceFile;
  workspaceTerminals?: DashboardWorkspaceTerminalInfo[];
  workspaceTerminal?: DashboardWorkspaceTerminalInfo;
  deletedWorkspaceFilePath?: string;
  terminalResult?: DashboardWorkspaceTerminalResult;
  /** Monotonic server revision used to discard stale realtime session lists. */
  realtimeRevision?: number;
  /** The active credentials changed and this VS Code window should be reloaded. */
  reloadRequired?: boolean;
  /** Account that should be used when presenting an in-dashboard reload confirmation. */
  reloadAccountId?: string;
  /** Deliver this action result before restarting the extension host. */
  reloadScheduled?: boolean;
}

export type DashboardActionPrompt =
  | {
      kind: "quotaWarning";
      accountId: string;
      message: string;
      switchAccountId?: string;
      switchLabel?: string;
      resetLabel?: string;
      selectLabel: string;
      laterLabel: string;
    }
  | {
      kind: "disabledActiveAccount";
      accountId: string;
      message: string;
      unloadLabel: string;
      keepUsingLabel: string;
    };

export interface DashboardNotice {
  level: "info" | "warning" | "error";
  message: string;
  notificationId?: string;
  actions?: string[];
}

export type DashboardHostMessage =
  | {
      type: "dashboard:snapshot";
      state: DashboardState;
    }
  | {
      type: "dashboard:connection";
      transport: "websocket";
      connected: boolean;
    }
  | {
      type: "dashboard:action-result";
      requestId: string;
      action: DashboardActionName;
      accountId?: string;
      status: "completed" | "cancelled" | "failed";
      payload?: DashboardActionResultPayload;
      error?: string;
    }
  | ({ type: "dashboard:notice" } & DashboardNotice)
  | { type: "dashboard:notification-dismissed"; notificationId: string };

export type DashboardClientMessage =
  | { type: "dashboard:ready" }
  /** Browser workspace-viewer lease; used to gate CLI session monitoring. */
  | { type: "dashboard:workspace-presence"; viewing: boolean }
  | { type: "dashboard:usage-history"; samples: DashboardUsageSample[] }
  | {
      type: "dashboard:action";
      requestId: string;
      action: DashboardActionName;
      accountId?: string;
      payload?: DashboardActionPayload;
    }
  | {
      type: "dashboard:setting";
      key: DashboardSettingKey;
      value: string | number | boolean;
    }
  | {
      type: "dashboard:notification-response";
      notificationId: string;
      action?: string;
    }
  | { type: "dashboard:pickCodexAppPath" }
  | { type: "dashboard:clearCodexAppPath" }
  | { type: "dashboard:pickCodexCliPath" }
  | { type: "dashboard:clearCodexCliPath" };
