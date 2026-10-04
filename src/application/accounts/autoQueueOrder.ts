import type { CodexManagerAccountRecord } from "../../core/types";
import { calculateAutoQueueEfficiency, parseCreditsOrderValue } from "../../domain/autoQueueOrder";
import {
  compareAutoQueueCandidates,
  createAutoQueuePolicy,
  hasAutoQueueCapability,
  type AutoQueueCandidate,
  type AutoQueuePolicy,
  type AutoQueueCapabilityThresholds
} from "../../domain/autoQueuePolicy";
import { isMonthlyQuotaWindow } from "../../utils/quotaLabels";
import { parseSubscriptionExpiryMs } from "../../utils/subscriptionExpiry";
import { getCodexManagerConfiguration, normalizeAutoRefreshMinutes } from "../../infrastructure/config/extensionSettings";

export type { AutoQueueCapabilityThresholds };
export type AutoQueueScoringOptions = { nowMs?: number; staleAfterMs?: number; policy?: AutoQueuePolicy } | AutoQueuePolicy;

export function getAccountAutoQueuePolicy(nowMs = Date.now(), staleAfterMs?: number): AutoQueuePolicy {
  const config = getCodexManagerConfiguration();
  return createAutoQueuePolicy({
    autoSwitchEnabled: config.get<boolean>("autoSwitchEnabled", false),
    autoResetEnabled: config.get<boolean>("autoResetEnabled", false),
    autoSwitchHourlyThreshold: config.get<number>("autoSwitchHourlyThreshold", 5),
    autoSwitchWeeklyThreshold: config.get<number>("autoSwitchWeeklyThreshold", 0),
    autoResetWeeklyThreshold: config.get<number>("autoResetWeeklyThreshold", 0),
    autoRefreshMinutes: normalizeAutoRefreshMinutes(config.get<number>("autoRefreshMinutes", 15))
  }, nowMs, staleAfterMs);
}

export function compareCodexManagerAccountAutoQueueOrder(left: CodexManagerAccountRecord, right: CodexManagerAccountRecord, options?: AutoQueueScoringOptions): number {
  const policy = resolvePolicy(options);
  return compareAutoQueueCandidates(toAutoQueueOrderValue(left), toAutoQueueOrderValue(right), policy);
}

export function getCodexManagerAccountAutoQueueEfficiency(account: CodexManagerAccountRecord, options?: AutoQueueScoringOptions) {
  const policy = resolvePolicy(options);
  return calculateAutoQueueEfficiency(toAutoQueueOrderValue(account), { ...policy, starred: account.queuePriority === true && hasCodexManagerAccountAutoQueueCapability(account, policy) });
}

function resolvePolicy(options?: AutoQueueScoringOptions): AutoQueuePolicy {
  return options && "autoResetEnabled" in options ? options : options?.policy ?? getAccountAutoQueuePolicy(options?.nowMs, options?.staleAfterMs);
}

export function hasCodexManagerAccountAutoQueueCapability(account: CodexManagerAccountRecord, thresholds?: AutoQueueCapabilityThresholds): boolean {
  return hasAutoQueueCapability(toAutoQueueOrderValue(account), thresholds);
}

export function hasComparableHourlyWindow(account: CodexManagerAccountRecord): boolean {
  const quota = account.quotaSummary;
  return quota?.hourlyWindowPresent === true && typeof quota.hourlyPercentage === "number" && Number.isFinite(quota.hourlyPercentage) &&
    typeof quota.hourlyWindowMinutes === "number" && Number.isFinite(quota.hourlyWindowMinutes) && quota.hourlyWindowMinutes > 0 && quota.hourlyWindowMinutes <= 360;
}

export function hasComparableWeeklyWindow(account: CodexManagerAccountRecord): boolean {
  const quota = account.quotaSummary;
  return quota?.weeklyWindowPresent === true && typeof quota.weeklyPercentage === "number" && Number.isFinite(quota.weeklyPercentage) &&
    typeof quota.weeklyWindowMinutes === "number" && Number.isFinite(quota.weeklyWindowMinutes) && quota.weeklyWindowMinutes >= 1440;
}

export function toAutoQueueOrderValue(account: CodexManagerAccountRecord): AutoQueueCandidate {
  const quota = account.quotaSummary;
  const hasLongWindow = hasComparableWeeklyWindow(account);
  const mainExhausted = hasLongWindow && (quota?.weeklyPercentage ?? 1) <= 0;
  const hourly = hasComparableHourlyWindow(account) ? { percentage: mainExhausted ? 0 : quota?.hourlyPercentage, resetAt: mainExhausted ? undefined : quota?.hourlyResetTime } : {};
  const isMonthly = hasLongWindow && isMonthlyQuotaWindow(account.planType, quota?.weeklyWindowMinutes);
  const longWindow = hasLongWindow ? { percentage: quota?.weeklyPercentage, resetAt: mainExhausted ? undefined : quota?.weeklyResetTime } : {};
  return {
    id: account.id,
    queuePriority: account.queuePriority,
    disabled: account.enabled === false,
    quotaError: Boolean(account.quotaError),
    resetCreditAttempt: Boolean(account.resetCreditAttempt),
    invalidQuota: Boolean((quota?.hourlyWindowPresent && !hasComparableHourlyWindow(account)) || (quota?.weeklyWindowPresent && !hasComparableWeeklyWindow(account))),
    windows: [hourly, isMonthly ? {} : longWindow, isMonthly ? longWindow : {}],
    credits: parseCreditsOrderValue(quota?.credits),
    subscriptionExpiresAt: parseSubscriptionExpiryMs(account.subscriptionActiveUntil),
    lastQuotaAt: account.lastQuotaAt,
    sessionStartedAt: account.sessionStartedAt,
    lastSelectedAt: account.lastSelectedAt,
    resetCreditsAvailable: quota?.resetCreditsAvailable,
    resetCreditsNextExpiresAt: quota?.resetCreditsNextExpiresAt
  };
}
