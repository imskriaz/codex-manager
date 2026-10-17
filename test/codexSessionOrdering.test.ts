import { expect, it } from "vitest";
import { mergeDashboardPeers, stabilizeCliSessionOrder } from "../src/domain/codexSessionState";
import type { DashboardCliSessionSummary } from "../src/domain/dashboard/types";
const row = (id: string, deviceId?: string): DashboardCliSessionSummary => ({ id, title: id, status: "idle", deviceId });
it("preserves initial positions as timestamps and running states change", () => {
  const order = new Map<string, number>();
  expect(stabilizeCliSessionOrder([row("a"), row("b")], order).map(row => row.id)).toEqual(["a", "b"]);
  expect(stabilizeCliSessionOrder([{ ...row("b"), status: "running", updatedAt: new Date().toISOString() }, row("a")], order).map(row => row.id)).toEqual(["a", "b"]);
});

it("keeps remote PCs in the picker when session data arrives before peer metadata", () => {
  expect(mergeDashboardPeers(
    [{ id: "local", name: "This PC", sessionCount: 1, connected: true, local: true }],
    [{ id: "remote-session", title: "Remote", status: "running", remote: true, deviceId: "remote", deviceName: "LAPTOP" }]
  )).toEqual([
    { id: "local", name: "This PC", sessionCount: 1, connected: true, local: true },
    { id: "remote", name: "LAPTOP", sessionCount: 0, connected: false, local: false }
  ]);
});
it("uses confirmed peer presence over cached session data", () => {
  const peers = [{ id: "remote", name: "Laptop", sessionCount: 1, connected: true }];
  const sessions = [{ ...row("remote-session", "remote"), remote: true, status: "running" as const }];
  expect(mergeDashboardPeers(peers, sessions)).toEqual(peers);
  expect(mergeDashboardPeers([], sessions)[0]?.connected).toBe(false);
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
