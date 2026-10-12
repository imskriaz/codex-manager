import { describe, expect, it, vi } from "vitest";
import { SecretStore } from "../src/storage/secrets";

describe("stored credential validation", () => {
  it("does not expose malformed secret JSON in parser diagnostics", async () => {
    const secrets = { get: vi.fn().mockResolvedValue('{"accessToken":"private-credential", broken') };
    await expect(new SecretStore(secrets as never).getTokens("account")).rejects.toThrow(/^Stored credentials are invalid\. Reauthorize this account to replace them\.$/);
  });
  it.each([null, [], 42, {}, { idToken: "id", accessToken: 42 }, { idToken: "id", accessToken: "access", refreshToken: {} }])
    ("rejects malformed credentials without leaking their content: %j", async (value) => {
      const secrets = { get: vi.fn().mockResolvedValue(JSON.stringify(value)) };
      await expect(new SecretStore(secrets as never).getTokens("account")).rejects.toThrow("Stored credentials are invalid");
    });
  it("distinguishes missing credentials from unavailable storage and valid sessions", async () => {
    const tokens = { idToken: "id", accessToken: "access", refreshToken: "refresh" };
    const secrets = { get: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Secret Storage offline")).mockResolvedValueOnce(JSON.stringify(tokens)) };
    const store = new SecretStore(secrets as never);
    await expect(store.getTokens("account")).resolves.toBeUndefined();
    await expect(store.getTokens("account")).rejects.toThrow("Secret Storage offline");
    await expect(store.getTokens("account")).resolves.toEqual(tokens);
  });
});
