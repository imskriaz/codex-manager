import { calculateAutoQueueEfficiency, compareAutoQueueUrgency, type AutoQueueOrderValue } from "./autoQueueOrder";

export interface AutoQueueCapabilityThresholds {
  hourlyEnabled: boolean;
  hourlyThreshold: number;
  weeklyThreshold: number;
}

export interface AutoQueuePolicy extends AutoQueueCapabilityThresholds {
  nowMs: number;
  staleAfterMs: number;
  autoSwitchEnabled: boolean;
  autoResetEnabled: boolean;
  resetWeeklyThreshold: number;
}

export interface AutoQueuePolicySettings {
  autoSwitchEnabled?: boolean;
  autoResetEnabled?: boolean;
  autoSwitchHourlyThreshold?: number;
  autoSwitchWeeklyThreshold?: number;
  autoResetWeeklyThreshold?: number;
  autoRefreshMinutes?: number;
  quotaFreshnessMs?: number;
}

export interface AutoQueueCandidate extends AutoQueueOrderValue {
  id?: string;
  queuePriority?: boolean;
  disabled?: boolean;
  quotaError?: boolean;
  resetCreditAttempt?: boolean;
}

export function createAutoQueuePolicy(settings: AutoQueuePolicySettings = {}, nowMs = Date.now(), staleAfterMs?: number): AutoQueuePolicy {
  const interval = finite(settings.autoRefreshMinutes, 15);
  const configuredFreshness = staleAfterMs ?? settings.quotaFreshnessMs;
  return {
    nowMs,
    staleAfterMs: typeof configuredFreshness === "number" && Number.isFinite(configuredFreshness) && configuredFreshness > 0
      ? configuredFreshness : getAutoQueueQuotaFreshnessMs(interval),
    hourlyEnabled: true,
    hourlyThreshold: normalizeAutoQueueThreshold(settings.autoSwitchHourlyThreshold, 5, 20),
    weeklyThreshold: normalizeAutoQueueThreshold(settings.autoSwitchWeeklyThreshold, 0, 20),
    autoSwitchEnabled: settings.autoSwitchEnabled === true,
    autoResetEnabled: settings.autoSwitchEnabled === true && settings.autoResetEnabled === true,
    resetWeeklyThreshold: normalizeAutoQueueThreshold(settings.autoResetWeeklyThreshold, 0, 100)
  };
}

export function getAutoQueueQuotaFreshnessMs(autoRefreshMinutes: number): number {
  const interval = Number.isFinite(autoRefreshMinutes) && autoRefreshMinutes > 0 ? autoRefreshMinutes : 15;
  return Math.max(30 * 60_000, interval * 2 * 60_000 + 5 * 60_000);
}

export function hasAutoQueueCapability(value: AutoQueueOrderValue, thresholds: AutoQueueCapabilityThresholds = { hourlyEnabled: true, hourlyThreshold: 0, weeklyThreshold: 0 }): boolean {
  if (value.invalidQuota || value.windows.some((window, index) => (index !== 0 || thresholds.hourlyEnabled) && window.percentage !== undefined && (!Number.isFinite(window.percentage) || window.percentage < 0 || window.percentage > 100))) return false;
  const windows = value.windows.filter((_, index) => index !== 0 || thresholds.hourlyEnabled);
  const known = windows.map((window) => window.percentage).filter((percentage): percentage is number => typeof percentage === "number" && Number.isFinite(percentage));
  if (value.windows.some((window, index) => (index !== 0 || thresholds.hourlyEnabled) && typeof window.percentage === "number" && Number.isFinite(window.percentage) && window.percentage <= (index === 0 ? thresholds.hourlyThreshold : thresholds.weeklyThreshold))) return false;
  return known.length > 0 || value.credits === Number.POSITIVE_INFINITY || (typeof value.credits === "number" && Number.isFinite(value.credits) && value.credits > 0);
}

export function isAutoQueueSnapshotFresh(value: AutoQueueOrderValue, policy: AutoQueuePolicy): boolean {
  const checked = value.lastQuotaAt;
  return typeof checked === "number" && Number.isFinite(checked) && checked > 0 && checked <= policy.nowMs &&
    policy.nowMs - checked <= policy.staleAfterMs &&
    (value.sessionStartedAt === undefined || (Number.isFinite(value.sessionStartedAt) && value.sessionStartedAt > 0 && checked >= value.sessionStartedAt));
}

export function isAutoQueueCandidateEligible(value: AutoQueueCandidate, policy: AutoQueuePolicy): boolean {
  return !value.disabled && !value.quotaError && !value.resetCreditAttempt && isAutoQueueSnapshotFresh(value, policy) && hasAutoQueueCapability(value, policy);
}

export function shouldKeepCurrentAutoQueueAccount(value: AutoQueueCandidate, policy: AutoQueuePolicy): boolean {
  // Disabling future selection does not make the current account's quota unusable.
  return !value.quotaError && isAutoQueueSnapshotFresh(value, policy) && hasAutoQueueCapability(value, policy);
}

/** An expired aggregate is uncertain until reconciled; it is never a usable reserve. */
export function usableAutoQueueResetCount(value: AutoQueueCandidate, policy: AutoQueuePolicy): number {
  if (!policy.autoResetEnabled || value.disabled || value.quotaError || value.invalidQuota || value.resetCreditAttempt || !isAutoQueueSnapshotFresh(value, policy)) return 0;
  const count = value.resetCreditsAvailable;
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return 0;
  const expiry = value.resetCreditsNextExpiresAt;
  if (expiry !== undefined && (!Number.isFinite(expiry) || expiry <= policy.nowMs / 1_000)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(count));
}

export function isAutoQueueResetCandidate(value: AutoQueueCandidate, policy: AutoQueuePolicy): boolean {
  const long = value.windows[2]?.percentage ?? value.windows[1]?.percentage;
  return usableAutoQueueResetCount(value, policy) > 0 && typeof long === "number" && Number.isFinite(long) && long <= policy.resetWeeklyThreshold;
}

export function compareAutoQueueCandidates(left: AutoQueueCandidate, right: AutoQueueCandidate, policy: AutoQueuePolicy): number {
  const rank = (value: AutoQueueCandidate) => {
    if (value.disabled) return 5;
    if (value.quotaError || value.resetCreditAttempt) return 4;
    if (isAutoQueueCandidateEligible(value, policy)) return 0;
    if (hasAutoQueueCapability(value, policy)) return 1;
    if (isAutoQueueResetCandidate(value, policy)) return 2;
    return 3;
  };
  const leftRank = rank(left);
  const rightRank = rank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;
  const leftStar = left.queuePriority === true && (leftRank === 0 || leftRank === 2);
  const rightStar = right.queuePriority === true && (rightRank === 0 || rightRank === 2);
  if (leftStar !== rightStar) return leftStar ? -1 : 1;
  if (leftRank === 0) {
    const urgency = compareAutoQueueUrgency(left, right, policy.nowMs / 1_000);
    if (urgency) return urgency;
  }
  const leftCount = usableAutoQueueResetCount(left, policy);
  const rightCount = usableAutoQueueResetCount(right, policy);
  const resetUrgency = (value: AutoQueueCandidate, count: number) => count > 0 && value.resetCreditsNextExpiresAt !== undefined && value.resetCreditsNextExpiresAt <= policy.nowMs / 1_000 + 24 * 60 * 60 ? value.resetCreditsNextExpiresAt : Number.POSITIVE_INFINITY;
  const leftExpiry = resetUrgency(left, leftCount);
  const rightExpiry = resetUrgency(right, rightCount);
  if (leftExpiry !== rightExpiry) return leftExpiry < rightExpiry ? -1 : 1;
  // Whole-point buckets prevent millisecond refresh jitter from defeating
  // fairness between accounts with the same usable capacity.
  const efficiency = (value: AutoQueueCandidate, count: number) => Math.round(calculateAutoQueueEfficiency(value, policy).score + Math.min(count, 100) * 2);
  const scoreDifference = efficiency(right, rightCount) - efficiency(left, leftCount);
  if (scoreDifference) return scoreDifference;
  // Equal usable capacity rotates toward the least recently selected account.
  const lastSelected = (value: AutoQueueCandidate) => typeof value.lastSelectedAt === "number" && Number.isFinite(value.lastSelectedAt) && value.lastSelectedAt > 0 ? value.lastSelectedAt : 0;
  const selectionDifference = lastSelected(left) - lastSelected(right);
  if (selectionDifference) return selectionDifference;
  return (left.id ?? "").localeCompare(right.id ?? "");
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizeAutoQueueThreshold(value: number | undefined, fallback: number, maximum: number): number {
  return Math.max(0, Math.min(maximum, Math.round(finite(value, fallback))));
}
