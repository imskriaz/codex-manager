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
  resetCreditsNextExpiresAt?: number;
};
const snapshots = new Map<string, CoordinatedQuotaSnapshot>();

export function recordQuotaCheck(accountId: string, checkedAt = Date.now()): void {
  const now = Date.now();
  if (!accountId || !isValidCheckTime(checkedAt, now)) return;
  const stored = lastChecks.get(accountId);
  const previous = isValidCheckTime(stored, now) ? stored : 0;
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
    healthKind?: string;
    resetCreditsAvailable?: number;
    resetCreditsNextExpiresAt?: number;
    metrics?: ReadonlyArray<{
      key?: string;
      visible?: boolean;
      period?: "hourly" | "weekly" | "monthly";
      percentage?: number;
      resetAt?: number;
    }>;
  }>
): void {
  const now = Date.now();
  for (const account of accounts) {
    if (account.healthKind === "refresh_failed" || account.healthKind === "reauthorize") continue;
    if (account.id && isValidCheckTime(account.lastQuotaAt, now)) {
      recordQuotaCheck(account.id, account.lastQuotaAt);
      const metrics = (Array.isArray(account.metrics) ? account.metrics : []) as NonNullable<typeof account.metrics>;
      const hourly = metrics.find((metric) => metric?.key === "hourly" && metric.visible !== false);
      const longWindow = metrics.find((metric) => metric?.key === "weekly" && metric.visible !== false);
      const resetCount =
        typeof account.resetCreditsAvailable === "number" &&
        Number.isSafeInteger(account.resetCreditsAvailable) &&
        account.resetCreditsAvailable >= 0
          ? account.resetCreditsAvailable
          : undefined;
      const snapshot: CoordinatedQuotaSnapshot = {
        checkedAt: account.lastQuotaAt,
        hourlyPercentage: normalizePercentage(hourly?.percentage),
        hourlyResetTime: normalizeResetTime(hourly?.resetAt),
        weeklyPercentage: normalizePercentage(longWindow?.percentage),
        weeklyResetTime: normalizeResetTime(longWindow?.resetAt),
        resetCreditsAvailable: resetCount,
        resetCreditsNextExpiresAt:
          resetCount && resetCount > 0 ? normalizeResetTime(account.resetCreditsNextExpiresAt) : undefined
      };
      for (const key of quotaIdentityKeys(account)) {
        recordQuotaCheck(key, account.lastQuotaAt);
        const previous = snapshots.get(key);
        if (!previous || !isValidCheckTime(previous.checkedAt, now) || snapshot.checkedAt > previous.checkedAt) {
          snapshots.set(key, snapshot);
        }
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
  const now = Date.now();
  const candidates = quotaIdentityKeys(account)
    .map((key) => snapshots.get(key))
    .filter((value): value is CoordinatedQuotaSnapshot => value !== undefined && isValidCheckTime(value.checkedAt, now))
    .sort((left, right) => right.checkedAt - left.checkedAt);
  const newest = candidates[0];
  const localCheckedAt = isValidCheckTime(account.lastQuotaAt, now) ? account.lastQuotaAt : 0;
  return newest && newest.checkedAt > localCheckedAt ? { ...newest } : undefined;
}

export function wasQuotaCheckedWithin(accountId: string, gapMs: number, now = Date.now()): boolean {
  if (!Number.isFinite(gapMs) || gapMs <= 0) return false;
  const checkedAt = lastChecks.get(accountId);
  return isValidCheckTime(checkedAt, now) && now - checkedAt < gapMs;
}

export function wasAccountQuotaCheckedWithin(
  account: { id: string; email?: string; accountId?: string | null },
  gapMs: number,
  now = Date.now()
): boolean {
  return quotaIdentityKeys(account).some((key) => {
    const checkedAt = lastChecks.get(key) ?? lastChecks.get(account.id);
    return Number.isFinite(gapMs) && gapMs > 0 && isValidCheckTime(checkedAt, now) && now - checkedAt < gapMs;
  });
}

export function clearQuotaCheckCoordination(): void {
  lastChecks.clear();
  snapshots.clear();
}

function quotaIdentityKeys(account: { id?: string; email?: string; accountId?: string | null }): string[] {
  const email = typeof account.email === "string" ? account.email.trim().toLowerCase() : undefined;
  const remoteId = typeof account.accountId === "string" ? account.accountId.trim() : undefined;
  return [
    account.id ? `id:${JSON.stringify([account.id, email ?? "", remoteId ?? ""])}` : undefined,
    // Workspace IDs can be shared by several users; an email alone can span workspaces.
    remoteId && email ? `remote:${JSON.stringify([email, remoteId])}` : undefined,
    !account.accountId && email ? `email:${email}` : undefined
  ].filter((value): value is string => Boolean(value));
}

function isValidCheckTime(checkedAt: number | undefined, now = Date.now()): checkedAt is number {
  return (
    typeof checkedAt === "number" &&
    Number.isFinite(checkedAt) &&
    checkedAt > 0 &&
    Number.isFinite(now) &&
    checkedAt <= now
  );
}

function normalizePercentage(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function normalizeResetTime(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
