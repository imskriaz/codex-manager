import type { AccountFilter } from "./preferences";
import { isAccountAttention, isAccountClaimedByAnotherDevice } from "./helpers";
import type { DashboardAccountViewModel } from "../../src/domain/dashboard/types";
import {
  compareAutoQueueCandidates,
  createAutoQueuePolicy,
  hasAutoQueueCapability,
  isAutoQueueCandidateEligible,
  type AutoQueueCandidate,
  type AutoQueuePolicy,
  type AutoQueueCapabilityThresholds
} from "../../src/domain/autoQueuePolicy";

export type DashboardAutoQueueCapabilityThresholds = AutoQueueCapabilityThresholds;

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
      (metric.key === "hourly" || metric.key === "weekly") &&
      typeof metric.percentage === "number" &&
      Number.isFinite(metric.percentage) &&
      metric.percentage === 0
  );
}

/** Quota filters describe the recorded balance, independent of auto-switch eligibility. */
export function hasDashboardQuotaRemaining(account: DashboardAccountViewModel): boolean {
  return !isDashboardAccountOutOfQuota(account) && hasDashboardAutoQueueCapability(account);
}

export function filterAccounts(accounts: DashboardAccountViewModel[], query: string, filter: AccountFilter, threshold: number): DashboardAccountViewModel[] {
  const normalized = query.trim().toLocaleLowerCase();
  return accounts.filter((account) => {
    const matchesQuery = !normalized || [account.email, account.displayName, account.accountName, account.workspaceLabel]
      .some((value) => value?.toLocaleLowerCase().includes(normalized));
    const attention = isAccountAttention(account);
    const matchesFilter = filter === "all"
      || (filter === "healthy" && !attention)
      || (filter === "attention" && attention)
      || (filter === "low" && account.metrics.some((metric) => metric.visible && typeof metric.percentage === "number" && Number.isFinite(metric.percentage) && metric.percentage >= 0 && metric.percentage <= threshold))
      || (filter === "active" && account.isActive)
      || (filter === "enabled" && account.enabled)
      || (filter === "disabled" && !account.enabled)
      || (filter === "claimed" && isAccountClaimedByAnotherDevice(account))
      || (filter === "capable" && hasDashboardQuotaRemaining(account))
      || (filter === "incapable" && isDashboardAccountOutOfQuota(account));
    return matchesQuery && matchesFilter;
  });
}

export function toDashboardAutoQueueOrderValue(account: DashboardAccountViewModel): AutoQueueCandidate {
  const mainQuota = mainQuotaMetric(account);
  const mainExhausted = (mainQuota?.percentage ?? 1) <= 0;
  const hourly = (account.metrics ?? []).find((metric) => metric.key === "hourly" && metric.visible && typeof metric.percentage === "number" && Number.isFinite(metric.percentage));
  return {
    id: account.id,
    queuePriority: account.queuePriority,
    disabled: account.enabled === false,
    quotaError: account.hasQuotaError,
    resetCreditAttempt: account.hasPendingResetCreditAttempt,
    invalidQuota: (account.metrics ?? []).some((metric) => metric.visible && (metric.key === "hourly" || metric.key === "weekly") && (typeof metric.percentage !== "number" || !Number.isFinite(metric.percentage) || metric.percentage < 0 || metric.percentage > 100)),
    windows: (["hourly", "weekly", "monthly"] as const).map((period) => {
      const metric = period === "hourly" ? hourly : mainQuota && (mainQuota.period ?? "weekly") === period ? mainQuota : undefined;
      return { percentage: metric ? sortingPercentage(account, metric) : undefined, resetAt: mainExhausted && metric ? undefined : metric?.resetAt };
    }),
    credits: account.creditsUnlimited ? Number.POSITIVE_INFINITY : account.creditsBalance,
    subscriptionExpiresAt: account.subscriptionExpiresAt,
    lastQuotaAt: account.lastQuotaAt,
    sessionStartedAt: account.sessionStartedAt,
    lastSelectedAt: account.lastSelectedAt,
    resetCreditsAvailable: account.resetCreditsAvailable,
    resetCreditsNextExpiresAt: account.resetCreditsNextExpiresAt
  };
}

export function compareDashboardAutoQueueAccounts(left: DashboardAccountViewModel, right: DashboardAccountViewModel, thresholds?: DashboardAutoQueueCapabilityThresholds | AutoQueuePolicy): number {
  const policy = thresholds && "nowMs" in thresholds ? thresholds : { ...createAutoQueuePolicy(), ...thresholds };
  return compareAutoQueueCandidates(toDashboardAutoQueueOrderValue(left), toDashboardAutoQueueOrderValue(right), policy);
}

export function hasDashboardAutoQueueCapability(account: DashboardAccountViewModel, thresholds?: DashboardAutoQueueCapabilityThresholds | AutoQueuePolicy): boolean {
  const value = toDashboardAutoQueueOrderValue(account);
  return thresholds && "nowMs" in thresholds ? isAutoQueueCandidateEligible(value, thresholds) : hasAutoQueueCapability(value, thresholds);
}

/**
 * Keep the account that is waiting for a window reload immediately after the
 * currently active account, regardless of the selected secondary sort key.
 * This makes a pending switch visible and actionable instead of allowing
 * quota/health/name sorting to bury it in the list.
 */
export function sortWithQueuedAccount(
  accounts: readonly DashboardAccountViewModel[],
  compare: (left: DashboardAccountViewModel, right: DashboardAccountViewModel) => number,
  groupQuota = true
): DashboardAccountViewModel[] {
  return [...accounts].sort((left, right) => {
    const activeDifference = Number(right.isActive) - Number(left.isActive);
    if (activeDifference !== 0) return activeDifference;
    const pendingDifference = Number(right.switchQueued) - Number(left.switchQueued);
    if (pendingDifference !== 0) return pendingDifference;
    if (!groupQuota) return compare(left, right);

    const missingMainQuotaDifference = Number(isDashboardMainQuotaMissing(left)) - Number(isDashboardMainQuotaMissing(right));
    if (missingMainQuotaDifference !== 0) return missingMainQuotaDifference;
    const quotaGroupDifference = Number(isDashboardAccountOutOfQuota(left)) - Number(isDashboardAccountOutOfQuota(right));
    if (quotaGroupDifference !== 0) return quotaGroupDifference;

    return compare(left, right);
  });
}
