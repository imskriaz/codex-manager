import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import {
  ExtensionSettingsStore,
  normalizeDailyTokenUsageIntervalMinutes,
  getQuotaWarningThresholds,
  isHourlyQuotaControlEnabled,
  normalizeQuotaWarningThreshold,
  normalizeQuotaWarningWeeklyThreshold,
  normalizeSyncHeartbeatMinutes,
  normalizeAutoResetWeeklyThreshold,
  isAutoResumeEnabled,
  isAutoSwitchRefreshAllBeforeSwitchEnabled
} from "../src/infrastructure/config/extensionSettings";

describe("5-hour quota control defaults", () => {
  it("defaults token collection on and bounds its interval from one minute to one day", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (_key: string, fallback: unknown) => fallback } as never);
    expect(new ExtensionSettingsStore().getDashboardSettings()).toMatchObject({ dailyTokenUsageEnabled: true, dailyTokenUsageIntervalMinutes: 60 });
    expect([NaN, Infinity, -1, 0, 1, 1.6, 60, 1440, 1441].map(normalizeDailyTokenUsageIntervalMinutes)).toEqual([60, 60, 1, 1, 1, 2, 60, 1440, 1440]);
  });
  it.each([[false, false], [false, true], [true, false], [true, true]])(
    "shares effective Auto Resume between runtime and dashboard with switch=%s, resume=%s",
    (autoSwitchEnabled, autoResumeEnabled) => {
      const update = vi.fn();
      const values = { autoSwitchEnabled, autoResumeEnabled };
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: (key: string, fallback?: unknown) => values[key as keyof typeof values] ?? fallback,
        update
      } as never);
      expect(isAutoResumeEnabled()).toBe(autoSwitchEnabled && autoResumeEnabled);
      expect(new ExtensionSettingsStore().getDashboardSettings().autoResumeEnabled)
        .toBe(autoSwitchEnabled && autoResumeEnabled);
      expect(update).not.toHaveBeenCalled();
      expect(values.autoResumeEnabled).toBe(autoResumeEnabled);
      expect(new ExtensionSettingsStore().getDashboardSettings().autoResumeGoalOnlyEnabled).toBe(true);
    }
  );

  it("keeps resume inactive when its parent is missing or malformed", () => {
    for (const parent of [undefined, "true", "false", 1]) {
      const config = { get: (key: string) => key === "autoResumeEnabled" ? true : parent } as never;
      expect(isAutoResumeEnabled(config)).toBe(false);
    }
  });

  it("uses the shared policy defaults for malformed switching and reset thresholds", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) => /Threshold$/.test(key) ? Number.NaN : fallback
    } as never);
    const settings = new ExtensionSettingsStore().getDashboardSettings();
    expect(settings.autoSwitchHourlyThreshold).toBe(5);
    expect(settings.autoSwitchWeeklyThreshold).toBe(0);
    expect(settings.autoResetWeeklyThreshold).toBe(0);
  });
  it("does not activate safety refresh without either switching or warnings", () => {
    const enabled = new Set(["autoSwitchRefreshAllBeforeSwitchEnabled"]);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) => (enabled.has(key) ? true : fallback)
    } as never);
    expect(isAutoSwitchRefreshAllBeforeSwitchEnabled()).toBe(false);
    enabled.add("quotaWarningEnabled");
    expect(isAutoSwitchRefreshAllBeforeSwitchEnabled()).toBe(true);
    enabled.delete("quotaWarningEnabled");
    enabled.add("autoSwitchEnabled");
    expect(isAutoSwitchRefreshAllBeforeSwitchEnabled()).toBe(true);
    enabled.delete("autoSwitchRefreshAllBeforeSwitchEnabled");
    expect(isAutoSwitchRefreshAllBeforeSwitchEnabled()).toBe(false);
  });
  it("publishes the shared freshness limit for normalized refresh settings", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) => (key === "autoRefreshMinutes" ? 60 : fallback)
    } as never);
    expect(new ExtensionSettingsStore().getDashboardSettings().quotaFreshnessMs).toBe(125 * 60_000);
  });
  it("validates the VS Code batch gap and removes obsolete network and WebSocket controls", () => {
    expect([Number.NaN, -1, 0, 1, 2.6, 60, 100].map(normalizeSyncHeartbeatMinutes)).toEqual([5, 1, 1, 1, 3, 60, 60]);
    const properties = JSON.parse(readFileSync("package.json", "utf8")).contributes.configuration.properties;
    expect(properties["codexManager.debugNetwork"]).toBeUndefined();
    expect(properties["codexManager.encryptedSyncWebSocketHeartbeatSeconds"]).toBeUndefined();
    expect(properties["codexManager.encryptedSyncCurrentAccountOnlyEnabled"]).toBeUndefined();
    const overlay = readFileSync("webview-src/dashboard/settingsOverlay.tsx", "utf8");
    expect(overlay).not.toContain("debugNetwork");
    expect(overlay).not.toContain("WebSocket heartbeat gap");
  });

  it("keeps claim checks on while full cross-PC account sync defaults off", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest.contributes.configuration.properties["codexManager.encryptedSyncEnabled"].default).toBe(true);
    expect(manifest.contributes.configuration.properties["codexManager.encryptedSyncClaimAllAccountsEnabled"].default).toBe(false);
    expect(manifest.contributes.configuration.properties["codexManager.fullCrossPcAccountSyncEnabled"].default).toBe(
      false
    );
    expect(manifest.contributes.configuration.properties["codexManager.encryptedSyncVsCodeHeartbeatMinutes"].default).toBe(5);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (_key: string, fallback?: unknown) => fallback,
      inspect: vi.fn(),
      update: vi.fn()
    } as never);
    expect(new ExtensionSettingsStore().getDashboardSettings().encryptedSyncEnabled).toBe(true);
    expect(new ExtensionSettingsStore().getDashboardSettings().encryptedSyncClaimAllAccountsEnabled).toBe(false);
    expect(new ExtensionSettingsStore().getDashboardSettings().fullCrossPcAccountSyncEnabled).toBe(false);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) => (key === "encryptedSyncEnabled" ? false : fallback),
      inspect: vi.fn(),
      update: vi.fn()
    } as never);
    expect(new ExtensionSettingsStore().getDashboardSettings().encryptedSyncEnabled).toBe(false);
  });
  it("publishes privacy mode as a shared disabled-by-default setting", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
      update: vi.fn(),
      inspect: vi.fn()
    } as never);

    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
    };

    expect(manifest.contributes.configuration.properties["codexManager.privacyMode"]?.default).toBe(false);
    expect(new ExtensionSettingsStore().getDashboardSettings().privacyMode).toBe(false);
  });

  it("keeps parallel window accounts machine-local and disabled by default", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
      update: vi.fn(),
      inspect: vi.fn()
    } as never);
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest.contributes.configuration.properties["codexManager.crossWindowAccountModeEnabled"]).toMatchObject({
      default: false,
      scope: "machine",
      ignoreSync: true
    });
    expect(new ExtensionSettingsStore().getDashboardSettings().crossWindowAccountModeEnabled).toBe(false);
  });

  it("keeps 5-hour quota control enabled without exposing a setting", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
      update: vi.fn(),
      inspect: vi.fn()
    } as never);

    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
    };

    expect(manifest.contributes.configuration.properties["codexManager.hourlyQuotaControlEnabled"]).toBeUndefined();
    expect(new ExtensionSettingsStore().getDashboardSettings().hourlyQuotaControlEnabled).toBe(true);
    expect(isHourlyQuotaControlEnabled()).toBe(true);
  });

  it("uses the requested switching and warning defaults", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
      update: vi.fn(),
      inspect: vi.fn((key: string) => (key === "quotaWarningWeeklyThreshold" ? { defaultValue: 1 } : undefined))
    } as never);

    const settings = new ExtensionSettingsStore().getDashboardSettings();
    expect(settings.autoSwitchHourlyThreshold).toBe(5);
    expect(settings.autoSwitchWeeklyThreshold).toBe(0);
    expect(settings.quotaWarningThreshold).toBe(10);
    expect(settings.quotaWarningWeeklyThreshold).toBe(1);
  });

  it("keeps warning thresholds selectable at one percentage point", () => {
    expect(normalizeQuotaWarningThreshold(9)).toBe(9);
    expect(normalizeQuotaWarningThreshold(10.6)).toBe(11);
    expect(normalizeQuotaWarningWeeklyThreshold(1)).toBe(1);
    expect(normalizeQuotaWarningWeeklyThreshold(4)).toBe(4);
    expect(
      getQuotaWarningThresholds({
        get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
        update: vi.fn(),
        inspect: vi.fn((key: string) => (key === "quotaWarningWeeklyThreshold" ? { defaultValue: 1 } : undefined))
      } as never)
    ).toEqual({ hourly: 10, weekly: 1 });
  });

  it("defaults the reset threshold and keeps workspace settings limited to enablement and transport", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest.contributes.configuration.properties["codexManager.autoResetWeeklyThreshold"]).toMatchObject({
      minimum: 0,
      default: 0
    });
    expect(manifest.contributes.configuration.properties["codexManager.codexSessionDefault"]).toBeUndefined();
    expect(manifest.contributes.configuration.properties["codexManager.codexSessionTransport"]).toBeUndefined();
    expect(normalizeAutoResetWeeklyThreshold(-1)).toBe(0);
    expect(normalizeAutoResetWeeklyThreshold(0)).toBe(0);
    expect(normalizeAutoResetWeeklyThreshold(101)).toBe(100);
    expect(normalizeAutoResetWeeklyThreshold(Number.NaN)).toBe(0);
  });
});
