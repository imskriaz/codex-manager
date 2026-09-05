import * as vscode from "vscode";
import type { DashboardSettings, DashboardThemeOption } from "../../domain/dashboard/types";
import { DashboardLanguage, DashboardLanguageOption, resolveDashboardLanguage } from "../../localization/languages";
import { normalizeQuotaColorThresholds } from "../../utils";

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
      codexAppRestartEnabled: config.get<boolean>("codexAppRestartEnabled", false),
      codexAppRestartMode: config.get<"auto" | "manual">("codexAppRestartMode") ?? "manual",
      backgroundTokenRefreshEnabled: config.get<boolean>("backgroundTokenRefreshEnabled", false),
      cliIntegrationEnabled: config.get<boolean>("cliIntegrationEnabled", false),
      autoRefreshMinutes: normalizeAutoRefreshMinutes(config.get<number>("autoRefreshMinutes", 15)),
      autoRefreshCurrentMinutes: normalizeCurrentAutoRefreshMinutes(config.get<number>("autoRefreshCurrentMinutes", 1)),
      usageHistoryRetentionDays: normalizeUsageHistoryRetentionDays(config.get<number>("usageHistoryRetentionDays", 7)),
      autoSwitchEnabled: config.get<boolean>("autoSwitchEnabled", false),
      hourlyQuotaControlEnabled: config.get<boolean>("hourlyQuotaControlEnabled", true),
      autoSwitchReloadWindowEnabled: config.get<boolean>("autoSwitchReloadWindowEnabled", false),
      autoSwitchHourlyThreshold: normalizeAutoSwitchThreshold(config.get<number>("autoSwitchHourlyThreshold", 5)),
      autoSwitchWeeklyThreshold: normalizeAutoSwitchThreshold(config.get<number>("autoSwitchWeeklyThreshold", 0)),
      autoSwitchRefreshAllBeforeSwitchEnabled: config.get<boolean>("autoSwitchRefreshAllBeforeSwitchEnabled", false),
      autoResetEnabled: config.get<boolean>("autoResetEnabled", false),
      autoResetWeeklyThreshold: normalizeAutoResetWeeklyThreshold(config.get<number>("autoResetWeeklyThreshold", 1)),
      autoSwitchLockMinutes: normalizeAutoSwitchLockMinutes(config.get<number>("autoSwitchLockMinutes", 0)),
      codexAppPath: config.get<string>("codexAppPath", ""),
      resolvedCodexAppPath: "",
      codexCliPath: config.get<string>("codexCliPath", ""),
      quotaWarningEnabled: config.get<boolean>("quotaWarningEnabled", false),
      quotaWarningThreshold: warningThresholds.hourly,
      quotaWarningWeeklyThreshold: warningThresholds.weekly,
      quotaGreenThreshold: thresholds.green,
      quotaYellowThreshold: thresholds.yellow,
      debugNetwork: config.get<boolean>("debugNetwork", false),
      encryptedSyncEnabled: config.get<boolean>("encryptedSyncEnabled", true),
      fullCrossPcAccountSyncEnabled: config.get<boolean>("fullCrossPcAccountSyncEnabled", false),
      // Runtime-owned and passphrase-gated; buildDashboardState replaces this placeholder.
      encryptedSyncRegistryOverrideEnabled: false,
      webDashboardEnabled: config.get<boolean>("webDashboardEnabled", false),
      webDashboardAlwaysOnlineEnabled: config.get<boolean>("webDashboardAlwaysOnlineEnabled", false),
      cloudflaredDomain: config.get<string>("cloudflaredDomain", "").trim(),
      displayLanguage: config.get<DashboardLanguageOption>("displayLanguage", "en")
    };
  }

  resolveLanguage(): DashboardLanguage {
    const configured = getCodexManagerConfiguration().get<string>("displayLanguage", "en");
    return resolveDashboardLanguage(configured, vscode.env.language);
  }

  onDidChange(listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CODEX_ACCOUNTS_SECTION)) {
        listener();
      }
    });
  }
}

export function normalizeDashboardTheme(value: string | undefined): DashboardThemeOption {
  return value === "dark" || value === "light" || value === "auto" ? value : "auto";
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
  return vscode.workspace.getConfiguration(CODEX_ACCOUNTS_SECTION);
}

export function getAutoRefreshMinutes(): number {
  return normalizeAutoRefreshMinutes(getCodexManagerConfiguration().get<number>("autoRefreshMinutes", 15));
}

export function getAutoRefreshCurrentMinutes(): number {
  return normalizeCurrentAutoRefreshMinutes(getCodexManagerConfiguration().get<number>("autoRefreshCurrentMinutes", 1));
}

export function isAutoSwitchRefreshAllBeforeSwitchEnabled(): boolean {
  return getCodexManagerConfiguration().get<boolean>("autoSwitchRefreshAllBeforeSwitchEnabled", false);
}

export function isBackgroundTokenRefreshEnabled(): boolean {
  return getCodexManagerConfiguration().get<boolean>("backgroundTokenRefreshEnabled", false);
}

export function isHourlyQuotaControlEnabled(): boolean {
  return getCodexManagerConfiguration().get<boolean>("hourlyQuotaControlEnabled", true);
}

export function normalizeAutoSwitchThreshold(value: number): number {
  if (!Number.isFinite(value)) {
    return 20;
  }

  return Math.max(0, Math.min(20, Math.round(value)));
}

export function normalizeAutoResetWeeklyThreshold(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(100, Math.round(value)));
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
