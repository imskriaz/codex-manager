import * as fs from "fs";
import * as path from "path";
import type * as vscode from "vscode";
import { hasAccountRows, readAccountIndex } from "./sqliteAccounts";

export type Database = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: Array<string | number | null>): Record<string, unknown> | undefined;
    all(...values: Array<string | number | null>): Record<string, unknown>[];
    run(...values: Array<string | number | null>): unknown;
  };
  close(): void;
};

export class SqliteStateStore {
  private constructor(readonly file: string, readonly database: Database) {}

  static async open(file: string): Promise<SqliteStateStore> {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(path.dirname(file), 0o700);
    const moduleName = "node:sqlite";
    const sqlite = await import(moduleName) as { DatabaseSync: new (file: string) => Database };
    const database = new sqlite.DatabaseSync(file);
    try {
      database.exec("PRAGMA busy_timeout = 100;");
      const version = database.prepare("PRAGMA user_version").get()?.["user_version"];
      if (typeof version !== "number" || version > 1) throw new Error("This storage database requires a newer Codex Manager version.");
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      database.exec("CREATE TABLE IF NOT EXISTS state (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, key)); PRAGMA user_version = 1;");
      if (process.platform !== "win32") fs.chmodSync(file, 0o600);
      return new SqliteStateStore(file, database);
    } catch (error) { database.close(); throw error; }
  }

  get<T>(namespace: string, key: string): T | undefined {
    const row = this.database.prepare("SELECT value FROM state WHERE namespace = ? AND key = ?").get(namespace, key);
    return row ? JSON.parse(String(row["value"])) as T : undefined;
  }

  set(namespace: string, key: string, value: unknown): void {
    if (value === undefined) {
      this.database.prepare("DELETE FROM state WHERE namespace = ? AND key = ?").run(namespace, key);
    } else {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new Error("The storage value cannot be serialized.");
      this.database.prepare("INSERT INTO state (namespace, key, value) VALUES (?, ?, ?) ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value WHERE state.value != excluded.value")
        .run(namespace, key, serialized);
    }
  }

  keys(namespace: string): string[] {
    return this.database.prepare("SELECT key FROM state WHERE namespace = ? ORDER BY key").all(namespace).map(row => String(row["key"]));
  }

  recent<T>(namespace: string, limit: number): T[] {
    return this.database.prepare("SELECT value FROM state WHERE namespace = ? ORDER BY key DESC LIMIT ?").all(namespace, limit)
      .map(row => JSON.parse(String(row["value"])) as T).reverse();
  }

  deleteBefore(namespace: string, key: string): void {
    this.database.prepare("DELETE FROM state WHERE namespace = ? AND key < ?").run(namespace, key);
  }

  transaction<T>(write: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = write();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* Preserve the original write failure. */ }
      throw error;
    }
  }

  close(): void { this.database.close(); }
}

let stateStore: SqliteStateStore | undefined;

export function getSqliteStateStore(): SqliteStateStore | undefined { return stateStore; }

export function isSqliteError(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number";
}

export function configureSqliteStateStore(store: SqliteStateStore | undefined): void { stateStore = store; }

export function createSqliteMemento(store: SqliteStateStore, namespace: string, legacy: vscode.Memento & { setKeysForSync?(keys: readonly string[]): void }): vscode.Memento & { setKeysForSync(keys: readonly string[]): void } {
  if (!store.get<boolean>("migrations", namespace)) {
    const entries = legacy.keys().map(key => [key, legacy.get(key)] as const);
    store.transaction(() => {
      if (store.get<boolean>("migrations", namespace)) return;
      for (const [key, value] of entries) if (store.get(namespace, key) === undefined) store.set(namespace, key, value);
      store.set("migrations", namespace, true);
    });
  }
  const syncKeys = new Set<string>();
  return {
    keys: () => store.keys(namespace),
    get: <T>(key: string, fallback?: T): T | undefined => {
      // Settings Sync remains the transport for the explicitly synchronized ciphertext.
      if (syncKeys.has(key)) {
        const downloaded = legacy.get<T>(key);
        if (JSON.stringify(downloaded) !== JSON.stringify(store.get(namespace, key))) store.set(namespace, key, downloaded);
      }
      const value = store.get<T>(namespace, key);
      return value === undefined ? fallback : value;
    },
    update: async (key: string, value: unknown) => {
      if (syncKeys.has(key)) await legacy.update(key, value);
      store.set(namespace, key, value);
    },
    setKeysForSync: (keys: readonly string[]) => {
      legacy.setKeysForSync?.(keys);
      syncKeys.clear();
      for (const key of keys) syncKeys.add(key);
    }
  } as vscode.Memento & { setKeysForSync(keys: readonly string[]): void };
}

/** Existing paths identify migration sources; SQLite owns subsequent managed-state writes. */
export function sqliteStoreForFile(file: string): SqliteStateStore | undefined {
  if (!stateStore) return undefined;
  const relative = path.relative(path.dirname(stateStore.file), path.resolve(file));
  const key = relative.replace(/\\/g, "/");
  return isManagedStatePath(key) ? stateStore : undefined;
}

export function isManagedStatePath(key: string): boolean {
  return /^(?:accounts-index(?:\.backup-\d+)?\.json|logging-settings\.json|window-account-slots-v1\.json|account-claim-authority\.json|always-online-relay\.(?:json|pid)|encrypted-accounts-vault\.json|codex-manager-running-turns\.json|startup-sync-cooldown\.json|maintenance-[a-f0-9]+\.json|accounts(?:\/[^/]+\.json)?|announcements(?:\/announcement_(?:cache|read_ids)\.json)?)$/.test(key);
}

function fileKey(store: SqliteStateStore, file: string): string {
  return path.relative(path.dirname(store.file), path.resolve(file)).replace(/\\/g, "/");
}

function readLegacyStateFile(file: string, maxBytes: number): string {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Stored state must be a regular file.");
    if (stat.size > maxBytes) throw new Error("Stored state exceeds its safe read limit.");
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (!bytes) break;
      offset += bytes;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally { fs.closeSync(descriptor); }
}

export function hasSqliteStateFile(file: string): boolean {
  const store = sqliteStoreForFile(file);
  if (store && fileKey(store, file) === "accounts-index.json" && hasAccountRows(store)) return true;
  return Boolean(store && store.get("files", fileKey(store, file)) !== undefined);
}

export function readSqliteStateFile(file: string, maxBytes = 32 * 1024 * 1024): string {
  const store = sqliteStoreForFile(file);
  if (!store) return readLegacyStateFile(file, maxBytes);
  const key = fileKey(store, file);
  if (key === "accounts-index.json" && hasAccountRows(store)) {
    const text = JSON.stringify(readAccountIndex(store));
    if (Buffer.byteLength(text) > maxBytes) throw new Error("Stored state exceeds its safe read limit.");
    return text;
  }
  let record = store.get<{ text: string | null }>("files", key);
  if (record === undefined) {
    const text = readLegacyStateFile(file, maxBytes);
    record = store.transaction(() => {
      const current = store.get<{ text: string | null }>("files", key);
      if (current) return current;
      const migrated = { text };
      store.set("files", key, migrated);
      return migrated;
    });
  }
  if (record.text === null) throw Object.assign(new Error(`Stored state does not exist: ${file}`), { code: "ENOENT" });
  if (typeof record.text !== "string" || Buffer.byteLength(record.text) > maxBytes) throw new Error("Stored state exceeds its safe read limit.");
  return record.text;
}

export function writeSqliteStateFile(file: string, text: string): void {
  const store = sqliteStoreForFile(file);
  if (!store) { fs.writeFileSync(file, text, { encoding: "utf8", mode: 0o600 }); return; }
  const key = fileKey(store, file);
  store.transaction(() => {
    if (key === "accounts-index.json") store.set("migrations", "account-rows-v1", undefined);
    store.set("files", key, { text });
  });
}

export function deleteSqliteStateFile(file: string): void {
  const store = sqliteStoreForFile(file);
  if (!store) { fs.rmSync(file, { force: true }); return; }
  const key = fileKey(store, file);
  store.transaction(() => {
    if (key === "accounts-index.json") store.set("migrations", "account-rows-v1", undefined);
    store.set("files", key, { text: null });
  });
}

export function listSqliteStateFiles(directory: string): string[] {
  const store = sqliteStoreForFile(directory);
  const disk = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  if (!store) return disk;
  const prefix = `${fileKey(store, directory)}/`;
  const saved = store.keys("files").filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"));
  const names = new Set([...disk, ...saved.map(key => key.slice(prefix.length))]);
  return [...names].filter(name => store.get<{ text: string | null }>("files", `${prefix}${name}`)?.text !== null);
}
