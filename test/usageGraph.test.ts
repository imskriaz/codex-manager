import { describe, expect, it } from "vitest";
import { buildUsageEvents, buildDailyTokenUsageEvents, consolidateDailyUsageEvents, resolveUsageGraphBucketCount, resolveUsageAxisMaximum, layoutUsageGraphBars, positionUsageGraphTooltip, summarizeUsageSegments, formatTokenCount } from "../webview-src/dashboard/overviewSection";

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
      { accountId: "a", fetchedAt: 1, usage: { days: 30, points: [{ unit: "tokens", date: "2026-10-15", totalTokens: 110, extensionTokens: 10 }] } },
      { accountId: "b", fetchedAt: 2, usage: { days: 30, points: [{ unit: "tokens", date: "2026-10-15", totalTokens: 220, extensionTokens: 20, surfaceValues: { vscode: 20, cli: 200 } }] } },
      { accountId: "a", fetchedAt: 3, usage: { days: 30, points: [{ unit: "tokens", date: "2026-10-15", totalTokens: 115, extensionTokens: 15 }] } }
    ]);
    expect(events.map(event => [event.accountId, event.used])).toEqual([["a", 115], ["b", 220]]);
    const consolidated = consolidateDailyUsageEvents(events);
    expect(consolidated).toMatchObject([{ accountId: "all", used: 335, segments: [{ key: "VS Code", used: 35 }, { key: "Other", used: 300 }] }]);
    expect(events.every(event => event.at === Date.parse("2026-10-15T00:00:00Z"))).toBe(true);
  });
  it("excludes unverified legacy values while preserving verified Other usage", () => {
    const events = buildDailyTokenUsageEvents([{ accountId: "a", fetchedAt: 1, usage: { days: 3, points: [
      { date: "2026-10-13", totalTokens: 900, surfaceValues: { cli: 900 } },
      { date: "2026-10-14", totalTokens: 700 },
      { unit: "tokens", date: "2026-10-15", totalTokens: 500, extensionTokens: 0 }
    ] } }]);
    expect(events).toMatchObject([{ accountId: "a", used: 500, segments: [{ key: "VS Code", used: 0 }, { key: "Other", used: 500 }] }]);
    expect(events).toHaveLength(1);
  });

  it("includes known totals with missing attribution without claiming they are VS Code or Other", () => {
    const events = buildDailyTokenUsageEvents([{ accountId: "a", fetchedAt: 1, usage: { days: 1, points: [
      { unit: "tokens", date: "2026-10-15", totalTokens: 500 }
    ] } }]);
    expect(consolidateDailyUsageEvents(events)).toMatchObject([{ used: 500, segments: [
      { key: "VS Code", used: 0 }, { key: "Other", used: 0 }, { key: "Unknown source", used: 500 }
    ] }]);
  });

});


describe("compact usage chart layout", () => {
  it("abbreviates token counts consistently across the chart and tooltips", () => {
    expect([0, 999, 1_000, 1_234, 1_000_000, 1_234_567, 1_000_000_000, 1_234_567_890].map(formatTokenCount))
      .toEqual(["0", "999", "1K", "1.2K", "1M", "1.2M", "1B", "1.2B"]);
  });
  it("uses readable linear scales for small quota changes and large token totals", () => {
    expect([0, 0.03, 0.4, 2, 2345, Infinity].map(resolveUsageAxisMaximum)).toEqual([1, 0.05, 0.5, 2, 5000, 1]);
    expect(Number.isFinite(resolveUsageAxisMaximum(Number.MAX_VALUE))).toBe(true);
    const bars = layoutUsageGraphBars([{ at: 5, accountId: "b", used: 25 }, { at: 5, accountId: "a", used: 50 }], 0, 10, 2, 100);
    expect(bars.map(bar => bar.event.accountId)).toEqual(["a", "b"]);
    expect(bars[0]!.height).toBe(bars[1]!.height * 2);
    expect(bars[0]!.x + bars[0]!.width).toBeLessThan(bars[1]!.x);
    expect(bars.every(bar => bar.x >= 0 && bar.x + bar.width <= 100)).toBe(true);
    expect(bars.map(bar => [bar.bucketStart, bar.bucketEnd])).toEqual([[5, 10], [5, 10]]);
  });

  it("keeps saved zero values and rejects invalid or out-of-range points", () => {
    const events = [-1, 0, 10, 11, NaN].map(at => ({ at, accountId: String(at), used: 0 }));
    events.push({ at: 5, accountId: "invalid", used: Infinity });
    expect(layoutUsageGraphBars(events, 0, 10, 2, 1).map(bar => bar.event.at)).toEqual([0, 10]);
    expect(layoutUsageGraphBars(events, 0, 0, 2, 1)).toEqual([]);
    expect(layoutUsageGraphBars(events, 0, 10, NaN, 1)).toEqual([]);
  });

  it("positions tooltips inside narrow viewports and falls below a top-edge bar", () => {
    const anchor = { left: 310, right: 320, top: 15, bottom: 50 };
    expect(positionUsageGraphTooltip(anchor, 264, 200, 320, 600)).toEqual({ left: 48, top: 60 });
    expect(positionUsageGraphTooltip({ ...anchor, left: 0, right: 10, top: 590, bottom: 600 }, 264, 200, 320, 600)).toEqual({ left: 8, top: 380 });
  });

  it("clamps tooltips at the viewport edges even with oversized content", () => {
    const anchor = { left: 380, right: 390, top: 900, bottom: 920 };
    expect(positionUsageGraphTooltip(anchor, 300, 200, 390, 600)).toEqual({ left: 82, top: 392 });
    expect(positionUsageGraphTooltip(anchor, 500, 700, 390, 600)).toEqual({ left: 8, top: 8 });
  });

  it("bounds source detail while preserving the complete total", () => {
    const segments = [1, 6, 3, 2, 4, 5, NaN, -1].map((used, index) => ({ key: String(index), used, color: "blue" }));
    const rows = summarizeUsageSegments(segments);
    expect(rows.map(row => row.used)).toEqual([6, 5, 4, 6]);
    expect(rows[3]!.key).toBe("Other sources");
    expect(rows.reduce((sum, row) => sum + row.used, 0)).toBe(21);
    expect(segments).toHaveLength(8);
  });
});
