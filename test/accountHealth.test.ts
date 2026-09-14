import { describe, expect, it } from "vitest";
import { resolveAccountHealth } from "../src/application/accounts/health";
import type { CodexManagerAccountRecord, CodexTokens } from "../src/core/types";
import type { TokenAutomationSnapshot } from "../src/presentation/workbench/tokenAutomationState";

function tokenExpiringAt(epochSeconds: number): string {
  return `header.${Buffer.from(JSON.stringify({ exp: epochSeconds })).toString("base64url")}.signature`;
}

describe("account token health", () => {
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
