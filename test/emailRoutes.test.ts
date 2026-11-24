import { Readable } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebDashboardServer } from '../src/services/webDashboardServer';
import { SqliteStateStore, configureSqliteStateStore } from '../src/storage/sqliteState';
import { defaultEmailPreferences } from '../src/services/emailNotifications';
import { removeTestDirectory } from './testFilesystem';

let root: string, database: SqliteStateStore, server: WebDashboardServer, host: any, user: any;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'manager-email-routes-'));
  database = await SqliteStateStore.open(path.join(root, 'state.sqlite')); configureSqliteStateStore(database);
  server = new WebDashboardServer({ extensionUri: { fsPath: process.cwd() }, secrets: { get: vi.fn(async () => undefined) } } as never, {} as never); host = server;
  user = { id: 'alex', role: 'user', enabled: true };
  vi.spyOn(host, 'isAuthorized').mockResolvedValue(true); vi.spyOn(host, 'officeUserForRequest').mockImplementation(async () => user);
  vi.spyOn(host, 'refreshCliSessionRealtimeLifecycle').mockImplementation(() => undefined);
});
afterEach(async () => { server.dispose(); vi.restoreAllMocks(); configureSqliteStateStore(undefined); database.close(); await removeTestDirectory(root); });
async function call(url: string, method = 'GET', body?: unknown) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []) as any;
  Object.assign(req, { method, url, headers: { host: '127.0.0.1:39875', origin: 'http://127.0.0.1:39875', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } });
  let output = ''; const res = { statusCode: 200, setHeader: vi.fn(), end: (value: string) => { output = String(value); } };
  await host.handle(req, res); return { status: res.statusCode, value: JSON.parse(output) };
}
it('keeps SMTP configuration master-only and binds preferences to the authenticated owner', async () => {
  expect((await call('/api/email/smtp')).status).toBe(403);
  const saved = await call('/api/email/preferences', 'PUT', { ...defaultEmailPreferences, address: 'alex@example.test', enabled: true, owner: 'master' });
  expect(saved.status).toBe(200); expect(saved.value.preferences.address).toBe('alex@example.test');
  user = { id: 'master', role: 'unrestricted-admin', enabled: true };
  expect((await call('/api/email/preferences')).value.preferences.address).toBe('');
  const config = await call('/api/email/smtp'); expect(config.status).toBe(200); expect(config.value.config).not.toHaveProperty('password');
});
it('reports test delivery failures in the initiating request and throttles repeated tests', async () => {
  vi.spyOn(host.email, 'test').mockRejectedValue(new Error('SMTP authentication failed. Check the username and app password.'));
  const first = await call('/api/email/test', 'POST', {});
  expect(first.status).toBe(400); expect(first.value.error).toContain('SMTP authentication failed');
  const second = await call('/api/email/test', 'POST', {}); expect(second.value.error).toContain('Wait 30 seconds');
  expect(host.email.test).toHaveBeenCalledOnce();
});
it('routes recent master results, questions and failures without replaying old or cancelled turns', () => {
  const notify = vi.spyOn(host.email, 'notify').mockImplementation(() => undefined);
  const state = { sessionId: '12345678-1234-1234-1234-123456789abc', streamId: 'stream', updatedAt: Date.now(), status: 'completed', messages: [{ id: 'answer', role: 'assistant', text: 'Finished result' }] };
  host.notifySessionEmail(state); host.notifySessionEmail({ ...state, status: 'failed' }); host.notifySessionEmail({ ...state, messages: [{ ...state.messages[0], questions: [{ title: 'Choose' }] }] });
  expect(notify.mock.calls.map(call => call[0].event)).toEqual(['ready', 'failed', 'needsAnswer']);
  expect(notify.mock.calls[0][0]).toMatchObject({ sessionKey: `local:${state.sessionId}`, result: 'Finished result' });
  host.notifySessionEmail({ ...state, updatedAt: Date.now() - 180000 }); host.notifySessionEmail({ ...state, status: 'cancelled' }); expect(notify).toHaveBeenCalledTimes(3);
});
