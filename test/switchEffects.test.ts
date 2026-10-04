import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoReloadWindowForAccount,
  reloadWindowNow,
  promptWindowReloadForAccount,
  scheduleExtensionHostReload
} from "../src/application/accounts/switchEffects";
import { setCurrentWindowRuntimeAccountId } from "../src/presentation/workbench/windowRuntimeAccount";

describe("account switch reload effects", () => {
  it("joins concurrent Reload actions in one capture and restart", async () => {
    let release: (() => void) | undefined;
    vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command) => {
      if (command === "codexManager.prepareDashboardForExtensionHostRestart")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return undefined;
    });
    const first = reloadWindowNow();
    const second = reloadWindowNow();
    release?.();
    await Promise.all([first, second]);
    expect(
      vi
        .mocked(vscode.commands.executeCommand)
        .mock.calls.filter(([command]) => command === "workbench.action.restartExtensionHost")
    ).toHaveLength(1);
  });

  it("does not bypass capture failure through either reload command", async () => {
    vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error("storage full"));
    await expect(reloadWindowNow()).rejects.toThrow("storage full");
    expect(vscode.commands.executeCommand).toHaveBeenCalledOnce();
  });

  it("upgrades preservation when a later scheduled request needs it", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
      scheduleExtensionHostReload(undefined, 10, "first", false);
      scheduleExtensionHostReload(undefined, 10, "second", true);
      await vi.advanceTimersByTimeAsync(10);
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "codexManager.prepareDashboardForExtensionHostRestart",
        { autoResume: true }
      );
    } finally {
      vi.useRealTimers();
    }
  });
  beforeEach(() => {
    vi.mocked(vscode.commands.executeCommand).mockReset();
    vi.mocked(vscode.window.showInformationMessage).mockReset();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) => (key === "crossWindowAccountModeEnabled" ? true : fallback)
    } as vscode.WorkspaceConfiguration);
    setCurrentWindowRuntimeAccountId("current-account");
  });

  it("schedules automatic reload without a second prompt for shared-account windows", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: (_key: string, fallback?: unknown) => fallback
      } as vscode.WorkspaceConfiguration);
      vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
      await expect(promptWindowReloadForAccount({ id: "shared-next", email: "next@example.com" })).resolves.toBe(true);
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "codexManager.prepareDashboardForExtensionHostRestart",
        { autoResume: true }
      );
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.restartExtensionHost");
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the extension host without reloading the full window when possible", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);

    await expect(autoReloadWindowForAccount("next-account")).resolves.toBe(true);

    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(
      1,
      "codexManager.prepareDashboardForExtensionHostRestart",
      { autoResume: true }
    );
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(2, "notifications.clearAll");
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(3, "workbench.action.restartExtensionHost");
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
  });

  it("falls back to a full window reload when the extension host restart fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue("Reload Now" as never);
    vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command: string) => {
      if (command === "workbench.action.restartExtensionHost") {
        throw new Error("Command unavailable");
      }
      return undefined;
    });

    await expect(promptWindowReloadForAccount({ id: "next-account", email: "next@example.com" })).resolves.toBe(true);

    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(
      1,
      "codexManager.prepareDashboardForExtensionHostRestart",
      { autoResume: true }
    );
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(2, "notifications.clearAll");
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(3, "workbench.action.restartExtensionHost");
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(4, "workbench.action.reloadWindow");
  });

  it("captures goal-filtered sessions for the manual Reload button", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    await expect(reloadWindowNow()).resolves.toBe(true);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "codexManager.prepareDashboardForExtensionHostRestart",
      { autoResume: true }
    );
  });

  it("continues a requested reload if clearing stale notifications fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command: string) => {
      if (command === "notifications.clearAll") throw new Error("Clear unavailable");
      return undefined;
    });

    await expect(autoReloadWindowForAccount("next-account")).resolves.toBe(true);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("notifications.clearAll");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.restartExtensionHost");
  });

  it("reports a delayed unload reload failure to both its host callback and VS Code", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const secondHostError = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command: string) => {
      if (command === "workbench.action.restartExtensionHost" || command === "workbench.action.reloadWindow") {
        throw new Error("Reload unavailable");
      }
      return undefined;
    });

    scheduleExtensionHostReload(onError, 10);
    scheduleExtensionHostReload(secondHostError, 10);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "codexManager.prepareDashboardForExtensionHostRestart",
      { autoResume: false }
    );
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("Reload unavailable"));
    expect(secondHostError).toHaveBeenCalledWith(expect.stringContaining("Reload unavailable"));
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Reload unavailable"));
    vi.useRealTimers();
  });

  it("coalesces duplicate delayed reload requests into one host restart", async () => {
    vi.useFakeTimers();
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);

    const first = scheduleExtensionHostReload(undefined, 10);
    const second = scheduleExtensionHostReload(undefined, 10);
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(10);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.restartExtensionHost");
    expect(
      vi
        .mocked(vscode.commands.executeCommand)
        .mock.calls.filter(([command]) => command === "workbench.action.restartExtensionHost")
    ).toHaveLength(1);
    vi.useRealTimers();
  });
});
