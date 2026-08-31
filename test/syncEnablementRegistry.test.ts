import { describe, expect, it } from "vitest";
import {
  createSyncAccountEnablement,
  mergeSyncAccountEnablement,
  isSyncAccountEnablementActive,
  SYNC_ACTIVITY_LEASE_TIMEOUT_MS
} from "../src/services/syncEnablementRegistry";

describe("synchronized account enablement registry", () => {
  it("keeps the record with the highest revision regardless of clock skew", () => {
    const older = createSyncAccountEnablement({
      accountId: "account-1",
      deviceId: "pc-a",
      deviceName: "Office PC",
      enabled: true,
      revision: 2,
      now: 9_000
    });
    const newer = createSyncAccountEnablement({
      accountId: "account-1",
      deviceId: "pc-b",
      deviceName: "Laptop",
      enabled: true,
      revision: 3,
      now: 100
    });

    expect(mergeSyncAccountEnablement([older], [newer])).toEqual([newer]);
  });

  it("keeps a disable record so stale enabled state cannot return", () => {
    const staleEnabled = createSyncAccountEnablement({
      accountId: "account-1",
      deviceId: "pc-a",
      deviceName: "Office PC",
      enabled: true,
      revision: 4,
      now: 100
    });
    const disabled = createSyncAccountEnablement({
      accountId: "account-1",
      deviceId: "pc-a",
      deviceName: "Office PC",
      enabled: false,
      revision: 5,
      now: 200
    });

    expect(mergeSyncAccountEnablement([staleEnabled], [disabled])).toEqual([disabled]);
  });

  it("resolves concurrent writes deterministically", () => {
    const office = createSyncAccountEnablement({
      accountId: "account-1",
      deviceId: "pc-a",
      deviceName: "Office PC",
      enabled: true,
      revision: 7,
      now: 100
    });
    const laptop = createSyncAccountEnablement({
      accountId: "account-1",
      deviceId: "pc-b",
      deviceName: "Laptop",
      enabled: true,
      revision: 7,
      now: 100
    });

    expect(mergeSyncAccountEnablement([office], [laptop])).toEqual([laptop]);
    expect(mergeSyncAccountEnablement([laptop], [office])).toEqual([laptop]);
  });

  it("treats a claim as active only after a recent successful sync", () => {
    const claim = createSyncAccountEnablement({
      accountId: "account-1",
      deviceId: "pc-a",
      deviceName: "Office PC",
      enabled: true,
      now: 1_000,
      lastSyncedAt: 10_000
    });

    expect(isSyncAccountEnablementActive(claim, 10_000 + SYNC_ACTIVITY_LEASE_TIMEOUT_MS - 1)).toBe(true);
    expect(isSyncAccountEnablementActive(claim, 10_000 + SYNC_ACTIVITY_LEASE_TIMEOUT_MS)).toBe(false);
  });

  it("prefers a newer activity stamp from the same PC at the same revision", () => {
    const older = createSyncAccountEnablement({
      accountId: "account-1",
      deviceId: "pc-a",
      deviceName: "Office PC",
      enabled: true,
      revision: 4,
      now: 100,
      lastSyncedAt: 1_000
    });
    const newer = { ...older, lastSyncedAt: 2_000 };
    expect(mergeSyncAccountEnablement([older], [newer])).toEqual([newer]);
  });
});
