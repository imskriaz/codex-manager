import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import { constants } from "fs";
import { getCodexManagerStorageRoot } from "../utils/storageRoot";
import { isManagedStatePath, SqliteStateStore, type Database } from "./sqliteState";
import { getCodexHomeStateKey } from "../codex/authFile";
import { CrossWindowOperationCoordinator } from "../utils/crossWindowOperations";

type Snapshot = { file: string; key: string; bytes: Buffer; hash: string; modifiedAt: number };

/** Retain every source byte until both databases commit and the source is verified unchanged. */
export async function migrateManagerStorage(targetRoot = getCodexManagerStorageRoot(), beforeCleanup?: () => Promise<void>): Promise<{ migrated: boolean; archivedFiles: number }> {
  targetRoot = path.resolve(targetRoot);
  const sourceRoot = path.resolve(targetRoot,"..",".codex-manager");
  const source = await fs.lstat(sourceRoot).catch((error:NodeJS.ErrnoException)=>{if(error.code === "ENOENT")return undefined;throw error;});
  if (!source) return {migrated:false,archivedFiles:0};
  if (!source.isDirectory() || source.isSymbolicLink() || sourceRoot === targetRoot)
    throw new Error("The previous manager storage must be a real, separate directory.");
  const coordinator = new CrossWindowOperationCoordinator(targetRoot);
  return coordinator.runExclusive("storage:root-migration","Storage migration",()=>migrateStorageExclusive(targetRoot,beforeCleanup),{waitMs:2_000});
}

async function migrateStorageExclusive(targetRoot:string,beforeCleanup?:()=>Promise<void>):Promise<{migrated:boolean;archivedFiles:number}> {
  targetRoot = path.resolve(targetRoot);
  const sourceRoot = path.resolve(targetRoot, "..", ".codex-manager");
  const sourceStat = await fs.lstat(sourceRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!sourceStat) return { migrated: false, archivedFiles: 0 };
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink() || path.resolve(targetRoot) === sourceRoot)
    throw new Error("The previous manager storage must be a real, separate directory.");

  let source: Database | undefined;
  let sourceTransaction = false;
  let manager: SqliteStateStore | undefined;
  let logs: SqliteStateStore | undefined;
  const sourceDatabase = path.join(sourceRoot, "codex-manager.sqlite");
  try {
    manager = await SqliteStateStore.open(path.join(targetRoot, "manager.sqlite"));
    const cleanupStarted = manager.get("migrations", "storage-migration-cleanup-v1") === true;
    const databaseStat = await fs.lstat(sourceDatabase).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!databaseStat && !cleanupStarted) {
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        const orphan = await fs.lstat(sourceDatabase + suffix).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
        if (orphan) throw new Error("The previous database is missing but recovery files remain. Source files were retained.");
      }
    }
    if (databaseStat) {
      if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) throw new Error("Storage migration refuses a linked database.");
      const moduleName = "node:sqlite";
      const sqlite = await import(moduleName) as { DatabaseSync: new (file: string) => Database };
      source = new sqlite.DatabaseSync(sourceDatabase);
      source.exec("PRAGMA busy_timeout = 100");
      const version = source.prepare("PRAGMA user_version").get()?.["user_version"];
      if (version !== 1) throw new Error("The previous database has an unsupported schema; its files were retained.");
      const tables = source.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
      if (tables.length !== 1 || tables[0]?.["name"] !== "state") throw new Error("The previous database has unknown tables; its files were retained.");
      // Changing WAL mode requires other connections to close, including idle older hosts.
      const mode = source.prepare("PRAGMA journal_mode = DELETE").get()?.["journal_mode"];
      if (mode !== "delete") throw new Error("Close older Codex Manager windows before moving storage.");
      source.exec("BEGIN EXCLUSIVE");
      sourceTransaction = true;
      if (source.prepare("PRAGMA integrity_check").get()?.["integrity_check"] !== "ok")
        throw new Error("The previous database failed its integrity check; its files were retained.");
    }
    const snapshots = await collectSnapshots(sourceRoot);
    const homeKeys = new Map([...new Set(snapshots.filter(item=>item.key.startsWith("window-codex-homes-v1/")).map(item=>item.key.split("/").slice(0,2).join("/")))]
      .map(home=>[getCodexHomeStateKey(path.join(sourceRoot,home)),getCodexHomeStateKey(path.join(targetRoot,home))]));
    assertNoLiveOwners(snapshots);
    logs = await SqliteStateStore.open(path.join(targetRoot, "manager_logs.sqlite"));
    const state = manager;
    const diagnostics = logs;
    const rows = source?.prepare("SELECT namespace, key, value FROM state").all() ?? [];
    const incoming = new Set([
      ...rows.map(row => JSON.stringify([row["namespace"], row["key"]])),
      ...snapshots.filter(item => isManagedStatePath(item.key)).map(item => JSON.stringify(["files", item.key]))
    ]);
    state.transaction(() => {
      for (const marker of cleanupStarted ? [] : state.keys("storage-migration-imports")) {
        if (incoming.has(marker)) continue;
        const [namespace, key] = JSON.parse(marker) as [string, string];
        const previous = state.get<{ value: unknown }>("storage-migration-imports", marker);
        if (previous && JSON.stringify(state.get(namespace, key)) === JSON.stringify(previous.value)) state.set(namespace, key, undefined);
        state.set("storage-migration-imports", marker, undefined);
      }
      for (const row of rows) {
        const namespace = String(row["namespace"]), key = String(row["key"]);
        importState(state, namespace, key, remapPaths(JSON.parse(String(row["value"])), sourceRoot, targetRoot, homeKeys));
      }
      for (const snapshot of snapshots.filter(item => !item.key.startsWith("logs/"))) {
        state.set("legacy-files", `${snapshot.key}:${snapshot.hash}`, { path: snapshot.key, sha256: snapshot.hash, modifiedAt: snapshot.modifiedAt, base64: snapshot.bytes.toString("base64") });
        if (isManagedStatePath(snapshot.key) && !rows.some(row => row["namespace"] === "files" && row["key"] === snapshot.key)) {
          let text = snapshot.bytes.toString("utf8");
          try { text = JSON.stringify(remapPaths(JSON.parse(text), sourceRoot, targetRoot, homeKeys)); } catch { /* Keep invalid state visible to existing recovery paths. */ }
          importState(state, "files", snapshot.key, { text });
        }
      }
    });
    diagnostics.transaction(() => {
      for (const snapshot of snapshots.filter(item => item.key.startsWith("logs/"))) {
        diagnostics.set("legacy-files", `${snapshot.key}:${snapshot.hash}`, { path: snapshot.key, sha256: snapshot.hash, base64: snapshot.bytes.toString("base64") });
        for (const [index, line] of snapshot.bytes.toString("utf8").split("\n").entries()) {
          let record: { timestamp?: unknown } | null;
          try { record = JSON.parse(line) as typeof record; }
          catch { continue; } // Partial records remain in the byte-for-byte archive.
          if (record && typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp)))
            diagnostics.set("logs", `${new Date(record.timestamp).toISOString()}:${createHash("sha256").update(`${snapshot.key}:${index}:${line}`).digest("hex")}`, record);
        }
      }
    });
    for (const snapshot of snapshots) {
      const store = snapshot.key.startsWith("logs/") ? diagnostics : state;
      if (store.get<{ base64: string }>("legacy-files", `${snapshot.key}:${snapshot.hash}`)?.base64 !== snapshot.bytes.toString("base64") ||
          digest(await fs.readFile(snapshot.file)) !== snapshot.hash)
        throw new Error("Storage changed during migration. Source files were retained; retry after older hosts close.");
    }
    const current = await collectSnapshots(sourceRoot);
    if (current.length !== snapshots.length || current.some((item, i) => item.key !== snapshots[i]?.key || item.hash !== snapshots[i]?.hash))
      throw new Error("Storage changed during migration. Source files were retained; retry after older hosts close.");
    // Isolated Codex homes contain native auth/session files, which Codex still needs on disk.
    const isolatedHomes = path.join(sourceRoot, "window-codex-homes-v1");
    if (await fs.lstat(isolatedHomes).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; })) {
      const destination = path.join(targetRoot, "window-codex-homes-v1");
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
      for (const snapshot of snapshots.filter(item => item.key.startsWith("window-codex-homes-v1/"))) {
        const file = path.join(targetRoot, snapshot.key);
        for (let directory = path.dirname(file); directory !== path.resolve(targetRoot); directory = path.dirname(directory)) {
          const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
          if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("The new isolated Codex home contains a linked or invalid directory.");
        }
        const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
        if (stat) {
          if (!stat.isFile() || stat.isSymbolicLink() || digest(await fs.readFile(file)) !== snapshot.hash)
            throw new Error("Old and new isolated Codex homes conflict. Source files were retained.");
        } else {
          await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          await fs.copyFile(snapshot.file, file, constants.COPYFILE_EXCL);
        }
      }
    }
    await beforeCleanup?.();
    const verified = await collectSnapshots(sourceRoot);
    if (verified.length !== snapshots.length || verified.some((item, i) => item.key !== snapshots[i]?.key || item.hash !== snapshots[i]?.hash))
      throw new Error("Source storage changed before cleanup. Source files were retained; retry after older hosts close.");
    state.set("migrations", "storage-root-v2", true);
    source?.exec("COMMIT");
    sourceTransaction = false;
    source?.close();
    source = undefined;
    // sourceRoot is the validated literal sibling .codex-manager; never remove the shared Codex home.
    state.set("migrations", "storage-migration-cleanup-v1", true);
    await fs.rm(sourceRoot, { recursive: true, force: false });
    state.transaction(() => { for (const key of state.keys("storage-migration-imports")) state.set("storage-migration-imports", key, undefined); state.set("migrations", "storage-migration-cleanup-v1", undefined); });
    return { migrated: true, archivedFiles: snapshots.length };
  } catch (error) {
    if (/locked|busy/i.test(error instanceof Error ? error.message : String(error)))
      throw new Error("Storage migration is waiting for older Codex Manager hosts to close. Source data was retained.", { cause: error });
    throw error;
  } finally {
    if (source) {
      if (sourceTransaction) { try { source.exec("ROLLBACK"); } catch { /* Preserve the migration failure. */ } }
      source.close();
    }
    logs?.close();
    manager?.close();
  }
}

function importState(store: SqliteStateStore, namespace: string, key: string, value: unknown): void {
  const marker = JSON.stringify([namespace, key]);
  const current = store.get(namespace, key);
  const previous = store.get("migrations", "storage-migration-cleanup-v1") ? undefined : store.get<{ value: unknown }>("storage-migration-imports", marker);
  if (current !== undefined && (!previous || JSON.stringify(previous.value) !== JSON.stringify(current))) {
    if (JSON.stringify(current) !== JSON.stringify(value)) store.set("legacy-database-conflicts", marker, value);
    return;
  }
  store.set(namespace, key, value);
  store.set("storage-migration-imports", marker, { value });
}

async function collectSnapshots(root: string, directory = root): Promise<Snapshot[]> {
  const result: Snapshot[] = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    const key = path.relative(root, file).replace(/\\/g, "/");
    if (entry.isSymbolicLink()) throw new Error("Storage migration refuses linked files or directories.");
    if (entry.isDirectory()) result.push(...await collectSnapshots(root, file));
    else if (entry.isFile()) {
      if (/^codex-manager\.sqlite(?:-wal|-shm|-journal)?$/.test(key)) continue;
      // shortcut: archive files up to 32 MiB in memory, use chunked archives if larger legacy files occur.
      const stat = await fs.stat(file);
      if (stat.size > 32 * 1024 * 1024) throw new Error(`Legacy storage file exceeds the safe migration limit: ${key}`);
      const bytes = await fs.readFile(file);
      result.push({ file, key, bytes, hash: digest(bytes), modifiedAt: stat.mtimeMs });
    } else throw new Error("Storage migration refuses special filesystem entries.");
  }
  return result;
}

function assertNoLiveOwners(snapshots: Snapshot[]): void {
  for (const snapshot of snapshots.filter(item => item.key.endsWith("/owner.json") || item.key === "always-online-relay.pid")) {
    let pid: unknown;
    try { pid = snapshot.key.endsWith(".pid") ? Number(snapshot.bytes.toString("utf8")) : (JSON.parse(snapshot.bytes.toString("utf8")) as { pid?: unknown }).pid; }
    catch { continue; }
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") continue; throw error; }
    throw new Error("Close older Codex Manager hosts and the detached relay before moving storage. Source data was retained.");
  }
}

function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function remapPaths(value: unknown, previous: string, next: string, homeKeys:ReadonlyMap<string,string>): unknown {
  if (typeof value === "string") {
    if (homeKeys.has(value)) return homeKeys.get(value);
    if (value.toLowerCase().startsWith(previous.toLowerCase())) return next + value.slice(previous.length);
    // Managed-file records store JSON as text.
    if (value.startsWith("{") || value.startsWith("[")) {
      try { return JSON.stringify(remapPaths(JSON.parse(value), previous, next, homeKeys)); } catch { return value; }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => remapPaths(item, previous, next, homeKeys));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [String(remapPaths(key, previous, next, homeKeys)), remapPaths(item, previous, next, homeKeys)]));
  return value;
}
