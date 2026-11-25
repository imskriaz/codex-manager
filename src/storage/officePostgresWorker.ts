import { workerData, type MessagePort } from 'node:worker_threads';
import { Client } from 'pg';
import type { OfficeStateRow } from './officeStatePolicy';

const {url, port} = workerData as {url: string; port: MessagePort};
let client: Client | undefined;
let depth = 0;
const lock = '709240518';
async function database(): Promise<Client> {
  if (client) return client;
  const candidate = new Client({connectionString: url, connectionTimeoutMillis: 1500, statement_timeout: 1500, query_timeout: 2000,
    application_name: 'codex-manager-office', options: '-c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000'});
  candidate.on('error', () => { if (client === candidate) client = undefined; });
  try {
    await candidate.connect();
    await candidate.query('CREATE TABLE IF NOT EXISTS codex_manager_office_state (namespace TEXT NOT NULL, key TEXT NOT NULL, value JSONB NOT NULL, PRIMARY KEY (namespace,key))');
    await candidate.query('CREATE TABLE IF NOT EXISTS codex_manager_office_migrations (source TEXT PRIMARY KEY, migrated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    client = candidate;
    return candidate;
  } catch (error) { await candidate.end().catch(() => undefined); throw error; }
}

async function migrate(db: Client, source: string, rows: OfficeStateRow[], requireExisting: boolean): Promise<void> {
  await db.query('BEGIN');
  try {
    await db.query(`SELECT pg_advisory_xact_lock(${lock})`);
    const existing = Boolean((await db.query('SELECT 1 FROM codex_manager_office_migrations WHERE source=$1', [source])).rowCount);
    if (requireExisting && !existing) throw new Error('The PostgreSQL migration marker is missing; restore the original database before retrying.');
    if (!existing) {
      // These tables were authoritative in the earlier users-only backend.
      for (const [table, key] of [['codex_manager_office_users', 'users'], ['codex_manager_office_mcp', 'mcp-servers']]) {
        if ((await db.query<{name: string | null}>('SELECT to_regclass($1) AS name', [table])).rows[0]?.name) {
          const legacy = await db.query<{record: unknown}>(`SELECT record FROM ${table} ORDER BY id`);
          await db.query("INSERT INTO codex_manager_office_state VALUES ('office-users',$1,$2::jsonb) ON CONFLICT DO NOTHING", [key, JSON.stringify(legacy.rows.map(row => row.record))]);
        }
      }
      for (const row of rows) {
        await db.query('INSERT INTO codex_manager_office_state VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING', [row.namespace, row.key, row.value]);
        const actual = await db.query<{matches: boolean}>('SELECT value=$3::jsonb AS matches FROM codex_manager_office_state WHERE namespace=$1 AND key=$2', [row.namespace, row.key, row.value]);
        // User membership may have changed in the previously configured PostgreSQL store.
        if (!actual.rows[0]?.matches && row.namespace !== 'office-users') throw new Error('Migration conflict; existing PostgreSQL data was preserved.');
      }
      await db.query('INSERT INTO codex_manager_office_migrations (source) VALUES ($1)', [source]);
    }
    // A crash after the PostgreSQL commit must not let a retry erase newer local data.
    for (const row of rows) {
      if (row.namespace === 'office-users') continue;
      const actual = await db.query<{matches:boolean}>('SELECT value=$3::jsonb AS matches FROM codex_manager_office_state WHERE namespace=$1 AND key=$2', [row.namespace,row.key,row.value]);
      if (!actual.rows[0]?.matches) throw new Error('Migration conflict; local data was preserved.');
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error; }
}

async function execute(operation: string, args: unknown[]): Promise<unknown> {
  const db = await database();
  const [namespace, key, serialized] = args as [string, string, string | undefined];
  switch (operation) {
    case 'migrate': await migrate(db, namespace, args[1] as OfficeStateRow[], args[2] === true); return;
    case 'get': return (await db.query<{value:unknown}>('SELECT value FROM codex_manager_office_state WHERE namespace=$1 AND key=$2', [namespace,key])).rows[0]?.value;
    case 'set':
      if (serialized === undefined) await db.query('DELETE FROM codex_manager_office_state WHERE namespace=$1 AND key=$2', [namespace,key]);
      else await db.query('INSERT INTO codex_manager_office_state VALUES ($1,$2,$3::jsonb) ON CONFLICT (namespace,key) DO UPDATE SET value=excluded.value', [namespace,key,serialized]);
      return;
    case 'keys': return (await db.query<{key:string}>('SELECT key FROM codex_manager_office_state WHERE namespace=$1 ORDER BY key', [namespace])).rows.map(row=>row.key);
    case 'entries': return (await db.query<{key:string;value:unknown}>('SELECT key,value FROM codex_manager_office_state WHERE namespace=$1 ORDER BY key', [namespace])).rows.map(row=>[row.key,row.value]);
    case 'recent': return (await db.query<{value:unknown}>('SELECT value FROM codex_manager_office_state WHERE namespace=$1 ORDER BY key DESC LIMIT $2', [namespace,args[1]])).rows.map(row=>row.value).reverse();
    case 'deleteBefore': await db.query('DELETE FROM codex_manager_office_state WHERE namespace=$1 AND key<$2', [namespace,key]); return;
    case 'bytes': {
      const namespaces = ['office-sessions','office-session-requests','office-session-revisions','office-preferences','office-projects','office-local-folders','office-schedules','office-usage'].map(value => `${value}:${namespace}`);
      const result = await db.query<{bytes:string}>("SELECT COALESCE(SUM(octet_length(value::text)),0) AS bytes FROM codex_manager_office_state WHERE namespace=ANY($1::text[]) OR (namespace IN ('office-memory','office-recommendations') AND key=$2) OR (namespace='office-schedules' AND value->>'owner'=$2)", [namespaces, namespace]);
      return Number(result.rows[0]?.bytes ?? 0);
    }
    case 'begin':
      if (!depth) { await db.query('BEGIN'); await db.query(`SELECT pg_advisory_xact_lock(${lock})`); }
      else await db.query(`SAVEPOINT office_${depth}`);
      depth++; return;
    case 'commit':
      if (depth === 1) await db.query('COMMIT'); else await db.query(`RELEASE SAVEPOINT office_${depth-1}`);
      depth--; return;
    case 'rollback':
      if (depth === 1) await db.query('ROLLBACK'); else await db.query(`ROLLBACK TO SAVEPOINT office_${depth-1}; RELEASE SAVEPOINT office_${depth-1}`);
      depth--; return;
    default: throw new Error('Unknown storage operation.');
  }
}

let pending = Promise.resolve();
port.on('message', (request: {operation: string; args: unknown[]; signal: Int32Array}) => {
  pending = pending.then(async () => {
    try { port.postMessage({value: await execute(request.operation, request.args)}); }
    catch (error) {
      // Discard a failed connection/transaction; the caller never falls back to SQLite.
      const previous = client; client = undefined; depth = 0;
      await previous?.end().catch(() => undefined);
      const code = (error as {code?: unknown})?.code;
      const diagnostic = typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code
        : error instanceof Error && error.message.startsWith('Migration conflict') ? 'MIGRATION_CONFLICT'
        : error instanceof Error && error.message.startsWith('The PostgreSQL migration marker is missing') ? 'MIGRATION_MARKER_MISSING'
        : error instanceof Error && /timeout/i.test(error.message) ? 'TIMEOUT' : 'DATABASE_ERROR';
      port.postMessage({failed: true, code: diagnostic});
    } finally { Atomics.store(request.signal, 0, 1); Atomics.notify(request.signal, 0); }
  });
});
