import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { handleDashboardSettingUpdate, pickDashboardCodexCliPath } from "../src/presentation/dashboard/settings";

describe("handleDashboardSettingUpdate", () => {
  it('persists the bounded workspace file limit and rejects nonnumeric or nonfinite values', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: vi.fn(), update, inspect: vi.fn() } as never);
    for (const [value, expected] of [[0, 1], [10, 10], [100, 16], [2.5, 3]]) {
      expect(await handleDashboardSettingUpdate('workspaceTextFileLimitMb', value)).toBe(true);
      expect(update).toHaveBeenLastCalledWith('workspaceTextFileLimitMb', expected, vscode.ConfigurationTarget.Global);
    }
    for (const value of [NaN, Infinity, '10']) expect(await handleDashboardSettingUpdate('workspaceTextFileLimitMb', value)).toBe(false);
  });
  it('stores model-capacity settings globally and validates the failure threshold', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: vi.fn(), update, inspect: vi.fn() } as never);
    for (const [value, expected] of [[0, 1], [3, 3], [1000, 100], [2.5, 3]]) {
      expect(await handleDashboardSettingUpdate('modelCapacityFailureCount', value)).toBe(true);
      expect(update).toHaveBeenLastCalledWith('modelCapacityFailureCount', expected, vscode.ConfigurationTarget.Global);
    }
    for (const value of [NaN, Infinity, '3']) expect(await handleDashboardSettingUpdate('modelCapacityFailureCount', value)).toBe(false);
    expect(await handleDashboardSettingUpdate('modelCapacityAutoSwitchEnabled', false)).toBe(true);
    expect(update).toHaveBeenLastCalledWith('modelCapacityAutoSwitchEnabled', false, vscode.ConfigurationTarget.Global);
  });
  it("persists a bounded token history gap and rejects text", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: vi.fn(), update, inspect: vi.fn() } as never);
    for (const [value, expected] of [[1, 1], [1440, 1440], [2000, 1440], [0, 1], [NaN, 60]]) {
      await expect(handleDashboardSettingUpdate("dailyTokenUsageIntervalMinutes", value)).resolves.toBe(true);
      expect(update).toHaveBeenLastCalledWith("dailyTokenUsageIntervalMinutes", expected, vscode.ConfigurationTarget.Global);
    }
    update.mockClear();
    await expect(handleDashboardSettingUpdate("dailyTokenUsageIntervalMinutes", "1")).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
  it("persists the token history toggle and rejects non-boolean values", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: vi.fn(), update,
      inspect: vi.fn(() => ({ key: "codexManager.dailyTokenUsageEnabled", defaultValue: false })) } as never);
    await expect(handleDashboardSettingUpdate("dailyTokenUsageEnabled", true)).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith("dailyTokenUsageEnabled", true, vscode.ConfigurationTarget.Global);
    update.mockClear();
    await expect(handleDashboardSettingUpdate("dailyTokenUsageEnabled", "true")).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
  it("always stores privacy mode globally so every surface shares it", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn(() => ({
        key: "codexManager.privacyMode",
        defaultValue: false,
        workspaceValue: false
      }))
    } as never);

    await expect(handleDashboardSettingUpdate("privacyMode", true)).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith("privacyMode", true, vscode.ConfigurationTarget.Global);
  });

  it("stores a selected Codex CLI executable at machine scope", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([{ fsPath: "C:\\Tools\\codex.exe" }] as never);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn(() => ({ key: "codexManager.codexCliPath", defaultValue: "" }))
    } as never);

    await expect(pickDashboardCodexCliPath({ resolveLanguage: () => "en" })).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith("codexCliPath", "C:\\Tools\\codex.exe", vscode.ConfigurationTarget.Global);
  });

  it("reports Codex CLI path picker cancellation without changing settings", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn()
    } as never);

    await expect(pickDashboardCodexCliPath({ resolveLanguage: () => "en" })).resolves.toBe(false);

    expect(update).not.toHaveBeenCalled();
  });

  it("accepts the cross-system WebSocket toggle", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn(() => ({ key: "codexManager.webSocketServerEnabled", defaultValue: false }))
    } as never);
    await expect(handleDashboardSettingUpdate("webSocketServerEnabled", true)).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith("webSocketServerEnabled", true, vscode.ConfigurationTarget.Global);
  });

  it("persists the Always Active host toggle globally", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const values = new Map<string, unknown>();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => values.has(key) ? values.get(key) : fallback),
      update,
      inspect: vi.fn(() => ({ key: "codexManager.alwaysActive", defaultValue: false }))
    } as never);
    update.mockImplementation(async (key, value) => { values.set(key, value); });
    await expect(handleDashboardSettingUpdate("alwaysActive", true)).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith("alwaysActive", true, vscode.ConfigurationTarget.Global);
    update.mockClear();
    await expect(handleDashboardSettingUpdate("alwaysActive", "true")).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("updates the workspace value when an effective setting is overridden there", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn(() => ({
        key: "codexManager.autoSwitchReloadWindowEnabled",
        defaultValue: false,
        globalValue: true,
        workspaceValue: false
      }))
    } as never);

    await expect(handleDashboardSettingUpdate("autoSwitchReloadWindowEnabled", true)).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith("autoSwitchReloadWindowEnabled", true, vscode.ConfigurationTarget.Workspace);
  });

  it("uses global settings when there is no workspace override", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn(() => ({
        key: "codexManager.autoSwitchReloadWindowEnabled",
        defaultValue: false
      }))
    } as never);

    await expect(handleDashboardSettingUpdate("autoSwitchReloadWindowEnabled", true)).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith("autoSwitchReloadWindowEnabled", true, vscode.ConfigurationTarget.Global);
  });

  it("stores autoResumeEnabled globally", async () => {
    const key = "autoResumeEnabled";
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn(() => ({
        key: "codexManager.autoResumeEnabled",
        defaultValue: false,
        workspaceValue: false
      }))
    } as never);

    await expect(handleDashboardSettingUpdate(key, true)).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith(key, true, vscode.ConfigurationTarget.Global);
  });

  it("stores parallel window mode globally and only after an explicit toggle", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn((_key: string, fallback?: unknown) => fallback);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get,
      update,
      inspect: vi.fn(() => ({
        key: "codexManager.crossWindowAccountModeEnabled",
        defaultValue: false,
        workspaceValue: true
      }))
    } as never);

    await expect(handleDashboardSettingUpdate("crossWindowAccountModeEnabled", true)).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith(
      "crossWindowAccountModeEnabled",
      true,
      vscode.ConfigurationTarget.Global
    );
  });

  it("always stores the workspace master gate on this PC", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn(() => ({
        key: "codexManager.cliIntegrationEnabled",
        defaultValue: false,
        workspaceValue: true
      }))
    } as never);

    await expect(handleDashboardSettingUpdate("cliIntegrationEnabled", false)).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith("cliIntegrationEnabled", false, vscode.ConfigurationTarget.Global);
  });

  it("preserves the legacy shared warning value before changing the 5-hour threshold", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => (key === "quotaWarningThreshold" ? 35 : fallback)),
      update,
      inspect: vi.fn((key: string) => ({
        key: `codexManager.${key}`,
        defaultValue: 20
      }))
    } as never);

    await expect(handleDashboardSettingUpdate("quotaWarningThreshold", 10)).resolves.toBe(true);

    expect(update).toHaveBeenNthCalledWith(
      1,
      "quotaWarningWeeklyThreshold",
      35,
      vscode.ConfigurationTarget.Global
    );
    expect(update).toHaveBeenNthCalledWith(2, "quotaWarningThreshold", 10, vscode.ConfigurationTarget.Global);
  });

  it("updates the weekly warning threshold independently", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn(() => ({ key: "codexManager.quotaWarningWeeklyThreshold", defaultValue: 0 }))
    } as never);

    await expect(handleDashboardSettingUpdate("quotaWarningWeeklyThreshold", 33)).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith("quotaWarningWeeklyThreshold", 33, vscode.ConfigurationTarget.Global);
  });

  it("accepts zero as the weekly warning threshold", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn(() => ({ key: "codexManager.quotaWarningWeeklyThreshold", defaultValue: 0 }))
    } as never);

    await expect(handleDashboardSettingUpdate("quotaWarningWeeklyThreshold", 0)).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith("quotaWarningWeeklyThreshold", 0, vscode.ConfigurationTarget.Global);
  });

  it("preserves the shared warning value at the existing workspace scope", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => (key === "quotaWarningThreshold" ? 40 : fallback)),
      update,
      inspect: vi.fn((key: string) =>
        key === "quotaWarningThreshold"
          ? { key: "codexManager.quotaWarningThreshold", defaultValue: 20, workspaceValue: 40 }
          : { key: `codexManager.${key}`, defaultValue: 20 }
      )
    } as never);

    await expect(handleDashboardSettingUpdate("quotaWarningThreshold", 15)).resolves.toBe(true);

    expect(update).toHaveBeenNthCalledWith(
      1,
      "quotaWarningWeeklyThreshold",
      40,
      vscode.ConfigurationTarget.Workspace
    );
    expect(update).toHaveBeenNthCalledWith(2, "quotaWarningThreshold", 15, vscode.ConfigurationTarget.Workspace);
  });
});


it("bounds token history retention independently from quota retention", async () => {
  const update = vi.fn().mockResolvedValue(undefined);
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: vi.fn(), update, inspect: () => ({}) } as never);
  await expect(handleDashboardSettingUpdate("tokenHistoryRetentionDays", 120)).resolves.toBe(true);
  expect(update).toHaveBeenCalledWith("tokenHistoryRetentionDays", 90, vscode.ConfigurationTarget.Global);
});
