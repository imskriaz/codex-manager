import { mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SqliteStateStore } from "../src/storage/sqliteState";
import { compactManagerDatabase } from "../src/storage/databaseMaintenance";
import { pruneManagerCaches, pruneManagerLogRows } from "../src/storage/storageCleanup";
import { writeManagerCacheEntry, peekManagerCacheId } from '../src/storage/managerCache';

let root: string, store: SqliteStateStore;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "manager-maintenance-")); store = await SqliteStateStore.open(path.join(root, "manager.sqlite")); });
afterEach(async () => { vi.restoreAllMocks(); store.close(); await rm(root, { recursive: true, force: true }); });

it("prunes expired Manager caches while preserving settings, credentials and pending work", () => {
  const now = Date.now();
  store.set("shared-reads", "expired", { completedAt: now - 61_000, value: "old" });
  store.set("shared-reads", "current", { completedAt: now, value: "new" });
  store.set("once-operations", "expired", now - 601_000); store.set("once-operations", "current", now);
  store.set("global", "codexManager.autoResumeSessionIds", ["keep"]);
  store.set("secrets", "token", "keep"); store.set("settings:local", "theme", "dark");
  store.set("unknown", "keep", { completedAt: 1 });
  writeManagerCacheEntry(store, 'expire', { id: 'one', completedAt: now, value: 'cached' });
  pruneManagerCaches(store, now);
  expect(peekManagerCacheId(store, 'expire')).toBe('one');
  pruneManagerCaches(store, now + 60_000);
  expect(peekManagerCacheId(store, 'expire')).toBeUndefined();
  expect(store.keys("shared-reads")).toEqual(["current"]); expect(store.keys("once-operations")).toEqual(["current"]);
  expect(store.get("global", "codexManager.autoResumeSessionIds")).toEqual(["keep"]);
  expect(store.get("secrets", "token")).toBe("keep"); expect(store.get("settings:local", "theme")).toBe("dark");
  expect(store.get("unknown", "keep")).toEqual({ completedAt: 1 });
});

it('continues other maintenance when the optional read cache cannot be pruned', () => {
  const now = Date.now(), prepare = store.prepare.bind(store);
  writeManagerCacheEntry(store, 'one', { id: 'one', completedAt: now, value: 1 });
  store.set('once-operations', 'expired', now - 601_000);
  vi.spyOn(store, 'prepare').mockImplementation(sql => {
    if (sql.startsWith('DELETE FROM manager_cache')) throw new Error('cache busy');
    return prepare(sql);
  });
  expect(() => pruneManagerCaches(store, now)).not.toThrow();
  expect(store.get('once-operations', 'expired')).toBeUndefined();
});

it("caps a noisy log day in SQLite and retains only current diagnostic archives", () => {
  const value = JSON.stringify({ message: "x".repeat(1024 * 1024) });
  store.transaction(() => {
    const insert = store.prepare("INSERT INTO state VALUES('logs',?,?)");
    for (let n = 0; n < 36; n++) insert.run(`2026-10-18T12:00:${String(n).padStart(2, "0")}Z`, value);
    store.set("logs", "2026-10-01", { message: "expired" });
    store.set("legacy-files", "logs/codex-manager-2026-10-01.jsonl:hash", { base64: "expired" });
    store.set("legacy-files", "logs/codex-manager-2026-10-18.jsonl:hash", { base64: "current" });
    store.set("unrelated", "keep", true);
  });
  pruneManagerLogRows(store, 3, new Date("2026-10-18T12:00:00Z"));
  expect(Number(store.prepare("SELECT SUM(length(CAST(value AS BLOB))) AS bytes FROM state WHERE namespace='logs'").get()?.["bytes"])).toBeLessThanOrEqual(32 * 1024 * 1024);
  expect(store.get("logs", "2026-10-01")).toBeUndefined();
  expect(store.keys("legacy-files")).toEqual(["logs/codex-manager-2026-10-18.jsonl:hash"]);
  expect(store.get("unrelated", "keep")).toBe(true);
});

it("reclaims an older Manager database without replacing it or losing retained rows", async () => {
  store.close(); await rm(path.join(root, "manager.sqlite"));
  const old = new DatabaseSync(path.join(root, "manager.sqlite"));
  old.exec("CREATE TABLE state(namespace TEXT,key TEXT,value TEXT,PRIMARY KEY(namespace,key)); PRAGMA user_version=1; BEGIN");
  const value = JSON.stringify("x".repeat(256 * 1024));
  for (let n = 0; n < 32; n++) old.prepare("INSERT INTO state VALUES('junk',?,?)").run(String(n), value);
  old.prepare("INSERT INTO state VALUES('accounts','keep','true')").run(); old.exec("COMMIT; DELETE FROM state WHERE namespace='junk'"); old.close();
  store = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
  const before = (await stat(store.file)).size;
  expect(await compactManagerDatabase(store.file)).toBe("completed");
  expect((await stat(store.file)).size).toBeLessThan(before / 2);
  expect(store.get("accounts", "keep")).toBe(true);
  expect(store.prepare("PRAGMA integrity_check").get()?.["integrity_check"]).toBe("ok");
  expect(store.prepare("PRAGMA auto_vacuum").get()?.["auto_vacuum"]).toBe(2);
});

it("defers a busy database and rejects native Codex database targets", async () => {
  const peer = new DatabaseSync(store.file);
  try {
    store.set("accounts", "keep", true); peer.exec("BEGIN IMMEDIATE");
    expect(await compactManagerDatabase(store.file)).toBe("deferred");
    expect(store.get("accounts", "keep")).toBe(true);
  } finally { peer.exec("ROLLBACK"); peer.close(); }
  await expect(compactManagerDatabase(path.join(root, "state_5.sqlite"))).rejects.toThrow("Only Manager");
  await expect(compactManagerDatabase(store.file, { days: 3, now: new Date() })).rejects.toThrow("Diagnostic retention");
  expect(await compactManagerDatabase(path.join(root, "manager_logs.sqlite"))).toBe("deferred");
});
