import { describe, expect, it } from "vitest";
import { resolveAccountHealth } from "../src/application/accounts/health";
import type { CodexManagerAccountRecord, CodexTokens } from "../src/core/types";
import type { TokenAutomationSnapshot } from "../src/presentation/workbench/tokenAutomationState";
import { getQuotaIssueKind } from "../src/utils/quotaIssue";

function tokenExpiringAt(epochSeconds: number): string {
  return `header.${Buffer.from(JSON.stringify({ exp: epochSeconds })).toString("base64url")}.signature`;
}

describe("account token health", () => {
  it.each([
    ["OAuth request timed out", "refresh_failed"],
    ["Refresh token request failed: network offline", "refresh_failed"],
    ["Authorization service unavailable (HTTP 503)", "refresh_failed"],
    ["Request 14012 failed", "refresh_failed"],
    ["Token refresh failed (invalid_grant).", "reauthorize"],
    ["Token refresh failed (refresh_token_reused).", "reauthorize"],
    ["API returned 401 - Unauthorized", "reauthorize"],
    ["Refresh token has expired", "reauthorize"],
    ["Please sign in again", "reauthorize"],
    ["Reauthentication is required", "reauthorize"],
    ["Refresh token was already used", "reauthorize"]
  ])("classifies %s without confusing transport errors with invalid credentials", (message, kind) => {
    expect(resolveAccountHealth({ id: "account" } as never, { accessToken: "access", idToken: "id" }, {
      accounts: { account: { lastError: message } }
    } as never).kind).toBe(kind);
    expect(getQuotaIssueKind({ message } as never)).toBe(kind === "reauthorize" ? "auth" : "quota");
  });
  it("does not request login before an unrefreshable access token actually expires", () => {
    const now = Math.floor(Date.now() / 1000);
    const automation = { accounts: {}, skewSeconds: 600 } as never;
    expect(resolveAccountHealth({ id: "account" } as never, {
      idToken: "id", accessToken: tokenExpiringAt(now + 300)
    }, automation).kind).toBe("expiring");
    expect(resolveAccountHealth({ id: "account" } as never, {
      idToken: "id", accessToken: tokenExpiringAt(now - 1)
    }, automation).kind).toBe("reauthorize");
  });
  it("requires reauthorization when stored credentials are missing", () => {
    expect(resolveAccountHealth({ id: "missing" } as never, undefined, { accounts: {} } as never)).toMatchObject({
      kind: "reauthorize", message: expect.stringContaining("Stored credentials are missing")
    });
  });
  it("keeps an account healthy when only its ID token is expired", () => {
    const now = Math.floor(Date.now() / 1000);
    const account: CodexManagerAccountRecord = {
      id: "account",
      email: "dev@example.com",
      createdAt: 1,
      updatedAt: 1
    };
    const tokens: CodexTokens = {
      idToken: tokenExpiringAt(now - 60),
      accessToken: tokenExpiringAt(now + 3600),
      refreshToken: "refresh-token"
    };
    const automation: TokenAutomationSnapshot = {
      enabled: false,
      intervalMs: 0,
      skewSeconds: 600,
      accounts: {}
    };

    expect(resolveAccountHealth(account, tokens, automation).kind).toBe("healthy");
    expect(resolveAccountHealth(account, { ...tokens, accessToken: tokenExpiringAt(now - 60) }, automation).kind).toBe(
      "expiring"
    );
  });
});
