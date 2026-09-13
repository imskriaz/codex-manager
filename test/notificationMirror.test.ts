import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  enableTransientVscodeNotices,
  resolveMirroredNotification,
  runWithNativeCommandWarnings,
  subscribeToVscodeNotifications,
  type MirroredNotification
} from "../src/utils/notificationMirror";

describe("VS Code notification mirror", () => {
  afterEach(() => {
    vi.mocked(vscode.window.showInformationMessage).mockReset();
    vi.mocked(vscode.window.showWarningMessage).mockReset();
    vi.mocked(vscode.window.showErrorMessage).mockReset();
    vi.mocked(vscode.window.setStatusBarMessage).mockReset();
  });

  it("mirrors ordinary native notices while preserving the native call", async () => {
    const native = vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce(undefined);
    const notices: MirroredNotification[] = [];
    const subscription = subscribeToVscodeNotifications((notice) => notices.push(notice));

    await vscode.window.showInformationMessage("Quota refreshed.");

    expect(native).toHaveBeenCalledWith("Quota refreshed.");
    expect(notices).toEqual([{ level: "info", message: "Quota refreshed." }]);
    subscription.dispose();
  });

  it("lets a browser confirmation resolve the same pending native choice", async () => {
    let releaseNative!: (value: string | undefined) => void;
    const nativePromise = new Promise<string | undefined>((resolve) => {
      releaseNative = resolve;
    });
    vi.mocked(vscode.window.showWarningMessage).mockReturnValue(nativePromise as never);
    let mirrored: MirroredNotification | undefined;
    const subscription = subscribeToVscodeNotifications((notice) => {
      mirrored = notice;
    });

    const resultPromise = vscode.window.showWarningMessage("Reload now?", "Reload", "Later");
    expect(mirrored?.notificationId).toBeTypeOf("string");
    expect(resolveMirroredNotification(mirrored!.notificationId!, "Reload")).toBe(true);
    await expect(resultPromise).resolves.toBe("Reload");
    releaseNative(undefined);
    subscription.dispose();
  });

  it("replaces passive notices and clears the last one on extension shutdown", async () => {
    const nativeInfo = vi.mocked(vscode.window.showInformationMessage);
    const nativeWarning = vi.mocked(vscode.window.showWarningMessage);
    const first = { dispose: vi.fn() };
    const second = { dispose: vi.fn() };
    vi.mocked(vscode.window.setStatusBarMessage).mockReturnValueOnce(first).mockReturnValueOnce(second);
    const quietNotices = enableTransientVscodeNotices();

    await expect(vscode.window.showInformationMessage("Quota refreshed.")).resolves.toBeUndefined();
    await expect(vscode.window.showWarningMessage("Quota is low.")).resolves.toBeUndefined();

    expect(nativeInfo).not.toHaveBeenCalled();
    expect(nativeWarning).not.toHaveBeenCalled();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(vscode.window.setStatusBarMessage).toHaveBeenNthCalledWith(1, "$(info) Codex Manager: Quota refreshed.", 10_000);
    expect(vscode.window.setStatusBarMessage).toHaveBeenNthCalledWith(2, "$(warning) Codex Manager: Quota is low.", 10_000);

    quietNotices.dispose();
    expect(second.dispose).toHaveBeenCalledOnce();
  });

  it("keeps actionable and error notifications native", async () => {
    const nativeInfo = vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce("Reload" as never);
    const nativeError = vi.mocked(vscode.window.showErrorMessage).mockResolvedValueOnce(undefined);
    const quietNotices = enableTransientVscodeNotices();

    await expect(vscode.window.showInformationMessage("Reload now?", "Reload", "Later")).resolves.toBe("Reload");
    await vscode.window.showErrorMessage("Refresh failed.");

    expect(nativeInfo).toHaveBeenCalledWith("Reload now?", "Reload", "Later");
    expect(nativeError).toHaveBeenCalledWith("Refresh failed.");
    expect(vscode.window.setStatusBarMessage).not.toHaveBeenCalled();
    quietNotices.dispose();
  });

  it("keeps Command Palette warnings native and clears an earlier passive notice", async () => {
    const status = { dispose: vi.fn() };
    const commandSuccess = { dispose: vi.fn() };
    vi.mocked(vscode.window.setStatusBarMessage).mockReturnValueOnce(status).mockReturnValueOnce(commandSuccess);
    const nativeWarning = vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined);
    const nativeInfo = vi.mocked(vscode.window.showInformationMessage);
    const quietNotices = enableTransientVscodeNotices();

    await vscode.window.showInformationMessage("Ready.");
    await runWithNativeCommandWarnings(() => vscode.window.showWarningMessage("Refresh failed."));

    expect(status.dispose).toHaveBeenCalledOnce();
    expect(nativeWarning).toHaveBeenCalledWith("Refresh failed.");
    await runWithNativeCommandWarnings(() => vscode.window.showInformationMessage("Refresh complete."));
    expect(nativeInfo).not.toHaveBeenCalled();
    quietNotices.dispose();
    expect(commandSuccess.dispose).toHaveBeenCalledOnce();
  });

  it("replaces an unanswered native choice when a newer choice arrives", async () => {
    let releaseFirst!: (value: string | undefined) => void;
    const firstChoice = new Promise<string | undefined>((resolve) => {
      releaseFirst = resolve;
    });
    const nativeInfo = vi.mocked(vscode.window.showInformationMessage);
    nativeInfo
      .mockReturnValueOnce(firstChoice as never)
      .mockResolvedValueOnce("Use latest" as never);
    vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command: string) => {
      if (command === "notifications.clearAll") releaseFirst(undefined);
      return undefined;
    });
    const quietNotices = enableTransientVscodeNotices();

    const earlier = vscode.window.showInformationMessage("Earlier choice?", "Use earlier");
    await Promise.resolve();
    const latest = vscode.window.showInformationMessage("Latest choice?", "Use latest");

    await expect(earlier).resolves.toBeUndefined();
    await expect(latest).resolves.toBe("Use latest");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("notifications.clearAll");
    expect(nativeInfo).toHaveBeenCalledTimes(2);
    quietNotices.dispose();
  });
});
