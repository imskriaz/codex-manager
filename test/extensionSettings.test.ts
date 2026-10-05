import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import {
  ExtensionSettingsStore,
  getQuotaWarningThresholds,
  isHourlyQuotaControlEnabled,
  normalizeQuotaWarningThreshold,
  normalizeQuotaWarningWeeklyThreshold,
  normalizeAutoResetWeeklyThreshold,
  isAutoResumeEnabled,
  isAutoSwitchRefreshAllBeforeSwitchEnabled
} from "../src/infrastructure/config/extensionSettings";

describe("5-hour quota control defaults", () => {
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
  it("keeps claim checks on while full cross-PC account sync defaults off", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest.contributes.configuration.properties["codexManager.encryptedSyncEnabled"].default).toBe(true);
    expect(manifest.contributes.configuration.properties["codexManager.fullCrossPcAccountSyncEnabled"].default).toBe(
      false
    );
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (_key: string, fallback?: unknown) => fallback,
      inspect: vi.fn(),
      update: vi.fn()
    } as never);
    expect(new ExtensionSettingsStore().getDashboardSettings().encryptedSyncEnabled).toBe(true);
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
    expect(manifest.contributes.configuration.properties["codexManager.codexSessionTransport"].default).toBe(
      "app-server-stdio"
    );
    expect(normalizeAutoResetWeeklyThreshold(-1)).toBe(0);
    expect(normalizeAutoResetWeeklyThreshold(0)).toBe(0);
    expect(normalizeAutoResetWeeklyThreshold(101)).toBe(100);
    expect(normalizeAutoResetWeeklyThreshold(Number.NaN)).toBe(0);
  });
});
