import { PassThrough } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebDashboardServer } from '../src/services/webDashboardServer';
import { SqliteStateStore, configureSqliteStateStore } from '../src/storage/sqliteState';
import { createProjectShare, revokeProjectShares, readProjectTasks, saveProjectTask } from '../src/services/projectTasks';
import * as boardService from '../src/services/projectBoard';
import { removeTestDirectory } from './testFilesystem';

let root: string, store: SqliteStateStore, server: { handle(request: unknown, response: unknown): Promise<void>; publicProjectInflight: number };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'manager-public-http-'));
  store = await SqliteStateStore.open(join(root, 'manager.sqlite')); configureSqliteStateStore(store);
  server = Object.assign(Object.create(WebDashboardServer.prototype), { settingsStore: { getDashboardSettings: () => ({ cloudflaredDomain: '' }) }, publicProjectRequests: new Map(), publicProjectInflight: 0 });
  vi.spyOn(boardService, 'readProjectBoard').mockImplementation(async projectPath => ({ projectPath: projectPath!, ...readProjectTasks(projectPath!), sessions: [], updatedAt: Date.now() }));
});
afterEach(async () => { vi.restoreAllMocks(); configureSqliteStateStore(undefined); store.close(); await removeTestDirectory(root); });
async function request(path: string, body?: unknown, origin = 'http://127.0.0.1:39875') {
  const incoming = Object.assign(new PassThrough(), { method: body ? 'POST' : 'GET', url: path, headers: { host: '127.0.0.1:39875', origin, 'x-codex-dashboard': '1' }, socket: { remoteAddress: '127.0.0.1' } });
  const headers = new Map<string, unknown>();
  const response = { statusCode: 200, body: '', setHeader: (key: string, value: unknown) => headers.set(key.toLowerCase(), value), removeHeader: (key: string) => headers.delete(key.toLowerCase()), end: (value: unknown) => { response.body = String(value ?? ''); } };
  const pending = server.handle(incoming, response); if (body) incoming.end(JSON.stringify(body)); else incoming.end(); await pending;
  return { ...response, headers };
}

it('allows framing only for links with embedding permission and always disables document caching', async () => {
  const privateFrame = createProjectShare(root, []), embedded = createProjectShare(root, ['embed']);
  const denied = await request(`/projects/share/${privateFrame.token}`);
  expect(denied.headers.get('x-frame-options')).toBe('DENY');
  const allowed = await request(`/projects/share/${embedded.token}`);
  expect(allowed.headers.has('x-frame-options')).toBe(false);
  expect(allowed.headers.get('content-security-policy')).toContain('frame-ancestors http: https:');
  expect(allowed.headers.get('cache-control')).toBe('no-store');
  revokeProjectShares(root);
  expect((await request(`/projects/share/${embedded.token}`)).statusCode).toBe(404);
});

it('enforces submissions and comment permissions over HTTP, including cross-origin rejection and duplicate requests', async () => {
  saveProjectTask(root, { id: 'task', title: 'Task', prompt: '', stage: 'planned', expectedRevision: 0 });
  const readOnly = createProjectShare(root, []), interactive = createProjectShare(root, ['submissions','comments']);
  const submission = { kind: 'task', id: 'idea', title: 'Visitor idea', prompt: 'Please do this' };
  expect((await request(`/api/projects/share/${readOnly.token}`, submission)).statusCode).toBe(400);
  expect((await request(`/api/projects/share/${interactive.token}`, submission, 'https://untrusted.example')).statusCode).toBe(403);
  expect((await request(`/api/projects/share/${interactive.token}`, submission)).statusCode).toBe(200);
  expect((await request(`/api/projects/share/${interactive.token}`, submission)).statusCode).toBe(200);
  expect(readProjectTasks(root).tasks.filter(task => task.id === 'idea')).toHaveLength(1);
  const comment = { kind: 'comment', id: 'comment', taskId: 'task', text: 'Feedback' };
  expect((await request(`/api/projects/share/${readOnly.token}`, comment)).statusCode).toBe(400);
  expect((await request(`/api/projects/share/${interactive.token}`, comment)).statusCode).toBe(200);
  expect(server.publicProjectInflight).toBe(0);
});

it('does not return a board when the owner revokes the link during its pending read', async () => {
  const share = createProjectShare(root, []);
  vi.mocked(boardService.readProjectBoard).mockImplementationOnce(async () => { revokeProjectShares(root); return { projectPath: root, tasks: [], comments: [], sessions: [], updatedAt: Date.now() }; });
  expect((await request(`/api/projects/share/${share.token}`)).statusCode).toBe(404);
});
