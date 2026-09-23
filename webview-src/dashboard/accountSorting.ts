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

type DashboardMetric = DashboardAccountViewModel["metrics"][number];

function mainQuotaMetric(account: DashboardAccountViewModel): DashboardMetric | undefined {
  return (account.metrics ?? []).find(
    (metric) =>
      metric.key === "weekly" &&
      metric.visible &&
      typeof metric.percentage === "number" &&
      Number.isFinite(metric.percentage)
  );
}

export function isDashboardMainQuotaExhausted(account: DashboardAccountViewModel): boolean {
  return (mainQuotaMetric(account)?.percentage ?? 1) <= 0;
}

export function isDashboardMainQuotaMissing(account: DashboardAccountViewModel): boolean {
  return mainQuotaMetric(account) === undefined;
}

function sortingPercentage(account: DashboardAccountViewModel, metric: DashboardMetric): number | undefined {
  return metric.key === "hourly" && (mainQuotaMetric(account)?.percentage ?? 1) <= 0 ? 0 : metric.percentage;
}

export function compareDashboardQuotaBalance(
  left: DashboardAccountViewModel,
  right: DashboardAccountViewModel,
  metricPriority: string
): number {
  const valuesFor = (account: DashboardAccountViewModel): Array<number | undefined> => {
    const metrics = account.metrics.filter(
      (metric) => metric.visible && typeof metric.percentage === "number" && Number.isFinite(metric.percentage)
    );
    if (!metrics.length) return [undefined];
    const percentages = metrics.map((metric) => sortingPercentage(account, metric) as number);
    const preferred = metrics.find((metric) => metric.key.includes(metricPriority)) ?? metrics[0];
    if (!preferred) return [undefined];
    return [Math.min(...percentages), sortingPercentage(account, preferred), ...percentages];
  };
  const leftValues = valuesFor(left);
  const rightValues = valuesFor(right);
  for (let index = 0; index < leftValues.length; index += 1) {
    const leftValue = leftValues[index];
    const rightValue = rightValues[index];
    if (leftValue === undefined && rightValue === undefined) continue;
    if (leftValue === undefined) return 1;
    if (rightValue === undefined) return -1;
    if (leftValue !== rightValue) return rightValue - leftValue;
  }
  return left.email.localeCompare(right.email);
}

export function isDashboardAccountOutOfQuota(account: DashboardAccountViewModel): boolean {
  if (account.healthKind === "quota") return true;
  return (account.metrics ?? []).some(
    (metric) =>
      metric.visible &&
      typeof metric.percentage === "number" &&
      Number.isFinite(metric.percentage) &&
      metric.percentage <= 0
  );
}

export function compareDashboardAutoQueueAccounts(
  left: DashboardAccountViewModel,
  right: DashboardAccountViewModel,
  thresholds?: DashboardAutoQueueCapabilityThresholds
): number {
  const orderValue = (account: DashboardAccountViewModel) => {
    const mainQuota = mainQuotaMetric(account);
    const mainExhausted = (mainQuota?.percentage ?? 1) <= 0;
    const hourly = account.metrics.find(
      (metric) =>
        metric.visible &&
        metric.key === "hourly" &&
        typeof metric.percentage === "number" &&
        Number.isFinite(metric.percentage)
    );
    return {
      windows: (["hourly", "weekly", "monthly"] as const).map((period) => {
        const metric = period === "hourly" ? hourly : mainQuota?.period === period ? mainQuota : undefined;
        return {
          percentage: metric ? sortingPercentage(account, metric) : undefined,
          resetAt: mainExhausted && metric ? undefined : metric?.resetAt
        };
      }),
      credits: account.creditsUnlimited ? Number.POSITIVE_INFINITY : account.creditsBalance,
      subscriptionExpiresAt: account.subscriptionExpiresAt,
      lastQuotaAt: account.lastQuotaAt
    };
  };
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
      (window) =>
        typeof window.resetAt === "number" && Number.isFinite(window.resetAt) && window.resetAt >= nowMs / 1_000
    );
  if (leftCapable && (hasFutureReset(leftOrder) || hasFutureReset(rightOrder))) {
    const leftScore = calculateAutoQueueEfficiency(leftOrder, {
      nowMs,
      staleAfterMs: 30 * 60_000,
      starred: leftPriority
    }).score;
    const rightScore = calculateAutoQueueEfficiency(rightOrder, {
      nowMs,
      staleAfterMs: 30 * 60_000,
      starred: rightPriority
    }).score;
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
  const quotaMetrics = account.metrics.filter(
    (metric) =>
      metric.visible &&
      (metric.key === "hourly" || metric.key === "weekly") &&
      typeof metric.percentage === "number" &&
      Number.isFinite(metric.percentage)
  );
  const concernedMetrics = quotaMetrics.filter((metric) => metric.key !== "hourly" || thresholds.hourlyEnabled);
  if (
    concernedMetrics.some(
      (metric) =>
        metric.percentage! <= (metric.key === "hourly" ? thresholds.hourlyThreshold : thresholds.weeklyThreshold)
    )
  ) {
    return false;
  }
  const allMainQuotaAvailable =
    concernedMetrics.length > 0 &&
    concernedMetrics.every(
      (metric) =>
        metric.percentage! > (metric.key === "hourly" ? thresholds.hourlyThreshold : thresholds.weeklyThreshold)
    );
  return account.creditsUnlimited === true || allMainQuotaAvailable || (account.creditsBalance ?? 0) > 0;
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
    const activeDifference = Number(right.isActive) - Number(left.isActive);
    if (activeDifference !== 0) return activeDifference;

    const missingMainQuotaDifference = Number(isDashboardMainQuotaMissing(left)) - Number(isDashboardMainQuotaMissing(right));
    if (missingMainQuotaDifference !== 0) return missingMainQuotaDifference;
    const quotaGroupDifference = Number(isDashboardAccountOutOfQuota(left)) - Number(isDashboardAccountOutOfQuota(right));
    if (quotaGroupDifference !== 0) return quotaGroupDifference;

    const rank = (account: DashboardAccountViewModel): number => (account.switchQueued ? 0 : 1);
    return rank(left) - rank(right) || compare(left, right);
  });
}
