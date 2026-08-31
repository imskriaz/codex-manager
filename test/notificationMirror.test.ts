import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  resolveMirroredNotification,
  subscribeToVscodeNotifications,
  type MirroredNotification
} from "../src/utils/notificationMirror";

describe("VS Code notification mirror", () => {
  afterEach(() => {
    vi.mocked(vscode.window.showInformationMessage).mockReset();
    vi.mocked(vscode.window.showWarningMessage).mockReset();
    vi.mocked(vscode.window.showErrorMessage).mockReset();
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
});
