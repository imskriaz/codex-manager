import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {SqliteStateStore, configureSqliteStateStore} from '../src/storage/sqliteState';
import {configureOfficeStorage} from '../src/storage/officeStorageMigration';
import {isOfficeState, officeMigrationRows} from '../src/storage/officeStatePolicy';
import {DashboardAuth} from '../src/services/dashboardAuth';
import {authenticateOfficeUser, createOfficeUser, getOfficeUser} from '../src/services/officeUsers';
import {OfficeSessionService} from '../src/services/officeSessions';
import {configureCrossWindowOperationCoordinator} from '../src/utils/crossWindowOperations';
import {saveOfficeProxyLog, startApiProxyLog, clearApiProxyHistory} from '../src/services/aiProxyHistory';
import {recordOfficeAudit, readOfficeAudit} from '../src/services/officeAudit';
import {removeTestDirectory} from './testFilesystem';

it('keeps master data local while including every Office namespace and splitting historical audit records', () => {
  for (const namespace of ['office-users','office-audit','office-memory','office-auth','office-push','office-proxy-logs','office-diagnostics','office-sessions:alex','office-file-history:alex','office-schedules']) expect(isOfficeState(namespace,'record')).toBe(true);
  for (const [namespace,key] of [['global','record'],['settings:office','record'],['office-sessions:master','record'],['office-memory','master'],['master-office-audit','entries']]) expect(isOfficeState(namespace,key)).toBe(false);
  const rows = officeMigrationRows([
    {namespace:'office-audit',key:'entries',value:JSON.stringify([{actor:{id:'master'}},{actor:{id:'alex'}}])},
    {namespace:'office-session-actors',key:'native',value:JSON.stringify({startedBy:{id:'master'}})},
    {namespace:'office-sessions:alex',key:'conversation',value:'{"text":"retained"}'}
  ]);
  expect(rows).toHaveLength(2);
  expect(JSON.parse(rows[0].value)).toEqual([{actor:{id:'alex'}}]);
});

const adminUrl = process.env.CODEX_MANAGER_TEST_POSTGRES_URL;
describe.skipIf(!adminUrl)('PostgreSQL Office storage (isolated test database)', () => {
  let root: string, store: SqliteStateStore, admin: Client, inspect: Client;
  let database: string;
  let service: ReturnType<typeof configureOfficeStorage>;
  let url: string;
  const settings = {provider:'postgres',url:''};
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(),'office-postgres-'));
    vi.stubEnv('CODEX_MANAGER_STORAGE_ROOT',root); await configureCrossWindowOperationCoordinator(root);
    database = 'manager_test_' + randomUUID().replaceAll('-','');
    admin = new Client({connectionString:adminUrl,connectionTimeoutMillis:2000}); await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    const connection = new URL(adminUrl!); connection.pathname = '/'+database; url = connection.toString();
    settings.provider='postgres'; settings.url=url;
    inspect = new Client({connectionString:url}); await inspect.connect();
    store = await SqliteStateStore.open(path.join(root,'manager.sqlite')); configureSqliteStateStore(store);
  });
  afterEach(async () => {
    service?.dispose(); configureSqliteStateStore(undefined); store?.close();
    await inspect?.end();
    if (database && admin) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin?.end(); await removeTestDirectory(root); vi.restoreAllMocks(); vi.unstubAllEnvs();
  });
  function start() {
    service = configureOfficeStorage(store,()=>settings,path.join(process.cwd(),'out/storage/officePostgresWorker.js'));
    return service.ready();
  }
  async function remote(namespace:string,key:string) {
    return (await inspect.query('SELECT value FROM codex_manager_office_state WHERE namespace=$1 AND key=$2',[namespace,key])).rows[0]?.value;
  }
  it('migrates users, sessions, logs, memory, schedules, projects, preferences, file history and browser sign-ins once', async () => {
    const namespaces=['office-users','office-sessions:alex','office-session-requests:alex','office-session-revisions:alex','office-session-owners','office-usage:alex','office-memory','office-recommendations','office-preferences:alex','office-schedules','office-projects:alex','office-file-history:alex','office-password-attempts'];
    for (const namespace of namespaces) store.set(namespace,'fixture',{owner:'alex',text:'keep me'});
    store.set('office-sessions:master','master',{text:'local'});
    store.set('office-memory','master',{text:'master memory'});
    store.set('office-audit','entries',[{id:'master-event',actor:{id:'master'},at:1},{id:'user-event',actor:{id:'alex'},at:2}]);
    store.set('office-session-actors','native',{startedBy:{id:'master'}});
    store.set('dashboard-auth','sessions',JSON.stringify([{fingerprint:'a'.repeat(64),officeUserId:'master'},{fingerprint:'b'.repeat(64),officeUserId:'alex'}]));
    store.set('secrets','codexManager.browserPush.v1',JSON.stringify({keys:{publicKey:'key',privateKey:'private'},subscriptions:[{owner:'a'.repeat(64)},{owner:'b'.repeat(64)}]}));
    const logs = await SqliteStateStore.open(path.join(root,'manager_logs.sqlite'));
    logs.set('logs','1',{actor:{id:'master'},message:'local'}); logs.set('logs','2',{actor:{id:'alex'},message:'remote'}); logs.close();
    const ready = start();
    expect(()=>store.set('office-memory','blocked',{text:'not accepted'})).toThrow('migrated');
    store.set('global','master action','available');
    await ready;
    for (const namespace of namespaces) {
      expect(await remote(namespace,'fixture')).toEqual({owner:'alex',text:'keep me'});
      expect(store.prepare('SELECT 1 FROM state WHERE namespace=? AND key=?').get(namespace,'fixture')).toBeUndefined();
    }
    expect(await remote('office-sessions:master','master')).toBeUndefined();
    expect(store.get('office-sessions:master','master')).toEqual({text:'local'});
    expect(store.get('office-memory','master')).toEqual({text:'master memory'});
    expect(store.get('master-session-actors','native')).toEqual({startedBy:{id:'master'}});
    expect(store.get('master-office-audit','entries')).toEqual([{id:'master-event',actor:{id:'master'},at:1}]);
    expect(await remote('office-audit','entries')).toEqual([{id:'user-event',actor:{id:'alex'},at:2}]);
    expect(await remote('office-diagnostics','2')).toEqual({actor:{id:'alex'},message:'remote'});
    expect(JSON.parse(store.get<string>('dashboard-auth','sessions')!)).toEqual([{fingerprint:'a'.repeat(64),officeUserId:'master'}]);
    expect(await remote('office-auth','sessions')).toEqual([{fingerprint:'b'.repeat(64),officeUserId:'alex'}]);
    expect(await remote('office-push','subscriptions')).toEqual([{owner:'b'.repeat(64)}]);
    expect(JSON.parse(store.get<string>('secrets','codexManager.browserPush.v1')!).subscriptions).toEqual([{owner:'a'.repeat(64)}]);
    expect((await fs.readdir(root)).some(file=>file.startsWith('office-before-postgres-'))).toBe(true);
    store.set('office-sessions:alex','fixture',undefined);
    service.dispose(); await start();
    expect(store.get('office-sessions:alex','fixture')).toBeUndefined();
    expect((await inspect.query('SELECT count(*)::int AS count FROM codex_manager_office_migrations')).rows[0].count).toBe(1);
  });
  it('keeps earlier PostgreSQL user membership authoritative and rolls back multi-record changes and nested transactions', async () => {
    await inspect.query('CREATE TABLE codex_manager_office_users (id TEXT PRIMARY KEY,record JSONB NOT NULL)');
    await inspect.query('INSERT INTO codex_manager_office_users VALUES ($1,$2)', ['existing',JSON.stringify({id:'existing',passwordHash:'retained'})]);
    store.set('office-users','users',[{id:'stale-local'}]);
    await start();
    expect(store.get('office-users','users')).toEqual([{id:'existing',passwordHash:'retained'}]);
    expect(()=>store.transaction(()=>{store.set('office-memory','alex',{revision:'rolled back'});store.set('office-usage:alex','today',{tokens:99});throw new Error('cancel');})).toThrow('cancel');
    expect(await remote('office-memory','alex')).toBeUndefined();
    expect(await remote('office-usage:alex','today')).toBeUndefined();
    store.transaction(()=>{
      store.set('office-memory','alex',{revision:'outer'});
      expect(()=>store.transaction(()=>{store.set('office-memory','alex',{revision:'nested'});throw new Error('nested');})).toThrow('nested');
      expect(store.get('office-memory','alex')).toEqual({revision:'outer'});
    });
    expect(await remote('office-memory','alex')).toEqual({revision:'outer'});
    expect(store.officePayloadBytes('alex')).toBeGreaterThan(0);
  });
  it('preserves conflicts and local source data and cannot reimport stale data after the one-time marker', async () => {
    store.set('office-memory','alex',{revision:'original'}); await start();
    service.dispose();
    store.prepare('INSERT INTO state VALUES (?,?,?)').run('office-memory','alex',JSON.stringify({revision:'newer-local'}));
    await expect(start()).rejects.toThrow('storage');
    expect(store.prepare('SELECT value FROM state WHERE namespace=? AND key=?').get('office-memory','alex')).toBeDefined();
    expect(await remote('office-memory','alex')).toEqual({revision:'original'});
  });
  it('refuses a recreated PostgreSQL database after local migration completed', async () => {
    store.set('office-memory','alex',{revision:'original'}); await start();
    await inspect.query('DELETE FROM codex_manager_office_state');
    await inspect.query('DELETE FROM codex_manager_office_migrations');
    service.dispose();
    await expect(start()).rejects.toMatchObject({cause:{code:'MIGRATION_MARKER_MISSING'}});
    expect(store.get('migrations','office-postgres-v1')).toBeDefined();
  });
  it('rejects database outages without local writes while master authentication and audit stay available', async () => {
    await start();
    await inspect.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='codex-manager-office'");
    expect(()=>store.set('office-memory','alex',{text:'must not fall back'})).toThrow('storage');
    expect(store.prepare('SELECT 1 FROM state WHERE namespace=?').get('office-memory')).toBeUndefined();
    expect(recordOfficeAudit('master action','completed',{id:'master',name:'Master'})).toBe(true);
    expect(store.get<unknown[]>('master-office-audit','entries')).toHaveLength(1);
    await expect(authenticateOfficeUser('manager-owner','password',async()=>true,'manager-owner')).resolves.toMatchObject({id:'master'});
    const auth = new DashboardAuth({} as never);
    await auth.writeSessions(JSON.stringify([{officeUserId:'master',fingerprint:'a'.repeat(64)}]),undefined,true);
    expect(JSON.parse((await auth.readSessions(true))!)).toHaveLength(1);
    settings.provider='sqlite';
    expect(()=>store.get('office-memory','alex')).toThrow('PostgreSQL is required');
    settings.provider='postgres'; await service.ready();
    recordOfficeAudit('user action','completed',{id:'alex',name:'Alex'});
    expect(readOfficeAudit()).toHaveLength(2);
    expect(await remote('office-audit','entries')).toHaveLength(1);
  });
  it('persists accepted messages and completed replies across service restart and does not revive cleared request logs', async () => {
    await start();
    const user = await createOfficeUser({username:'alex@example.test',password:'test-password',workspacePath:path.join(root,'alex')});
    const options = {readUser:getOfficeUser,generate:vi.fn(async()=> 'Durable reply'),changed:vi.fn()};
    const chats = new OfficeSessionService(options);
    const action = {type:'dashboard:action' as const,action:'startCodexCliSession' as const,requestId:'one-request',payload:{text:'Hello',model:'gpt-test'}};
    try {
      const accepted = await chats.handle(user,action);
      const id = accepted.cliSession!.id;
      await vi.waitFor(()=>expect(chats.result(user.id,id).status).toBe('completed'));
      const restarted = new OfficeSessionService(options);
      expect(restarted.list(user.id)).toHaveLength(1);
      const restored = await restarted.handle(user,{type:'dashboard:action',action:'getCodexCliSessionMessages',requestId:'read',payload:{sessionId:id}});
      expect(restored.cliSessionMessages).toEqual(expect.arrayContaining([expect.objectContaining({text:'Durable reply'})]));
      await restarted.handle(user,action);
      expect(restarted.list(user.id)).toHaveLength(1);
      expect(options.generate).toHaveBeenCalledOnce();
      restarted.stop();
      expect(store.prepare("SELECT 1 FROM state WHERE namespace LIKE 'office-%'").get()).toBeUndefined();
      const log = startApiProxyLog('POST','/v1/responses','log'); saveOfficeProxyLog(log);
      expect(store.keys('office-proxy-logs')).toHaveLength(1);
      clearApiProxyHistory(); log.status='completed'; saveOfficeProxyLog(log);
      expect(store.keys('office-proxy-logs')).toHaveLength(0);
    } finally { chats.stop(); }
  });
});
