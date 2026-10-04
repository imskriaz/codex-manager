import type { CodexManagerAccountRecord, CodexQuotaSummary, CodexTokens } from "../core/types";
import { extractClaims } from "../utils/jwt";
import { normalizeQuotaSummary } from "../utils/quotaWindows";
import { isFreePlanType } from "../utils/quotaLabels";
import {
  applyRemoteProfileToAccount,
  type RemoteAccountProfileLike,
  shouldRepairWorkspaceMetadata
} from "./accountMetadata";

export function applyQuotaUpdate(params: {
  account: CodexManagerAccountRecord;
  quotaSummary?: CodexQuotaSummary;
  quotaError?: CodexManagerAccountRecord["quotaError"];
  updatedPlanType?: string;
  updatedSubscriptionActiveUntil?: string;
  now: number;
}): string | undefined {
  params.account.lastQuotaAt = params.now;
  params.account.updatedAt = params.now;
  const previousQuotaSummary = params.account.quotaSummary;
  const nextQuotaSummary = normalizeQuotaSummary(
    params.quotaSummary ?? (params.quotaError ? previousQuotaSummary : undefined)
  );
  if (nextQuotaSummary && previousQuotaSummary) {
    nextQuotaSummary.resetCreditsExcludedIds = [...new Set([
      ...(previousQuotaSummary.resetCreditsExcludedIds ?? []),
      ...(nextQuotaSummary.resetCreditsExcludedIds ?? [])
    ])];
    // Omitted reset information is not a replacement snapshot. A supplied new
    // aggregate/list must not inherit expiry or IDs belonging to older credits.
    if (nextQuotaSummary.resetCreditsAvailable === undefined) {
      nextQuotaSummary.resetCreditsAvailable = previousQuotaSummary.resetCreditsAvailable;
      nextQuotaSummary.resetCreditsNextExpiresAt = previousQuotaSummary.resetCreditsNextExpiresAt;
      nextQuotaSummary.resetCreditsAvailableIds = previousQuotaSummary.resetCreditsAvailableIds
        ? [...previousQuotaSummary.resetCreditsAvailableIds]
        : undefined;
    } else if (nextQuotaSummary.resetCreditsAvailableIds === undefined &&
      nextQuotaSummary.resetCreditsExcludedIds.length > 0) {
      // The usage aggregate does not identify excluded credits. A dedicated
      // reset snapshot must verify any increase in usable reserves.
      nextQuotaSummary.resetCreditsAvailable = Math.min(
        nextQuotaSummary.resetCreditsAvailable, previousQuotaSummary.resetCreditsAvailable ?? 0
      );
      if (nextQuotaSummary.resetCreditsAvailable === 0) {
        nextQuotaSummary.resetCreditsNextExpiresAt = undefined;
      }
    }
    if (nextQuotaSummary.resetCreditsAvailableIds) {
      nextQuotaSummary.resetCreditsAvailableIds = nextQuotaSummary.resetCreditsAvailableIds.filter(
        (id) => !nextQuotaSummary.resetCreditsExcludedIds?.includes(id)
      );
    }
  }
  params.account.quotaSummary = nextQuotaSummary;
  params.account.quotaError = params.quotaError;
  params.account.dismissedHealthIssueKey = undefined;

  if (params.updatedPlanType) {
    params.account.planType = params.updatedPlanType;
    if (isFreePlanType(params.updatedPlanType)) {
      params.account.subscriptionActiveUntil = undefined;
    }
  }
  if (params.updatedSubscriptionActiveUntil && !isFreePlanType(params.updatedPlanType)) {
    params.account.subscriptionActiveUntil = params.updatedSubscriptionActiveUntil;
  }

  return params.account.planType;
}

export function syncLoginAtFromTokens(account: CodexManagerAccountRecord, tokens: CodexTokens): void {
  if (account.loginAt) {
    return;
  }

  const claims = extractClaims(tokens.idToken, tokens.accessToken);
  account.loginAt = claims.loginAt ?? account.loginAt;
}

export function shouldAttemptRemoteProfileRepair(account: CodexManagerAccountRecord, planType?: string): boolean {
  return shouldRepairWorkspaceMetadata(account, planType);
}

export function applyRemoteProfileFromTokens(params: {
  account: CodexManagerAccountRecord;
  tokens: CodexTokens;
  remoteProfile?: RemoteAccountProfileLike;
  planType?: string;
  allowAccountIdRepair?: boolean;
}): boolean {
  const claims = extractClaims(params.tokens.idToken, params.tokens.accessToken);
  return applyRemoteProfileToAccount({
    account: params.account,
    claims,
    remoteProfile: params.remoteProfile,
    planType: params.planType ?? params.account.planType,
    allowAccountIdRepair: params.allowAccountIdRepair
  });
}
