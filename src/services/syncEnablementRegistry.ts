const MAX_DEVICE_LABEL_LENGTH = 120;
const MAX_IDENTIFIER_LENGTH = 4096;
export const SYNC_ACTIVITY_LEASE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * One durable enablement record per account. An enabled record identifies the
 * single PC that may use the account; a disabled record releases it for all PCs.
 */
export type SyncAccountEnablement = {
  accountId: string;
  deviceId: string;
  deviceName: string;
  enabled: boolean;
  revision: number;
  updatedAt: number;
  /** Wall-clock time of the last successful encrypted sync by this PC. */
  lastSyncedAt?: number;
};

export function createSyncAccountEnablement(params: {
  accountId: string;
  deviceId: string;
  deviceName: string;
  enabled: boolean;
  revision?: number;
  now?: number;
  lastSyncedAt?: number;
}): SyncAccountEnablement {
  return {
    accountId: params.accountId,
    deviceId: params.deviceId,
    deviceName: sanitizeDeviceName(params.deviceName),
    enabled: params.enabled,
    revision: params.revision ?? 1,
    updatedAt: params.now ?? Date.now(),
    ...(params.lastSyncedAt !== undefined ? { lastSyncedAt: params.lastSyncedAt } : {})
  };
}

/**
 * Merge the plain registry without trusting wall clocks. Revisions win first;
 * a device ID tie-break makes concurrent writes converge deterministically.
 */
export function mergeSyncAccountEnablement(
  local: readonly SyncAccountEnablement[],
  remote: readonly SyncAccountEnablement[]
): SyncAccountEnablement[] {
  return canonicalizeSyncAccountEnablement([...local, ...remote]);
}

export function canonicalizeSyncAccountEnablement(
  entries: readonly SyncAccountEnablement[]
): SyncAccountEnablement[] {
  const byAccount = new Map<string, SyncAccountEnablement>();
  for (const candidate of entries) {
    if (!isValidSyncAccountEnablement(candidate)) continue;
    const current = byAccount.get(candidate.accountId);
    if (!current || compareEnablementFreshness(candidate, current) > 0) {
      byAccount.set(candidate.accountId, candidate);
    }
  }
  return [...byAccount.values()]
    .map((entry) => ({ ...entry, deviceName: sanitizeDeviceName(entry.deviceName) }))
    .sort((left, right) => left.accountId.localeCompare(right.accountId));
}

export function isValidSyncAccountEnablement(value: unknown): value is SyncAccountEnablement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<SyncAccountEnablement>;
  return (
    isNonEmptyBoundedString(candidate.accountId, MAX_IDENTIFIER_LENGTH) &&
    isNonEmptyBoundedString(candidate.deviceId, MAX_IDENTIFIER_LENGTH) &&
    isNonEmptyBoundedString(candidate.deviceName, MAX_DEVICE_LABEL_LENGTH) &&
    typeof candidate.enabled === "boolean" &&
    typeof candidate.revision === "number" &&
    Number.isSafeInteger(candidate.revision) &&
    candidate.revision > 0 &&
    typeof candidate.updatedAt === "number" &&
    Number.isFinite(candidate.updatedAt) &&
    candidate.updatedAt > 0 &&
    (candidate.lastSyncedAt === undefined ||
      (typeof candidate.lastSyncedAt === "number" && Number.isFinite(candidate.lastSyncedAt) && candidate.lastSyncedAt > 0))
  );
}

function compareEnablementFreshness(left: SyncAccountEnablement, right: SyncAccountEnablement): number {
  if (left.revision !== right.revision) return left.revision - right.revision;
  if (left.deviceId === right.deviceId) {
    return (left.lastSyncedAt ?? 0) - (right.lastSyncedAt ?? 0) || left.updatedAt - right.updatedAt;
  }
  return left.deviceId.localeCompare(right.deviceId);
}

export function isSyncAccountEnablementActive(
  entry: SyncAccountEnablement,
  now = Date.now(),
  timeoutMs = SYNC_ACTIVITY_LEASE_TIMEOUT_MS
): boolean {
  return entry.lastSyncedAt !== undefined && entry.lastSyncedAt + timeoutMs > now;
}

function sanitizeDeviceName(value: string): string {
  const normalized = value.trim().slice(0, MAX_DEVICE_LABEL_LENGTH);
  return normalized || "Unknown PC";
}

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}
