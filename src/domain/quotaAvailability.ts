import type { DashboardAccountViewModel } from './dashboard/types';
import { formatResetRelativeTime } from '../utils/resetTime';

export interface QuotaAvailability {
  status: 'available' | 'offline' | 'checking';
  /** Epoch seconds, matching dashboard quota reset times. */
  availableAt?: number;
}

export function quotaAvailability(accounts: DashboardAccountViewModel[], now = Date.now()): QuotaAvailability {
  const eligible = accounts.filter(account => account.enabled && (!account.runningDeviceName || account.runningOnThisDevice));
  const candidates = eligible.map<QuotaAvailability>(account => {
    if (account.hasQuotaError || account.hasPendingResetCreditAttempt) return { status: 'checking' };
    // Monthly limits occupy the weekly slot; review/model-specific limits do not block ordinary chat.
    const windows = account.metrics.filter(metric => metric.visible && ['hourly', 'weekly'].includes(metric.key));
    if (!windows.length) return { status: account.creditsUnlimited || (account.creditsBalance ?? 0) > 0 ? 'available' : 'checking' };
    const blocked = windows.filter(metric => metric.percentage === 0);
    if (!blocked.length) return { status: windows.every(metric => typeof metric.percentage === 'number' && Number.isFinite(metric.percentage) && metric.percentage > 0 && metric.percentage <= 100) ? 'available' : 'checking' };
    const resets = blocked.map(metric => metric.resetAt);
    const known = windows.every(metric => typeof metric.percentage === 'number' && Number.isFinite(metric.percentage) && metric.percentage >= 0 && metric.percentage <= 100) && resets.every((reset): reset is number => typeof reset === 'number' && Number.isFinite(reset) && reset > now / 1000);
    return { status: 'offline', availableAt: known ? Math.max(...resets as number[]) : undefined };
  });
  if (candidates.some(candidate => candidate.status === 'available')) return { status: 'available' };
  if (!candidates.length || candidates.some(candidate => candidate.status === 'checking')) return { status: 'checking' };
  return { status: 'offline', availableAt: candidates.every(candidate => candidate.availableAt !== undefined) ? Math.min(...candidates.map(candidate => candidate.availableAt!)) : undefined };
}

export function quotaOfflineMessage(availability: QuotaAvailability, now = Date.now()): string {
  const reset = availability.availableAt;
  if (!reset || reset * 1000 <= now) return "We're offline. Checking availability.";
  const date = new Date(reset * 1000);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  const time = date.toLocaleString(undefined, { ...(sameDay ? {} : { month: 'short', day: 'numeric' } as const), hour: 'numeric', minute: '2-digit' });
  return `We're offline. Back at ${time} (${formatResetRelativeTime(reset, now, 'en')}).`;
}
