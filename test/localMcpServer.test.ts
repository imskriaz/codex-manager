import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.unmock('../src/services/localMcpServer');
import { LocalMcpServer } from '../src/services/localMcpServer';
import { localMcpEndpoint } from '../tools/local-mcp.cjs';
import { WebDashboardServer } from '../src/services/webDashboardServer';

let root: string, server: LocalMcpServer;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'manager-local-mcp-')); vi.stubEnv('CODEX_MANAGER_STORAGE_ROOT', root); server = new LocalMcpServer(); });
afterEach(async () => { await server.stop(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
function read(path = '/api/schema', headers = {}): Promise<{ status: number; value: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: localMcpEndpoint(root), path, headers }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, value: JSON.parse(body) }));
    });
    req.on('error', reject); req.end();
  });
}

it('serves internal MCP without a token even when the remote API is disabled', async () => {
  const dashboard = Object.assign(Object.create(WebDashboardServer.prototype), {
    settingsStore: { getDashboardSettings: () => ({ apiAccessEnabled: false }) },
    isAuthorized: vi.fn(() => { throw new Error('Browser authentication must not be used'); })
  });
  await server.start((req, res) => dashboard.handle(req, res, true));
  const result = await read();
  expect(result.status).toBe(200); expect(result.value.actions).toContain('coordinateCodexSessions');
  expect(result.value.token.name).toBe('Local Codex Manager MCP'); expect(dashboard.isAuthorized).not.toHaveBeenCalled();
  expect((await read('/api/schema', { Origin: 'http://malicious.test' })).status).toBe(403);
  expect((await read('/shutdown')).status).toBe(403);
});

it('runs the stdio MCP client on the local transport with no credential and no TCP URL', async () => {
  await server.start(async (_req, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ actions: ['coordinateCodexSessions'] })); });
  const env = { ...process.env, CODEX_MANAGER_TRANSPORT: 'local' }; delete env.CODEX_MANAGER_URL; delete env.CODEX_MANAGER_TOKEN;
  const child = spawn(process.execPath, ['tools/codex-manager-mcp.mjs'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (value: any) => void>(); let id = 0;
  lines.on('line', line => { const response = JSON.parse(line); pending.get(response.id)?.(response); });
  const call = (method: string, params = {}) => new Promise<any>((resolve, reject) => {
    const current = ++id; const timer = setTimeout(() => reject(new Error('stdio timed out')), 4000);
    pending.set(current, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }) + '\n');
  });
  try {
    await call('initialize'); const response = await call('tools/call', { name: 'manager_schema', arguments: {} });
    expect(response.result.isError).not.toBe(true); expect(JSON.parse(response.result.content[0].text).actions).toContain('coordinateCodexSessions');
  } finally { lines.close(); child.kill(); }
});

it('does not let an HTTP header enable local MCP authorization on the browser listener', async () => {
  const dashboard = Object.assign(Object.create(WebDashboardServer.prototype), {
    settingsStore: { getDashboardSettings: () => ({ apiAccessEnabled: false }) },
    isAuthorized: vi.fn(async () => false)
  });
  let body = ''; const headers = new Map();
  const response = { statusCode: 200, setHeader: (key: string, value: string) => headers.set(key, value), end: (value: string) => { body = value; } };
  await dashboard.handle({ method: 'GET', url: '/api/schema', headers: { host: '127.0.0.1:39875', 'x-codex-local-mcp': '1' } }, response);
  expect(response.statusCode).toBe(401); expect(body).toContain('expired');
});

it('keeps the existing owner when a second host tries to claim the local endpoint', async () => {
  await server.start(async (_req, res) => { res.end('{}'); });
  const other = new LocalMcpServer();
  try { await expect(other.start(async (_req, res) => { res.end('{}'); })).rejects.toThrow(); expect((await read()).status).toBe(200); }
  finally { await other.stop(); }
});

it('coalesces startup and closes an in-flight listener before shutdown returns', async () => {
  const handle = async (_req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => { res.end('{}'); };
  const first = server.start(handle), second = server.start(handle);
  expect(second).toBe(first);
  await server.stop(); await first;
  await expect(read()).rejects.toThrow();
  await server.start(handle);
  expect((await read()).status).toBe(200);
});
