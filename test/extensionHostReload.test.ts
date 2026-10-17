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
      expect(execute).toHaveBeenCalledTimes(3);
      expect(execute).toHaveBeenCalledWith("codexManager.closeEditorsForExtensionHostRestart", expect.objectContaining({ closeSessions: false }));
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

  it("uses one 500ms budget across capture, notification clearing and delivery for automatic reload", async () => {
    vi.useFakeTimers();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback: unknown) =>
      key === "autoSwitchReloadWindowEnabled" ? true : fallback } as never);
    const warningCount = vi.mocked(vscode.window.showWarningMessage).mock.calls.length;
    const delivery = subscribeToNotificationDelivery(() => new Promise(() => undefined));
    vi.mocked(vscode.commands.executeCommand).mockImplementation(name =>
      name === "codexManager.prepareDashboardForExtensionHostRestart" || name === "notifications.clearAll"
        ? new Promise(() => undefined) : Promise.resolve(undefined));
    try {
      const work = reloadExtensionHostWithSessionCapture(true, true, true);
      await vi.advanceTimersByTimeAsync(500);
      await work;
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.restartExtensionHost");
      expect(vscode.window.showWarningMessage.mock.calls.slice(warningCount)).not.toContainEqual(
        expect.arrayContaining([expect.stringContaining("could not be fully preserved")])
      );
    } finally { delivery.dispose(); vi.useRealTimers(); }
  });

  it("restores the dashboard after both restart commands fail and permits a new retry", async () => {
    vi.mocked(vscode.commands.executeCommand).mockImplementation(async name => {
      if (name === "workbench.action.restartExtensionHost" || name === "workbench.action.reloadWindow") throw new Error("unavailable");
    });
    await expect(reloadExtensionHostWithSessionCapture(true)).rejects.toThrow("unavailable");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("codexManager.restoreDashboardAfterExtensionHostRestart");
    vi.mocked(vscode.commands.executeCommand).mockReset().mockResolvedValue(undefined);
    await expect(reloadExtensionHostWithSessionCapture(true)).resolves.toBeUndefined();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.restartExtensionHost");
  });

  it("reloads the full window after capture when updated configuration contributions are missing", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (_key: string, fallback: unknown) => fallback, inspect: () => undefined } as never);
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    await reloadExtensionHostWithSessionCapture(true);
    expect(vscode.commands.executeCommand.mock.calls.map(call => call[0])).toEqual(["codexManager.prepareDashboardForExtensionHostRestart", "codexManager.closeEditorsForExtensionHostRestart", "workbench.action.reloadWindow"]);
  });

  it("closes editors after saving recovery and before restarting", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    await reloadExtensionHostWithSessionCapture(true);
    expect(vscode.commands.executeCommand.mock.calls.map(call => call[0])).toEqual([
      "codexManager.prepareDashboardForExtensionHostRestart", "codexManager.closeEditorsForExtensionHostRestart", "workbench.action.restartExtensionHost"
    ]);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("codexManager.closeEditorsForExtensionHostRestart", expect.objectContaining({ closeSessions: true }));
  });

  it.each(["refused", "timeout"])("continues visibly when editor cleanup is %s and aborts late work", async failure => {
    vi.useFakeTimers();
    let closingSignal: AbortSignal | undefined;
    vi.mocked(vscode.commands.executeCommand).mockImplementation(async (name, options) => {
      if (name !== "codexManager.closeEditorsForExtensionHostRestart") return;
      closingSignal = (options as { signal: AbortSignal }).signal;
      if (failure === "refused") throw new Error("Tabs could not close");
      await new Promise<void>(() => undefined);
    });
    try {
      const work = reloadExtensionHostWithSessionCapture(true);
      await vi.advanceTimersByTimeAsync(8_000);
      await work;
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("some Codex or Codex Manager tabs could not close"));
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.restartExtensionHost");
      expect(closingSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
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

  it.each(["capture", "clear", "delivery"])("a manual reload interrupts an automatic optional %s wait", async (phase) => {
    vi.useFakeTimers();
    let finish!: () => void;
    let delivery: { dispose(): void } | undefined;
    const execute = vi.mocked(vscode.commands.executeCommand);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback: unknown) => key === "autoSwitchReloadWindowEnabled" ? true : fallback
    } as never);
    execute.mockImplementation(name => {
      if ((phase === "capture" && name === "codexManager.prepareDashboardForExtensionHostRestart") ||
          (phase === "clear" && name === "notifications.clearAll"))
        return new Promise<void>(resolve => { finish = resolve; });
      return Promise.resolve(undefined);
    });
    if (phase === "delivery") delivery = subscribeToNotificationDelivery(() => new Promise<void>(resolve => { finish = resolve; }));
    try {
      const background = reloadExtensionHostWithSessionCapture(true, true, true);
      await vi.advanceTimersByTimeAsync(0);
      expect(execute).not.toHaveBeenCalledWith("workbench.action.restartExtensionHost");
      const manual = reloadExtensionHostWithSessionCapture(true);
      expect(manual).toBe(background);
      await vi.advanceTimersByTimeAsync(0);
      await manual;
      expect(execute.mock.calls.filter(([name]) => name === "workbench.action.restartExtensionHost")).toHaveLength(1);
      finish?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      delivery?.dispose();
      vi.useRealTimers();
    }
  });
});
