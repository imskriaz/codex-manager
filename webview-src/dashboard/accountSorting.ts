import type { DashboardAccountViewModel } from "../../src/domain/dashboard/types";
import {
  calculateAutoQueueEfficiency,
  compareAutoQueueOrderValues,
  compareAutoQueueUrgency
} from "../../src/domain/autoQueueOrder";

export type DashboardAutoQueueCapabilityThresholds = {
  hourlyEnabled: boolean;
  hourlyThreshold: number;
  weeklyThreshold: number;
};

export function compareDashboardAutoQueueAccounts(
  left: DashboardAccountViewModel,
  right: DashboardAccountViewModel,
  thresholds?: DashboardAutoQueueCapabilityThresholds
): number {
  const metricForPeriod = (account: DashboardAccountViewModel, period: "hourly" | "weekly" | "monthly") =>
    account.metrics.find(
      (metric) =>
        metric.visible &&
        metric.period === period &&
        typeof metric.percentage === "number" &&
        Number.isFinite(metric.percentage)
    );
  const orderValue = (account: DashboardAccountViewModel) => ({
    windows: (["hourly", "weekly", "monthly"] as const).map((period) => {
      const metric = metricForPeriod(account, period);
      return { percentage: metric?.percentage, resetAt: metric?.resetAt };
    }),
    credits: account.creditsUnlimited ? Number.POSITIVE_INFINITY : account.creditsBalance,
    subscriptionExpiresAt: account.subscriptionExpiresAt,
    lastQuotaAt: account.lastQuotaAt
  });
  const leftOrder = orderValue(left);
  const rightOrder = orderValue(right);
  const leftCapable = hasDashboardAutoQueueCapability(left, thresholds);
  const rightCapable = hasDashboardAutoQueueCapability(right, thresholds);
  // A reset time is not quota. Exhausted accounts remain ignored until an
  // existing refresh/peer event reports usable quota after the reset.
  if (leftCapable !== rightCapable) {
    return leftCapable ? -1 : 1;
  }
  const urgencyDifference = compareAutoQueueUrgency(leftOrder, rightOrder);
  if (urgencyDifference !== 0) {
    return urgencyDifference;
  }

  const leftPriority = left.queuePriority === true && leftCapable;
  const rightPriority = right.queuePriority === true && rightCapable;
  if (leftPriority !== rightPriority) {
    return leftPriority ? -1 : 1;
  }

  const nowMs = Date.now();
  const hasFutureReset = (order: ReturnType<typeof orderValue>) =>
    order.windows.some(
      (window) => typeof window.resetAt === "number" && Number.isFinite(window.resetAt) && window.resetAt >= nowMs / 1_000
    );
  if (leftCapable && (hasFutureReset(leftOrder) || hasFutureReset(rightOrder))) {
    const leftScore = calculateAutoQueueEfficiency(leftOrder, { nowMs, staleAfterMs: 30 * 60_000, starred: leftPriority }).score;
    const rightScore = calculateAutoQueueEfficiency(rightOrder, { nowMs, staleAfterMs: 30 * 60_000, starred: rightPriority }).score;
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
  }

  return compareAutoQueueOrderValues(leftOrder, rightOrder);
}

export function hasDashboardAutoQueueCapability(
  account: DashboardAccountViewModel,
  thresholds: DashboardAutoQueueCapabilityThresholds = {
    hourlyEnabled: true,
    hourlyThreshold: 0,
    weeklyThreshold: 0
  }
): boolean {
  const primaryQuotaMetrics = account.metrics.filter(
    (metric) =>
      metric.visible &&
      (metric.key === "hourly" || metric.key === "weekly") &&
      typeof metric.percentage === "number" &&
      Number.isFinite(metric.percentage)
  );
  const concernedMetrics = primaryQuotaMetrics.filter((metric) => metric.key !== "hourly" || thresholds.hourlyEnabled);
  if (
    concernedMetrics.some(
      (metric) =>
        metric.percentage! <= (metric.key === "hourly" ? thresholds.hourlyThreshold : thresholds.weeklyThreshold)
    )
  )
    return false;
  const hasQuota = concernedMetrics.some(
    (metric) => metric.percentage! > (metric.key === "hourly" ? thresholds.hourlyThreshold : thresholds.weeklyThreshold)
  );
  return account.creditsUnlimited === true || hasQuota || (account.creditsBalance ?? 0) > 0;
}

/**
 * Keep the account that is waiting for a window reload immediately after the
 * currently active account, regardless of the selected secondary sort key.
 * This makes a pending switch visible and actionable instead of allowing
 * quota/health/name sorting to bury it in the list.
 */
export function sortWithQueuedAccount(
  accounts: readonly DashboardAccountViewModel[],
  compare: (left: DashboardAccountViewModel, right: DashboardAccountViewModel) => number
): DashboardAccountViewModel[] {
  return [...accounts].sort((left, right) => {
    const rank = (account: DashboardAccountViewModel): number => (account.isActive ? 0 : account.switchQueued ? 1 : 2);
    return rank(left) - rank(right) || compare(left, right);
  });
}
