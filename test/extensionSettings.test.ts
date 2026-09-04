import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import {
  ExtensionSettingsStore,
  getQuotaWarningThresholds,
  isHourlyQuotaControlEnabled,
  normalizeQuotaWarningThreshold,
  normalizeQuotaWarningWeeklyThreshold
} from "../src/infrastructure/config/extensionSettings";

describe("5-hour quota control defaults", () => {
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

  it("defaults to enabled in both the extension manifest and runtime fallbacks", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
      update: vi.fn(),
      inspect: vi.fn()
    } as never);

    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
    };

    expect(
      manifest.contributes.configuration.properties["codexManager.hourlyQuotaControlEnabled"]?.default
    ).toBe(true);
    expect(new ExtensionSettingsStore().getDashboardSettings().hourlyQuotaControlEnabled).toBe(true);
    expect(isHourlyQuotaControlEnabled()).toBe(true);
  });

  it("uses the requested switching and warning defaults", () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
      update: vi.fn(),
      inspect: vi.fn((key: string) => key === "quotaWarningWeeklyThreshold" ? { defaultValue: 1 } : undefined)
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
    expect(getQuotaWarningThresholds({
      get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
      update: vi.fn(),
      inspect: vi.fn((key: string) => key === "quotaWarningWeeklyThreshold" ? { defaultValue: 1 } : undefined)
    } as never)).toEqual({ hourly: 10, weekly: 1 });
  });
});
