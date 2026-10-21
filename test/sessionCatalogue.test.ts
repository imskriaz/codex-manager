import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as fs from "fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("fs/promises", { spy: true });
import { SqliteStateStore, configureSqliteStateStore } from "../src/storage/sqliteState";
import { getCodexHomeStateKey } from "../src/codex/authFile";
import { invalidateSessionCatalogue, readSessionCatalogue, saveSessionCatalogue, pruneSessionCache, removeDeletedSessionCache, saveSessionStatus } from "../src/storage/sqliteSessions";
import { readCodexCliSessions } from "../src/services/codexSessionResume";
import { writeCodexSessionPreference } from '../src/services/codexSessionPreferences';
import * as settings from '../src/infrastructure/config/extensionSettings';
import { getNativeCodexSessionRunning } from "../src/services/codexNativeSessionStatus";
import type { DashboardCliSessionSummary } from "../src/domain/dashboard/types";
let root: string, store: SqliteStateStore;
const row: DashboardCliSessionSummary = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", title: "Older project work", projectPath: "D:/project", status: "idle", archived: false };
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "session-catalogue-")); store = await SqliteStateStore.open(path.join(root, "manager.sqlite")); configureSqliteStateStore(store); });
afterEach(async () => { configureSqliteStateStore(undefined); store.close(); vi.useRealTimers(); vi.mocked(fs.access).mockReset(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
it("shows persisted metadata immediately after reopening without scanning history", async () => {
  const generation = invalidateSessionCatalogue(store, root); saveSessionCatalogue(store, root, generation, [row], Date.now());
  store.close(); store = await SqliteStateStore.open(path.join(root, "manager.sqlite")); configureSqliteStateStore(store);
  const scan = vi.spyOn(fs, "readdir").mockClear();
  expect(await readCodexCliSessions(root)).toEqual([row]); expect(scan).not.toHaveBeenCalled();
});
it('clears removed queue and global recovery settings from cached rows without rescanning', async () => {
  const generation = invalidateSessionCatalogue(store, root);
  saveSessionCatalogue(store, root, generation, [{ ...row, queueEnabled: true, queuePriority: 1, queueError: 'Old failure', autoResumeEnabled: true }], Date.now());
  writeCodexSessionPreference(root, row.id, { queue: false });
  const scan = vi.spyOn(fs, 'readdir').mockClear();
  const result = (await readCodexCliSessions(root))[0]!;
  expect(result.queueEnabled).toBeUndefined(); expect(result.queuePriority).toBeUndefined(); expect(result.queueError).toBeUndefined(); expect(result.autoResumeEnabled).not.toBe(true);
  expect(scan).not.toHaveBeenCalled();
});
it('preserves a per-session Disable while global Auto Resume is enabled', async () => {
  vi.spyOn(settings, 'isAutoResumeEnabled').mockReturnValue(true);
  const generation = invalidateSessionCatalogue(store, root);
  saveSessionCatalogue(store, root, generation, [{ ...row, autoResumeEnabled: true }], Date.now());
  writeCodexSessionPreference(root, row.id, { autoResume: false });
  expect((await readCodexCliSessions(root))[0]?.autoResumeEnabled).toBe(false);
});
it("keeps verified running rows through stale metadata refresh using one batch status query", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const generation = invalidateSessionCatalogue(store, root);
  const rows = Array.from({length:100},(_,n) => ({...row,id:`${n.toString(16).padStart(8,"0")}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`,status:"running" as const}));
  saveSessionCatalogue(store,root,generation,rows,Date.now());
  vi.setSystemTime(Date.now()+6_000);
  for (const item of rows) saveSessionStatus(store,root,item.id,"running");
  vi.spyOn(fs,"access").mockRejectedValue(new Error("history drive offline"));
  const query = vi.spyOn(store,"prepare");
  const result = await readCodexCliSessions(root);
  expect(result.every(item => item.status === "running" && !item.statusError)).toBe(true);
  expect(query.mock.calls.filter(([sql]) => sql.startsWith("SELECT session_id,status FROM session_status"))).toHaveLength(1);
  expect(query.mock.calls.filter(([sql]) => sql.includes("session_status WHERE home=? AND session_id=?"))).toHaveLength(0);
});
it.each(["running","idle","unknown"] as const)("overlays fresh %s status without rescanning cached history", async status => {
  const generation = invalidateSessionCatalogue(store,root);
  saveSessionCatalogue(store,root,generation,[{...row,status:"unknown",locked:true,statusError:"Previous scan failed"}],Date.now());
  saveSessionStatus(store,root,row.id,status);
  const scan = vi.spyOn(fs,"readdir").mockClear();
  expect((await readCodexCliSessions(root))[0]).toMatchObject({status,locked:status!=="idle",canStop:false});
  if (status !== "unknown") expect((await readCodexCliSessions(root))[0]?.statusError).toBeUndefined();
  expect(scan).not.toHaveBeenCalled();
});
it("uses native transitions before their buffered write, and never promotes expired status", async () => {
  vi.useFakeTimers({toFake:["Date"]});
  const generation = invalidateSessionCatalogue(store,root);
  saveSessionCatalogue(store,root,generation,[{...row,status:"running"}],Date.now());
  saveSessionStatus(store,root,row.id,"running");
  vi.mocked(getNativeCodexSessionRunning).mockReturnValueOnce(false);
  expect((await readCodexCliSessions(root))[0]?.status).toBe("idle");
  vi.setSystemTime(Date.now()+31_000);
  vi.spyOn(fs,"access").mockRejectedValue(new Error("native storage offline"));
  expect((await readCodexCliSessions(root))[0]).toMatchObject({status:"unknown",locked:true,canStop:false});
});
it("prevents an old scan from restoring deleted metadata and isolates Codex homes", () => {
  const old = invalidateSessionCatalogue(store, root); saveSessionCatalogue(store, root, old, [row], Date.now());
  const current = invalidateSessionCatalogue(store, root);
  saveSessionCatalogue(store, root, old, [row], Date.now()); expect(readSessionCatalogue(store, root)?.invalidated).toBe(true);
  saveSessionCatalogue(store, root, current, [], Date.now()); expect(readSessionCatalogue(store, root)?.rows).toEqual([]);
  expect(readSessionCatalogue(store, path.join(root, "other"))).toBeUndefined();
});
it("retains saved history when a forced read encounters an unreadable native database", async () => {
  const generation = invalidateSessionCatalogue(store, root); saveSessionCatalogue(store, root, generation, [row], Date.now());
  await writeFile(path.join(root, "state_5.sqlite"), "unreadable database");
  await expect(readCodexCliSessions(root, undefined, true)).rejects.toThrow();
  expect(readSessionCatalogue(store, root)?.rows).toEqual([row]);
});
it("bounds cached homes and removes expired or malformed snapshots", () => {
  for (let i = 0; i < 12; i++) { const home = path.join(root, String(i)); const generation = invalidateSessionCatalogue(store, home); saveSessionCatalogue(store, home, generation, [row], Date.now()); }
  expect(store.keys("session-catalogue")).toHaveLength(8);
  store.set("session-catalogue", getCodexHomeStateKey(root), { checkedAt: 1 });
  store.database.prepare("INSERT INTO state VALUES ('session-catalogue','invalid','bad json')").run();
  pruneSessionCache(store);
  expect(store.keys("session-catalogue")).not.toContain("invalid"); expect(store.keys("session-catalogue")).not.toContain(getCodexHomeStateKey(root));
});
it("migrates the legacy JSON catalogue once and removes deleted rows from later snapshots", () => {
  const other = { ...row, id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", title: "Another project" };
  const key = getCodexHomeStateKey(root);
  store.set("session-catalogue", key, { generation: "old", checkedAt: Date.now(), bootAt: Date.now(), rows: [row, other] });
  expect(readSessionCatalogue(store, root)?.rows).toEqual([row, other]);
  expect(store.get<Record<string, unknown>>("session-catalogue", key)).not.toHaveProperty("rows");
  saveSessionCatalogue(store, root, "old", [other], Date.now());
  expect(readSessionCatalogue(store, root)?.rows).toEqual([other]);
  expect(store.prepare("SELECT COUNT(*) AS n FROM session_catalogue_rows").get()?.["n"]).toBe(1);
});
it("cleans confirmed deleted sessions but protects recovery and newer scans", () => {
  const generation = invalidateSessionCatalogue(store, root);
  saveSessionCatalogue(store, root, generation, [row], Date.now()); saveSessionStatus(store, root, row.id, "idle");
  store.set("workspace:local", "codexManager.autoResumeSessionIds", [row.id]);
  removeDeletedSessionCache(store, root, [row.id], generation);
  expect(readSessionCatalogue(store, root)?.rows).toEqual([row]);
  store.set("workspace:local", "codexManager.autoResumeSessionIds", undefined);
  const next = invalidateSessionCatalogue(store, root, true);
  removeDeletedSessionCache(store, root, [row.id], generation);
  expect(readSessionCatalogue(store, root)?.rows).toEqual([row]);
  removeDeletedSessionCache(store, root, [row.id], next);
  expect(readSessionCatalogue(store, root)?.rows).toEqual([]);
  expect(store.prepare("SELECT COUNT(*) AS n FROM session_status").get()?.["n"]).toBe(0);
});
it("omits stale index-only records after a complete scan", async () => {
  await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id: row.id, thread_name: row.title }));
  expect(await readCodexCliSessions(root, undefined, true)).toEqual([]);
});
it("rolls back an incomplete oversized cache replacement", () => {
  const generation = invalidateSessionCatalogue(store, root); saveSessionCatalogue(store, root, generation, [row], Date.now());
  expect(() => saveSessionCatalogue(store, root, generation, [{ ...row, projectPath: "x".repeat(9 * 1024 * 1024) }], Date.now())).toThrow("size limit");
  expect(readSessionCatalogue(store, root)?.rows).toEqual([row]);
});
