import { readFileSync } from "fs";
import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { scheduleAutomaticExtensionHostRefresh } from "../src/utils/extensionHostRecovery";

describe("automatic extension host recovery", () => {
  it("does not restart after a successful activation", () => {
    const extension = readFileSync("src/extension.ts", "utf8");
    const activationBoundary = extension.slice(
      extension.indexOf("try {\n    await workbench.activate();"),
      extension.indexOf("function resolveExtensionVersion")
    );

    expect(activationBoundary).toMatch(/await workbench\.activate\(\);\s*}\s*catch/);
    expect(activationBoundary.match(/scheduleAutomaticExtensionHostRefresh/g)).toHaveLength(1);
  });

  it("persists the recovery marker before restarting the host", async () => {
    vi.useFakeTimers();
    let finishUpdate: (() => void) | undefined;
    const update = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishUpdate = resolve;
        })
    );
    const context = { globalState: { get: vi.fn(() => undefined), update } } as never;

    scheduleAutomaticExtensionHostRefresh(context, "1.2.8-pre1", 50);
    await vi.advanceTimersByTimeAsync(50);

    expect(update).toHaveBeenCalledWith("codexManager.lastAutomaticRecoveryVersion", "1.2.8-pre1");
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();

    finishUpdate?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.restartExtensionHost");
    vi.useRealTimers();
  });

  it("does not restart repeatedly for the same failed version", async () => {
    vi.useFakeTimers();
    const execute = vi.mocked(vscode.commands.executeCommand);
    execute.mockClear();
    const context = { globalState: { get: vi.fn(() => "1.2.8-pre1"), update: vi.fn() } } as never;

    scheduleAutomaticExtensionHostRefresh(context, "1.2.8-pre1", 50);
    await vi.advanceTimersByTimeAsync(50);

    expect(execute).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("coalesces repeated recovery requests while marker persistence is pending", async () => {
    vi.useFakeTimers();
    const execute = vi.mocked(vscode.commands.executeCommand);
    execute.mockClear();
    let finishUpdate: (() => void) | undefined;
    const update = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishUpdate = resolve;
        })
    );
    const context = { globalState: { get: vi.fn(() => undefined), update } } as never;

    scheduleAutomaticExtensionHostRefresh(context, "1.2.8", 50);
    scheduleAutomaticExtensionHostRefresh(context, "1.2.8", 50);
    expect(update).toHaveBeenCalledTimes(1);
    finishUpdate?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("workbench.action.restartExtensionHost");
    vi.useRealTimers();
  });

  it("does not restart when the recovery marker cannot be persisted", async () => {
    vi.useFakeTimers();
    const execute = vi.mocked(vscode.commands.executeCommand);
    execute.mockClear();
    const showError = vi.mocked(vscode.window.showErrorMessage);
    showError.mockClear();
    const context = {
      globalState: { get: vi.fn(() => undefined), update: vi.fn().mockRejectedValue(new Error("storage unavailable")) }
    } as never;

    scheduleAutomaticExtensionHostRefresh(context, "1.2.8-pre2", 50);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);

    expect(execute).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith(expect.stringContaining("could not safely retry activation"));
    vi.useRealTimers();
  });

  it("falls back to a full window reload when host restart is unavailable", async () => {
    vi.useFakeTimers();
    const execute = vi.mocked(vscode.commands.executeCommand);
    execute.mockReset();
    execute.mockImplementation(async (command) => {
      if (command === "workbench.action.restartExtensionHost") {
        throw new Error("restart unavailable");
      }
      return undefined;
    });
    const context = { globalState: { get: vi.fn(() => undefined), update: vi.fn().mockResolvedValue(undefined) } } as never;

    scheduleAutomaticExtensionHostRefresh(context, "1.2.8-pre1", 50);
    await vi.advanceTimersByTimeAsync(50);

    expect(execute).toHaveBeenNthCalledWith(1, "workbench.action.restartExtensionHost");
    expect(execute).toHaveBeenNthCalledWith(2, "workbench.action.reloadWindow");
    vi.useRealTimers();
  });
});
