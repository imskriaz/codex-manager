import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { handleDashboardSettingUpdate, pickDashboardCodexCliPath } from "../src/presentation/dashboard/settings";

describe("handleDashboardSettingUpdate", () => {
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

  it("accepts the optional always-online host toggle", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn(() => ({ key: "codexManager.webDashboardAlwaysOnlineEnabled", defaultValue: false }))
    } as never);
    await expect(handleDashboardSettingUpdate("webDashboardAlwaysOnlineEnabled", true)).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith("webDashboardAlwaysOnlineEnabled", true, vscode.ConfigurationTarget.Global);
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
