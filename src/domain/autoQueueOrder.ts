export interface AutoQueueWindowOrderValue {
  percentage?: number;
  resetAt?: number;
}

export interface AutoQueueOrderValue {
  windows: readonly AutoQueueWindowOrderValue[];
  credits?: number;
  subscriptionExpiresAt?: number;
  lastQuotaAt?: number;
}

export type AutoQueueDecisionReason = "quota-expiring" | "long-window-protected" | "starred-priority" | "quota-balance" | "stale-data";

export interface AutoQueueEfficiencyResult {
  score: number;
  reason: AutoQueueDecisionReason;
  freshness: number;
}

export const AUTO_QUEUE_URGENT_RESET_SECONDS = [20 * 60, 3 * 60 * 60, 24 * 60 * 60] as const;
export const AUTO_QUEUE_URGENT_SUBSCRIPTION_SECONDS = 24 * 60 * 60;

/** Pure scoring: callers decide when to evaluate, so this creates no quota or sync traffic. */
export function calculateAutoQueueEfficiency(
  value: AutoQueueOrderValue,
  options: { nowMs?: number; staleAfterMs: number; starred?: boolean }
): AutoQueueEfficiencyResult {
  const nowMs = options.nowMs ?? Date.now();
  const nowSeconds = nowMs / 1_000;
  const ageMs = typeof value.lastQuotaAt === "number" ? Math.max(0, nowMs - value.lastQuotaAt) : options.staleAfterMs;
  const freshness = clamp(1 - ageMs / Math.max(options.staleAfterMs, 1), 0, 1);
  const [hourly, weekly, monthly] = value.windows;
  const expiringRisk =
    expiringQuotaRisk(hourly, nowSeconds, 5 * 60 * 60) +
    expiringQuotaRisk(weekly, nowSeconds, 24 * 60 * 60) * 0.35 +
    expiringQuotaRisk(monthly, nowSeconds, 3 * 24 * 60 * 60) * 0.2 +
    expiringSubscriptionRisk(value.subscriptionExpiresAt, nowMs);
  const longWindow = monthly?.percentage !== undefined ? monthly : weekly;
  const longPercentage = finitePercentage(longWindow?.percentage);
  const longWindowProtection = Math.pow((100 - longPercentage) / 100, monthly?.percentage !== undefined ? 2.2 : 1.7) * 85;
  const balance = finitePercentage(hourly?.percentage) * 0.55 + longPercentage * 0.45;
  const starredBonus = options.starred ? 22 : 0;
  const creditsBonus = value.credits === Number.POSITIVE_INFINITY ? 8 : Math.min(Math.max(value.credits ?? 0, 0), 25) * 0.1;
  const score = (balance + expiringRisk + starredBonus + creditsBonus - longWindowProtection) * (0.65 + freshness * 0.35);
  let reason: AutoQueueDecisionReason = "quota-balance";
  if (freshness < 0.2) reason = "stale-data";
  else if (longWindowProtection >= 45) reason = "long-window-protected";
  else if (expiringRisk >= 18) reason = "quota-expiring";
  else if (options.starred) reason = "starred-priority";
  return { score, reason, freshness };
}

function expiringQuotaRisk(window: AutoQueueWindowOrderValue | undefined, nowSeconds: number, horizonSeconds: number): number {
  const percentage = finitePercentage(window?.percentage);
  if (!percentage || typeof window?.resetAt !== "number" || !Number.isFinite(window.resetAt)) return 0;
  const secondsLeft = window.resetAt - nowSeconds;
  if (secondsLeft < 0 || secondsLeft > horizonSeconds) return 0;
  return percentage * (1 - secondsLeft / horizonSeconds) * 1.15;
}

function expiringSubscriptionRisk(expiresAt: number | undefined, nowMs: number): number {
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return 0;
  const timeLeft = expiresAt - nowMs;
  const horizon = 24 * 60 * 60 * 1_000;
  return timeLeft >= 0 && timeLeft <= horizon ? 35 * (1 - timeLeft / horizon) : 0;
}

function finitePercentage(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 100) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Quota that is close to expiring must be used before starred accounts:
 * 5-hour within 20 minutes, weekly within 3 hours, monthly within 1 day, and
 * subscription expiry within 1 day. Window precedence remains 5h, weekly,
 * monthly, then subscription.
 */
export function compareAutoQueueUrgency(
  left: AutoQueueOrderValue,
  right: AutoQueueOrderValue,
  nowSeconds = Date.now() / 1_000
): number {
  const windowCount = Math.max(left.windows.length, right.windows.length);
  for (let index = 0; index < windowCount; index += 1) {
    const threshold = AUTO_QUEUE_URGENT_RESET_SECONDS[index];
    if (threshold === undefined) continue;
    const leftReset = urgentAt(left.windows[index]?.resetAt, nowSeconds, threshold);
    const rightReset = urgentAt(right.windows[index]?.resetAt, nowSeconds, threshold);
    if (leftReset === undefined && rightReset === undefined) continue;
    if (leftReset === undefined) return 1;
    if (rightReset === undefined) return -1;
    if (leftReset !== rightReset) return leftReset - rightReset;
  }
  const leftExpiry = urgentAt(
    left.subscriptionExpiresAt,
    nowSeconds * 1_000,
    AUTO_QUEUE_URGENT_SUBSCRIPTION_SECONDS * 1_000
  );
  const rightExpiry = urgentAt(
    right.subscriptionExpiresAt,
    nowSeconds * 1_000,
    AUTO_QUEUE_URGENT_SUBSCRIPTION_SECONDS * 1_000
  );
  if (leftExpiry === undefined && rightExpiry === undefined) return 0;
  if (leftExpiry === undefined) return 1;
  if (rightExpiry === undefined) return -1;
  return leftExpiry - rightExpiry;
}

/**
 * Compares auto-queue candidates by remaining quota and the time until that
 * window resets. A criterion is ignored when either candidate is missing it,
 * so incomplete API responses do not penalize an otherwise usable account.
 */
export function compareAutoQueueOrderValues(left: AutoQueueOrderValue, right: AutoQueueOrderValue): number {
  const windowCount = Math.max(left.windows.length, right.windows.length);
  for (let index = 0; index < windowCount; index += 1) {
    const leftWindow = left.windows[index];
    const rightWindow = right.windows[index];
    if (!leftWindow || !rightWindow) {
      continue;
    }

    // After urgent resets and explicit stars have been handled, preserve the
    // remaining quota that expires first, then prefer the higher percentage.
    const resetDifference = compareWhenBoth(leftWindow.resetAt, rightWindow.resetAt, 1);
    if (resetDifference !== 0) {
      return resetDifference;
    }

    const quotaDifference = compareWhenBoth(leftWindow.percentage, rightWindow.percentage, -1);
    if (quotaDifference !== 0) {
      return quotaDifference;
    }
  }

  const creditsDifference = compareWhenBoth(left.credits, right.credits, -1);
  if (creditsDifference !== 0) {
    return creditsDifference;
  }

  const expiryDifference = compareWhenBoth(left.subscriptionExpiresAt, right.subscriptionExpiresAt, 1);
  if (expiryDifference !== 0) {
    return expiryDifference;
  }

  return compareWhenBoth(left.lastQuotaAt, right.lastQuotaAt, -1);
}

function urgentAt(value: number | undefined, now: number, threshold: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const timeLeft = value - now;
  return timeLeft >= 0 && timeLeft <= threshold ? value : undefined;
}

export function parseCreditsOrderValue(
  credits: { hasCredits: boolean; unlimited: boolean; overageLimitReached: boolean; balance: string } | undefined
): number | undefined {
  if (!credits) {
    return undefined;
  }
  if (credits.unlimited) {
    return Number.POSITIVE_INFINITY;
  }
  if (credits.overageLimitReached || !credits.hasCredits) {
    return 0;
  }

  const numericBalance = Number(credits.balance.replace(/[^0-9.-]/g, ""));
  return credits.balance.trim() && Number.isFinite(numericBalance) ? numericBalance : undefined;
}

function compareWhenBoth(left: number | undefined, right: number | undefined, direction: 1 | -1): number {
  if (left === undefined || right === undefined) {
    return 0;
  }
  if (!Number.isFinite(left) && left !== Number.POSITIVE_INFINITY) {
    return 0;
  }
  if (!Number.isFinite(right) && right !== Number.POSITIVE_INFINITY) {
    return 0;
  }
  if (left === right) {
    return 0;
  }
  return direction * (left - right);
}
