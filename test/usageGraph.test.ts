import { describe, expect, it } from "vitest";
import { buildUsageEvents, buildDailyTokenUsageEvents, resolveUsageGraphBucketCount } from "../webview-src/dashboard/overviewSection";

describe("quota usage graph", () => {
  it("distributes a quota change observed after five minutes across those minutes", () => {
    const start = 1_800_000_000_000;
    const events = buildUsageEvents([
      { at: start, accountId: "account-1", hourly: 60, weekly: 80 },
      { at: start + 5 * 60_000, accountId: "account-1", hourly: 55, weekly: 80 }
    ]);

    expect(events).toHaveLength(5);
    expect(events.map((event) => event.at)).toEqual([
      start + 60_000,
      start + 2 * 60_000,
      start + 3 * 60_000,
      start + 4 * 60_000,
      start + 5 * 60_000
    ]);
    expect(events.map((event) => event.used)).toEqual([1, 1, 1, 1, 1]);
  });

  it("keeps unusually stale observations at their detection time", () => {
    const start = 1_800_000_000_000;
    const events = buildUsageEvents([
      { at: start, accountId: "account-1", hourly: 60 },
      { at: start + 61 * 60_000, accountId: "account-1", hourly: 50 }
    ]);

    expect(events).toEqual([{ at: start + 61 * 60_000, accountId: "account-1", used: 10 }]);
  });

  it("uses one bucket per minute in the one-hour view", () => {
    expect(resolveUsageGraphBucketCount("1h")).toBe(60);
  });

  it("aggregates quota interpolation without retaining every minute's event", () => {
    const start = Date.now() - 10 * 60_000;
    const history = [{ at: start, accountId: "a", hourly: 90 }, { at: start + 10 * 60_000, accountId: "a", hourly: 80 }];
    const events = buildUsageEvents(history, { from: start, to: start + 10 * 60_000, buckets: 2 });
    expect(events).toHaveLength(2);
    expect(events.reduce((sum, event) => sum + event.used, 0)).toBe(10);
  });

  it("consolidates daily tokens by their saved account and date without double counting", () => {
    const events = buildDailyTokenUsageEvents([
      { accountId: "a", fetchedAt: 1, usage: { days: 30, points: [{ date: "2026-10-15", totalTokens: 10 }] } },
      { accountId: "b", fetchedAt: 2, usage: { days: 30, points: [{ date: "2026-10-15", totalTokens: 20 }] } },
      { accountId: "a", fetchedAt: 3, usage: { days: 30, points: [{ date: "2026-10-15", totalTokens: 15 }] } }
    ]);
    expect(events.map(event => [event.accountId, event.used])).toEqual([["a", 15], ["b", 20]]);
    expect(events.every(event => event.at === Date.parse("2026-10-15T00:00:00Z"))).toBe(true);
  });
});
