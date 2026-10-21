import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as vscode from 'vscode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebDashboardServer } from '../src/services/webDashboardServer';
import { configureCrossWindowOperationCoordinator } from '../src/utils/crossWindowOperations';
import { createDashboardApiToken, revokeDashboardApiToken } from '../src/services/dashboardApiToken';
import * as board from '../src/services/projectBoard';
import { removeTestDirectory } from './testFilesystem';

const { sessionProjects } = vi.hoisted(() => ({ sessionProjects: new Map<string, string>() }));
vi.mock('../src/services/codexSessionResume', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/codexSessionResume')>(),
  readCodexCliSessionSummary: vi.fn(async (id: string) => ({ id, projectPath: sessionProjects.get(id), status: 'idle' }))
}));
let root: string, first: string, second: string, origin: string, host: Server, enabled: boolean;
let context: vscode.ExtensionContext;
const dispatch = vi.fn(async (message: { type: string; action?: string; requestId?: string }) => ({
  messages: [{ type: 'dashboard:action-result', requestId: message.requestId, action: message.action, status: 'completed', payload: { notice: { level: 'info', message: 'Action completed.' } } },
    { type: 'dashboard:snapshot', state: { accounts: [{ id: 'private-account' }], settings: {} } }], reloadAfterResponse: false
}));
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'manager-api-http-')); first = join(root, 'first'); second = join(root, 'second');
  await Promise.all([mkdir(first), mkdir(second)]); await configureCrossWindowOperationCoordinator(root);
  sessionProjects.set('own', first); sessionProjects.set('other', second); enabled = true; dispatch.mockClear();
  const secrets = new Map<string, string>();
  context = { secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); } } } as unknown as vscode.ExtensionContext;
  const server = Object.assign(Object.create(WebDashboardServer.prototype), {
    context, getUrl: () => origin, settingsStore: { getDashboardSettings: () => ({ cloudflaredDomain: '', apiAccessEnabled: enabled }) },
    processClientMessage: dispatch, publishProcessedSnapshot: vi.fn()
  });
  vi.spyOn(board, 'readProjectBoard').mockImplementation(async projectPath => ({ projectPath: projectPath!, tasks: [], comments: [], sessions: [], updatedAt: Date.now() }));
  host = createServer((request, response) => { void server.handle(request, response).catch(() => { response.statusCode = 500; response.end('Unexpected server failure'); }); });
  await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => { host.close(() => resolve()); host.closeAllConnections(); });
  vi.restoreAllMocks(); sessionProjects.clear(); await removeTestDirectory(root);
});
const request = (token: string, path: string, message?: unknown, requestOrigin?: string) => fetch(origin + path, {
  method: message === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(requestOrigin ? { Origin: requestOrigin } : {}) },
  ...(message === undefined ? {} : { body: JSON.stringify(message) }), signal: AbortSignal.timeout(5000)
});
const action = (name: string, payload = {}) => ({ type: 'dashboard:action', requestId: 'http-check', action: name, payload });

it('enforces operation permissions over HTTP and excludes ungranted appended dashboard state', async () => {
  const { token } = await createDashboardApiToken(context, { name: 'Rename only', permissions: ['renameCodexCliSession'] });
  expect((await request(token, '/api/schema').then(r => r.json())).actions).toEqual(['renameCodexCliSession']);
  expect((await request(token, '/api/state')).status).toBe(403);
  const result = await request(token, '/api/message', action('renameCodexCliSession', { sessionId: 'own', title: 'New title' }));
  expect(result.status).toBe(200);
  const body = await result.json();
  expect(body.messages).toHaveLength(1); expect(JSON.stringify(body)).not.toContain('private-account');
  expect((await request(token, '/api/message', action('deleteCodexCliSession', { sessionId: 'own' }))).status).toBe(403);
  expect(dispatch).toHaveBeenCalledOnce();
});

it('enforces multiple project scopes on state, session ownership, remote targets and filesystem requests', async () => {
  const { token } = await createDashboardApiToken(context, { name: 'First project', projectPath: first, permissions: ['state', 'readWorkspaceFile', 'getCodexCliSessionMessages'] });
  expect((await request(token, '/api/state')).status).toBe(200);
  expect((await request(token, '/api/state?projectPath=' + encodeURIComponent(second))).status).toBe(403);
  for (const message of [action('readWorkspaceFile', { projectPath: second, filePath: 'private.txt' }), action('readWorkspaceFile', { projectPath: first, targetDeviceId: 'other-pc' }), action('getCodexCliSessionMessages', { sessionId: 'other' })])
    expect((await request(token, '/api/message', message)).status).toBe(403);
  expect((await request(token, '/api/message', action('getCodexCliSessionMessages', { sessionId: 'own' }))).status).toBe(200);
  expect(dispatch).toHaveBeenCalledOnce();
  const multi = await createDashboardApiToken(context, { name: 'Two projects', projectPaths: [first, second], permissions: ['state'] });
  expect((await request(multi.token, '/api/state')).status).toBe(403);
  for (const project of [first, second]) expect((await request(multi.token, '/api/state?projectPath=' + encodeURIComponent(project))).status).toBe(200);
});

it('rejects invalid, revoked and disabled tokens despite a local browser authentication fallback', async () => {
  const { token, record } = await createDashboardApiToken(context, { name: 'Read', permissions: ['state'] });
  expect((await request('cm_' + '0'.repeat(64), '/api/schema')).status).toBe(401);
  enabled = false; expect((await request(token, '/api/schema')).status).toBe(401);
  enabled = true; expect((await request(token, '/api/schema')).status).toBe(200);
  await revokeDashboardApiToken(context, record.id);
  expect((await request(token, '/api/schema')).status).toBe(401); expect(dispatch).not.toHaveBeenCalled();
});

it('preserves explicit state permission and rejects cross-origin, unlisted and global-settings requests', async () => {
  const { token } = await createDashboardApiToken(context, { name: 'Read and rename', permissions: ['state', 'renameCodexCliSession'] });
  const result = await request(token, '/api/message', action('renameCodexCliSession'));
  expect((await result.json()).messages.some((message: { type: string }) => message.type === 'dashboard:snapshot')).toBe(true);
  expect((await request(token, '/api/message', action('renameCodexCliSession'), 'https://untrusted.example')).status).toBe(403);
  expect((await request(token, '/api/message', action('unknownOperation'))).status).toBe(400);
  expect((await request(token, '/api/message', { type: 'dashboard:setting', key: 'apiAccessEnabled', value: false })).status).toBe(403);
  expect((await request(token, '/workspace')).status).toBe(403); expect(dispatch).toHaveBeenCalledOnce();
});
