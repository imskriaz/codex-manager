import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateManagerStorage } from "../src/storage/storageMigration";
import { SqliteStateStore } from "../src/storage/sqliteState";
import { removeTestDirectory } from "./testFilesystem";
import { getCodexHomeStateKey } from "../src/codex/authFile";
import { readLatestValidTempIndex } from "../src/storage/accountsPersistence";
import { configureSqliteStateStore } from "../src/storage/sqliteState";

let home: string, source: string, target: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "manager-storage-migration-"));
  source = path.join(home, ".codex-manager"); target = path.join(home, ".codex");
});
afterEach(async () => { vi.restoreAllMocks(); await removeTestDirectory(home); });
async function write(name: string, text: string) {
  const file = path.join(source, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text);
}
async function oldStore() { return SqliteStateStore.open(path.join(source, "codex-manager.sqlite")); }
async function state(database = "manager.sqlite") { return SqliteStateStore.open(path.join(target, database)); }

describe("existing-user storage migration", () => {
  it("serializes file-only migration across windows and rechecks whether cleanup already finished",async()=>{
    await write("logging-settings.json",'{"enabled":false}');
    let release!:()=>void,entered!:()=>void;
    const ready=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const first=migrateManagerStorage(target,()=>{entered();return gate;});await ready;
    const second=migrateManagerStorage(target);await new Promise(resolve=>setTimeout(resolve,30));release();
    expect((await Promise.all([first,second])).map(result=>result.migrated)).toEqual([true,false]);
    const store=await state();try{expect(store.get("files","logging-settings.json")).toEqual({text:'{"enabled":false}'});}finally{store.close();}
  });

  it("does nothing for a fresh install without creating legacy folders", async () => {
    expect(await migrateManagerStorage(target)).toEqual({ migrated: false, archivedFiles: 0 });
    expect(await fs.readdir(home)).toEqual([]);
  });

  it("imports committed state, offline caches, logs and recovery files, preserving native auth", async () => {
    await fs.mkdir(target); await fs.writeFile(path.join(target, "auth.json"), "native-auth-do-not-touch");
    const old = await oldStore();
    old.set("global", "preference", true);
    old.set("files", "accounts-index.json", { text: '{"accounts":[{"id":"current"}]}' });
    old.set("files", "accounts/deleted.json", { text: null });
    old.set("files", "window-account-slots-v1.json", { text: JSON.stringify({ slots: [{ home: path.join(source, "window-codex-homes-v1", "slot") }] }) });
    old.close();
    await write("accounts-index.json", '{"accounts":[{"id":"stale"}]}');
    await write("accounts-index.json.tmp-crashed", "partial recovery snapshot");
    await write("accounts/deleted.json", "stale encrypted backup");
    await write("accounts/legacy.json", "legacy encrypted backup");
    await write("announcements/announcement_cache.json", '{"offline":true}');
    await write("logs/codex-manager-2026-10-16.jsonl", '{"timestamp":"2026-10-16T00:00:00.000Z","message":"retained"}\npartial');
    await write("unknown.bin", "unknown\u0000data");
    await write("always-online-server.js", "legacy executable");
    await write("window-codex-homes-v1/slot/auth.json", "isolated-native-auth");
    const result = await migrateManagerStorage(target);
    expect(result.migrated).toBe(true);
    expect(await fs.stat(source).catch(() => undefined)).toBeUndefined();
    expect(await fs.readFile(path.join(target, "auth.json"), "utf8")).toBe("native-auth-do-not-touch");
    expect(await fs.readFile(path.join(target, "window-codex-homes-v1", "slot", "auth.json"), "utf8")).toBe("isolated-native-auth");
    const store = await state(), logs = await state("manager_logs.sqlite");
    try {
      expect(store.get("global", "preference")).toBe(true);
      expect(store.get("files", "accounts-index.json")).toEqual({ text: '{"accounts":[{"id":"current"}]}' });
      expect(store.get("files", "accounts/deleted.json")).toEqual({ text: null });
      expect(store.get("files", "accounts/legacy.json")).toEqual({ text: "legacy encrypted backup" });
      expect(store.get<{text:string}>("files", "window-account-slots-v1.json")!.text).toContain(JSON.stringify(target).slice(1, -1));
      const archive = store.keys("legacy-files").map(key => store.get<{path:string; base64:string}>("legacy-files", key)!);
      expect(Buffer.from(archive.find(item => item.path === "unknown.bin")!.base64, "base64").toString()).toBe("unknown\u0000data");
      expect(archive.some(item => item.path.endsWith(".tmp-crashed"))).toBe(true);
      expect(logs.recent<{message:string}>("logs", 10).map(item => item.message)).toEqual(["retained"]);
      expect(logs.keys("legacy-files")).toHaveLength(1);
    } finally { logs.close(); store.close(); }
    expect(await migrateManagerStorage(target)).toEqual({ migrated: false, archivedFiles: 0 });
    expect((await fs.readdir(target)).sort()).toEqual(["auth.json", "manager.sqlite", "manager_logs.sqlite", "window-codex-homes-v1"].sort());
  });

  it("migrates file-only installs and leaves malformed snapshots available for normal recovery", async () => {
    await write("accounts-index.json", "partial JSON");
    await write("accounts-index.backup-1.json", '{"accounts":[]}');
    await write("logging-settings.json", '{"enabled":true,"retentionDays":7}');
    await migrateManagerStorage(target);
    const store = await state();
    expect(store.get("files", "accounts-index.json")).toEqual({ text: "partial JSON" });
    expect(store.keys("legacy-files")).toHaveLength(3);
    store.close();
  });

  it("refuses active older hosts and retries after their connection closes", async () => {
    const old = await oldStore(); old.set("global", "current", "saved");
    try { await expect(migrateManagerStorage(target)).rejects.toThrow(/older Codex Manager/); }
    finally { old.close(); }
    expect(await fs.stat(source)).toBeDefined();
    await expect(migrateManagerStorage(target)).resolves.toMatchObject({ migrated: true });
    const store = await state(); expect(store.get("global", "current")).toBe("saved"); store.close();
  });

  it("remaps scoped account selection and recovers archived interrupted account saves", async () => {
    const previous = getCodexHomeStateKey(path.join(source, "window-codex-homes-v1/slot"));
    const next = getCodexHomeStateKey(path.join(target, "window-codex-homes-v1/slot"));
    await write("window-codex-homes-v1/slot/auth.json", "native-auth");
    await write("accounts-index.json", JSON.stringify({ accounts: [], activeAccountStateVersion: 1, activeAccountIdsByCodexHome: { [previous]: "a" } }));
    await write("accounts-index.json.tmp-interrupted", JSON.stringify({ accounts: [{ id: "a", email: "a@example.com", createdAt: 1, updatedAt: 2 }] }));
    await migrateManagerStorage(target);
    const store = await state();
    configureSqliteStateStore(store);
    try {
      expect(JSON.parse(store.get<{text:string}>("files", "accounts-index.json")!.text).activeAccountIdsByCodexHome).toEqual({ [next]: "a" });
      expect((await readLatestValidTempIndex(path.join(target,"accounts-index.json"),".tmp"))?.accounts[0]?.id).toBe("a");
    } finally { configureSqliteStateStore(undefined); store.close(); }
  });

  it("preserves all sources on full storage, and resumes after a partially committed migration", async () => {
    const old = await oldStore(); old.set("global", "current", "first"); old.close();
    await write("accounts-index.json.tmp-recovery", "keep me");
    await fs.mkdir(target); await fs.writeFile(path.join(target, "manager_logs.sqlite"), "damaged logs database");
    await expect(migrateManagerStorage(target)).rejects.toThrow();
    const updated = await oldStore(); updated.set("global", "current", "newer"); updated.close();
    await fs.unlink(path.join(target, "manager_logs.sqlite"));
    const set = SqliteStateStore.prototype.set;
    const failure = vi.spyOn(SqliteStateStore.prototype, "set").mockImplementation(function(namespace, key, value) {
      if (namespace === "legacy-files") throw new Error("database or disk is full");
      return set.call(this, namespace, key, value);
    });
    await expect(migrateManagerStorage(target)).rejects.toThrow("full");
    expect(await fs.readFile(path.join(source, "accounts-index.json.tmp-recovery"), "utf8")).toBe("keep me");
    failure.mockRestore();
    await migrateManagerStorage(target);
    const store = await state(); expect(store.get("global", "current")).toBe("newer"); store.close();
  });

  it("preserves existing destination changes instead of overwriting them with older data", async () => {
    const old = await oldStore(); old.set("global", "preference", "old"); old.close();
    const current = await state(); current.set("global", "preference", "current"); current.close();
    await migrateManagerStorage(target);
    const store = await state(); expect(store.get("global", "preference")).toBe("current"); store.close();
  });

  it("preserves imported database rows when cleanup removed only part of the source folder", async () => {
    const old = await oldStore();
    old.set("global", "only-in-database", "committed");
    old.set("files", "accounts-index.json", { text: "authoritative database snapshot" });
    old.close();
    await write("accounts-index.json", "stale physical snapshot");
    await expect(migrateManagerStorage(target, () => Promise.reject(new Error("interrupted cleanup")))).rejects.toThrow("interrupted");
    const destination = await state();
    destination.set("migrations", "storage-migration-cleanup-v1", true);
    destination.close();
    await fs.unlink(path.join(source, "codex-manager.sqlite"));
    await migrateManagerStorage(target);
    const store = await state();
    try {
      expect(store.get("global", "only-in-database")).toBe("committed");
      expect(store.get("files", "accounts-index.json")).toEqual({ text: "authoritative database snapshot" });
      expect(store.get("migrations", "storage-migration-cleanup-v1")).toBeUndefined();
    } finally { store.close(); }
  });

  it("retains orphaned SQLite recovery files when the original database is missing", async () => {
    await write("codex-manager.sqlite-wal", "orphaned recovery bytes");
    await expect(migrateManagerStorage(target)).rejects.toThrow("recovery files remain");
    expect(await fs.readFile(path.join(source, "codex-manager.sqlite-wal"), "utf8")).toBe("orphaned recovery bytes");
  });

  it("detects source changes before cleanup and retries without duplicating appended logs", async () => {
    const first = '{"timestamp":"2026-10-16T00:00:00.000Z","message":"first"}\n';
    const second = '{"timestamp":"2026-10-16T00:00:01.000Z","message":"second"}\n';
    await write("logging-settings.json", '{"enabled":false}');
    await write("logs/current.jsonl", first);
    await expect(migrateManagerStorage(target, async () => {
      await write("logging-settings.json", '{"enabled":true}');
      await write("logs/current.jsonl", first + second);
    })).rejects.toThrow("changed before cleanup");
    expect(await fs.stat(source)).toBeDefined();
    await migrateManagerStorage(target);
    const store = await state(), logs = await state("manager_logs.sqlite");
    expect(store.get("files", "logging-settings.json")).toEqual({ text: '{"enabled":true}' });
    expect(logs.recent<{message:string}>("logs",10).map(item=>item.message)).toEqual(["first","second"]);
    store.close(); logs.close();
  });

  it("retains both native homes on a conflict and resumes a partially copied home", async () => {
    await write("window-codex-homes-v1/slot/auth.json", "original");
    const destination = path.join(target,"window-codex-homes-v1/slot");
    await fs.mkdir(destination,{recursive:true}); await fs.writeFile(path.join(destination,"auth.json"),"newer-native-auth");
    await expect(migrateManagerStorage(target)).rejects.toThrow("conflict");
    expect(await fs.readFile(path.join(source,"window-codex-homes-v1/slot/auth.json"),"utf8")).toBe("original");
    expect(await fs.readFile(path.join(destination,"auth.json"),"utf8")).toBe("newer-native-auth");
    await fs.unlink(path.join(destination,"auth.json"));
    await migrateManagerStorage(target);
    expect(await fs.readFile(path.join(destination,"auth.json"),"utf8")).toBe("original");
  });

  it("recovers committed WAL after an older process exits without closing the database", async () => {
    await fs.mkdir(source);
    const script = "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE state(namespace TEXT,key TEXT,value TEXT,PRIMARY KEY(namespace,key));PRAGMA user_version=1');db.prepare('INSERT INTO state VALUES(?,?,?)').run('global','reboot','true');process.exit(0)";
    execFileSync(process.execPath, ["-e", script, path.join(source,"codex-manager.sqlite")], { windowsHide: true, timeout: 10000, stdio: "pipe" });
    await migrateManagerStorage(target);
    const store = await state(); expect(store.get("global", "reboot")).toBe(true); store.close();
  });

  it("rejects corrupt/future databases, live file owners, and linked folders without deleting them", async () => {
    await write("codex-manager.sqlite", "damaged");
    await expect(migrateManagerStorage(target)).rejects.toThrow();
    expect(await fs.readFile(path.join(source,"codex-manager.sqlite"), "utf8")).toBe("damaged");
    await fs.unlink(path.join(source,"codex-manager.sqlite"));
    const future = new DatabaseSync(path.join(source,"codex-manager.sqlite")); future.exec("PRAGMA user_version=2"); future.close();
    await expect(migrateManagerStorage(target)).rejects.toThrow("unsupported schema");
    await fs.unlink(path.join(source,"codex-manager.sqlite"));
    await write("cross-window-operations-v1/owner/owner.json", JSON.stringify({ pid: process.pid }));
    await expect(migrateManagerStorage(target)).rejects.toThrow("Close older");
    await fs.unlink(path.join(source,"cross-window-operations-v1/owner/owner.json"));
    const external = path.join(home,"outside"); await fs.mkdir(external); await fs.writeFile(path.join(external,"keep"),"keep");
    await fs.symlink(external,path.join(source,"linked"),process.platform === "win32" ? "junction" : "dir");
    await expect(migrateManagerStorage(target)).rejects.toThrow("linked");
    expect(await fs.readFile(path.join(external,"keep"),"utf8")).toBe("keep");
  });
});
