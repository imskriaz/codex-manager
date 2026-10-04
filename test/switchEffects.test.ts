import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoReloadWindowForAccount,
  deferWindowReloadForAccount,
  reloadWindowNow,
  promptWindowReloadForAccount,
  scheduleExtensionHostReload
} from "../src/application/accounts/switchEffects";
import {
  clearQueuedAccountSwitch,
  getQueuedAccountSwitch,
  setCurrentWindowRuntimeAccountId
} from "../src/presentation/workbench/windowRuntimeAccount";

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
      get: (key: string, fallback?: unknown) =>
        key === "crossWindowAccountModeEnabled" || key === "autoSwitchReloadWindowEnabled" ? true : fallback
    } as vscode.WorkspaceConfiguration);
    setCurrentWindowRuntimeAccountId("current-account");
    clearQueuedAccountSwitch();
  });

  it("schedules automatic reload without a second prompt for shared-account windows", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: (key: string, fallback?: unknown) => (key === "autoSwitchReloadWindowEnabled" ? true : fallback)
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

  it("queues shared-auth changes and offers an explicit reload when automatic reload is off", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (_key: string, fallback?: unknown) => fallback
    } as vscode.WorkspaceConfiguration);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue("Later" as never);
    await expect(promptWindowReloadForAccount({ id: "shared-next", email: "next@example.com" })).resolves.toBe(false);
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    expect(getQueuedAccountSwitch()?.toAccountId).toBe("shared-next");
  });

  it("keeps deferred and observed account changes pending while automatic reload is off", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (_key: string, fallback?: unknown) => fallback
    } as vscode.WorkspaceConfiguration);
    expect(deferWindowReloadForAccount("shared-next")).toBe(true);
    await expect(autoReloadWindowForAccount("shared-next")).resolves.toBe(false);
    expect(getQueuedAccountSwitch()?.toAccountId).toBe("shared-next");
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
  });

  it("allows a manually requested reload even when automatic reload is off", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (_key: string, fallback?: unknown) => fallback
    } as vscode.WorkspaceConfiguration);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue("Reload Now" as never);
    await expect(promptWindowReloadForAccount({ id: "shared-next", email: "next@example.com" })).resolves.toBe(true);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.restartExtensionHost");
    expect(getQueuedAccountSwitch()).toBeUndefined();
  });

  it("rechecks the reload preference after session capture and keeps the account queued", async () => {
    let finishCapture: (() => void) | undefined;
    vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command) => {
      if (command === "codexManager.prepareDashboardForExtensionHostRestart") {
        await new Promise<void>((resolve) => {
          finishCapture = resolve;
        });
      }
      return undefined;
    });
    const automatic = autoReloadWindowForAccount("next-account");
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (_key: string, fallback?: unknown) => fallback
    } as vscode.WorkspaceConfiguration);
    finishCapture?.();
    await expect(automatic).resolves.toBe(false);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.restartExtensionHost");
    expect(getQueuedAccountSwitch()?.toAccountId).toBe("next-account");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("Automatic reload is disabled")
    );
  });

  it("honors an explicit reload joined to an automatic capture after its setting changes", async () => {
    let finishCapture: (() => void) | undefined;
    vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command) => {
      if (command === "codexManager.prepareDashboardForExtensionHostRestart") {
        await new Promise<void>((resolve) => {
          finishCapture = resolve;
        });
      }
      return undefined;
    });
    const automatic = autoReloadWindowForAccount("next-account");
    const explicit = reloadWindowNow();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (_key: string, fallback?: unknown) => fallback
    } as vscode.WorkspaceConfiguration);
    finishCapture?.();
    await expect(Promise.all([automatic, explicit])).resolves.toEqual([true, true]);
    expect(
      vi
        .mocked(vscode.commands.executeCommand)
        .mock.calls.filter(([command]) => command === "workbench.action.restartExtensionHost")
    ).toHaveLength(1);
  });

  it("cancels a scheduled automatic reload when its preference changes", async () => {
    vi.useFakeTimers();
    try {
      deferWindowReloadForAccount("next-account");
      scheduleExtensionHostReload(undefined, 10, "Shared Codex account changed", true, true);
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: (_key: string, fallback?: unknown) => fallback
      } as vscode.WorkspaceConfiguration);
      await vi.advanceTimersByTimeAsync(10);
      expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
      expect(getQueuedAccountSwitch()?.toAccountId).toBe("next-account");
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("Automatic reload is disabled")
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves an explicit scheduled reload coalesced with an automatic request", async () => {
    vi.useFakeTimers();
    try {
      scheduleExtensionHostReload(undefined, 10, "automatic", true, true);
      scheduleExtensionHostReload(undefined, 10, "manual", true);
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: (_key: string, fallback?: unknown) => fallback
      } as vscode.WorkspaceConfiguration);
      await vi.advanceTimersByTimeAsync(10);
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.restartExtensionHost");
    } finally {
      vi.useRealTimers();
    }
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
