import { onDidChangeConfiguration } from "../../storage/configurationEvents";
import * as vscode from "vscode";
import type {
  DashboardCodexSessionTransport,
  DashboardSettings,
  DashboardThemeOption
} from "../../domain/dashboard/types";
import { DashboardLanguage, DashboardLanguageOption, resolveDashboardLanguage } from "../../localization/languages";
import { normalizeQuotaColorThresholds } from "../../utils";
import { getAutoQueueQuotaFreshnessMs, normalizeAutoQueueThreshold } from "../../domain/autoQueuePolicy";
import { getPersistentLogLevel, getPersistentLogRetentionDays, isPersistentLoggingEnabled } from "../../utils/persistentLog";
import { sqliteConfiguration } from "../../storage/sqliteContext";

const CODEX_ACCOUNTS_SECTION = "codexManager";

export class ExtensionSettingsStore {
  getDashboardSettings(): DashboardSettings {
    const config = getCodexManagerConfiguration();
    const warningThresholds = getQuotaWarningThresholds(config);
    const thresholds = normalizeQuotaColorThresholds(
      config.get<number>("quotaGreenThreshold", 60),
      config.get<number>("quotaYellowThreshold", 20)
    );

    return {
      dashboardTheme: normalizeDashboardTheme(config.get<string>("dashboardTheme", "auto")),
      privacyMode: config.get<boolean>("privacyMode", false),
      persistentLoggingEnabled: isPersistentLoggingEnabled(),
      persistentLogRetentionDays: getPersistentLogRetentionDays(),
      persistentLogLevel: getPersistentLogLevel(),
      codexAppRestartEnabled: config.get<boolean>("codexAppRestartEnabled", false),
      codexAppRestartMode: config.get<"auto" | "manual">("codexAppRestartMode") ?? "manual",
      cliIntegrationEnabled: config.get<boolean>("cliIntegrationEnabled", false),
      taskBoardEnabled: config.get<boolean>("taskBoardEnabled", true),
      apiAccessEnabled: config.get<boolean>("apiAccessEnabled", false),
      codexSessionTransport: readCodexSessionTransport(config),
      autoRefreshMinutes: normalizeAutoRefreshMinutes(config.get<number>("autoRefreshMinutes", 15)),
      autoRefreshCurrentMinutes: normalizeCurrentAutoRefreshMinutes(config.get<number>("autoRefreshCurrentMinutes", 1)),
      quotaFreshnessMs: getAutoQueueQuotaFreshnessMs(
        normalizeAutoRefreshMinutes(config.get<number>("autoRefreshMinutes", 15))
      ),
      usageHistoryRetentionDays: normalizeUsageHistoryRetentionDays(config.get<number>("usageHistoryRetentionDays", 7)),
      tokenHistoryRetentionDays: normalizeTokenHistoryRetentionDays(config.get<number>("tokenHistoryRetentionDays", 30)),
      dailyTokenUsageIntervalMinutes: normalizeDailyTokenUsageIntervalMinutes(config.get<number>("dailyTokenUsageIntervalMinutes", 60)),
      dailyTokenUsageEnabled: config.get<boolean>("dailyTokenUsageEnabled", true),
      autoSwitchEnabled: config.get<boolean>("autoSwitchEnabled", false),
      autoSwitchWaitForSessionsEnabled: config.get<boolean>("autoSwitchWaitForSessionsEnabled", false),
      // The 5-hour quota is always part of automatic quota control. Keep the
      // legacy field in the dashboard model for old snapshots, but do not read
      // the removed user setting anymore.
      hourlyQuotaControlEnabled: true,
      autoSwitchReloadWindowEnabled: config.get<boolean>("autoSwitchReloadWindowEnabled", false),
      autoResumeEnabled: isAutoResumeEnabled(config),
      autoResumeOpenVsCode: config.get<boolean>("autoResumeOpenVsCode", false) === true,
      crossWindowAccountModeEnabled: config.get<boolean>("crossWindowAccountModeEnabled", false),
      autoSwitchHourlyThreshold: normalizeAutoSwitchThreshold(config.get<number>("autoSwitchHourlyThreshold", 5)),
      autoSwitchWeeklyThreshold: normalizeAutoSwitchThreshold(config.get<number>("autoSwitchWeeklyThreshold", 0), 0),
      autoSwitchRefreshAllBeforeSwitchEnabled: config.get<boolean>("autoSwitchRefreshAllBeforeSwitchEnabled", false),
      autoResetEnabled: config.get<boolean>("autoResetEnabled", false),
      autoResetWeeklyThreshold: normalizeAutoResetWeeklyThreshold(config.get<number>("autoResetWeeklyThreshold", 0)),
      autoSwitchLockMinutes: normalizeAutoSwitchLockMinutes(config.get<number>("autoSwitchLockMinutes", 0)),
      codexAppPath: config.get<string>("codexAppPath", ""),
      resolvedCodexAppPath: "",
      codexCliPath: config.get<string>("codexCliPath", ""),
      quotaWarningEnabled: config.get<boolean>("quotaWarningEnabled", false),
      quotaWarningThreshold: warningThresholds.hourly,
      quotaWarningWeeklyThreshold: warningThresholds.weekly,
      quotaGreenThreshold: thresholds.green,
      quotaYellowThreshold: thresholds.yellow,
      encryptedSyncEnabled: config.get<boolean>("encryptedSyncEnabled", true),
      encryptedSyncClaimAllAccountsEnabled: config.get<boolean>("encryptedSyncClaimAllAccountsEnabled", false) === true,
      fullCrossPcAccountSyncEnabled: config.get<boolean>("fullCrossPcAccountSyncEnabled", false),
      encryptedSyncVsCodeHeartbeatMinutes: normalizeSyncHeartbeatMinutes(config.get<number>("encryptedSyncVsCodeHeartbeatMinutes", 5)),
      // Runtime-owned and passphrase-gated; buildDashboardState replaces this placeholder.
      encryptedSyncRegistryOverrideEnabled: false,
      webDashboardEnabled: config.get<boolean>("webDashboardEnabled", false),
      webSocketServerEnabled: config.get<boolean>("webSocketServerEnabled", true),
      cloudflaredDomain: config.get<string>("cloudflaredDomain", "").trim(),
      displayLanguage: config.get<DashboardLanguageOption>("displayLanguage", "en")
    };
  }

  resolveLanguage(): DashboardLanguage {
    const configured = getCodexManagerConfiguration().get<string>("displayLanguage", "en");
    return resolveDashboardLanguage(configured, vscode.env.language);
  }

  onDidChange(listener: () => void): vscode.Disposable {
    return onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CODEX_ACCOUNTS_SECTION)) {
        listener();
      }
    });
  }
}

export function normalizeDashboardTheme(value: string | undefined): DashboardThemeOption {
  return value === "dark" || value === "light" || value === "auto" ? value : "auto";
}

/** Retired transport preferences migrate to the single supported App Server connection. */
export function normalizeCodexSessionTransport(_value: string | undefined): DashboardCodexSessionTransport {
  return "app-server-stdio";
}

export function readCodexSessionTransport(_config?: vscode.WorkspaceConfiguration): DashboardCodexSessionTransport {
  return "app-server-stdio";
}

export function normalizeSyncHeartbeatMinutes(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(60, Math.round(value)));
}

export function getSyncHeartbeatMinutes(): number {
  return normalizeSyncHeartbeatMinutes(getCodexManagerConfiguration().get<number>("encryptedSyncVsCodeHeartbeatMinutes", 5));
}

export function normalizeDailyTokenUsageIntervalMinutes(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(1440, Math.round(value))) : 60;
}

export function normalizeAutoRefreshMinutes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.max(5, Math.min(60, Math.round(value)));
}

export function normalizeCurrentAutoRefreshMinutes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.max(1, Math.min(60, Math.round(value)));
}

export function normalizeUsageHistoryRetentionDays(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 7;
  }

  return Math.max(1, Math.min(90, Math.round(value)));
}

export function getCodexManagerConfiguration(): vscode.WorkspaceConfiguration {
  return sqliteConfiguration(vscode.workspace.getConfiguration(CODEX_ACCOUNTS_SECTION));
}

export function isAutoResumeEnabled(config = getCodexManagerConfiguration()): boolean {
  return (
    config.get<boolean>("autoSwitchEnabled", false) === true && config.get<boolean>("autoResumeEnabled", false) === true
  );
}

export function getAutoRefreshMinutes(): number {
  return normalizeAutoRefreshMinutes(getCodexManagerConfiguration().get<number>("autoRefreshMinutes", 15));
}

export function getAutoRefreshCurrentMinutes(): number {
  return normalizeCurrentAutoRefreshMinutes(getCodexManagerConfiguration().get<number>("autoRefreshCurrentMinutes", 1));
}

export function isAutoSwitchRefreshAllBeforeSwitchEnabled(): boolean {
  const config = getCodexManagerConfiguration();
  return (
    config.get<boolean>("autoSwitchRefreshAllBeforeSwitchEnabled", false) &&
    (config.get<boolean>("autoSwitchEnabled", false) || config.get<boolean>("quotaWarningEnabled", false))
  );
}

export function isHourlyQuotaControlEnabled(): boolean {
  return true;
}

export function normalizeAutoSwitchThreshold(value: number, fallback = 5): number {
  return normalizeAutoQueueThreshold(value, fallback, 20);
}

export function normalizeAutoResetWeeklyThreshold(value: number): number {
  return normalizeAutoQueueThreshold(value, 0, 100);
}

export function normalizeQuotaWarningThreshold(value: number): number {
  if (!Number.isFinite(value)) {
    return 20;
  }

  return Math.max(0, Math.min(90, Math.round(value)));
}

export function normalizeQuotaWarningWeeklyThreshold(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(90, Math.round(value)));
}

export function getQuotaWarningThresholds(config: vscode.WorkspaceConfiguration = getCodexManagerConfiguration()): {
  hourly: number;
  weekly: number;
} {
  const hourly = normalizeQuotaWarningThreshold(config.get<number>("quotaWarningThreshold", 10));
  const configuredWeekly = getExplicitNumberConfiguration(config, "quotaWarningWeeklyThreshold");
  const weeklyInspection = config.inspect?.<number>("quotaWarningWeeklyThreshold");
  return {
    hourly,
    // A real VS Code configuration exposes the manifest default through
    // inspect(); lightweight callers that do not provide inspect() retain the
    // legacy shared hourly value for compatibility.
    weekly:
      configuredWeekly !== undefined
        ? normalizeQuotaWarningWeeklyThreshold(configuredWeekly)
        : typeof weeklyInspection?.defaultValue === "number"
          ? normalizeQuotaWarningWeeklyThreshold(weeklyInspection.defaultValue)
          : hourly
  };
}

function getExplicitNumberConfiguration(config: vscode.WorkspaceConfiguration, key: string): number | undefined {
  const inspected = config.inspect?.<number>(key);
  return (
    inspected?.workspaceFolderLanguageValue ??
    inspected?.workspaceFolderValue ??
    inspected?.workspaceLanguageValue ??
    inspected?.workspaceValue ??
    inspected?.globalLanguageValue ??
    inspected?.globalValue
  );
}

export function normalizeAutoSwitchLockMinutes(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(120, Math.round(value)));
}

export function normalizeTokenHistoryRetentionDays(value: number): number {
  return normalizeUsageHistoryRetentionDays(Number.isFinite(value) && value > 0 ? value : 30);
}
