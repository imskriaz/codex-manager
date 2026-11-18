import { readFileSync } from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDashboardToastController,
  DASHBOARD_TOAST_DURATION_MS,
  DASHBOARD_INFO_TOAST_DURATION_MS,
  scheduleDashboardToastDismiss,
  type DashboardToast
} from "../webview-src/dashboard/toast";

describe("dashboard toast", () => {
  it('keeps generic disconnected-action notices out of toasts without hiding other failures or action prompts', () => {
    const changed = vi.fn(), controller = createDashboardToastController(changed);
    for (const state of ['closed', 'failed']) controller.show({ level: 'error', message: `The connection ${state} before this action was confirmed. Its outcome is unknown; reconnect and verify before retrying.` });
    controller.show({ level: 'warning', message: 'Stop requested. Waiting for Codex to end the turn.' });
    expect(changed).not.toHaveBeenCalled();
    controller.show({ level: 'error', message: 'Permission denied. Your changes were kept.' });
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Permission denied. Your changes were kept.' }));
    controller.show({ level: 'warning', message: 'The connection closed before this action was confirmed.', actions: ['Review'] });
    expect(changed).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
  it('suppresses cached-session inspection progress even when an older host labels it as a warning', () => {
    const changed=vi.fn(),controller=createDashboardToastController(changed);
    for(const message of ['Checking saved running activity. Refresh before sending.','Session history is available, but running state could not be verified. Refresh before sending. Checking saved running activity. Refresh before sending.']) controller.show({level:'warning',message});
    expect(changed).not.toHaveBeenCalled();
    controller.show({level:'error',message:'Session inspection failed: storage unavailable.'});
    expect(changed).toHaveBeenCalledOnce();controller.dispose();
  });

  it('does not repeat a visible failure or replace it with informational progress', () => {
    const changed = vi.fn(); const controller = createDashboardToastController(changed);
    controller.show({ level: 'error', message: 'Failed' });
    controller.show({ level: 'info', message: 'Sending' });
    controller.show({ level: 'error', message: 'Failed' });
    expect(changed).toHaveBeenCalledOnce();
    controller.show({ level: 'info', message: 'Approval needed', actions: ['Review'] });
    expect(changed).toHaveBeenCalledOnce();
    controller.dispose();
  });
  it('dismisses recovered offline warnings without erasing unconfirmed writes or another system’s outage', () => {
    vi.useFakeTimers(); const changed = vi.fn(); const controller = createDashboardToastController(changed);
    controller.show({ level: 'warning', message: 'The browser is offline. This action was not sent; reconnect and try again.' });
    controller.connectionRestored(); expect(changed).toHaveBeenLastCalledWith(undefined);
    for (const message of ['Offline saved view. Reconnect to verify the latest state.', 'The host is offline. This operation was not sent or queued. Reconnect and retry.']) {
      controller.show({ level: 'warning', message });
      controller.connectionRestored(); expect(changed).toHaveBeenLastCalledWith(undefined);
    }
    controller.show({ level: 'error', message: 'Its outcome is unknown; reconnect and verify before retrying.' });
    controller.connectionRestored(); expect(changed.mock.lastCall?.[0]?.level).toBe('error');
    controller.show({ level: 'warning', message: 'This system is offline. Reconnect it before switching accounts.' });
    controller.connectionRestored(); expect(changed.mock.lastCall?.[0]?.message).toContain('This system');
    controller.connectionRestored(true); expect(changed).toHaveBeenLastCalledWith(undefined);
    controller.dispose();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps informational outcomes quiet without hiding attention or failures", () => {
    vi.useFakeTimers(); const changed=vi.fn(); const controller=createDashboardToastController(changed);
    controller.show({level:'info',message:'Account token refreshed.'});
    controller.show({level:'info',message:'Approval needed',actions:['Review']});
    vi.advanceTimersByTime(DASHBOARD_INFO_TOAST_DURATION_MS-1);
    expect(changed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    for(const level of ['warning','error'] as const) {
      controller.show({level,message:'Check before retrying.'});
      vi.advanceTimersByTime(DASHBOARD_INFO_TOAST_DURATION_MS);
      expect(changed.mock.lastCall?.[0]?.message).toBe('Check before retrying.');
      vi.advanceTimersByTime(DASHBOARD_TOAST_DURATION_MS-DASHBOARD_INFO_TOAST_DURATION_MS);
      expect(changed).toHaveBeenLastCalledWith(undefined);
    }
    controller.dispose();
  });

  it("shares the short info timeout with public conversation feedback", () => {
    const source=readFileSync('webview-src/dashboard/publicMessages.tsx','utf8');
    expect(source).toContain('scheduleDashboardToastDismiss(() => setNotice(undefined)');
    expect(source).toContain("notice.level === 'info' ? DASHBOARD_INFO_TOAST_DURATION_MS : DASHBOARD_TOAST_DURATION_MS");
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

  it("replaces the visible toast and gives the newest notice a full ten seconds", () => {
    vi.useFakeTimers();
    const onChange = vi.fn<(toast: DashboardToast | undefined) => void>();
    const controller = createDashboardToastController(onChange);

    controller.show({ level: "error", message: "First" });
    const first = onChange.mock.lastCall?.[0];
    vi.advanceTimersByTime(1_000);
    controller.show({ level: "warning", message: "Second" });
    const second = onChange.mock.lastCall?.[0];

    expect(first?.message).toBe("First");
    expect(second?.message).toBe("Second");
    expect(second?.id).not.toBe(first?.id);
    expect(onChange).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5_000);
    expect(onChange).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5_000);
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    controller.dispose();
  });

  it("cancels the timer on manual dismissal and ignores stale dismissals", () => {
    vi.useFakeTimers();
    const onChange = vi.fn<(toast: DashboardToast | undefined) => void>();
    const controller = createDashboardToastController(onChange);

    controller.show({ level: "warning", message: "First" });
    const firstId = onChange.mock.lastCall?.[0]?.id;
    controller.show({ level: "warning", message: "Second" });
    const secondId = onChange.mock.lastCall?.[0]?.id;
    controller.dismiss(firstId!);
    expect(onChange.mock.lastCall?.[0]?.message).toBe("Second");

    controller.dismiss(secondId!);
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    vi.advanceTimersByTime(DASHBOARD_TOAST_DURATION_MS);
    expect(onChange).toHaveBeenCalledTimes(3);
    controller.dispose();
  });

  it("cancels a pending toast when the dashboard unmounts or reloads", () => {
    vi.useFakeTimers();
    const onChange = vi.fn<(toast: DashboardToast | undefined) => void>();
    const controller = createDashboardToastController(onChange);

    controller.show({ level: "error", message: "Temporary failure" });
    controller.dispose();
    vi.advanceTimersByTime(DASHBOARD_TOAST_DURATION_MS);

    expect(onChange).toHaveBeenCalledTimes(1);
    controller.show({ level: "info", message: "Late message" });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("portals the current notice above dashboard dialogs", () => {
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");

    expect(main).toMatch(/createPortal\([\s\S]*?dashboard-notice-stack[\s\S]*?document\.body/);
    expect(css).toMatch(/--dashboard-z-overlay:\s*30000/);
    expect(css).toMatch(/--dashboard-z-toast:\s*40000/);
    expect(css).toMatch(/\.dashboard-notice-stack\s*\{[\s\S]*?z-index:\s*var\(--dashboard-z-toast\)/);
    expect(css).toMatch(/\.dashboard-notice-stack \.dashboard-notice\s*\{[\s\S]*?position:\s*relative/);
  });

  it("keeps mobile notices compact and limited to two lines", () => {
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");
    expect(css).toContain(".dashboard-notice-stack { right: 8px; width: min(300px");
    expect(css).toContain("-webkit-line-clamp: 2");
    expect(css).toContain(".dashboard-connection-banner { right: 8px; left: auto;");
    expect(css).toContain(".cli-workspace .cli-composer-unavailable { width: calc(100% - 16px);");
  });

  it("keeps only the original close button for visible notices", () => {
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");
    const css = readFileSync("media/webview/quotaSummary.css", "utf8");
    expect(main).toContain('aria-label="Dismiss notification"');
    for (const label of ['Cancel queued message', 'Copy notification', 'Clear notification']) {
      expect(main).not.toContain('aria-label="' + label + '"');
    }
    expect(main).not.toContain('dashboard-notice-icon-action');
    expect(css).not.toContain(".dashboard-notice-actions");
    expect(css).toContain('grid-template-columns: 8px minmax(0, 1fr) 28px');
    expect(css).toContain('grid-template-columns: 6px minmax(0, 1fr) 24px');
  });

  it('copies the original notification and clears it only after clipboard confirmation', async () => {
    const changed = vi.fn(), controller = createDashboardToastController(changed);
    controller.show({ level: 'error', message: 'Original failure' });
    const id = changed.mock.lastCall![0]!.id;
    let finish!: () => void;
    const write = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const copying = controller.copy(id, write);
    expect(changed.mock.lastCall![0]).toMatchObject({ message: 'Original failure', pendingAction: 'copy' });
    expect(await controller.copy(id, write)).toBe(false);
    finish();
    expect(await copying).toBe(true);
    expect(write).toHaveBeenCalledExactlyOnceWith('Original failure');
    expect(changed.mock.lastCall![0]).toBeUndefined(); controller.dispose();
  });

  it('preserves clipboard failures and never clears a newer toast on late copy completion', async () => {
    const changed = vi.fn(), controller = createDashboardToastController(changed);
    controller.show({ level: 'error', message: 'Original failure' });
    const id = changed.mock.lastCall![0]!.id;
    expect(await controller.copy(id, async () => { throw new Error('Denied'); })).toBe(false);
    expect(changed.mock.lastCall![0]).toMatchObject({ message: 'Original failure', actionError: expect.stringContaining('Copy failed') });
    let finish!: () => void;
    const copying = controller.copy(id, () => new Promise<void>(resolve => { finish = resolve; }));
    controller.show({ level: 'warning', message: 'Newer failure' });
    finish(); expect(await copying).toBe(false);
    expect(changed.mock.lastCall![0]?.message).toBe('Newer failure'); controller.dispose();
  });

  it('cancels only the captured operation and preserves an unconfirmed cancellation', async () => {
    const changed = vi.fn(), controller = createDashboardToastController(changed), cancel = vi.fn(async () => false);
    controller.show({ level: 'warning', message: 'Queued work', cancel });
    const id = changed.mock.lastCall![0]!.id;
    expect(await controller.cancel(id)).toBe(false);
    expect(changed.mock.lastCall![0]).toMatchObject({ message: 'Queued work', actionError: expect.stringContaining('Cancellation was not confirmed') });
    cancel.mockResolvedValue(true);
    expect(await controller.cancel(id)).toBe(true);
    expect(changed.mock.lastCall![0]).toBeUndefined();
    expect(await controller.cancel(id)).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(2); controller.dispose();
  });

  it("closes browser push notifications on replacement, timeout, and reload", () => {
    const main = readFileSync("webview-src/dashboard/main.tsx", "utf8");

    expect(main).toContain("recentBrowserPushes.current.has(notificationKey)");
    expect(main).toContain('notice.systemName');
    expect(main).toContain('window.addEventListener("pagehide", closeBrowserPush)');
    expect(main).toContain("cancelBrowserPushDismissRef.current = scheduleDashboardToastDismiss");
    expect(main).toContain("notification.close()");
  });
});
