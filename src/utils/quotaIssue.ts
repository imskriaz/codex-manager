import type { CodexQuotaErrorInfo } from "../core/types";

export type QuotaIssueKind = "disabled" | "auth" | "quota";

export function getQuotaIssueKind(error?: CodexQuotaErrorInfo): QuotaIssueKind | undefined {
  if (!error) {
    return undefined;
  }

  const message = (error.message ?? "").toLowerCase();
  const code = String(error.code ?? "").toLowerCase();

  if (
    code === "deactivated_workspace" ||
    message.includes("deactivated_workspace") ||
    message.includes("api returned 402")
  ) {
    return "disabled";
  }

  if (
    code === "unauthorized" ||
    code.startsWith("auth_") ||
    isCredentialRejection(code) ||
    isCredentialRejection(message)
  ) {
    return "auth";
  }

  return "quota";
}

/** Transport errors mentioning OAuth or refresh tokens do not require a new login. */
export function isCredentialRejection(message = ""): boolean {
  return /\b(?:401|unauthorized|invalid_grant|refresh_token_(?:expired|reused|invalidated)|token_(?:expired|invalid|revoked))\b|\b(?:access |refresh )?token (?:has (?:been )?)?(?:expired|invalid|revoked|missing)\b|\b(?:expired|invalid|revoked) (?:access |refresh )?token\b|no refresh token is available/i.test(message);
}
