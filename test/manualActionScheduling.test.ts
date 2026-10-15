import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { createSharedInspection, runWithConcurrencyLimit, waitWithin } from "../src/utils/concurrency";
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

  it("shares one inspection while keeping cancellation local to each consumer", async () => {
    let inspectCount = 0;
    let release!: (value: string) => void;
    const inspect = () => { inspectCount += 1; return new Promise<string>(resolve => { release = resolve; }); };
    const firstController = new AbortController();
    const first = createSharedInspection("test-session-snapshot", inspect, firstController.signal);
    const second = createSharedInspection("test-session-snapshot", inspect);
    firstController.abort(new Error("first consumer stopped"));
    await expect(first).rejects.toThrow("first consumer stopped");
    expect(inspectCount).toBe(1);
    release("shared");
    await expect(second).resolves.toBe("shared");
  });

  it("does no work for a cancelled caller and stops the scan after the last consumer leaves", async () => {
    vi.useFakeTimers();
    const cancelled = new AbortController();
    cancelled.abort(new Error("disabled"));
    const unused = vi.fn(async () => "unused");
    await expect(createSharedInspection("disabled-check", unused, cancelled.signal)).rejects.toThrow("disabled");
    expect(unused).not.toHaveBeenCalled();
    let inspectionSignal!: AbortSignal;
    let finish!: (value: string) => void;
    const controller = new AbortController();
    const work = createSharedInspection("cancelled-check", signal => {
      inspectionSignal = signal;
      return new Promise<string>(resolve => { finish = resolve; });
    }, controller.signal);
    const checked = expect(work).rejects.toThrow("stopped");
    await Promise.resolve();
    controller.abort(new Error("stopped"));
    await checked;
    expect(inspectionSignal.aborted).toBe(true);
    await expect(createSharedInspection("cancelled-check", async () => "fresh")).resolves.toBe("fresh");
    finish("stale");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries failed and timed out inspections without keeping the old scan", async () => {
    vi.useFakeTimers();
    await expect(createSharedInspection("retry-check", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    let signal!: AbortSignal;
    const work = createSharedInspection("retry-check", current => {
      signal = current;
      return new Promise<string>(() => undefined);
    }, undefined, 100);
    const checked = expect(work).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await checked;
    expect(signal.aborted).toBe(true);
    await expect(createSharedInspection("retry-check", async () => "reconnected")).resolves.toBe("reconnected");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a full inspection queue and frees capacity after cancellation", async () => {
    const controller = new AbortController();
    const pending = Array.from({ length: 256 }, (_, index) => createSharedInspection(`queue-${index}`, () => new Promise(() => undefined), controller.signal).catch(error => error));
    await expect(createSharedInspection("queue-overflow", async () => "unused")).rejects.toThrow("Session inspection is busy");
    controller.abort(new Error("queue cancelled"));
    expect((await Promise.all(pending)).every(error => error.message === "queue cancelled")).toBe(true);
    await expect(createSharedInspection("queue-overflow", async () => "ready")).resolves.toBe("ready");
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
