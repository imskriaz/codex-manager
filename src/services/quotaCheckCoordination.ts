/**
 * Lightweight cross-window / cross-PC quota-check timestamps.
 *
 * WebSocket peer snapshots carry each account's lastQuotaAt. The dashboard
 * server feeds those timestamps into this registry so background automation on
 * another PC does not immediately re-check the same account.
 */
const lastChecks = new Map<string, number>();
type CoordinatedQuotaSnapshot = {
  checkedAt: number;
  hourlyPercentage?: number;
  hourlyResetTime?: number;
  weeklyPercentage?: number;
  weeklyResetTime?: number;
  resetCreditsAvailable?: number;
};
const snapshots = new Map<string, CoordinatedQuotaSnapshot>();

export function recordQuotaCheck(accountId: string, checkedAt = Date.now()): void {
  if (!accountId || !Number.isFinite(checkedAt)) return;
  const previous = lastChecks.get(accountId) ?? 0;
  if (checkedAt > previous) lastChecks.set(accountId, checkedAt);
}

export function recordAccountQuotaCheck(
  account: { id: string; email?: string; accountId?: string | null; lastQuotaAt?: number },
  checkedAt = account.lastQuotaAt ?? Date.now()
): void {
  for (const key of quotaIdentityKeys(account)) recordQuotaCheck(key, checkedAt);
  recordQuotaCheck(account.id, checkedAt);
}

export function recordPeerQuotaChecks(
  accounts: ReadonlyArray<{
    id?: string;
    email?: string;
    accountId?: string;
    lastQuotaAt?: number;
    resetCreditsAvailable?: number;
    metrics?: ReadonlyArray<{
      period?: "hourly" | "weekly" | "monthly";
      percentage?: number;
      resetAt?: number;
    }>;
  }>
): void {
  for (const account of accounts) {
    if (account.id && typeof account.lastQuotaAt === "number") {
      recordQuotaCheck(account.id, account.lastQuotaAt);
      const hourly = account.metrics?.find((metric) => metric.period === "hourly");
      const longWindow = account.metrics?.find(
        (metric) => metric.period === "weekly" || metric.period === "monthly"
      );
      const snapshot: CoordinatedQuotaSnapshot = {
        checkedAt: account.lastQuotaAt,
        hourlyPercentage: hourly?.percentage,
        hourlyResetTime: hourly?.resetAt,
        weeklyPercentage: longWindow?.percentage,
        weeklyResetTime: longWindow?.resetAt,
        resetCreditsAvailable: account.resetCreditsAvailable
      };
      for (const key of quotaIdentityKeys(account)) {
        recordQuotaCheck(key, account.lastQuotaAt);
        const previous = snapshots.get(key);
        if (!previous || snapshot.checkedAt > previous.checkedAt) snapshots.set(key, snapshot);
      }
    }
  }
}

export function getCoordinatedQuotaSnapshot(account: {
  id: string;
  email?: string;
  accountId?: string | null;
  lastQuotaAt?: number;
}): CoordinatedQuotaSnapshot | undefined {
  const candidates = quotaIdentityKeys(account)
    .map((key) => snapshots.get(key))
    .filter((value): value is CoordinatedQuotaSnapshot => value !== undefined)
    .sort((left, right) => right.checkedAt - left.checkedAt);
  const newest = candidates[0];
  return newest && newest.checkedAt > (account.lastQuotaAt ?? 0) ? { ...newest } : undefined;
}

export function wasQuotaCheckedWithin(accountId: string, gapMs: number, now = Date.now()): boolean {
  if (!Number.isFinite(gapMs) || gapMs <= 0) return false;
  const checkedAt = lastChecks.get(accountId);
  return typeof checkedAt === "number" && now - checkedAt < gapMs;
}

export function wasAccountQuotaCheckedWithin(
  account: { id: string; email?: string; accountId?: string | null },
  gapMs: number,
  now = Date.now()
): boolean {
  return quotaIdentityKeys(account).some((key) => {
    const checkedAt = lastChecks.get(key) ?? lastChecks.get(account.id);
    return Number.isFinite(gapMs) && gapMs > 0 && typeof checkedAt === "number" && now - checkedAt < gapMs;
  });
}

export function clearQuotaCheckCoordination(): void {
  lastChecks.clear();
  snapshots.clear();
}

function quotaIdentityKeys(account: { id?: string; email?: string; accountId?: string | null }): string[] {
  return [
    account.id ? `id:${account.id}` : undefined,
    account.accountId ? `remote:${account.accountId}` : undefined,
    account.email ? `email:${account.email.trim().toLowerCase()}` : undefined
  ].filter((value): value is string => Boolean(value));
}
