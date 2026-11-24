import { describe, expect, it } from 'vitest';
import type { DashboardAccountViewModel, DashboardMetricViewModel } from '../src/domain/dashboard/types';
import { quotaAvailability, quotaOfflineMessage } from '../src/domain/quotaAvailability';

const now = Date.UTC(2026, 10, 22, 10);
const reset = (minutes: number) => now / 1000 + minutes * 60;
const metric = (key: string, percentage: number | undefined, minutes?: number): DashboardMetricViewModel => ({ key, label: key, visible: true, percentage, resetAt: minutes === undefined ? undefined : reset(minutes) });
const account = (...metrics: DashboardMetricViewModel[]) => ({ enabled: true, metrics }) as DashboardAccountViewModel;

describe('workspace quota availability', () => {
  it('waits for every exhausted window on each account, then chooses the earliest usable account', () => {
    const weekly = account(metric('hourly', 0, 60), metric('weekly', 0, 1440));
    const monthly = account(metric('hourly', 0, 120), { ...metric('weekly', 0, 43200), period: 'monthly' });
    const hourly = account(metric('hourly', 0, 180), metric('weekly', 20, 10080));
    expect(quotaAvailability([weekly, monthly], now)).toEqual({ status: 'offline', availableAt: reset(1440) });
    expect(quotaAvailability([monthly, weekly, hourly], now)).toEqual({ status: 'offline', availableAt: reset(180) });
    expect(quotaAvailability([account(metric('hourly', 0, 300), metric('weekly', 0, 60))], now).availableAt).toBe(reset(300));
  });

  it('excludes disabled and reserved accounts and ignores unrelated limits', () => {
    const exhausted = account(metric('hourly', 0, 120), metric('review', 0, 43200));
    const available = account(metric('weekly', 20), metric('review', 0), metric('additional-0-weekly', 0));
    expect(quotaAvailability([exhausted, { ...available, enabled: false }, { ...available, runningDeviceName: 'Other PC' }], now)).toEqual({ status: 'offline', availableAt: reset(120) });
    expect(quotaAvailability([exhausted, available], now).status).toBe('available');
    expect(quotaAvailability([{ ...available, runningDeviceName: 'This PC', runningOnThisDevice: true }], now).status).toBe('available');
    expect(quotaAvailability([{ ...account(), creditsUnlimited: true }], now).status).toBe('available');
  });

  it('does not invent a return time for unknown, invalid, pending, or elapsed resets', () => {
    expect(quotaAvailability([], now).status).toBe('checking');
    const exhausted = account(metric('hourly', 0, 60));
    for (const patch of [{ hasQuotaError: true }, { hasPendingResetCreditAttempt: true }]) expect(quotaAvailability([exhausted, { ...exhausted, ...patch }], now).status).toBe('checking');
    for (const minutes of [undefined, 0, -1, NaN, Infinity]) expect(quotaAvailability([account(metric('hourly', 0, minutes))], now)).toEqual({ status: 'offline', availableAt: undefined });
    expect(quotaAvailability([exhausted, account(metric('weekly', 0))], now).availableAt).toBeUndefined();
    expect(quotaAvailability([account(metric('weekly', NaN))], now).status).toBe('checking');
    expect(quotaAvailability([account(metric('hourly', 0, 60), metric('weekly', undefined))], now).availableAt).toBeUndefined();
  });

  it.each([[1440, '1d'], [60, '1h'], [1, '1m'], [1501, '1d 1h 1m'], [0.5, '<1m']])('shows a local return time and compact wait for %s minutes', (minutes, duration) => {
    const message = quotaOfflineMessage({ status: 'offline', availableAt: reset(minutes as number) }, now);
    expect(message).toContain("Temporarily unavailable. Expected back at ");
    expect(message).toContain(`(${duration} left)`);
    const target = new Date(reset(minutes as number) * 1000);
    expect(message).toContain(target.toLocaleString(undefined, { ...(target.toDateString() === new Date(now).toDateString() ? {} : { month: 'short', day: 'numeric' } as const), hour: 'numeric', minute: '2-digit' }));
  });

  it('keeps a visible fallback after the reset until availability is confirmed', () => {
    expect(quotaOfflineMessage({ status: 'offline' }, now)).toBe("Temporarily unavailable. Checking when you can chat again.");
    expect(quotaOfflineMessage({ status: 'offline', availableAt: reset(1) }, now + 60_000)).toBe("Temporarily unavailable. Checking when you can chat again.");
  });
});
