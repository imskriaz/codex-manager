import type { DashboardAccountViewModel } from "../../src/domain/dashboard/types";
import { compareAutoQueueOrderValues } from "../../src/domain/autoQueueOrder";

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
  const leftPriority = left.queuePriority === true && hasDashboardAutoQueueCapability(left, thresholds);
  const rightPriority = right.queuePriority === true && hasDashboardAutoQueueCapability(right, thresholds);
  if (leftPriority !== rightPriority) {
    return leftPriority ? -1 : 1;
  }

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

  return compareAutoQueueOrderValues(orderValue(left), orderValue(right));
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
  const concernedMetrics = primaryQuotaMetrics.filter(
    (metric) => metric.key !== "hourly" || thresholds.hourlyEnabled
  );
  if (
    concernedMetrics.some(
      (metric) =>
        metric.percentage! <=
        (metric.key === "hourly" ? thresholds.hourlyThreshold : thresholds.weeklyThreshold)
    )
  ) return false;
  const hasQuota = concernedMetrics.some(
    (metric) =>
      metric.percentage! >
      (metric.key === "hourly" ? thresholds.hourlyThreshold : thresholds.weeklyThreshold)
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
