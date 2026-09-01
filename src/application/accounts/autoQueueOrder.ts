import type { CodexManagerAccountRecord } from "../../core/types";
import {
  calculateAutoQueueEfficiency,
  compareAutoQueueOrderValues,
  compareAutoQueueUrgency,
  parseCreditsOrderValue
} from "../../domain/autoQueueOrder";
import { isMonthlyQuotaWindow } from "../../utils/quotaLabels";
import { parseSubscriptionExpiryMs } from "../../utils/subscriptionExpiry";

export function compareCodexManagerAccountAutoQueueOrder(
  left: CodexManagerAccountRecord,
  right: CodexManagerAccountRecord,
  options?: { nowMs?: number; staleAfterMs?: number }
): number {
  const leftOrder = toOrderValue(left);
  const rightOrder = toOrderValue(right);
  const urgencyDifference = compareAutoQueueUrgency(leftOrder, rightOrder);
  if (urgencyDifference !== 0) {
    return urgencyDifference;
  }

  const leftPriority = left.queuePriority === true && hasCodexManagerAccountAutoQueueCapability(left);
  const rightPriority = right.queuePriority === true && hasCodexManagerAccountAutoQueueCapability(right);
  if (leftPriority !== rightPriority) {
    return leftPriority ? -1 : 1;
  }

  const nowSeconds = (options?.nowMs ?? Date.now()) / 1_000;
  if (hasFutureReset(leftOrder, nowSeconds) || hasFutureReset(rightOrder, nowSeconds)) {
    const leftScore = score(left, leftOrder, options).score;
    const rightScore = score(right, rightOrder, options).score;
    if (leftScore !== rightScore) return rightScore - leftScore;
  }

  return compareAutoQueueOrderValues(leftOrder, rightOrder);
}

export function getCodexManagerAccountAutoQueueEfficiency(account: CodexManagerAccountRecord, options?: { nowMs?: number; staleAfterMs?: number }) {
  return score(account, toOrderValue(account), options);
}

function score(account: CodexManagerAccountRecord, order: ReturnType<typeof toOrderValue>, options?: { nowMs?: number; staleAfterMs?: number }) {
  return calculateAutoQueueEfficiency(order, {
    nowMs: options?.nowMs,
    staleAfterMs: options?.staleAfterMs ?? 30 * 60_000,
    starred: account.queuePriority === true && hasCodexManagerAccountAutoQueueCapability(account)
  });
}

function hasFutureReset(order: ReturnType<typeof toOrderValue>, nowSeconds: number): boolean {
  return order.windows.some((window) => typeof window.resetAt === "number" && Number.isFinite(window.resetAt) && window.resetAt >= nowSeconds);
}

export type AutoQueueCapabilityThresholds = {
  hourlyEnabled: boolean;
  hourlyThreshold: number;
  weeklyThreshold: number;
};

export function hasCodexManagerAccountAutoQueueCapability(
  account: CodexManagerAccountRecord,
  thresholds: AutoQueueCapabilityThresholds = {
    hourlyEnabled: true,
    hourlyThreshold: 0,
    weeklyThreshold: 0
  }
): boolean {
  const quota = account.quotaSummary;
  // Capability follows the automatic-switch settings for each controlled
  // quota window. Credits cannot override a window at or below its threshold.
  if (
    (thresholds.hourlyEnabled &&
      hasComparableHourlyWindow(account) &&
      quota!.hourlyPercentage <= thresholds.hourlyThreshold) ||
    (hasComparableWeeklyWindow(account) && quota!.weeklyPercentage <= thresholds.weeklyThreshold)
  ) {
    return false;
  }
  const hasQuota =
    (thresholds.hourlyEnabled &&
      hasComparableHourlyWindow(account) &&
      (quota?.hourlyPercentage ?? 0) > thresholds.hourlyThreshold) ||
    (hasComparableWeeklyWindow(account) && (quota?.weeklyPercentage ?? 0) > thresholds.weeklyThreshold);
  const credits = parseCreditsOrderValue(quota?.credits);
  return hasQuota || credits === Number.POSITIVE_INFINITY || (credits !== undefined && credits > 0);
}

export function hasComparableHourlyWindow(account: CodexManagerAccountRecord): boolean {
  const quota = account.quotaSummary;
  if (!quota?.hourlyWindowPresent) {
    return false;
  }

  const windowMinutes = quota.hourlyWindowMinutes;
  return (
    typeof quota.hourlyPercentage === "number" &&
    Number.isFinite(quota.hourlyPercentage) &&
    typeof windowMinutes === "number" &&
    windowMinutes > 0 &&
    windowMinutes <= 360
  );
}

export function hasComparableWeeklyWindow(account: CodexManagerAccountRecord): boolean {
  const quota = account.quotaSummary;
  if (!quota?.weeklyWindowPresent) {
    return false;
  }

  const windowMinutes = quota.weeklyWindowMinutes;
  return (
    typeof quota.weeklyPercentage === "number" &&
    Number.isFinite(quota.weeklyPercentage) &&
    typeof windowMinutes === "number" &&
    windowMinutes >= 1440
  );
}

function toOrderValue(account: CodexManagerAccountRecord) {
  const quota = account.quotaSummary;
  const hourly = hasComparableHourlyWindow(account)
    ? { percentage: quota?.hourlyPercentage, resetAt: quota?.hourlyResetTime }
    : {};
  const hasLongWindow = hasComparableWeeklyWindow(account);
  const isMonthly = hasLongWindow && isMonthlyQuotaWindow(account.planType, quota?.weeklyWindowMinutes);
  const longWindow = hasLongWindow ? { percentage: quota?.weeklyPercentage, resetAt: quota?.weeklyResetTime } : {};

  return {
    windows: [hourly, isMonthly ? {} : longWindow, isMonthly ? longWindow : {}],
    credits: parseCreditsOrderValue(quota?.credits),
    subscriptionExpiresAt: parseSubscriptionExpiryMs(account.subscriptionActiveUntil),
    lastQuotaAt: account.lastQuotaAt
  };
}
