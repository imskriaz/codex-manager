import { expect, it } from "vitest";
import { stabilizeCliSessionOrder } from "../src/domain/codexSessionState";
import type { DashboardCliSessionSummary } from "../src/domain/dashboard/types";
const row = (id: string, deviceId?: string): DashboardCliSessionSummary => ({ id, title: id, status: "idle", deviceId });
it("preserves initial positions as timestamps and running states change", () => {
  const order = new Map<string, number>();
  expect(stabilizeCliSessionOrder([row("a"), row("b")], order).map(row => row.id)).toEqual(["a", "b"]);
  expect(stabilizeCliSessionOrder([{ ...row("b"), status: "running", updatedAt: new Date().toISOString() }, row("a")], order).map(row => row.id)).toEqual(["a", "b"]);
});
it("prepends new rows once and preserves positions across partial reconnects", () => {
  const order = new Map<string, number>();
  stabilizeCliSessionOrder([row("a"), row("b")], order);
  expect(stabilizeCliSessionOrder([row("c"), row("d"), row("b"), row("a")], order).map(row => row.id)).toEqual(["c", "d", "a", "b"]);
  stabilizeCliSessionOrder([row("b")], order);
  expect(stabilizeCliSessionOrder([row("a"), row("b"), row("d"), row("c")], order).map(row => row.id)).toEqual(["c", "d", "a", "b"]);
});
it("keeps the same session ID on different PCs distinct", () => {
  const order = new Map<string, number>();
  stabilizeCliSessionOrder([row("a", "one"), row("a", "two")], order);
  expect(stabilizeCliSessionOrder([row("a", "two"), row("a", "one")], order).map(row => row.deviceId)).toEqual(["one", "two"]);
});
