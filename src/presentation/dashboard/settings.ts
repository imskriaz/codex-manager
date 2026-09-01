import * as vscode from "vscode";
import { getDashboardCopy } from "../../application/dashboard/copy";
import type { DashboardSettingKey } from "../../domain/dashboard/types";
import {
  ExtensionSettingsStore,
  getCodexManagerConfiguration,
  normalizeAutoRefreshMinutes,
  normalizeAutoSwitchLockMinutes,
  normalizeAutoSwitchThreshold,
  normalizeAutoResetWeeklyThreshold,
  normalizeDashboardTheme,
  normalizeQuotaWarningThreshold,
  normalizeQuotaWarningWeeklyThreshold,
  normalizeUsageHistoryRetentionDays
} from "../../infrastructure/config/extensionSettings";
import { isDashboardLanguageOption } from "../../localization/languages";
import { normalizeQuotaColorThresholds } from "../../utils";

export type DashboardConfigurationKey = DashboardSettingKey | "codexAppPath" | "codexCliPath";

export async function handleDashboardSettingUpdate(
  key: DashboardConfigurationKey,
  value: string | number | boolean,
  target?: vscode.ConfigurationTarget
): Promise<boolean> {
  const config = getCodexManagerConfiguration();
  let updated = false;

  switch (key) {
    case "dashboardTheme":
      if (typeof value === "string") {
        await updateDashboardConfiguration(config, key, normalizeDashboardTheme(value), target);
        updated = true;
      }
      break;
    case "codexAppRestartEnabled":
    case "autoSwitchEnabled":
    case "hourlyQuotaControlEnabled":
    case "autoSwitchReloadWindowEnabled":
    case "autoSwitchRefreshAllBeforeSwitchEnabled":
    case "autoResetEnabled":
    case "backgroundTokenRefreshEnabled":
    case "cliIntegrationEnabled":
    case "quotaWarningEnabled":
    case "debugNetwork":
    case "encryptedSyncEnabled":
    case "webDashboardEnabled":
    case "webDashboardAlwaysOnlineEnabled":
      if (typeof value === "boolean") {
        await updateDashboardConfiguration(config, key, value, target);
        updated = true;
      }
      break;
    case "cloudflaredDomain":
      if (typeof value === "string") {
        const normalized = normalizeCloudflaredDomain(value);
        if (normalized !== undefined) {
          await updateDashboardConfiguration(config, key, normalized, target);
          updated = true;
        }
      }
      break;
    case "codexAppRestartMode":
      if (value === "auto" || value === "manual") {
        await updateDashboardConfiguration(config, key, value, target);
        updated = true;
      }
      break;
    case "autoSwitchHourlyThreshold":
    case "autoSwitchWeeklyThreshold":
      if (typeof value === "number") {
        await updateDashboardConfiguration(config, key, normalizeAutoSwitchThreshold(value), target);
        updated = true;
      }
      break;
    case "autoResetWeeklyThreshold":
      if (typeof value === "number") {
        await updateDashboardConfiguration(config, key, normalizeAutoResetWeeklyThreshold(value), target);
        updated = true;
      }
      break;
    case "quotaWarningThreshold":
      if (typeof value === "number") {
        // Materialize the inherited weekly value before changing the legacy
        // shared key so existing users keep their prior warning behavior.
        if (!hasExplicitConfigurationValue(config, "quotaWarningWeeklyThreshold")) {
          const inheritedTarget = target ?? resolveConfigurationTarget(config, key);
          await updateDashboardConfiguration(
            config,
            "quotaWarningWeeklyThreshold",
            normalizeQuotaWarningWeeklyThreshold(config.get<number>("quotaWarningThreshold", 10)),
            inheritedTarget
          );
        }
        await updateDashboardConfiguration(config, key, normalizeQuotaWarningThreshold(value), target);
        updated = true;
      }
      break;
    case "quotaWarningWeeklyThreshold":
      if (typeof value === "number") {
        await updateDashboardConfiguration(config, key, normalizeQuotaWarningWeeklyThreshold(value), target);
        updated = true;
      }
      break;
    case "quotaGreenThreshold":
      if (typeof value === "number") {
        const normalized = normalizeQuotaColorThresholds(
          snapToAllowed(value, [50, 60, 70, 80, 90], 60),
          config.get<number>("quotaYellowThreshold", 20)
        );
        await updateDashboardConfiguration(config, key, normalized.green, target);
        updated = true;
      }
      break;
    case "quotaYellowThreshold":
      if (typeof value === "number") {
        const normalized = normalizeQuotaColorThresholds(
          config.get<number>("quotaGreenThreshold", 60),
          snapToAllowed(value, [10, 20, 30, 40, 50], 20)
        );
        await updateDashboardConfiguration(config, key, normalized.yellow, target);
        updated = true;
      }
      break;
    case "autoSwitchLockMinutes":
      if (typeof value === "number") {
        await updateDashboardConfiguration(config, key, normalizeAutoSwitchLockMinutes(value), target);
        updated = true;
      }
      break;
    case "autoRefreshMinutes":
    case "autoRefreshCurrentMinutes":
      if (typeof value === "number") {
        await updateDashboardConfiguration(config, key, normalizeAutoRefreshMinutes(value), target);
        updated = true;
      }
      break;
    case "usageHistoryRetentionDays":
      if (typeof value === "number") {
        await updateDashboardConfiguration(config, key, normalizeUsageHistoryRetentionDays(value), target);
        updated = true;
      }
      break;
    case "displayLanguage":
      if (typeof value === "string" && isDashboardLanguageOption(value)) {
        await updateDashboardConfiguration(config, key, value, target);
        updated = true;
      }
      break;
    case "codexAppPath":
    case "codexCliPath":
      if (typeof value === "string") {
        await updateDashboardConfiguration(config, key, value, target);
        updated = true;
      }
      break;
    default:
      return false;
  }

  return updated;
}

/** Normalize the optional Cloudflared public origin entered in dashboard settings. */
export function normalizeCloudflaredDomain(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function snapToAllowed(value: number, allowed: readonly number[], fallback: number): number {
  if (!Number.isFinite(value)) {return fallback;}
  return allowed.reduce((closest, candidate) =>
    Math.abs(candidate - value) < Math.abs(closest - value) ? candidate : closest
  , fallback);
}

function hasExplicitConfigurationValue(config: vscode.WorkspaceConfiguration, key: string): boolean {
  const inspected = config.inspect?.(key);
  return Boolean(
    inspected &&
      (inspected.workspaceFolderLanguageValue !== undefined ||
        inspected.workspaceFolderValue !== undefined ||
        inspected.workspaceLanguageValue !== undefined ||
        inspected.workspaceValue !== undefined ||
        inspected.globalLanguageValue !== undefined ||
        inspected.globalValue !== undefined)
  );
}

async function updateDashboardConfiguration(
  config: vscode.WorkspaceConfiguration,
  key: DashboardConfigurationKey,
  value: string | number | boolean,
  target?: vscode.ConfigurationTarget
): Promise<void> {
  await config.update(key, value, target ?? resolveConfigurationTarget(config, key));
}

function resolveConfigurationTarget(
  config: vscode.WorkspaceConfiguration,
  key: DashboardConfigurationKey
): vscode.ConfigurationTarget {
  // Workspace access exposes local files, terminals, and CLI sessions. Keep
  // its master gate in this machine's user settings even if an older install
  // left a workspace-level override behind in a shared repository.
  if (key === "cliIntegrationEnabled") {
    return vscode.ConfigurationTarget.Global;
  }
  const inspected = config.inspect(key);
  if (inspected?.workspaceFolderValue !== undefined) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  if (inspected?.workspaceValue !== undefined) {
    return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.Global;
}

export async function pickDashboardCodexAppPath(
  settingsStore: Pick<ExtensionSettingsStore, "resolveLanguage">
): Promise<void> {
  const pickerCopy = getDashboardCopy(settingsStore.resolveLanguage());
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: pickerCopy.pickPath
  });

  if (!selected?.[0]) {
    return;
  }

  const config = getCodexManagerConfiguration();
  const target = resolveConfigurationTarget(config, "codexAppPath");
  await config.update("codexAppPath", selected[0].fsPath, target);
}

export async function pickDashboardCodexCliPath(
  settingsStore: Pick<ExtensionSettingsStore, "resolveLanguage">
): Promise<boolean> {
  const pickerCopy = getDashboardCopy(settingsStore.resolveLanguage());
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: pickerCopy.pickPath
  });
  if (!selected?.[0]) return false;

  const config = getCodexManagerConfiguration();
  const target = resolveConfigurationTarget(config, "codexCliPath");
  await config.update("codexCliPath", selected[0].fsPath, target);
  return true;
}
