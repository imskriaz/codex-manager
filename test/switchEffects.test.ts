import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoReloadWindowForAccount,
  promptWindowReloadForAccount,
  scheduleExtensionHostReload
} from "../src/application/accounts/switchEffects";
import { setCurrentWindowRuntimeAccountId } from "../src/presentation/workbench/windowRuntimeAccount";

describe("account switch reload effects", () => {
  beforeEach(() => {
    vi.mocked(vscode.commands.executeCommand).mockReset();
    vi.mocked(vscode.window.showInformationMessage).mockReset();
    setCurrentWindowRuntimeAccountId("current-account");
  });

  it("restarts the extension host without reloading the full window when possible", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);

    await expect(autoReloadWindowForAccount("next-account")).resolves.toBe(true);

    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(1, "codexManager.prepareDashboardForExtensionHostRestart");
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(2, "workbench.action.restartExtensionHost");
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

    await expect(
      promptWindowReloadForAccount({ id: "next-account", email: "next@example.com" })
    ).resolves.toBe(true);

    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(1, "codexManager.prepareDashboardForExtensionHostRestart");
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(2, "workbench.action.restartExtensionHost");
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(3, "workbench.action.reloadWindow");
  });

  it("reports a delayed unload reload failure to both its host callback and VS Code", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command: string) => {
      if (command === "workbench.action.restartExtensionHost" || command === "workbench.action.reloadWindow") {
        throw new Error("Reload unavailable");
      }
      return undefined;
    });

    scheduleExtensionHostReload(onError, 10);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("Reload unavailable"));
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Reload unavailable"));
    vi.useRealTimers();
  });
});
