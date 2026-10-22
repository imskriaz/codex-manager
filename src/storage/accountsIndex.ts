import { createError } from "../core/errors";
import type { CodexManagerAccountRecord, CodexManagerIndex } from "../core/types";
import { normalizeQuotaSummary, accountQuotaAvailability } from "../utils/quotaWindows";

export function setManualAccountSelection(index: CodexManagerIndex, home: string, account: CodexManagerAccountRecord): void {
  index.manualSelectionByCodexHome ??= {};
  const quota = accountQuotaAvailability(account);
  if (quota === 'available') delete index.manualSelectionByCodexHome[home];
  else index.manualSelectionByCodexHome[home] = { accountId: account.id, ...(quota === 'unknown' ? { awaitingQuota: true } : {}) };
}

export function markActive(index: CodexManagerIndex, accountId: string, now = Date.now(), codexHomeKey?: string): void {
  const startsNewSession = index.currentAccountId !== accountId;
  const previousAccountId = index.currentAccountId;
  index.currentAccountId = accountId;
  setScopedActiveAccount(index, codexHomeKey, accountId);
  for (const account of index.accounts) {
    const nextActive = account.id === accountId;
    if (startsNewSession && account.id === previousAccountId) {
      completeAccountUsageSession(account, now);
    }
    account.isActive = nextActive;
    if (nextActive && (startsNewSession || account.sessionStartedAt == null)) {
      account.sessionStartedAt = now;
      account.lastSelectedAt = now;
    }
  }
}

export function scopeActiveAccountState(index: CodexManagerIndex, codexHomeKey: string): boolean {
  const knownAccountIds = new Set(index.accounts.map((account) => account.id));
  let changed = false;

  if (index.activeAccountStateVersion !== 1) {
    index.activeAccountStateVersion = 1;
    index.activeAccountIdsByCodexHome = { ...(index.activeAccountIdsByCodexHome ?? {}) };
    if (index.currentAccountId && knownAccountIds.has(index.currentAccountId)) {
      index.activeAccountIdsByCodexHome[codexHomeKey] ??= index.currentAccountId;
    }
    changed = true;
  }

  const scoped = index.activeAccountIdsByCodexHome ?? {};
  const storedAccountId = scoped[codexHomeKey];
  const activeAccountId = storedAccountId && knownAccountIds.has(storedAccountId) ? storedAccountId : undefined;
  if (storedAccountId && !activeAccountId) {
    delete scoped[codexHomeKey];
    changed = true;
  }
  index.activeAccountIdsByCodexHome = scoped;
  if (index.currentAccountId !== activeAccountId) {
    index.currentAccountId = activeAccountId;
    changed = true;
  }
  for (const account of index.accounts) {
    const nextActive = account.id === activeAccountId;
    if (account.isActive !== nextActive) {
      account.isActive = nextActive;
      changed = true;
    }
  }
  return changed;
}

function setScopedActiveAccount(index: CodexManagerIndex, codexHomeKey: string | undefined, accountId?: string): void {
  if (!codexHomeKey) return;
  index.activeAccountStateVersion = 1;
  index.activeAccountIdsByCodexHome ??= {};
  if (accountId) index.activeAccountIdsByCodexHome[codexHomeKey] = accountId;
  else delete index.activeAccountIdsByCodexHome[codexHomeKey];
}

export function syncActiveAccountState(
  index: CodexManagerIndex,
  accountId: string | undefined,
  now = Date.now(),
  codexHomeKey?: string
): boolean {
  const normalizedAccountId =
    accountId && index.accounts.some((account) => account.id === accountId) ? accountId : undefined;
  const startsNewSession = index.currentAccountId !== normalizedAccountId;
  const previousAccountId = index.currentAccountId;
  let changed = startsNewSession;
  index.currentAccountId = normalizedAccountId;
  const previousScopedAccountId = codexHomeKey ? index.activeAccountIdsByCodexHome?.[codexHomeKey] : undefined;
  setScopedActiveAccount(index, codexHomeKey, normalizedAccountId);
  if (codexHomeKey && previousScopedAccountId !== normalizedAccountId) changed = true;

  for (const account of index.accounts) {
    const nextActive = account.id === normalizedAccountId;
    if (startsNewSession && account.id === previousAccountId) {
      completeAccountUsageSession(account, now);
      changed = true;
    }
    if (account.isActive !== nextActive) {
      account.isActive = nextActive;
      changed = true;
    }
    if (nextActive && (startsNewSession || account.sessionStartedAt == null)) {
      account.sessionStartedAt = now;
      account.lastSelectedAt = now;
      changed = true;
    }
  }

  return changed;
}

function completeAccountUsageSession(account: CodexManagerAccountRecord, now: number): void {
  if (typeof account.sessionStartedAt === "number" && Number.isFinite(account.sessionStartedAt)) {
    const elapsed = Math.max(0, now - account.sessionStartedAt);
    const previous =
      typeof account.totalUsageMs === "number" && Number.isFinite(account.totalUsageMs)
        ? Math.max(0, account.totalUsageMs)
        : 0;
    account.totalUsageMs = previous + elapsed;
  }
  account.sessionStartedAt = undefined;
}

export function createEmptyIndex(): CodexManagerIndex {
  return { accounts: [] };
}

/** Apply this window's edits to the latest index without reviving remotely removed accounts. */
export function mergeAccountsIndexChanges(base: CodexManagerIndex, local: CodexManagerIndex, current: CodexManagerIndex, homeKey?: string): CodexManagerIndex {
  base = cloneIndex(base);
  const merged = cloneIndex(current);
  if (homeKey) {
    scopeActiveAccountState(base, homeKey);
    scopeActiveAccountState(merged, homeKey);
  }
  const originals = new Map(base.accounts.map(account => [account.id, account]));
  const incoming = new Map(local.accounts.map(account => [account.id, account]));
  merged.accounts = merged.accounts.filter(account => !originals.has(account.id) || incoming.has(account.id));
  const saved = new Map(merged.accounts.map(account => [account.id, account]));
  const added: CodexManagerAccountRecord[] = [];
  for (const account of local.accounts) {
    const original = originals.get(account.id);
    const latest = saved.get(account.id);
    if (!original) {
      if (latest) Object.assign(latest, structuredClone(account));
      else added.push(structuredClone(account));
    } else if (latest) {
      const savedUpdatedAt = latest.updatedAt;
      for (const key of new Set([...Object.keys(original), ...Object.keys(account)])) {
        const previous: unknown = Reflect.get(original, key);
        const next: unknown = Reflect.get(account, key);
        if (JSON.stringify(previous) !== JSON.stringify(next)) Reflect.set(latest, key, structuredClone(next));
      }
      latest.updatedAt = Math.max(savedUpdatedAt, account.updatedAt);
    }
  }
  merged.accounts.unshift(...added);
  if (homeKey) {
    const previous = base.activeAccountIdsByCodexHome?.[homeKey];
    const next = local.activeAccountIdsByCodexHome?.[homeKey];
    if (previous !== next) setScopedActiveAccount(merged, homeKey, next);
    const previousManual = base.manualSelectionByCodexHome?.[homeKey];
    const nextManual = local.manualSelectionByCodexHome?.[homeKey];
    if (JSON.stringify(previousManual) !== JSON.stringify(nextManual)) {
      merged.manualSelectionByCodexHome ??= {};
      if (nextManual) merged.manualSelectionByCodexHome[homeKey] = structuredClone(nextManual);
      else delete merged.manualSelectionByCodexHome[homeKey];
    }
    scopeActiveAccountState(merged, homeKey);
  } else if (base.currentAccountId !== local.currentAccountId) merged.currentAccountId = local.currentAccountId;
  return merged;
}

export function cloneIndex(index: CodexManagerIndex): CodexManagerIndex {
  const normalized: CodexManagerIndex = {
    currentAccountId: index?.currentAccountId,
    activeAccountStateVersion: index?.activeAccountStateVersion,
    manualSelectionByCodexHome: index?.manualSelectionByCodexHome ? structuredClone(index.manualSelectionByCodexHome) : undefined,
    activeAccountIdsByCodexHome: index?.activeAccountIdsByCodexHome
      ? { ...index.activeAccountIdsByCodexHome }
      : undefined,
    accounts: Array.isArray(index?.accounts)
      ? index.accounts.map((account) => ({
          ...account,
          quotaSummary: normalizeQuotaSummary(account.quotaSummary)
        }))
      : []
  };

  return structuredClone(normalized);
}

export function parseAccountsIndex(raw: string, filePath: string): CodexManagerIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw createError.storageIndexCorrupted(filePath, cause);
  }
  return parseAccountsIndexValue(parsed, filePath);
}

export function parseAccountsIndexValue(value: unknown, filePath: string): CodexManagerIndex {
  try {
    if (!isValidAccountsIndex(value)) {
      throw new Error("Invalid accounts index structure");
    }

    return cloneIndex(value);
  } catch (cause) {
    throw createError.storageIndexCorrupted(filePath, cause);
  }
}

export function getBackupPath(indexPath: string, slot: number): string {
  return indexPath.replace(/\.json$/i, `.backup-${slot}.json`);
}

function isValidAccountsIndex(value: unknown): value is CodexManagerIndex {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<CodexManagerIndex>;
  if (candidate.manualSelectionByCodexHome !== undefined && (!candidate.manualSelectionByCodexHome || typeof candidate.manualSelectionByCodexHome !== 'object' || Array.isArray(candidate.manualSelectionByCodexHome) ||
    Object.entries(candidate.manualSelectionByCodexHome).some(([key, value]) => !key || !value || typeof value !== 'object' || typeof value.accountId !== 'string' || !value.accountId || value.awaitingQuota !== undefined && typeof value.awaitingQuota !== 'boolean'))) return false;
  if (!Array.isArray(candidate.accounts)) {
    return false;
  }

  if (candidate.activeAccountStateVersion !== undefined && candidate.activeAccountStateVersion !== 1) {
    return false;
  }
  if (
    candidate.activeAccountIdsByCodexHome !== undefined &&
    (!candidate.activeAccountIdsByCodexHome ||
      typeof candidate.activeAccountIdsByCodexHome !== "object" ||
      Array.isArray(candidate.activeAccountIdsByCodexHome) ||
      Object.entries(candidate.activeAccountIdsByCodexHome).some(
        ([key, accountId]) => !key || typeof accountId !== "string" || !accountId
      ))
  ) {
    return false;
  }

  return candidate.accounts.every((account) => {
    if (!account || typeof account !== "object") {
      return false;
    }

    const record = account as Partial<CodexManagerAccountRecord>;
    return (
      typeof record.id === "string" &&
      typeof record.email === "string" &&
      typeof record.createdAt === "number" &&
      Number.isFinite(record.createdAt) &&
      typeof record.updatedAt === "number" &&
      Number.isFinite(record.updatedAt) &&
      [record.profileRequestAt, record.subscriptionRequestAt, record.resetCreditsRequestAt].every(value => value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0)) &&
      (record.resetCreditsGeneration === undefined || (Number.isSafeInteger(record.resetCreditsGeneration) && record.resetCreditsGeneration >= 0)) &&
      (record.sessionStartedAt === undefined ||
        (typeof record.sessionStartedAt === "number" && Number.isFinite(record.sessionStartedAt))) &&
      (record.lastSelectedAt === undefined ||
        (typeof record.lastSelectedAt === "number" &&
          Number.isFinite(record.lastSelectedAt) &&
          record.lastSelectedAt >= 0)) &&
      (record.resetCreditAttempt === undefined ||
        (record.resetCreditAttempt !== null &&
          typeof record.resetCreditAttempt === "object" &&
          typeof record.resetCreditAttempt.requestId === "string" &&
          record.resetCreditAttempt.requestId.length > 0 &&
          record.resetCreditAttempt.requestId.length <= 128 &&
          Number.isFinite(record.resetCreditAttempt.attemptedAt) &&
          record.resetCreditAttempt.attemptedAt > 0 &&
          Number.isSafeInteger(record.resetCreditAttempt.availableBefore) &&
          record.resetCreditAttempt.availableBefore > 0)) &&
      (record.totalUsageMs === undefined ||
        (typeof record.totalUsageMs === "number" &&
          Number.isFinite(record.totalUsageMs) &&
          record.totalUsageMs >= 0)) &&
      (record.tags === undefined || (Array.isArray(record.tags) && record.tags.every((tag) => typeof tag === "string")))
    );
  });
}
