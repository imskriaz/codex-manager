import { Readable } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebDashboardServer } from '../src/services/webDashboardServer';
import { SqliteStateStore, configureSqliteStateStore } from '../src/storage/sqliteState';
import * as officeUsers from '../src/services/officeUsers';
import { OfficeSessionService } from '../src/services/officeSessions';
import { removeTestDirectory } from './testFilesystem';

let root: string, database: SqliteStateStore, server: WebDashboardServer, host: any, user: any;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'workspace-clear-routes-'));
  database = await SqliteStateStore.open(path.join(root, 'state.sqlite')); configureSqliteStateStore(database);
  server = new WebDashboardServer({ extensionUri: { fsPath: process.cwd() }, secrets: { get: vi.fn(async () => undefined) } } as never, {} as never); host = server;
  user = { id: 'alex', role: 'user', enabled: true, features: ['files', 'generalChat'] };
  vi.spyOn(host, 'isAuthorized').mockResolvedValue(true); vi.spyOn(host, 'officeUserForRequest').mockImplementation(async () => user);
  host.settingsStore = { getDashboardSettings: () => ({ teamWorkspaceEnabled: true }) };
});
afterEach(async () => { server.dispose(); vi.restoreAllMocks(); configureSqliteStateStore(undefined); database.close(); await removeTestDirectory(root); });
async function call(method: string, body?: unknown, url = '/api/office/sessions/11111111-1111-1111-1111-111111111111') {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as any;
  Object.assign(req, { method, url, headers: { host: '127.0.0.1:39875', origin: 'http://127.0.0.1:39875', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } });
  let output = ''; const res = { statusCode: 200, setHeader: vi.fn(), end: (value: string) => { output = String(value); } };
  await host.handle(req, res); return { status: res.statusCode, value: JSON.parse(output) };
}

it('allows administrators to inspect only the selected user?s sessions without mutating them', async () => {
  const owner = '11111111-1111-1111-1111-111111111111', id = '22222222-2222-2222-2222-222222222222';
  const session = { id, owner, title: 'Buyer follow-up', projectPath: '', updatedAt: new Date().toISOString(), turns: [{ id:'turn', state:'done', user:{id:'question',role:'user',text:'Prepare report.'}, assistant:{id:'answer',role:'assistant',text:'Report ready.'} }] };
  database.set(`office-sessions:${owner}`, id, session);
  database.set('office-sessions:other', '33333333-3333-3333-3333-333333333333', {...session,id:'33333333-3333-3333-3333-333333333333',owner:'other'});
  vi.spyOn(officeUsers,'getOfficeUser').mockResolvedValue({id:owner,role:'user',enabled:false,features:[]} as never);
  const service=new OfficeSessionService({readUser:async()=>undefined,generate:async()=>'',changed:vi.fn()});
  vi.spyOn(host,'teamSessions').mockReturnValue(service);
  user = {...user,id:'master',role:'unrestricted-admin'};
  const listed = await call('GET'); expect(listed.status).toBe(200); expect(listed.value.sessions.map((item:any)=>item.id)).toEqual([id]);
  const detail = await call('GET',undefined,`/api/office/sessions/${owner}/${id}`); expect(detail.status).toBe(200); expect(detail.value.messages.map((item:any)=>item.text)).toEqual(['Prepare report.','Report ready.']);
  expect(database.get(`office-sessions:${owner}`,id)).toEqual(session);
  expect((await call('GET',undefined,`/api/office/sessions/${owner}/33333333-3333-3333-3333-333333333333`)).status).toBe(400);
  expect((await call('POST',{})).status).toBe(400);
});
it('rejects workspace users and invalid session identifiers', async () => {
  expect((await call('GET')).status).toBe(403);
  user={...user,id:'master',role:'unrestricted-admin'};
  expect((await call('GET',undefined,'/api/office/sessions/invalid')).status).toBe(400);
});
