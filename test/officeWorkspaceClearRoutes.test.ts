import { Readable } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebDashboardServer } from '../src/services/webDashboardServer';
import { SqliteStateStore, configureSqliteStateStore } from '../src/storage/sqliteState';
import * as workspaceClear from '../src/services/officeWorkspaceClear';
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
async function call(method: string, body?: unknown) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as any;
  Object.assign(req, { method, url: '/api/workspace/clear?kind=files', headers: { host: '127.0.0.1:39875', origin: 'http://127.0.0.1:39875', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } });
  let output = ''; const res = { statusCode: 200, setHeader: vi.fn(), end: (value: string) => { output = String(value); } };
  await host.handle(req, res); return { status: res.statusCode, value: JSON.parse(output) };
}
it('binds preview and clearing to the signed-in user and returns explicit failures', async () => {
  const clear = vi.spyOn(workspaceClear, 'clearOfficeWorkspace').mockResolvedValue({ kind: 'files', count: 3, revision: 'r1', message: '3 files permanently deleted.' });
  const preview = await call('GET'); expect(preview.status, preview.value.error).toBe(200); expect(clear).toHaveBeenLastCalledWith(user, { kind: 'files' }, true);
  expect((await call('POST', { kind: 'files', confirmed: true, revision: 'r1', owner: 'other' })).value.message).toBe('3 files permanently deleted.');
  expect(clear.mock.calls[1][0].id).toBe('alex');
  clear.mockRejectedValueOnce(new Error('Your workspace changed. Review the clear action again before deleting.'));
  const failed = await call('POST', { kind: 'files', confirmed: true, revision: 'r1' });
  expect(failed.status).toBe(400); expect(failed.value.error).toContain('workspace changed');
});
it('rejects master, disabled users and malformed actions before invoking deletion', async () => {
  const clear = vi.spyOn(workspaceClear, 'clearOfficeWorkspace');
  user = { ...user, id: 'master', role: 'unrestricted-admin' }; expect((await call('GET')).status).toBe(403);
  user = { ...user, id: 'alex', role: 'user', enabled: false }; expect((await call('POST', {})).status).toBe(401);
  user.enabled = true;
  expect((await call('POST', [])).status).toBe(400); expect((await call('DELETE', {})).status).toBe(400);
  expect(clear).not.toHaveBeenCalled();
});
