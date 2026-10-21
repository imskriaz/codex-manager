import type { SqliteStateStore } from './sqliteState';

export type ManagerCacheEntry<T> = { id: string; completedAt: number; value?: T };
const initialized = new WeakSet<SqliteStateStore>();
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;
const RETENTION_MS = 60_000;

function initialize(store: SqliteStateStore): void {
  if (initialized.has(store)) return;
  store.database.exec(`CREATE TABLE IF NOT EXISTS manager_cache (
    key TEXT PRIMARY KEY,id TEXT NOT NULL,created_at REAL NOT NULL,expires_at REAL NOT NULL,
    byte_size INTEGER NOT NULL CHECK(byte_size>=0),data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS manager_cache_expiry ON manager_cache(expires_at);
    CREATE INDEX IF NOT EXISTS manager_cache_recent ON manager_cache(created_at DESC,key);`);
  initialized.add(store);
}

export function peekManagerCacheId(store: SqliteStateStore, key: string): string | undefined {
  initialize(store);
  const id = store.prepare('SELECT id FROM manager_cache WHERE key=?').get(key)?.['id'];
  return typeof id === 'string' ? id : undefined;
}

export function readManagerCacheEntry<T>(store: SqliteStateStore, key: string, seenId: string | undefined, startedAt: number, maxAgeMs: number, now = Date.now()): ManagerCacheEntry<T> | undefined {
  initialize(store);
  const row = store.prepare(`SELECT id,created_at,data FROM manager_cache WHERE key=? AND created_at<=? AND expires_at>?
    AND (created_at>? OR (id IS NOT ? AND created_at>=?)) AND byte_size BETWEEN 0 AND ? AND length(CAST(data AS BLOB))=byte_size`)
    .get(key, now, now, now - Math.min(RETENTION_MS, Math.max(0, maxAgeMs)), seenId ?? null, startedAt, MAX_ENTRY_BYTES);
  if (!row || typeof row['id'] !== 'string' || typeof row['data'] !== 'string' || Buffer.byteLength(row['data']) > MAX_ENTRY_BYTES) return;
  try {
    const parsed = JSON.parse(row['data']) as { value?: T } | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    return { id: row['id'], completedAt: Number(row['created_at']), value: parsed.value };
  } catch { return; }
}

/** Evict using indexed metadata; never load the cache's payloads into memory together. */
export function pruneManagerCache(store: SqliteStateStore, now = Date.now(), keepKey = ''): void {
  initialize(store);
  store.prepare('DELETE FROM manager_cache WHERE expires_at<=? OR created_at>? OR byte_size>?').run(now, now, MAX_ENTRY_BYTES);
  store.prepare(`DELETE FROM manager_cache WHERE key IN (
    SELECT key FROM (SELECT key,ROW_NUMBER() OVER recent AS n,SUM(byte_size) OVER recent AS bytes
      FROM manager_cache WINDOW recent AS (ORDER BY (key=?) DESC,created_at DESC,key DESC))
    WHERE n>? OR bytes>?)`).run(keepKey, MAX_CACHE_ENTRIES, MAX_CACHE_BYTES);
}

export function writeManagerCacheEntry<T>(store: SqliteStateStore, key: string, entry: ManagerCacheEntry<T>): void {
  initialize(store);
  const data = JSON.stringify({ value: entry.value }), bytes = Buffer.byteLength(data);
  if (bytes > MAX_ENTRY_BYTES) { store.prepare('DELETE FROM manager_cache WHERE key=?').run(key); return; }
  store.transaction(() => {
    store.prepare(`INSERT INTO manager_cache(key,id,created_at,expires_at,byte_size,data) VALUES(?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET id=excluded.id,created_at=excluded.created_at,expires_at=excluded.expires_at,byte_size=excluded.byte_size,data=excluded.data`)
      .run(key, entry.id, entry.completedAt, entry.completedAt + RETENTION_MS, bytes, data);
    pruneManagerCache(store, Date.now(), key);
  });
}
