import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebDashboardServer } from '../src/services/webDashboardServer';
import { SqliteStateStore, configureSqliteStateStore } from '../src/storage/sqliteState';
import { officeLocalFolders } from '../src/services/officeLocalFolders';
import { removeTestDirectory } from './testFilesystem';

let root: string, database: SqliteStateStore, server: WebDashboardServer, host: any, user: any;
const client = '11111111-1111-1111-1111-111111111111';
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'local-folder-routes-'));
  database = await SqliteStateStore.open(path.join(root, 'state.sqlite')); configureSqliteStateStore(database);
  const workspace = path.join(root, 'alex'); await mkdir(workspace);
  server = new WebDashboardServer({ extensionUri: { fsPath: process.cwd() }, secrets: { get: vi.fn(async () => undefined) } } as never, {} as never); host = server;
  user = { id: 'alex', role: 'user', enabled: true, features: ['files','generalChat'], workspacePath: workspace };
  vi.spyOn(host, 'isAuthorized').mockResolvedValue(true); vi.spyOn(host, 'officeUserForRequest').mockImplementation(async () => user);
  host.settingsStore = { getDashboardSettings: () => ({ teamWorkspaceEnabled: true }) };
});
afterEach(async () => { officeLocalFolders.close(); server.dispose(); vi.restoreAllMocks(); configureSqliteStateStore(undefined); database.close(); await removeTestDirectory(root); });
async function call(body: unknown, origin = 'http://127.0.0.1:39875') {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as any;
  Object.assign(req, { method: 'POST', url: '/api/workspace/local-folder', headers: { host: '127.0.0.1:39875', origin, 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } });
  let output = ''; const res = { statusCode: 200, setHeader: vi.fn(), end: (value: string) => { output = String(value); } };
  await host.handle(req, res); return { status: res.statusCode, value: JSON.parse(output) };
}
const connect = () => call({ operation: 'connect', client, creationId: '33333333-3333-3333-3333-333333333333', name: 'My project', folderName: 'Selected folder' });
async function command(project: string) {
  let value: any;
  await vi.waitFor(() => { value ??= officeLocalFolders.poll('alex', project, client)[0]; expect(value).toBeDefined(); });
  return value;
}
it('creates only an owned project marker and routes actual reads and writes through the browser', async () => {
  const connected = await connect(); expect(connected.status, connected.value.error).toBe(200);
  const project = connected.value.project;
  expect(project).toMatchObject({ label: 'My project', localFolder: { name: 'Selected folder' } });
  expect((await connect()).value.project.path).toBe(project.path);
  const read = host.processOfficeMessage(user, { type: 'dashboard:action', action: 'readWorkspaceFile', requestId: 'read', payload: { projectPath: project.path, filePath: 'local.txt' } });
  const reading = await command(project.path);
  await call({ operation: 'result', project: project.path, client, id: reading.id, result: { data: Buffer.from('Local content').toString('base64'), revision: 'a'.repeat(64), size: 13 } });
  expect((await read).messages[0].payload.workspaceFile.content).toBe('Local content');
  const write = host.processOfficeMessage(user, { type: 'dashboard:action', action: 'saveWorkspaceFile', requestId: 'write', payload: { projectPath: project.path, filePath: 'local.txt', fileContent: 'New content', fileRevision: 'a'.repeat(64) } });
  const writing = await command(project.path);
  expect(writing).toMatchObject({ operation: 'write', path: 'local.txt', revision: 'a'.repeat(64), data: Buffer.from('New content').toString('base64') });
  await call({ operation: 'result', project: project.path, client, id: writing.id, result: { revision: 'b'.repeat(64), size: 11 } });
  expect((await write).messages[0].status).toBe('completed');
  expect(await readdir(project.path)).toEqual([]);
});
it('rejects administrators, disabled file access, foreign projects and cross-origin requests', async () => {
  const connected = await connect(), project = connected.value.project.path;
  user = { ...user, id: 'sam' };
  expect((await call({ operation: 'connect', client, project })).status).toBe(400);
  user = { ...user, id: 'alex', role: 'unrestricted-admin' }; expect((await connect()).status).toBe(403);
  user = { ...user, role: 'user', features: [] }; expect((await connect()).status).toBe(403);
  user.features = ['files']; expect((await call({ operation: 'connect', client, project }, 'https://untrusted.example')).status).toBe(403);
});
it('does not fall back to host files when a local connection is lost or a path escapes', async () => {
  const project = (await connect()).value.project.path;
  await call({ operation: 'disconnect', client, project });
  const action = (filePath: string) => host.processOfficeMessage(user, { type: 'dashboard:action', action: 'readWorkspaceFile', requestId: 'read', payload: { projectPath: project, filePath } });
  expect((await action('local.txt')).messages[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('offline') });
  expect((await action('../secret')).messages[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('relative path') });
  expect(await readdir(project)).toEqual([]);
});
it('retains the local boundary after removing a project from the list', async () => {
  const project = (await connect()).value.project.path;
  const result = await host.processOfficeMessage(user, { type: 'dashboard:action', action: 'removeWorkspaceProject', requestId: 'remove', payload: { projectPath: project, confirmed: true } });
  expect(result.messages[0].status).toBe('completed');
  const read = await host.processOfficeMessage(user, { type: 'dashboard:action', action: 'readWorkspaceFile', requestId: 'read', payload: { projectPath: project, filePath: 'local.txt' } });
  expect(read.messages[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('offline') });
});
it('keeps two local projects distinct in the same browser connection', async () => {
  const first = (await connect()).value.project;
  const second = await call({ operation: 'connect', client, creationId: '44444444-4444-4444-4444-444444444444', name: 'Another project', folderName: 'Another folder' });
  expect(second.status).toBe(200); expect(second.value.project.path).not.toBe(first.path);
  expect(second.value.project.label).toBe('Another project');
});

it('persists Write by default, enforces user permission and rejects changes during pending actions', async () => {
 const connected=await connect(),project=connected.value.project.path;
 expect((await call({operation:'permission',project,client})).value.permission).toBe('write');
 expect(()=>officeLocalFolders.request(user.id,project,{operation:'delete',path:'old'})).toThrow('Full permission');
 expect((await call({operation:'permission',project,client,permission:'read-only'})).value.permission).toBe('read-only');
 expect(()=>officeLocalFolders.request(user.id,project,{operation:'write',path:'file',data:'eA=='})).toThrow('read only');
 expect((await call({operation:'permission',project,client,permission:'full'})).value.permission).toBe('full');
 const pending=officeLocalFolders.request(user.id,project,{operation:'inspect',path:'old'});
 expect((await call({operation:'permission',project,client,permission:'write'})).status).toBe(400);
 const inspecting=await command(project);
 expect(inspecting.permission).toBe('full');
 await call({operation:'result',project,client,id:inspecting.id,result:{message:'Files inspected.',revision:'a'.repeat(64),entries:[{path:'old',kind:'folder'}]}});
 await expect(pending).resolves.toMatchObject({message:'Files inspected.'});
 expect((await call({operation:'permission',project,client,permission:'write'})).value.permission).toBe('write');
});
