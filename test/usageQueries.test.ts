import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendDashboardUsageSnapshot, initializeDashboardUsageStorage, queryDashboardUsage, readDashboardUsageSummary, saveDashboardUsageHistory, upsertDashboardDailyUsageCache } from "../src/services/dashboardUsageHistory";
import { configureSqliteStateStore, SqliteStateStore } from "../src/storage/sqliteState";
import { initializeUsageStorage, queryUsageRows, readDailyUsageRow } from "../src/storage/sqliteUsage";
import { removeTestDirectory } from "./testFilesystem";

let store: SqliteStateStore;
let root: string;
const ctx = () => ({ globalState: { get: vi.fn(), update: vi.fn() } }) as never;
const day = 86_400_000;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "usage-query-"));
  store = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
  configureSqliteStateStore(store);
});
afterEach(async () => {
  vi.restoreAllMocks();
  configureSqliteStateStore(undefined);
  store.close();
  await removeTestDirectory(root);
});

describe("database-driven usage graphs", () => {
  it("queries a quota range with one earlier baseline per account and no future rows", async () => {
    const context = ctx();
    const at = Date.now() - 100_000;
    await saveDashboardUsageHistory(context, [
      { accountId: "a", at: at - 100, hourly: 80 }, { accountId: "a", at: at - 10, hourly: 70 },
      { accountId: "b", at: at - 20, hourly: 90 }, { accountId: "a", at: at + 1, hourly: 60 },
      { accountId: "b", at: at + 2, hourly: 85 }, { accountId: "a", at: at + 20, hourly: 50 }
    ]);
    const prepare = vi.spyOn(store, "prepare");
    const result = queryDashboardUsage(context, { mode: "quota", from: at, to: at + 10 });
    expect(result.history.map(sample => sample.at)).toEqual([at - 20, at - 10, at + 1, at + 2]);
    expect(result.oldestAt).toBe(at - 100);
    expect(result.dailyUsageCache).toEqual([]);
    expect(prepare.mock.calls.some(([sql]) => sql === "SELECT * FROM usage_samples ORDER BY at,account_id")).toBe(false);
  });

  it("writes only changed quota rows, expires retained rows, and clears without loading history", async () => {
    const context = ctx();
    const at = Date.now();
    const state = { settings: { usageHistoryRetentionDays: 7 }, accounts: [{ id: "a", metrics: [{ key: "hourly", period: "hourly", percentage: 80 }] }] } as never;
    await appendDashboardUsageSnapshot(context, state, at - 8 * day);
    await appendDashboardUsageSnapshot(context, state, at - day);
    const revision = readDashboardUsageSummary(context).revision;
    const prepare = vi.spyOn(store, "prepare");
    await appendDashboardUsageSnapshot(context, state, at);
    expect(readDashboardUsageSummary(context).count).toBe(1);
    const next = readDashboardUsageSummary(context);
    await appendDashboardUsageSnapshot(context, state, at + 2);
    expect(readDashboardUsageSummary(context)).toEqual(next);
    expect(next.revision).toBeGreaterThan(revision);
    expect(prepare.mock.calls.some(([sql]) => sql === "SELECT * FROM usage_samples ORDER BY at,account_id")).toBe(false);
    await saveDashboardUsageHistory(context, []);
    expect(readDashboardUsageSummary(context).count).toBe(0);
  });

  it("merges partial daily responses by account/date, replaces corrections, and returns only requested days", async () => {
    const context = ctx();
    const now = Date.now();
    await upsertDashboardDailyUsageCache(context, "a", { days: 30, points: [
      { date: "2026-10-13", totalTokens: 10 }, { date: "2026-10-14", totalTokens: 20 }
    ] }, now - 1);
    await upsertDashboardDailyUsageCache(context, "a", { days: 30, points: [{ date: "2026-10-14", totalTokens: 25 }] }, now);
    await upsertDashboardDailyUsageCache(context, "b", { days: 30, points: [{ date: "2026-10-14", totalTokens: 30 }] }, now);
    await upsertDashboardDailyUsageCache(context, "a", { days: 30, points: [{ date: "2026-10-14", totalTokens: 999 }] }, now - 2);
    expect(readDailyUsageRow(store, "a")?.usage.points.map(point => point.totalTokens)).toEqual([10, 25]);
    const result = queryDashboardUsage(context, { mode: "tokens", from: Date.parse("2026-10-14T00:00:00Z"), to: Date.parse("2026-10-15T00:00:00Z") });
    expect(result.dailyUsageCache.map(entry => [entry.accountId, entry.usage.points.map(point => point.totalTokens)])).toEqual([["a", [25]], ["b", [30]]]);
    expect(result.history).toEqual([]);
    expect(result.oldestAt).toBe(Date.parse("2026-10-13T00:00:00Z"));
  });

  it("retains more than 64 accounts and reads only metadata plus the selected token points", async () => {
    const context = ctx();
    for (let index = 0; index < 66; index++) await upsertDashboardDailyUsageCache(context, `account-${index}`, {
      days: 30, points: [{ date: "2026-10-14", totalTokens: index }]
    });
    const prepare = vi.spyOn(store, "prepare");
    const result = queryDashboardUsage(context, { mode: "tokens", from: Date.parse("2026-10-14T00:00:00Z"), to: Date.parse("2026-10-15T00:00:00Z") });
    expect(result.dailyUsageCache).toHaveLength(66);
    expect(prepare.mock.calls.some(([sql]) => sql === "SELECT data FROM daily_usage ORDER BY fetched_at DESC")).toBe(false);
    expect(result.dailyUsageCache.find(entry => entry.accountId === "account-0")?.usage.points[0]?.totalTokens).toBe(0);
  });

  it("bounds large query results and explicitly marks truncated data", () => {
    initializeDashboardUsageStorage(ctx());
    const at = Date.now() - 20_000;
    store.transaction(() => {
      const insert = store.prepare("INSERT INTO usage_samples(account_id,at,hourly) VALUES(?,?,?)");
      for (let index = 0; index < 10_002; index++) insert.run("a", at + index, index % 100);
    });
    const result = queryUsageRows(store, { mode: "quota", from: at, to: at + 11_000 });
    expect(result.history).toHaveLength(10_000);
    expect(result.truncated).toBe(true);
    expect(result.history[0]?.at).toBe(at + 2);
  });

  it("migrates existing daily rows into the date index while preserving the source", () => {
    store.database.exec("CREATE TABLE daily_usage(account_id TEXT PRIMARY KEY,fetched_at REAL NOT NULL,data TEXT NOT NULL)");
    const entry = { accountId: "a", fetchedAt: Date.now(), usage: { days: 30, points: [{ date: "2026-10-14", totalTokens: 12 }] } };
    store.prepare("INSERT INTO daily_usage VALUES(?,?,?)").run("a", entry.fetchedAt, JSON.stringify(entry));
    initializeUsageStorage(store);
    expect(store.prepare("SELECT COUNT(*) AS count FROM daily_usage_points").get()?.["count"]).toBe(1);
    expect(readDailyUsageRow(store, "a")).toEqual(entry);
    expect(store.get("migrations", "daily-usage-points-v1")).toBe(true);
  });

  it.each([undefined, { mode: "quota", from: 0, to: 1 }, { mode: "quota", from: 1, to: Infinity },
    { mode: "tokens", from: 1, to: 32 * day }, { mode: "other", from: 1, to: 2 }])("rejects invalid ranges before querying: %j", query => {
    const prepare = vi.spyOn(store, "prepare");
    expect(() => queryDashboardUsage(ctx(), query as never)).toThrow("usage graph range is invalid");
    expect(prepare).not.toHaveBeenCalled();
  });
});
