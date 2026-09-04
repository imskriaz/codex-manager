import { getErrorMessage } from "../core/errors";
import type {
  CodexManagerAccountRecord,
  CodexImportPreviewIssue,
  CodexImportPreviewSummary,
  CodexImportResultIssue,
  SharedCodexManagerAccountJson
} from "../core/types";
import { normalizeQuotaSummary } from "../utils/quotaWindows";
import {
  fromSharedQuota,
  fromSharedQuotaError,
  normalizeAccountTags,
  normalizeEpochMs,
  previewSharedEntry,
  sanitizeOptionalValue
} from "./sharedAccounts";

export function toSharedEntries(input: SharedCodexManagerAccountJson | SharedCodexManagerAccountJson[]): SharedCodexManagerAccountJson[] {
  const entries = Array.isArray(input) ? input : [input];
  return entries.map(normalizeSharedAccountImportEntry);
}

export function previewSharedAccountsImportEntries(
  entries: SharedCodexManagerAccountJson[],
  existingIds: Set<string>
): CodexImportPreviewSummary {
  const normalizedEntries = toSharedEntries(entries);
  const invalidEntries: CodexImportPreviewIssue[] = [];
  let valid = 0;
  let overwriteCount = 0;

  normalizedEntries.forEach((entry, index) => {
    try {
      const preview = previewSharedEntry(entry);
      valid += 1;
      if (preview.storageId && existingIds.has(preview.storageId)) {
        overwriteCount += 1;
      }
    } catch (error) {
      invalidEntries.push(createSharedImportIssue(entry, index, error));
    }
  });

  return {
    total: normalizedEntries.length,
    valid,
    overwriteCount,
    invalidCount: invalidEntries.length,
    invalidEntries
  };
}

export function createSharedImportIssue(
  entry: SharedCodexManagerAccountJson,
  index: number,
  error: unknown
): CodexImportResultIssue {
  return {
    index,
    accountId: sanitizeOptionalValue(entry.account_id) ?? sanitizeOptionalValue(entry.id),
    email: sanitizeOptionalValue(entry.email),
    message: typeof error === "string" ? error : getErrorMessage(error)
  };
}

export function applySharedAccountEntry(account: CodexManagerAccountRecord, entry: SharedCodexManagerAccountJson): void {
  // account.enabled and account.queuePriority intentionally remain untouched:
  // they belong to this PC, even when the rest of the session metadata came
  // from another machine.
  account.userId = sanitizeOptionalValue(entry.user_id) ?? account.userId;
  account.planType = sanitizeOptionalValue(entry.plan_type) ?? account.planType;
  account.subscriptionActiveUntil = sanitizeOptionalValue(entry.subscription_active_until) ?? account.subscriptionActiveUntil;
  account.accountId = sanitizeOptionalValue(entry.account_id) ?? account.accountId;
  account.organizationId = sanitizeOptionalValue(entry.organization_id) ?? account.organizationId;
  account.accountName = sanitizeOptionalValue(entry.account_name) ?? account.accountName;
  account.tags = normalizeAccountTags(entry.tags, account.tags);
  if (entry.token_refresh_enabled !== undefined) {
    account.tokenRefreshEnabled = entry.token_refresh_enabled !== false;
  }
  account.addedVia = sanitizeOptionalValue(entry.added_via) ?? account.addedVia ?? "json";
  account.accountStructure = sanitizeOptionalValue(entry.account_structure) ?? account.accountStructure;
  account.createdAt = normalizeEpochMs(entry.created_at) ?? account.createdAt;
  account.updatedAt = normalizeEpochMs(entry.last_used) ?? normalizeEpochMs(entry.added_at ?? undefined) ?? Date.now();
  account.credentialUpdatedAt =
    normalizeEpochMs(entry.credential_updated_at) ?? account.credentialUpdatedAt ?? account.createdAt;

  if (entry.quota !== undefined) {
    account.quotaSummary = entry.quota ? normalizeQuotaSummary(fromSharedQuota(entry.quota)) : undefined;
    if (account.quotaSummary) {
      account.lastQuotaAt = account.updatedAt;
    }
  }

  if (entry.quota_error !== undefined) {
    account.quotaError = fromSharedQuotaError(entry.quota_error);
    if (account.quotaError) {
      account.lastQuotaAt = account.updatedAt;
    }
  }
}

function normalizeSharedAccountImportEntry(entry: SharedCodexManagerAccountJson): SharedCodexManagerAccountJson {
  return entry;
}
