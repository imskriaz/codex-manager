import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { SessionArtifactRequest } from '../src/domain/sessionArtifacts';
import { SqliteStateStore, configureSqliteStateStore } from '../src/storage/sqliteState';
import { artifactAppSource, handleSessionArtifact, manageSessionArtifacts, upgradeSessionArtifact } from '../src/services/sessionArtifacts';

let folder: string;
let store: SqliteStateStore;
const servers: http.Server[] = [];
const options = {
  dashboardOrigin: 'https://example.test',
  previewDomain: 'example.test',
  confirmed: true,
  resolveProject: async () => folder
};
const manage = (request: SessionArtifactRequest, session = 'session-one') => manageSessionArtifacts(session, request, options);

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'manager-artifacts-'));
  store = await SqliteStateStore.open(join(folder, 'test.sqlite'));
  configureSqliteStateStore(store);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No public tunnel in the test')));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  configureSqliteStateStore(undefined);
  store.close();
  await rm(folder, { recursive: true, force: true });
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a port.');
  return address.port;
}

function gateway() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (!handleSessionArtifact(request, response, pathname)) response.end('dashboard');
  });
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (!upgradeSessionArtifact(request, socket, head, pathname)) socket.destroy();
  });
  return listen(server);
}

function get(port: number, url: string, host?: string, method = 'GET', headers: http.OutgoingHttpHeaders = {}) {
  const address = new URL(url);
  return new Promise<{ status?: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    http.request({ hostname: '127.0.0.1', port, path: address.pathname + address.search, method, headers: { host: host ?? address.host, ...headers } }, response => {
      response.setEncoding('utf8');
      let body = '';
      response.on('data', chunk => body += chunk);
      response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
      response.on('error', reject);
    }).on('error', reject).end();
  });
}

it('issues a distinct redirect for every share and revokes only the matching session artifact', async () => {
  const request = { operation: 'create', kind: 'link', source: 'https://example.org/page#details', title: 'Demo' } as const;
  const port = await gateway();
  const first = await manage(request);
  const second = await manage(request);
  expect(first.warning).toMatch(/public link could not be verified/);
  expect(first.artifact?.url).not.toBe(second.artifact?.url);
  expect((await manage({ operation: 'list' }, 'session-two')).sessionArtifacts).toEqual([]);
  await expect(manage({ operation: 'revoke', id: first.artifact!.id }, 'session-two')).rejects.toThrow(/expired or been revoked/);
  expect((await get(port, first.artifact!.url)).headers.location).toBe(request.source);
  await manage({ operation: 'revoke', id: first.artifact!.id });
  expect((await get(port, first.artifact!.url)).status).toBe(404);
  expect((await get(port, second.artifact!.url)).status).toBe(302);
  expect((await get(port, second.artifact!.url, 'different.example.test')).status).toBe(404);
});

it('serves an HTML snapshot on its own hostname and blocks paths outside the artifact', async () => {
  await writeFile(join(folder, 'demo.html'), '<h1>first version</h1>');
  const request = { operation: 'create', kind: 'file', title: 'Demo', source: 'demo.html' } as const;
  const { artifact } = await manage(request);
  await writeFile(join(folder, 'demo.html'), '<h1>changed</h1>');
  await expect(manage({ ...request, source: '../demo.html' })).rejects.toThrow(/inside this session/);
  const url = new URL(artifact!.url);
  const port = await gateway();
  const result = await get(port, url.href);
  expect(result.body).toBe('<h1>first version</h1>');
  expect(result.headers['content-type']).toContain('text/html');
  expect(result.headers['cache-control']).toBe('no-store');
  expect((await get(port, new URL('/api/state', url).href)).status).toBe(404);
  expect((await get(port, url.href, 'cm-preview-invalid.example.test')).status).toBe(404);
});

it('proxies the selected loopback app, reports reachability, and supports its WebSocket', async () => {
  const app = http.createServer((request, response) => {
    response.setHeader('Set-Cookie', ['app=1; Domain=example.test; Path=/', 'codex_dashboard_session=drop']);
    response.end(`${request.url} ${request.headers.cookie ?? ''}`);
  });
  const webSocket = new WebSocketServer({ server: app });
  webSocket.on('connection', client => client.on('message', message => client.send(message)));
  const appPort = await listen(app);
  const secondAppPort = await listen(http.createServer((_request, response) => response.end('second app')));
  const port = await gateway();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const probe = await get(port, url, undefined, 'HEAD', { 'x-codex-artifact-check': '1' });
    return new Response(null, { status: probe.status, headers: { 'x-codex-artifact-check': String(probe.headers['x-codex-artifact-check']) } });
  }));
  const { artifact, warning } = await manage({ operation: 'create', kind: 'app', title: 'App', source: `http://localhost:${appPort}/demo?q=works` });
  const second = await manage({ operation: 'create', kind: 'app', title: 'Second app', source: String(secondAppPort) });
  expect(warning).toBeUndefined();
  expect(new URL(second.artifact!.url).hostname).not.toBe(new URL(artifact!.url).hostname);
  expect((await get(port, second.artifact!.url)).body).toBe('second app');
  const response = await get(port, artifact!.url, undefined, 'GET', { cookie: 'app=1; codex_dashboard_session=private' });
  expect(response.body).toBe('/demo?q=works app=1');
  expect(response.headers['set-cookie']).toEqual(['app=1; Path=/']);
  const client = new WebSocket(`ws://127.0.0.1:${port}/socket`, { headers: { host: new URL(artifact!.url).host } });
  try {
    await once(client, 'open');
    client.send('hello');
    expect(String((await once(client, 'message'))[0])).toBe('hello');
  } finally {
    client.close();
    await once(client, 'close');
    await new Promise<void>(resolve => webSocket.close(() => resolve()));
  }
  await manage({ operation: 'revoke', id: artifact!.id });
  expect((await get(port, artifact!.url)).status).toBe(404);
  expect((await get(port, second.artifact!.url)).status).toBe(200);
  expect(() => artifactAppSource('http://192.168.1.10:3000')).toThrow(/loopback/);
  expect(() => artifactAppSource('39875')).toThrow(/loopback/);
});
