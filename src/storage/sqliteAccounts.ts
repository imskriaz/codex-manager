import type { CodexManagerAccountRecord, CodexManagerIndex } from "../core/types";
import { parseAccountsIndex } from "./accountsIndex";
import type { SqliteStateStore } from "./sqliteState";

const initialized = new WeakSet<SqliteStateStore>();
const INDEX_KEY = "accounts-index.json";
const MIGRATION = "account-rows-v1";

function schema(store: SqliteStateStore): void {
  if (initialized.has(store)) return;
  store.database.exec(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, position INTEGER NOT NULL, email TEXT NOT NULL, enabled INTEGER NOT NULL,
    queue_priority REAL, updated_at REAL NOT NULL, total_usage_ms REAL NOT NULL,
    session_started_at REAL, hourly_remaining REAL, long_remaining REAL, data TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS accounts_queue ON accounts(enabled, queue_priority);
  CREATE INDEX IF NOT EXISTS accounts_updated ON accounts(updated_at);`);
  initialized.add(store);
}

export function hasAccountRows(store: SqliteStateStore): boolean { return store.get<boolean>("migrations", MIGRATION) === true; }

export function readAccountIndex(store: SqliteStateStore): CodexManagerIndex {
  const header = store.get<Omit<CodexManagerIndex, "accounts">>("account-index", "header");
  if (!header) throw Object.assign(new Error("Accounts index does not exist."), { code: "ENOENT" });
  const accounts = store.database.prepare("SELECT data FROM accounts ORDER BY position").all().map(row => JSON.parse(String(row["data"])) as CodexManagerAccountRecord);
  return parseAccountsIndex(JSON.stringify({ ...header, accounts }), store.file);
}

export function readAccountRow(store: SqliteStateStore, id: string, home: string): CodexManagerAccountRecord | undefined {
  if (!hasAccountRows(store)) return undefined;
  const row = store.database.prepare("SELECT data FROM accounts WHERE id = ?").get(id);
  if (!row) return undefined;
  const account = parseAccountsIndex(JSON.stringify({ accounts: [JSON.parse(String(row["data"]))] }), store.file).accounts[0]!;
  if (account.id !== id) throw new Error("Stored account identity does not match its database key.");
  const header = store.get<Omit<CodexManagerIndex, "accounts">>("account-index", "header");
  const active = header?.activeAccountStateVersion === 1 ? header.activeAccountIdsByCodexHome?.[home] : header?.currentAccountId;
  return { ...account, isActive: active === id };
}

/** Account rows and rotating recovery snapshots commit together; unchanged rows are not rewritten. */
export function saveAccountIndex(store: SqliteStateStore, value: CodexManagerIndex, backupCount = 0, onlyIfMissing = false): void {
  const index = parseAccountsIndex(JSON.stringify(value), store.file);
  const ids = new Set(index.accounts.map(account => account.id));
  if (ids.size !== index.accounts.length) throw new Error("The accounts index contains duplicate account IDs.");
  schema(store);
  store.transaction(() => {
    if (onlyIfMissing && hasAccountRows(store)) return;
    if (backupCount > 0) {
      let previous: CodexManagerIndex | undefined;
      try {
        const old = store.get<{ text: string | null }>("files", INDEX_KEY)?.text;
        previous = hasAccountRows(store) ? readAccountIndex(store) : old ? parseAccountsIndex(old, store.file) : undefined;
      } catch (error) { if (typeof (error as { errcode?: unknown } | null)?.errcode === "number") throw error; }
      if (previous) {
        for (let slot = backupCount; slot >= 2; slot--) {
          const old = store.get<{ text: string | null }>("files", `accounts-index.backup-${slot - 1}.json`);
          if (old?.text) {
            try { parseAccountsIndex(old.text, store.file); } catch { continue; }
            store.set("files", `accounts-index.backup-${slot}.json`, old);
          }
        }
        store.set("files", "accounts-index.backup-1.json", { text: JSON.stringify(previous) });
      }
    }
    for (const row of store.database.prepare("SELECT id FROM accounts").all()) {
      if (!ids.has(String(row["id"]))) store.database.prepare("DELETE FROM accounts WHERE id = ?").run(String(row["id"]));
    }
    const write = store.database.prepare(`INSERT INTO accounts(id,position,email,enabled,queue_priority,updated_at,total_usage_ms,session_started_at,hourly_remaining,long_remaining,data)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,email=excluded.email,enabled=excluded.enabled,
      queue_priority=excluded.queue_priority,updated_at=excluded.updated_at,total_usage_ms=excluded.total_usage_ms,
      session_started_at=excluded.session_started_at,hourly_remaining=excluded.hourly_remaining,long_remaining=excluded.long_remaining,data=excluded.data
      WHERE accounts.data != excluded.data OR accounts.position != excluded.position`);
    index.accounts.forEach((account, position) => write.run(account.id, position, account.email, account.enabled === false ? 0 : 1,
      typeof account.queuePriority === "number" && Number.isFinite(account.queuePriority) ? account.queuePriority : null, account.updatedAt, account.totalUsageMs ?? 0, account.sessionStartedAt ?? null,
      account.quotaSummary?.hourlyPercentage ?? null, account.quotaSummary?.weeklyPercentage ?? null, JSON.stringify(account)));
    const { accounts: _accounts, ...header } = index;
    store.set("account-index", "header", header);
    store.set("migrations", MIGRATION, true);
    store.set("files", INDEX_KEY, undefined);
  });
}
