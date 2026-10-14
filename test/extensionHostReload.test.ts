import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reloadExtensionHostWithSessionCapture } from "../src/utils/extensionHostReload";
import { subscribeToNotificationDelivery } from "../src/utils/notificationMirror";

describe("bounded shared extension host reload", () => {
  it("waits for push attempts before restarting and continues visibly after a delivery timeout", async () => {
    vi.useFakeTimers();
    const delivery = subscribeToNotificationDelivery(() => new Promise<void>(() => {}));
    try {
      vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
      const work = reloadExtensionHostWithSessionCapture(true);
      await vi.advanceTimersByTimeAsync(500);
      await work;
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Preparing to reload Codex Manager.");
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("browser notification delivery could not be confirmed"));
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.restartExtensionHost");
    } finally { delivery.dispose(); vi.useRealTimers(); }
  });
  beforeEach(() => {
    vi.mocked(vscode.commands.executeCommand).mockReset();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (_key: string, fallback: unknown) => fallback
    } as never);
  });

  it("continues reload when capture times out and retains a visible warning", async () => {
    vi.useFakeTimers();
    try {
      let finish: (() => void) | undefined;
      const execute = vi.mocked(vscode.commands.executeCommand);
      execute.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          })
      );
      const pending = reloadExtensionHostWithSessionCapture(true);
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toBeUndefined();
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("could not be fully preserved"));
      expect(execute).toHaveBeenCalledWith("workbench.action.restartExtensionHost");
      expect(execute).toHaveBeenCalledTimes(2);
      expect((execute.mock.calls[0][1] as { signal: AbortSignal }).signal.aborted).toBe(true);
      finish?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never issues fallback reload after an uncertain restart timeout", async () => {
    vi.useFakeTimers();
    try {
      let finish: (() => void) | undefined;
      const execute = vi.mocked(vscode.commands.executeCommand);
      execute.mockImplementation((command) =>
        command === "workbench.action.restartExtensionHost"
          ? new Promise<void>((resolve) => {
              finish = resolve;
            })
          : Promise.resolve(undefined)
      );
      const pending = reloadExtensionHostWithSessionCapture(true);
      const failed = expect(pending).rejects.toThrow("did not acknowledge");
      await vi.advanceTimersByTimeAsync(45_000);
      await failed;
      expect(execute).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
      finish?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let optional notification clearing stall a successful reload", async () => {
    vi.useFakeTimers();
    try {
      let finish: (() => void) | undefined;
      const execute = vi.mocked(vscode.commands.executeCommand);
      execute.mockImplementation((command) =>
        command === "notifications.clearAll"
          ? new Promise<void>((resolve) => {
              finish = resolve;
            })
          : Promise.resolve(undefined)
      );
      const pending = reloadExtensionHostWithSessionCapture(true, true);
      await vi.advanceTimersByTimeAsync(2_000);
      await pending;
      expect(execute).toHaveBeenCalledWith("workbench.action.restartExtensionHost");
      finish?.();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reloads the full window after capture when updated configuration contributions are missing", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (_key: string, fallback: unknown) => fallback, inspect: () => undefined } as never);
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    await reloadExtensionHostWithSessionCapture(true);
    expect(vscode.commands.executeCommand.mock.calls.map(call => call[0])).toEqual(["codexManager.prepareDashboardForExtensionHostRestart", "workbench.action.reloadWindow"]);
  });

  it("joins automatic and explicit reload callers into one shared workflow", async () => {
    let finish: (() => void) | undefined;
    const execute = vi.mocked(vscode.commands.executeCommand);
    execute.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    execute.mockResolvedValue(undefined);
    const first = reloadExtensionHostWithSessionCapture(true);
    const second = reloadExtensionHostWithSessionCapture(true, true);
    expect(second).toBe(first);
    finish?.();
    await Promise.all([first, second]);
    expect(execute.mock.calls.filter(([command]) => command === "workbench.action.restartExtensionHost")).toHaveLength(
      1
    );
  });
});
