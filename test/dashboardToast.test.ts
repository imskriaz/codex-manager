import { readFileSync } from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_TOAST_DURATION_MS,
  scheduleDashboardToastDismiss
} from "../webview-src/dashboard/toast";

describe("dashboard toast", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-dismisses after ten seconds", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();

    scheduleDashboardToastDismiss(onDismiss);
    vi.advanceTimersByTime(DASHBOARD_TOAST_DURATION_MS - 1);
    expect(onDismiss).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("cancels auto-dismiss when the toast is replaced or manually closed", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();

    const cancel = scheduleDashboardToastDismiss(onDismiss);
    cancel();
    vi.advanceTimersByTime(DASHBOARD_TOAST_DURATION_MS);

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("portals stacked notices above dashboard dialogs", () => {
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");

    expect(main).toMatch(/createPortal\([\s\S]*?dashboard-notice-stack[\s\S]*?document\.body/);
    expect(css).toMatch(/--dashboard-z-overlay:\s*30000/);
    expect(css).toMatch(/--dashboard-z-toast:\s*40000/);
    expect(css).toMatch(/\.dashboard-notice-stack\s*\{[\s\S]*?z-index:\s*var\(--dashboard-z-toast\)/);
    expect(css).toMatch(/\.dashboard-notice-stack \.dashboard-notice\s*\{[\s\S]*?position:\s*relative/);
  });
});
