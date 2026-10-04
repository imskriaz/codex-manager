import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearQuotaCheckCoordination,
  getCoordinatedQuotaSnapshot,
  recordAccountQuotaCheck,
  recordPeerQuotaChecks,
  wasAccountQuotaCheckedWithin,
  wasQuotaCheckedWithin
} from "../src/services/quotaCheckCoordination";

describe("quota check coordination", () => {
  const now = 1_700_000_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => {
    clearQuotaCheckCoordination();
    vi.useRealTimers();
  });

  it("shares a peer account check timestamp across hosts", () => {
    recordPeerQuotaChecks([{ id: "account-1", lastQuotaAt: Date.now() }]);
    expect(wasQuotaCheckedWithin("account-1", 60_000)).toBe(true);
    expect(wasQuotaCheckedWithin("account-2", 60_000)).toBe(false);
  });

  it("does not apply a gap to an explicit zero-gap check", () => {
    recordPeerQuotaChecks([{ id: "account-1", lastQuotaAt: Date.now() }]);
    expect(wasQuotaCheckedWithin("account-1", 0)).toBe(false);
  });

  it("shares the same user and workspace across host-local account IDs", () => {
    recordPeerQuotaChecks([{ id: "peer-id", email: " User@Example.com ", accountId: "workspace-a", lastQuotaAt: now }]);
    const local = { id: "local-id", email: "user@example.com", accountId: "workspace-a" };
    expect(wasAccountQuotaCheckedWithin(local, 60_000)).toBe(true);
    expect(getCoordinatedQuotaSnapshot(local)?.checkedAt).toBe(now);
  });

  it("never shares quota between different workspaces with the same email", () => {
    recordPeerQuotaChecks([{ id: "peer-id", email: "user@example.com", accountId: "workspace-a", lastQuotaAt: now }]);
    for (const accountId of ["workspace-b", undefined]) {
      const local = { id: "local-id", email: "user@example.com", accountId };
      expect(wasAccountQuotaCheckedWithin(local, 60_000)).toBe(false);
      expect(getCoordinatedQuotaSnapshot(local)).toBeUndefined();
    }
  });

  it("never shares a workspace quota across different users", () => {
    recordPeerQuotaChecks([{ id: "peer-id", email: "user@example.com", accountId: "workspace-a", lastQuotaAt: now }]);
    const local = { id: "local-id", email: "other@example.com", accountId: "workspace-a" };
    expect(wasAccountQuotaCheckedWithin(local, 60_000)).toBe(false);
    expect(getCoordinatedQuotaSnapshot(local)).toBeUndefined();
  });

  it("retains email matching only when neither record has a workspace identity", () => {
    recordAccountQuotaCheck({ id: "local-id", email: " User@Example.com " }, now);
    expect(wasAccountQuotaCheckedWithin({ id: "peer-id", email: "user@example.com" }, 60_000)).toBe(true);
    expect(
      wasAccountQuotaCheckedWithin({ id: "peer-id", email: "user@example.com", accountId: "workspace-a" }, 60_000)
    ).toBe(false);
  });

  it("selects main windows by metric key and carries coherent reset reserves", () => {
    recordPeerQuotaChecks([
      {
        id: "account-1",
        lastQuotaAt: now,
        resetCreditsAvailable: 3,
        resetCreditsNextExpiresAt: now / 1000 + 600,
        metrics: [
          { key: "review", period: "weekly", percentage: 1, resetAt: 100 },
          { key: "additional-0-hourly", period: "hourly", percentage: 2, resetAt: 200 },
          { key: "hourly", period: "hourly", percentage: 75, resetAt: now / 1000 + 300 },
          { key: "weekly", period: "monthly", percentage: 50, resetAt: now / 1000 + 900 }
        ]
      }
    ]);
    expect(getCoordinatedQuotaSnapshot({ id: "account-1" })).toEqual({
      checkedAt: now,
      hourlyPercentage: 75,
      hourlyResetTime: now / 1000 + 300,
      weeklyPercentage: 50,
      weeklyResetTime: now / 1000 + 900,
      resetCreditsAvailable: 3,
      resetCreditsNextExpiresAt: now / 1000 + 600
    });
  });

  it("rejects invalid percentages, reset timestamps, and reset counts", () => {
    recordPeerQuotaChecks([
      {
        id: "account-1",
        lastQuotaAt: now,
        resetCreditsAvailable: -1,
        resetCreditsNextExpiresAt: Infinity,
        metrics: [
          { key: "hourly", percentage: NaN, resetAt: Infinity },
          { key: "weekly", percentage: 101, resetAt: -1 }
        ]
      }
    ]);
    const snapshot = getCoordinatedQuotaSnapshot({ id: "account-1" });
    expect(snapshot).toMatchObject({ checkedAt: now });
    expect(snapshot?.hourlyPercentage).toBeUndefined();
    expect(snapshot?.weeklyPercentage).toBeUndefined();
    expect(snapshot?.hourlyResetTime).toBeUndefined();
    expect(snapshot?.weeklyResetTime).toBeUndefined();
    expect(snapshot?.resetCreditsAvailable).toBeUndefined();
    expect(snapshot?.resetCreditsNextExpiresAt).toBeUndefined();
  });

  it("does not retain expiry from an older reset list after a newer snapshot", () => {
    recordPeerQuotaChecks([
      { id: "account-1", lastQuotaAt: now - 100, resetCreditsAvailable: 2, resetCreditsNextExpiresAt: now / 1000 + 600 }
    ]);
    recordPeerQuotaChecks([
      { id: "account-1", lastQuotaAt: now, resetCreditsAvailable: 0, resetCreditsNextExpiresAt: now / 1000 + 600 }
    ]);
    expect(getCoordinatedQuotaSnapshot({ id: "account-1" })?.resetCreditsAvailable).toBe(0);
    expect(getCoordinatedQuotaSnapshot({ id: "account-1" })?.resetCreditsNextExpiresAt).toBeUndefined();
  });

  it("ignores invalid and future peer timestamps without poisoning a later valid check", () => {
    for (const lastQuotaAt of [NaN, Infinity, 0, -1, now + 1, now + 86_400_000]) {
      recordPeerQuotaChecks([{ id: "account-1", lastQuotaAt }]);
      expect(wasQuotaCheckedWithin("account-1", 60_000)).toBe(false);
      expect(getCoordinatedQuotaSnapshot({ id: "account-1" })).toBeUndefined();
    }
    recordPeerQuotaChecks([{ id: "account-1", lastQuotaAt: now - 1 }]);
    expect(wasQuotaCheckedWithin("account-1", 60_000)).toBe(true);
  });

  it("expires coordination at the gap boundary and ignores clocks that move backward", () => {
    recordPeerQuotaChecks([{ id: "account-1", lastQuotaAt: now }]);
    expect(wasQuotaCheckedWithin("account-1", 60_000, now + 60_000)).toBe(false);
    expect(wasAccountQuotaCheckedWithin({ id: "account-1" }, 60_000, now - 1)).toBe(false);
    vi.setSystemTime(now - 1);
    expect(getCoordinatedQuotaSnapshot({ id: "account-1" })).toBeUndefined();
    recordPeerQuotaChecks([{ id: "account-1", lastQuotaAt: now - 1 }]);
    expect(getCoordinatedQuotaSnapshot({ id: "account-1" })?.checkedAt).toBe(now - 1);
  });

  it("never replaces newer local quota with an old or duplicate peer snapshot", () => {
    recordPeerQuotaChecks([{ id: "account-1", lastQuotaAt: now }]);
    recordPeerQuotaChecks([{ id: "account-1", lastQuotaAt: now - 1 }]);
    expect(getCoordinatedQuotaSnapshot({ id: "account-1", lastQuotaAt: now })).toBeUndefined();
    expect(getCoordinatedQuotaSnapshot({ id: "account-1", lastQuotaAt: now - 100 })?.checkedAt).toBe(now);
  });

  it("does not match a reused local ID across different workspace identities", () => {
    recordPeerQuotaChecks([
      {
        id: "same-id",
        email: "user@example.com",
        accountId: "remote-workspace",
        lastQuotaAt: now,
        metrics: [{ key: "hourly", percentage: 90 }]
      }
    ]);
    expect(
      getCoordinatedQuotaSnapshot({ id: "same-id", email: "user@example.com", accountId: "local-workspace" })
    ).toBeUndefined();
  });

  it("does not promote hidden or failed peer quota evidence", () => {
    recordPeerQuotaChecks([{ id: "hidden", lastQuotaAt: now, metrics: [{ key: "hourly", percentage: 100, visible: false }] }]);
    expect(getCoordinatedQuotaSnapshot({ id: "hidden" })?.hourlyPercentage).toBeUndefined();
    recordPeerQuotaChecks([{ id: "failed", lastQuotaAt: now, healthKind: "refresh_failed", metrics: [{ key: "hourly", percentage: 100 }] }]);
    expect(getCoordinatedQuotaSnapshot({ id: "failed" })).toBeUndefined();
    expect(wasQuotaCheckedWithin("failed", 60000)).toBe(false);
  });
});
