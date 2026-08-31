import { afterEach, describe, expect, it } from "vitest";
import {
  clearQuotaCheckCoordination,
  recordPeerQuotaChecks,
  wasQuotaCheckedWithin
} from "../src/services/quotaCheckCoordination";

describe("quota check coordination", () => {
  afterEach(() => clearQuotaCheckCoordination());

  it("shares a peer account check timestamp across hosts", () => {
    recordPeerQuotaChecks([{ id: "account-1", lastQuotaAt: Date.now() }]);
    expect(wasQuotaCheckedWithin("account-1", 60_000)).toBe(true);
    expect(wasQuotaCheckedWithin("account-2", 60_000)).toBe(false);
  });

  it("does not apply a gap to an explicit zero-gap check", () => {
    recordPeerQuotaChecks([{ id: "account-1", lastQuotaAt: Date.now() }]);
    expect(wasQuotaCheckedWithin("account-1", 0)).toBe(false);
  });
});
