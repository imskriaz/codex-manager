import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebDashboardServer } from '../src/services/webDashboardServer';
import { SqliteStateStore, configureSqliteStateStore } from '../src/storage/sqliteState';
import { createProjectShare, revokeProjectShares, readProjectTasks, saveProjectTask } from '../src/services/projectTasks';
import * as boardService from '../src/services/projectBoard';
import { removeTestDirectory } from './testFilesystem';
import { ProjectShareEvents } from '../src/services/projectShareEvents';

let root: string, store: SqliteStateStore, events: ProjectShareEvents, server: { handle(request: unknown, response: unknown): Promise<void>; publicProjectInflight: number };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'manager-public-http-'));
  store = await SqliteStateStore.open(join(root, 'manager.sqlite')); configureSqliteStateStore(store);
  events = new ProjectShareEvents();
  server = Object.assign(Object.create(WebDashboardServer.prototype), { settingsStore: { getDashboardSettings: () => ({ cloudflaredDomain: '' }) }, publicProjectRequests: new Map(), publicProjectInflight: 0, projectShareEvents: events });
  vi.spyOn(boardService, 'readProjectBoard').mockImplementation(async projectPath => ({ projectPath: projectPath!, ...readProjectTasks(projectPath!), sessions: [], updatedAt: Date.now() }));
});
afterEach(async () => { events.close(); vi.restoreAllMocks(); configureSqliteStateStore(undefined); store.close(); await removeTestDirectory(root); });
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
  expect(allowed.body).toContain('/assets/dashboard.js?v=');
  expect(allowed.body).toContain('/assets/projectShare.js?v=');
  expect(allowed.headers.get('content-security-policy')).toContain("img-src 'self' https: data:");
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

it('rejects expired event subscriptions and mutations through the read-only event route', async () => {
  const share = createProjectShare(root, []);
  expect((await request(`/api/projects/share/${share.token}/events`, { kind: 'task' })).statusCode).toBe(405);
  revokeProjectShares(root);
  expect((await request(`/api/projects/share/${share.token}/events`)).statusCode).toBe(404);
  expect(server.publicProjectInflight).toBe(0);
});

it('streams real HTTP invalidations, bounds duplicate views, and closes immediately on revocation', async () => {
  const share = createProjectShare(root, []);
  const network = createServer((incoming, response) => { void server.handle(incoming, response); });
  await new Promise<void>(resolve => network.listen(0, '127.0.0.1', resolve));
  const address = network.address() as { port: number };
  const endpoint = `http://127.0.0.1:${address.port}/api/projects/share/${share.token}/events`;
  const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader(), decode = new TextDecoder();
    expect(decode.decode((await reader.read()).value)).toContain('event: ready');
    const second = await fetch(endpoint, { signal: controller.signal });
    expect(second.ok).toBe(true);
    expect((await fetch(endpoint, { signal: controller.signal })).status).toBe(429);
    expect(server.publicProjectInflight).toBe(0);
    saveProjectTask(root, { id: 'live', title: 'Live task', prompt: '', stage: 'idea', expectedRevision: 0 });
    expect(decode.decode((await reader.read()).value)).toContain('event: change');
    revokeProjectShares(root);
    expect(decode.decode((await reader.read()).value)).toContain('event: revoked');
    expect((await reader.read()).done).toBe(true);
  } finally {
    clearTimeout(deadline); controller.abort(); events.close(); network.closeAllConnections();
    await new Promise<void>(resolve => network.close(() => resolve()));
  }
});
