import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDailyTokenUsage } from "../src/services/dailyTokenUsage";
import { readDashboardDailyUsage, queryDashboardUsage, upsertDashboardDailyUsageCache } from "../src/services/dashboardUsageHistory";
import { configureSqliteStateStore, SqliteStateStore } from "../src/storage/sqliteState";
import { configureCrossWindowOperationCoordinator } from "../src/utils/crossWindowOperations";
import { removeTestDirectory } from "./testFilesystem";
import { APIError } from "../src/core/errors";
import { fetchWithTimeout } from "../src/utils/network";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const usage = { days: 30, points: [{ date: "2026-10-15", totalTokens: 42 }] };
let root: string;
let store: SqliteStateStore;
let now: number;
const context = () => ({ globalState: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) } }) as never;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "daily-token-usage-"));
  store = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
  configureSqliteStateStore(store);
  await configureCrossWindowOperationCoordinator(root);
  now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(async () => {
  vi.restoreAllMocks();
  configureSqliteStateStore(undefined);
  store.close();
  await removeTestDirectory(root);
});

describe("daily token usage on account load", () => {
  it("uses the shared bulk budget for automatic history and foreground capacity for a manual check", async () => {
    const budgets: boolean[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const slot = store.get<{ background: boolean }>("provider-budget", "0") ?? store.get<{ background: boolean }>("provider-budget", "1");
      budgets.push(slot!.background);
      return new Response(JSON.stringify(usage), { status: 200 });
    });
    const fetchUsage = async (signal: AbortSignal) => {
      const response = await fetchWithTimeout("https://provider.example.test/usage", { signal });
      return await response.json() as typeof usage;
    };
    await loadDailyTokenUsage(context(), "a", fetchUsage);
    now += 1000;
    await loadDailyTokenUsage(context(), "b", fetchUsage, { manual: true });
    expect(budgets).toEqual([true, false]);
  });

  it("shares a request and reuses the persisted result across contexts until exactly one hour", async () => {
    const ctx = context();
    let complete!: (value: typeof usage) => void;
    const fetchUsage = vi.fn(() => new Promise<typeof usage>(resolve => { complete = resolve; }));
    const first = loadDailyTokenUsage(ctx, "a", fetchUsage);
    const duplicate = loadDailyTokenUsage(ctx, "a", fetchUsage);
    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));
    complete(usage);
    await expect(first).resolves.toMatchObject({ accountId: "a", usage });
    now += HOUR - 1;
    await expect(loadDailyTokenUsage(context(), "a", fetchUsage)).resolves.toMatchObject({ usage });
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    now++;
    fetchUsage.mockImplementation(async () => usage);
    await loadDailyTokenUsage(context(), "a", fetchUsage);
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("applies the hourly gap to existing saved data without changing its timestamp", async () => {
    const fetchedAt = now - HOUR + 1;
    await upsertDashboardDailyUsageCache(context(), "a", usage, fetchedAt);
    const fetchUsage = vi.fn().mockResolvedValue(usage);
    await expect(loadDailyTokenUsage(context(), "a", fetchUsage)).resolves.toMatchObject({ fetchedAt });
    expect(fetchUsage).not.toHaveBeenCalled();
    now++;
    await loadDailyTokenUsage(context(), "a", fetchUsage);
    expect(fetchUsage).toHaveBeenCalledOnce();
  });

  it("preserves old data on failure and persists the failed attempt without automatic retries", async () => {
    await upsertDashboardDailyUsageCache(context(), "a", usage, now - 2 * DAY);
    const fetchUsage = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(loadDailyTokenUsage(context(), "a", fetchUsage)).rejects.toThrow("offline");
    expect(readDashboardDailyUsage(context(), "a")?.usage).toEqual(usage);
    await expect(loadDailyTokenUsage(context(), "a", fetchUsage)).rejects.toThrow(/offline.*one hour/);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    now += HOUR;
    fetchUsage.mockResolvedValue(usage);
    await expect(loadDailyTokenUsage(context(), "a", fetchUsage)).resolves.toMatchObject({ usage });
  });

  it("keeps an interrupted check on cooldown after reboot and never polls other accounts", async () => {
    store.set("daily-usage-checks", "a", { at: now, error: "The previous daily usage check did not complete." });
    const fetchUsage = vi.fn().mockResolvedValue(usage);
    await expect(loadDailyTokenUsage(context(), "a", fetchUsage)).rejects.toThrow("did not complete");
    expect(fetchUsage).not.toHaveBeenCalled();
    await loadDailyTokenUsage(context(), "b", fetchUsage);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(readDashboardDailyUsage(context(), "a")).toBeUndefined();
  });

  it("refuses a second window's request while the first owns the account check", async () => {
    let complete!: (value: typeof usage) => void;
    const fetchUsage = vi.fn(() => new Promise<typeof usage>(resolve => { complete = resolve; }));
    const first = loadDailyTokenUsage(context(), "a", fetchUsage);
    await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(1));
    await expect(loadDailyTokenUsage(context(), "a", fetchUsage)).rejects.toThrow("still in progress");
    complete(usage);
    await first;
    await loadDailyTokenUsage(context(), "a", fetchUsage);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, { days: 30, points: [{ date: "2026-02-30", totalTokens: 4 }] },
    { days: 30, points: [{ date: "2026-10-15", totalTokens: -1 }] },
    { days: 30, points: [{ date: "2026-10-15", totalTokens: 1, surfaceValues: { cli: Infinity } }] }])(
    "rejects an unreadable response without replacing history: %j", async invalid => {
      await upsertDashboardDailyUsageCache(context(), "a", usage, now - 2 * DAY);
      await expect(loadDailyTokenUsage(context(), "a", vi.fn().mockResolvedValue(invalid))).rejects.toThrow("readable daily data");
      expect(readDashboardDailyUsage(context(), "a")?.usage).toEqual(usage);
    }
  );

  it("does not call the provider when the attempt cannot be persisted", async () => {
    const set = store.set.bind(store);
    vi.spyOn(store, "set").mockImplementation((namespace, key, value) => {
      if (namespace === "daily-usage-checks") throw new Error("storage full");
      set(namespace, key, value);
    });
    const fetchUsage = vi.fn().mockResolvedValue(usage);
    await expect(loadDailyTokenUsage(context(), "a", fetchUsage)).rejects.toThrow("storage full");
    expect(fetchUsage).not.toHaveBeenCalled();
  });

  it("rolls back a failed history write and keeps the failure visible on reload", async () => {
    await upsertDashboardDailyUsageCache(context(), "a", usage, now - 2 * DAY);
    const prepare = store.prepare.bind(store);
    const spy = vi.spyOn(store, "prepare").mockImplementation(sql => {
      if (sql.startsWith("INSERT INTO daily_usage_points")) throw new Error("disk full");
      return prepare(sql);
    });
    const fetchUsage = vi.fn().mockResolvedValue({ days: 30, points: [{ date: "2026-10-15", totalTokens: 99 }] });
    await expect(loadDailyTokenUsage(context(), "a", fetchUsage)).rejects.toThrow("disk full");
    spy.mockRestore();
    expect(readDashboardDailyUsage(context(), "a")?.usage).toEqual(usage);
    await expect(loadDailyTokenUsage(context(), "a", fetchUsage)).rejects.toThrow("disk full");
    expect(fetchUsage).toHaveBeenCalledTimes(1);
  });

  it("rejects clock rollback and invalid check metadata without making a request", async () => {
    store.set("daily-usage-checks", "a", { at: now + DAY });
    const fetchUsage = vi.fn();
    await expect(loadDailyTokenUsage(context(), "a", fetchUsage)).rejects.toThrow("clock changed");
    store.set("daily-usage-checks", "a", { at: "invalid" });
    await expect(loadDailyTokenUsage(context(), "a", fetchUsage)).rejects.toThrow("saved usage check is invalid");
    expect(fetchUsage).not.toHaveBeenCalled();
  });

  it("bounds in-flight requests without retaining completed account histories", async () => {
    const ctx = context();
    let complete!: (value: typeof usage) => void;
    const response = new Promise<typeof usage>(resolve => { complete = resolve; });
    const fetchUsage = vi.fn(() => response);
    const requests = Array.from({ length: 32 }, (_, index) => loadDailyTokenUsage(ctx, `account-${index}`, fetchUsage));
    await expect(loadDailyTokenUsage(ctx, "queue-full", fetchUsage)).rejects.toThrow("request queue");
    await vi.waitFor(() => expect(fetchUsage).toHaveBeenCalledTimes(32));
    complete(usage);
    await Promise.all(requests);
    fetchUsage.mockResolvedValue(usage);
    await expect(loadDailyTokenUsage(ctx, "after-drain", fetchUsage)).resolves.toMatchObject({ accountId: "after-drain" });
  });

  it("honours a server retry delay longer than one hour", async () => {
    const fetchUsage = vi.fn().mockRejectedValue(new APIError("rate limited", { statusCode: 429, context: { retryAt: now + 2 * HOUR } }));
    await expect(loadDailyTokenUsage(context(), "a", fetchUsage)).rejects.toThrow("rate limited");
    now += HOUR;
    await expect(loadDailyTokenUsage(context(), "a", fetchUsage)).rejects.toThrow("server retry delays");
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    now += HOUR;
    fetchUsage.mockResolvedValue(usage);
    await loadDailyTokenUsage(context(), "a", fetchUsage);
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });
  it("refreshes manually inside one hour while retaining automatic throttling", async () => {
    const ctx = context();
    const fetchUsage = vi.fn().mockResolvedValue(usage);
    await loadDailyTokenUsage(ctx, "a", fetchUsage);
    now += 1000;
    fetchUsage.mockResolvedValue({ ...usage, points: [{ ...usage.points[0], totalTokens: 99 }] });
    await expect(loadDailyTokenUsage(ctx, "a", fetchUsage, { manual: true })).resolves.toMatchObject({ usage: { points: [{ totalTokens: 99 }] } });
    await loadDailyTokenUsage(ctx, "a", fetchUsage);
    expect(fetchUsage).toHaveBeenCalledTimes(2);
  });

  it("keeps provider retry delays even for explicit refresh", async () => {
    const fetchUsage = vi.fn().mockRejectedValue(new APIError("rate limited", { statusCode: 429, context: { retryAt: now + 60000 } }));
    await expect(loadDailyTokenUsage(context(), "a", fetchUsage)).rejects.toThrow("rate limited");
    await expect(loadDailyTokenUsage(context(), "a", fetchUsage, { manual: true })).rejects.toThrow("server cooldown");
    expect(fetchUsage).toHaveBeenCalledOnce();
  });

  it("retains ninety days in SQLite and applies a shorter retention to queries and writes", async () => {
    let retention = 90;
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback: unknown) => key === "tokenHistoryRetentionDays" ? retention : fallback } as never);
    const current = now;
    const point = (at: number) => ({ date: new Date(at).toISOString().slice(0, 10), totalTokens: 42 });
    now -= 60 * DAY;
    await upsertDashboardDailyUsageCache(context(), "a", { days: 1, points: [point(now)] }, now);
    now = current;
    await upsertDashboardDailyUsageCache(context(), "a", { days: 1, points: [point(now)] }, now);
    const query = { mode: "tokens" as const, from: now - 61 * DAY, to: now - 31 * DAY };
    expect(queryDashboardUsage(context(), query).dailyUsageCache[0]?.usage.points).toHaveLength(1);
    retention = 7;
    expect(queryDashboardUsage(context(), query).dailyUsageCache[0]?.usage.points).toHaveLength(0);
    await upsertDashboardDailyUsageCache(context(), "a", { days: 1, points: [point(now)] }, now + 1);
    expect(store.prepare("SELECT COUNT(*) AS count FROM daily_usage_points").get()?.["count"]).toBe(1);
  });

});
