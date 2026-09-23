import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { scheduleAutomaticExtensionHostRefresh } from "../src/utils/extensionHostRecovery";

describe("automatic extension host recovery", () => {
  it("restarts the host once when a new extension version is activated", async () => {
    vi.useFakeTimers();
    const update = vi.fn().mockResolvedValue(undefined);
    const context = { globalState: { get: vi.fn(() => undefined), update } } as never;

    scheduleAutomaticExtensionHostRefresh(context, "1.2.8-pre1", 50);
    await vi.advanceTimersByTimeAsync(50);

    expect(update).toHaveBeenCalledWith("codexManager.lastActivatedHostVersion", "1.2.8-pre1");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.restartExtensionHost");
    vi.useRealTimers();
  });

  it("does not restart repeatedly for the same activated version", async () => {
    vi.useFakeTimers();
    const execute = vi.mocked(vscode.commands.executeCommand);
    execute.mockClear();
    const context = { globalState: { get: vi.fn(() => "1.2.8-pre1"), update: vi.fn() } } as never;

    scheduleAutomaticExtensionHostRefresh(context, "1.2.8-pre1", 50);
    await vi.advanceTimersByTimeAsync(50);

    expect(execute).not.toHaveBeenCalled();
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
