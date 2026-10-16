import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureSqliteStateStore, SqliteStateStore } from "../src/storage/sqliteState";
import { saveAccountIndex, readAccountIndex, readAccountRow } from "../src/storage/sqliteAccounts";
import { readUsageRows, replaceUsageRows, readDailyUsageRows, replaceDailyUsageRows } from "../src/storage/sqliteUsage";
import { saveSessionLive, readStoredSessionLive, listStoredSessionLive, readAccountSessionStats, readSessionStatus, saveSessionStatus, saveRunningTurnRows, readRunningTurnRows } from "../src/storage/sqliteSessions";
import { recordSessionLive, flushSessionRecording, disposeSessionRecording } from "../src/services/sessionRecording";
import type { DashboardCodexSessionLiveState } from "../src/domain/dashboard/types";
import { getCodexHome } from "../src/codex/authFile";
import { removeTestDirectory } from "./testFilesystem";

let root: string, store: SqliteStateStore;
const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const stream = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
function live(patch: Partial<DashboardCodexSessionLiveState> = {}): DashboardCodexSessionLiveState {
  return { sessionId: id, streamId: stream, sequence: 1, updatedAt: Date.now(), status: "running", messages: [{ id: "reply", text: "saved" }], tokenUsage: { total: 10, input: 7, output: 3 }, ...patch };
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "manager-records-"));
  store = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
  configureSqliteStateStore(store);
});
afterEach(async () => {
  disposeSessionRecording();
  configureSqliteStateStore(undefined);
  store.close();
  vi.restoreAllMocks();
  await removeTestDirectory(root);
});

describe("account and statistics rows", () => {
  it("queries accounts by identity, keeps scoped selection, and commits backups with changes", () => {
    const account = { id: "a", email: "a@example.com", createdAt: 1, updatedAt: 2 };
    saveAccountIndex(store, { accounts: [account], activeAccountStateVersion: 1, activeAccountIdsByCodexHome: { home: "a" } });
    expect(readAccountRow(store, "a", "home")).toMatchObject({ isActive: true });
    expect(readAccountRow(store, "a", "other")).toMatchObject({ isActive: false });
    saveAccountIndex(store, { accounts: [{ ...account, enabled: false }] }, 3);
    saveAccountIndex(store, { accounts: [] }, 0, true);
    expect(readAccountIndex(store).accounts[0]?.enabled).toBe(false);
    expect(JSON.parse(store.get<{text:string}>("files", "accounts-index.backup-1.json")!.text).accounts[0].enabled).toBeUndefined();
    expect(() => saveAccountIndex(store, { accounts: [account, account] })).toThrow(/duplicate/i);
    expect(readAccountIndex(store).accounts).toHaveLength(1);
    const peer = new DatabaseSync(store.file);
    try {
      peer.exec("BEGIN IMMEDIATE");
      expect(() => saveAccountIndex(store, { accounts: [] }, 3)).toThrow(/locked|busy/i);
      expect(readAccountRow(store, "a", "home")).toBeDefined();
      peer.exec("ROLLBACK");
      saveAccountIndex(store, { accounts: [] }, 3);
      expect(readAccountRow(store, "a", "home")).toBeUndefined();
    } finally { peer.close(); }
  });

  it("imports aggregate usage once, deduplicates samples, and rejects stale daily replacements", () => {
    const key = "legacy-usage", samples = [{ accountId: "a", at: 10, hourly: 20 }];
    store.set("global", key, samples);
    replaceUsageRows(store, samples, key);
    replaceUsageRows(store, [...samples, { accountId: "a", at: 10, hourly: 30 }], key);
    replaceUsageRows(store, samples, key, true);
    expect(readUsageRows(store)).toMatchObject([{ accountId: "a", at: 10, hourly: 30 }]);
    expect(store.get("global", key)).toBeUndefined();
    expect(store.get("legacy-state", key)).toEqual(samples);
    replaceDailyUsageRows(store, [{ accountId: "a", fetchedAt: 20, usage: { days: 1, points: [] } }], "daily");
    replaceDailyUsageRows(store, [{ accountId: "a", fetchedAt: 10, usage: { days: 2, points: [] } }], "daily");
    expect(readDailyUsageRows(store)[0]).toMatchObject({ fetchedAt: 20, usage: { days: 1 } });
    replaceUsageRows(store, [], key);
    expect(readUsageRows(store)).toEqual([]);
  });
});

describe("durable session recording", () => {
  it("rejects duplicate and stale events, retains each turn's totals, and keeps the account captured at start", () => {
    const first = live(), second = live({ streamId: "cccccccc-cccc-cccc-cccc-cccccccccccc", updatedAt: first.updatedAt + 20 });
    expect(saveSessionLive(store, root, first, "a")).toBe(true);
    expect(saveSessionLive(store, root, first, "a")).toBe(false);
    saveSessionLive(store, root, second, "b");
    saveSessionLive(store, root, { ...first, sequence: 2, updatedAt: first.updatedAt + 10, status: "completed", tokenUsage: { total: 15 } }, "b");
    expect(readStoredSessionLive(store, root, id)?.streamId).toBe(second.streamId);
    expect(readAccountSessionStats(store, "a")).toMatchObject({ turns: 1, total_tokens: 15 });
    expect(readAccountSessionStats(store, "b")).toMatchObject({ turns: 1, total_tokens: 10 });
    expect(saveSessionLive(store, root, { ...first, sequence: 3, status: "running" }, "a")).toBe(false);
    expect(listStoredSessionLive(store, root)).toHaveLength(1);
    expect(readStoredSessionLive(store, root, id.toUpperCase())?.streamId).toBe(second.streamId);
  });

  it("marks rebooted snapshots disconnected and expired or inconclusive native status unknown", () => {
    saveSessionLive(store, root, live());
    store.database.exec("UPDATE session_turns SET boot_at=0");
    expect(readStoredSessionLive(store, root, id)?.status).toBe("disconnected");
    saveSessionStatus(store, root, id, "running", Date.now() - 31_000);
    // An older check cannot replace the newer live record.
    expect(readSessionStatus(store, root, id)).toBe("running");
    store.database.exec("UPDATE session_status SET checked_at=0");
    expect(readSessionStatus(store, root, id)).toBe("unknown");
    saveSessionStatus(store, root, id, "unknown");
    expect(readSessionStatus(store, root, id)).toBe("unknown");
  });

  it("takes an immutable snapshot, retries storage contention, bounds its queue and resumes after draining", () => {
    const state = live();
    recordSessionLive(state, "a");
    state.messages[0]!.text = "mutated by listener";
    const peer = new DatabaseSync(store.file);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      peer.exec("BEGIN IMMEDIATE");
      expect(flushSessionRecording()).toBe(false);
      peer.exec("ROLLBACK");
      expect(flushSessionRecording()).toBe(true);
      expect(readStoredSessionLive(store, getCodexHome(), id)?.messages[0]?.text).toBe("saved");
      for (let n = 0; n < 129; n++) recordSessionLive(live({ streamId: `${n.toString(16).padStart(8, "0")}-dddd-dddd-dddd-dddddddddddd`, updatedAt: state.updatedAt + n + 1 }));
      expect(warning).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: expect.stringContaining("queue is full") }));
      expect(flushSessionRecording(128)).toBe(true);
      expect(store.database.prepare("SELECT COUNT(*) AS count FROM session_turns").get()?.["count"]).toBe(129);
      recordSessionLive(live({ sequence: 2, status: "completed" }));
      expect(flushSessionRecording()).toBe(true);
    } finally { peer.close(); }
  });

  it("retains committed turns when storage is full and retries without a file fallback", () => {
    saveSessionLive(store, root, live({ status: "completed", updatedAt: Date.now() - 6 * 60_000, messages: [], diff: "+retired display diff" }), "a");
    expect(readStoredSessionLive(store, root, id)?.diff).toBeUndefined();
    const pages = Number(store.database.prepare("PRAGMA page_count").get()?.["page_count"]);
    store.database.exec(`PRAGMA max_page_count=${pages}`);
    recordSessionLive(live({ streamId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", messages: Array.from({ length: 30 }, (_, n) => ({ id: String(n), text: "x".repeat(12_000) })) }), "a");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(flushSessionRecording()).toBe(false);
    expect(readAccountSessionStats(store, "a")["turns"]).toBe(1);
    store.database.exec("PRAGMA max_page_count=1073741823");
    expect(flushSessionRecording()).toBe(true);
    expect(readAccountSessionStats(store, "a")["turns"]).toBe(2);
  });

  it("migrates running recovery rows and preserves committed data after reopening", async () => {
    saveRunningTurnRows(store, [{ id, projectPath: root, startedAt: Date.now(), ownerPid: process.pid }]);
    saveSessionLive(store, root, live({ status: "completed" }), "a");
    store.close();
    store = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
    configureSqliteStateStore(store);
    expect(readRunningTurnRows(store)).toMatchObject([{ id, projectPath: root }]);
    expect(readStoredSessionLive(store, root, id)?.status).toBe("completed");
    expect(readAccountSessionStats(store, "a")).toMatchObject({ turns: 1, total_tokens: 10 });
    saveRunningTurnRows(store, []);
    expect(readRunningTurnRows(store)).toEqual([]);
  });
});
