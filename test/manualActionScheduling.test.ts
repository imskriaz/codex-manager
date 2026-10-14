import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { runWithConcurrencyLimit, waitWithin } from "../src/utils/concurrency";
import { consumeDashboardActionNotice, withDashboardNotificationSuppression } from "../src/utils/notificationPolicy";
import { runRegisteredCommand } from "../src/commands";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("manual action scheduling", () => {
  it("retains command warnings for the initiating dashboard and leaves native notifications alone", async () => {
    const warning = vscode.window.showWarningMessage;
    vi.mocked(warning).mockClear();
    const notice = await withDashboardNotificationSuppression(async () => {
      void vscode.window.showInformationMessage("Starting refresh");
      void vscode.window.showWarningMessage("Account saved; quota unavailable");
      return consumeDashboardActionNotice();
    });
    expect(notice).toEqual({ level: "warning", message: "Account saved; quota unavailable" });
    expect(warning).not.toHaveBeenCalled();
  });
  it("starts the first batch immediately and spaces subsequent work", async () => {
    vi.useFakeTimers();
    const worker = vi.fn(async () => undefined);
    const work = runWithConcurrencyLimit([1, 2, 3], 2, worker, { delayMs: 300 });
    expect(worker.mock.calls).toEqual([[1, 0], [2, 1]]);
    await vi.advanceTimersByTimeAsync(299);
    expect(worker).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await work;
    expect(worker).toHaveBeenCalledTimes(3);
  });

  it("bounds optional work, observes a late failure and clears its timer", async () => {
    vi.useFakeTimers();
    let fail!: (error: Error) => void;
    const raw = new Promise<void>((_, reject) => { fail = reject; });
    const checked = expect(waitWithin(raw, 500, "still loading")).rejects.toThrow("still loading");
    await vi.advanceTimersByTimeAsync(500);
    await checked;
    fail(new Error("late failure"));
    await Promise.resolve();
    await expect(waitWithin(Promise.resolve("ready"), 500, "unused")).resolves.toBe("ready");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves Command Palette failures during overlapping dashboard requests and restores notifications", async () => {
    const original = vscode.window.showErrorMessage;
    vi.mocked(original).mockClear();
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = withDashboardNotificationSuppression(() => new Promise<void>(resolve => { finishFirst = resolve; }));
    const second = withDashboardNotificationSuppression(async () => {
      await new Promise<void>(resolve => { finishSecond = resolve; });
      void vscode.window.showErrorMessage("dashboard-only error");
    });
    finishFirst();
    await first;
    await expect(runRegisteredCommand("Manual refresh", () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(original).toHaveBeenCalledWith("Manual refresh failed: offline");
    finishSecond();
    await second;
    expect(original).not.toHaveBeenCalledWith("dashboard-only error");
    expect(vscode.window.showErrorMessage).toBe(original);
    await expect(withDashboardNotificationSuppression(() => { throw new Error("sync failure"); })).rejects.toThrow("sync failure");
    expect(vscode.window.showErrorMessage).toBe(original);
  });
});
