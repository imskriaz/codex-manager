import { needsTokenRefresh } from "../../auth/oauth";
import { CodexManagerAccountRecord, CodexTokens } from "../../core/types";
import { getQuotaIssueKind, isCredentialRejection } from "../../utils/quotaIssue";
import type { AccountAutomationState, TokenAutomationSnapshot } from "../../presentation/workbench/tokenAutomationState";

export type AccountHealthKind = "healthy" | "expiring" | "refresh_failed" | "reauthorize" | "disabled" | "quota";

export type AccountHealthInfo = {
  kind: AccountHealthKind;
  issueKey: string;
  message?: string;
};

export function resolveAccountHealth(
  account: CodexManagerAccountRecord,
  tokens: CodexTokens | undefined,
  automation: TokenAutomationSnapshot
): AccountHealthInfo {
  const automationState = automation.accounts[account.id];
  const quotaIssueKind = getQuotaIssueKind(account.quotaError);
  if (quotaIssueKind === "disabled") {
    return {
      kind: "disabled",
      issueKey: buildIssueKey("disabled", account.quotaError?.code, account.quotaError?.message),
      message: account.quotaError?.message
    };
  }

  const automationError = automationState?.lastError;
  if (quotaIssueKind === "auth" || isCredentialRejection(automationError)) {
    return {
      kind: "reauthorize",
      issueKey: buildIssueKey("reauthorize", account.quotaError?.code, account.quotaError?.message, automationError),
      message: automationError ?? account.quotaError?.message
    };
  }

  if (quotaIssueKind === "quota") {
    return {
      kind: "quota",
      issueKey: buildIssueKey("quota", account.quotaError?.code, account.quotaError?.message),
      message: account.quotaError?.message
    };
  }

  if (automationError) {
    return {
      kind: "refresh_failed",
      issueKey: buildIssueKey("refresh_failed", undefined, automationError),
      message: automationError
    };
  }

  if (!tokens?.accessToken || !tokens.idToken) {
    return {
      kind: "reauthorize",
      issueKey: "reauthorize:missing-credentials",
      message: "Stored credentials are missing. Reauthorize this account to continue."
    };
  }

  if (tokens?.accessToken && tokens.idToken && needsTokenRefresh(tokens, automation.skewSeconds || 600)) {
    if (!tokens.refreshToken?.trim() && needsTokenRefresh(tokens, 0)) {
      return {
        kind: "reauthorize",
        issueKey: buildIssueKey("reauthorize", undefined, tokens.accountId ?? account.accountId),
        message: "Token expired and no refresh token is available"
      };
    }

    return {
      kind: "expiring",
      issueKey: buildIssueKey("expiring", undefined, tokens.accountId ?? account.accountId),
      message: "Token is nearing expiration"
    };
  }

  return {
    kind: "healthy",
    issueKey: "healthy"
  };
}

export function isHealthDismissed(account: CodexManagerAccountRecord, health: AccountHealthInfo): boolean {
  return Boolean(account.dismissedHealthIssueKey && account.dismissedHealthIssueKey === health.issueKey);
}

export function getAccountAutomationState(
  automation: TokenAutomationSnapshot,
  accountId: string
): AccountAutomationState | undefined {
  return automation.accounts[accountId];
}

function buildIssueKey(kind: AccountHealthKind, ...parts: Array<string | undefined>): string {
  return [kind, ...parts.filter((value): value is string => Boolean(value?.trim()))].join(":");
}
