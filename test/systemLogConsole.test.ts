import { expect, it } from "vitest";
import { parseSystemLogRecords } from "../webview-src/dashboard/systemLogConsole";

it("keeps dated console rows in chronological order with bounded expandable details", () => {
  const rows = parseSystemLogRecords([null, 12, {}, { timestamp: "2026-10-18T12:00:00.000Z", level: "error", scope: "recovery", message: "First", details: { accepted: false } }, { timestamp: "invalid", level: "future", message: "Second" }]);
  expect(rows).toHaveLength(2); expect(rows.map(row => row.message)).toEqual(["First", "Second"]);
  expect(rows[0]).toMatchObject({ level: "error", scope: "recovery", timestamp: "2026-10-18T12:00:00.000Z" });
  expect(rows[0]?.details).toContain('"accepted": false'); expect(rows[1]).toMatchObject({ level: "info", scope: "system", timestamp: undefined });
  expect(parseSystemLogRecords([{ message: "x".repeat(100_000) }])[0]?.details.length).toBe(65_536);
  expect(parseSystemLogRecords(Array.from({ length: 1001 }, (_, i) => ({ message: String(i) })))[0]?.message).toBe("1");
});
