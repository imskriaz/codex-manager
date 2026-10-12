import { describe, expect, it, vi } from "vitest";
import {
  normalizeDashboardDailyUsageCache,
  normalizeDashboardUsageHistory,
  appendDashboardUsageSnapshot,
  readDashboardUsageHistory,
  saveDashboardUsageHistory,
  readDashboardDailyUsageCache,
  upsertDashboardDailyUsageCache
} from "../src/services/dashboardUsageHistory";

describe("dashboard daily usage cache", () => {
  it("keeps existing cache data when a replacement is invalid", async () => {
    const previous = [{ accountId: "account", fetchedAt: Date.now(), usage: { days: 7, points: [] } }];
    const update = vi.fn();
    const context = { globalState: { get: () => previous, update } } as never;
    await expect(upsertDashboardDailyUsageCache(context, "account", { days: 7, points: [] }, Infinity)).rejects.toThrow("cache entry is invalid");
    await expect(upsertDashboardDailyUsageCache(context, "account", { days: 90, points: [] })).rejects.toThrow("cache entry is invalid");
    expect(update).not.toHaveBeenCalled();
    expect(readDashboardDailyUsageCache(context)).toEqual(previous);
  });
  it("rejects malformed or oversized cached usage entries", () => {
    expect(
      normalizeDashboardDailyUsageCache([
        { accountId: "ok", fetchedAt: 100, usage: { days: 1, points: [{ date: "2026-08-28", totalTokens: 4 }] } },
        { accountId: "bad", fetchedAt: 100, usage: { days: 90, points: [] } },
        { accountId: "bad", fetchedAt: 100, usage: { days: 1, points: [{ date: "x", totalTokens: -1 }] } }
      ])
    ).toHaveLength(1);
  });

  it("rejects timestamps far in the future", () => {
    const future = Date.now() + 10 * 60_000;
    expect(
      normalizeDashboardDailyUsageCache([
        { accountId: "future", fetchedAt: future, usage: { days: 1, points: [] } }
      ])
    ).toEqual([]);
  });

  it("upserts usage in the reconciled global persistent store", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const context = {
      globalState: {
        get: vi.fn().mockReturnValue([]),
        update
      }
    } as never;
    const entries = await upsertDashboardDailyUsageCache(
      context,
      "account-1",
      { days: 7, points: [{ date: "2026-08-28", totalTokens: 42 }] },
      123
    );

    expect(entries[0]?.accountId).toBe("account-1");
    expect(update).toHaveBeenCalledWith("codexManager.dashboardDailyUsageCache.v1", entries);
    expect(readDashboardDailyUsageCache(context)).toEqual([]);
  });

  it("serializes concurrent upserts so both accounts survive", async () => {
    let stored: unknown[] = [];
    const context = {
      globalState: {
        get: vi.fn(() => stored),
        update: vi.fn(async (_key: string, value: unknown[]) => {
          await Promise.resolve();
          stored = value;
        })
      }
    } as never;

    await Promise.all([
      upsertDashboardDailyUsageCache(context, "account-a", { days: 7, points: [] }, Date.now()),
      upsertDashboardDailyUsageCache(context, "account-b", { days: 7, points: [] }, Date.now())
    ]);

    expect((stored as Array<{ accountId: string }>).map((entry) => entry.accountId).sort()).toEqual([
      "account-a",
      "account-b"
    ]);
  });
});

describe("dashboard usage persistence recovery", () => {
  function store() {
    const values = new Map<string, unknown>();
    const update = vi.fn(async (key: string, value: unknown) => {
      await Promise.resolve();
      values.set(key, value);
    });
    return { context: { globalState: { get: (key: string) => values.get(key), update } } as never, update };
  }
  const state = (id: string, percentage: number) => ({
    settings: { usageHistoryRetentionDays: 7 },
    accounts: [{ id, metrics: [{ key: "hourly", period: "hourly", percentage }] }]
  }) as never;

  it("keeps concurrent snapshots and does not append unchanged quotas", async () => {
    const { context, update } = store();
    const now = Date.now();
    await Promise.all([appendDashboardUsageSnapshot(context, state("a", 50), now), appendDashboardUsageSnapshot(context, state("b", 70), now)]);
    expect(readDashboardUsageHistory(context)).toHaveLength(2);
    await appendDashboardUsageSnapshot(context, state("a", 50), now + 1);
    expect(update).toHaveBeenCalledTimes(2);
    await appendDashboardUsageSnapshot(context, state("a", 0), now - 1);
    expect(readDashboardUsageHistory(context).find((sample) => sample.accountId === "a")?.hourly).toBe(50);
  });

  it("merges stale saves without erasing recent samples and clears explicitly", async () => {
    const { context } = store();
    const now = Date.now();
    await appendDashboardUsageSnapshot(context, state("a", 50), now);
    await saveDashboardUsageHistory(context, [{ at: now - 1, accountId: "b", hourly: 75 }]);
    expect(readDashboardUsageHistory(context)).toHaveLength(2);
    await saveDashboardUsageHistory(context, []);
    expect(readDashboardUsageHistory(context)).toEqual([]);
  });

  it("propagates storage-full failures without poisoning retries", async () => {
    const { context, update } = store();
    update.mockRejectedValueOnce(new Error("storage full"));
    await expect(appendDashboardUsageSnapshot(context, state("a", 50))).rejects.toThrow("storage full");
    await appendDashboardUsageSnapshot(context, state("b", 75));
    expect(readDashboardUsageHistory(context).map((sample) => sample.accountId)).toEqual(["b"]);
  });

  it("deduplicates records and rejects malformed or future timestamps", () => {
    const now = Date.now();
    expect(normalizeDashboardUsageHistory([
      { at: now, accountId: "a", hourly: 50 }, { at: now, accountId: "a", hourly: 60 },
      { at: Infinity, accountId: "b" }, { at: now + 600_000, accountId: "c" }
    ])).toEqual([{ at: now, accountId: "a", hourly: 60 }]);
    expect(normalizeDashboardDailyUsageCache([
      { accountId: "a", fetchedAt: now - 1, usage: { days: 1, points: [] } },
      { accountId: "a", fetchedAt: now, usage: { days: 7, points: [] } }
    ])).toEqual([{ accountId: "a", fetchedAt: now, usage: { days: 7, points: [] } }]);
  });

  it("keeps newer daily usage when an older request completes late", async () => {
    const { context } = store();
    const now = Date.now();
    await upsertDashboardDailyUsageCache(context, "a", { days: 7, points: [] }, now);
    await upsertDashboardDailyUsageCache(context, "a", { days: 1, points: [] }, now - 1);
    expect(readDashboardDailyUsageCache(context)[0]?.usage.days).toBe(7);
  });

  it("rejects invalid snapshot timestamps without deleting stored history", async () => {
    const { context } = store();
    await appendDashboardUsageSnapshot(context, state("a", 50));
    await expect(appendDashboardUsageSnapshot(context, state("b", 0), NaN)).rejects.toThrow("timestamp is invalid");
    expect(readDashboardUsageHistory(context)).toHaveLength(1);
  });
});
