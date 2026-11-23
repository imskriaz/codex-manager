import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { OfficePostgresStore, OFFICE_DATABASE_ERROR } from './officePostgres';
import { isOfficeState, officeMigrationRows, type OfficeStateRow } from './officeStatePolicy';
import { SqliteStateStore } from './sqliteState';

export const OFFICE_MIGRATION_PENDING = 'Workspace storage is being migrated. Please try again shortly; no new changes were accepted.';
type Settings = { provider: string; url: string };
type Session = { officeUserId?: string; fingerprint?: string };
const pushKey = 'codexManager.browserPush.v1';
type Push = {subscriptions: Array<{owner: string}>};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function target(url: string): string { const parsed = new URL(url); return hash(`${parsed.host}${parsed.pathname}`); }
function sessions(value: unknown): Session[] {
  if (typeof value !== 'string') return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('Stored sign-in sessions must be reviewed before migration.');
  return parsed as Session[];
}
const member = (session: Session) => !!session.officeUserId && session.officeUserId !== 'master';

/** Installs routing immediately; migration and connection waits never hold up master actions. */
export function configureOfficeStorage(store: SqliteStateStore, settings: () => Settings, workerFile?: string) {
  let backend: OfficePostgresStore | undefined;
  let preparing: Promise<void> | undefined;
  let ready = false;
  let activeUrl = '';
  let retryAt = 0;
  let lastError: Error | undefined;
  let disposed = false;
  const source = `office-v1:${hash(path.resolve(store.file).toLowerCase())}`;
  const localRows = (): OfficeStateRow[] => store.prepare("SELECT namespace,key,value FROM state WHERE namespace LIKE 'office-%' ORDER BY namespace,key").all() as OfficeStateRow[];
  const authRows = (): OfficeStateRow[] => {
    const value = sessions(store.get('dashboard-auth', 'sessions')).filter(member);
    return value.length ? [{namespace: 'office-auth', key: 'sessions', value: JSON.stringify(value)}] : [];
  };
  const pushState = (): {value?: Push; local: Push['subscriptions']; remote: Push['subscriptions']} => {
    const raw = store.get<string | null>('secrets', pushKey);
    const value = raw ? JSON.parse(raw) as Push : undefined;
    const masters = new Set([hash('local'), ...sessions(store.get('dashboard-auth', 'sessions')).filter(value => !member(value)).map(value => value.fingerprint)]);
    return {value, local: value?.subscriptions.filter(value => masters.has(value.owner)) ?? [], remote: value?.subscriptions.filter(value => !masters.has(value.owner)) ?? []};
  };
  const pushRows = (): OfficeStateRow[] => {
    const value = pushState().remote;
    return value.length ? [{namespace: 'office-push', key: 'subscriptions', value: JSON.stringify(value)}] : [];
  };
  const migrate = async (url: string): Promise<void> => {
    const mark = store.get<{target: string}>('migrations', 'office-postgres-v1');
    if (mark && mark.target !== target(url)) throw new Error('The workspace database changed. Migrate the existing PostgreSQL database before switching its connection.');
    const candidate = new OfficePostgresStore(url, workerFile);
    backend?.close(); backend = candidate; activeUrl = url; ready = false;
    let logs: SqliteStateStore | undefined;
    try {
      const rows = [...officeMigrationRows(localRows()), ...authRows(), ...pushRows()];
      const logFile = path.join(path.dirname(store.file), 'manager_logs.sqlite');
      if (fs.existsSync(logFile)) logs = await SqliteStateStore.open(logFile);
      const logRows = (): OfficeStateRow[] => logs?.prepare("SELECT namespace,key,value FROM state WHERE namespace='logs' AND json_extract(value,'$.actor.id') IS NOT NULL AND json_extract(value,'$.actor.id')!='master' ORDER BY key").all().map(row => ({namespace: 'office-diagnostics', key: String(row['key']), value: String(row['value'])})) ?? [];
      const diagnostics = logRows(); rows.push(...diagnostics);
      if (!mark && rows.length) {
        const backup = path.join(path.dirname(store.file), `office-before-postgres-${randomUUID()}.json`);
        fs.writeFileSync(backup, JSON.stringify({source, rows}), {mode: 0o600, flag: 'wx'});
      }
      await candidate.migrateAsync(source, rows);
      if (disposed) throw new Error('The host stopped during storage migration.');
      // An older host writing during migration must never lose its newer records.
      const current = [...officeMigrationRows(localRows()), ...authRows(), ...pushRows(), ...logRows()];
      if (JSON.stringify(current) !== JSON.stringify(rows)) throw new Error('Local workspace data changed during migration. Keep the recovery copy and review the conflict before retrying.');
      store.transaction(() => {
        for (const row of localRows()) {
          if (!isOfficeState(row.namespace, row.key)) continue;
          const value: unknown = JSON.parse(row.value);
          if (row.namespace === 'office-audit' && Array.isArray(value)) {
            const master: unknown[] = value.filter((entry: {actor?: {id?: string}}) => entry.actor?.id === 'master');
            const newer = store.get<unknown[]>('master-office-audit', 'entries') ?? [];
            store.set('master-office-audit', 'entries', [...newer, ...master]);
          }
          if (row.namespace === 'office-session-actors' && (value as {startedBy?: {id?: string}})?.startedBy?.id === 'master') store.set('master-session-actors', row.key, value);
          store.prepare('DELETE FROM state WHERE namespace=? AND key=?').run(row.namespace, row.key);
        }
        const local = sessions(store.get('dashboard-auth', 'sessions')).filter(value => !member(value));
        const push = pushState();
        if (push.value) store.set('secrets', pushKey, JSON.stringify({...push.value, subscriptions: push.local}));
        store.set('dashboard-auth', 'sessions', JSON.stringify(local));
        store.set('migrations', 'office-postgres-v1', {source, target: target(url), completedAt: Date.now()});
      });
      for (const row of diagnostics) logs?.prepare("DELETE FROM state WHERE namespace='logs' AND key=? AND value=?").run(row.key, row.value);
      ready = true;
    } finally { logs?.close(); }
  };
  const ensure = (): OfficePostgresStore | undefined => {
    const value = settings();
    if (value.provider !== 'postgres') {
      if (store.get('migrations', 'office-postgres-v1')) throw new Error('PostgreSQL is required for this migrated workspace. Restore its connection to continue.');
      return undefined;
    }
    if (!value.url) throw new Error(OFFICE_DATABASE_ERROR);
    if (ready && backend && !backend.unavailable && activeUrl === value.url) return backend;
    if (!preparing && Date.now() >= retryAt && !disposed) {
      preparing = migrate(value.url).catch((error: unknown) => {
        ready = false; backend?.close(); retryAt = Date.now() + 5_000;
        lastError = error instanceof Error ? error : new Error(OFFICE_DATABASE_ERROR);
        throw error;
      }).then(() => { lastError = undefined; }).finally(() => { preparing = undefined; });
      void preparing.catch(error => console.warn('[codexManager] Workspace PostgreSQL migration/connection failed', error));
    }
    if (!preparing && lastError) throw lastError;
    throw new Error(OFFICE_MIGRATION_PENDING);
  };
  store.routeOfficeState(ensure);
  return {
    async ready(): Promise<void> {
      try { ensure(); } catch (error) { if (!preparing) throw error; }
      await preparing;
    },
    dispose(): void { disposed = true; backend?.close(); }
  };
}
