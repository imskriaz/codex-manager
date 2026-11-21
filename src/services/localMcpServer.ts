import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { localMcpEndpoint } from '../../tools/local-mcp.cjs';
import { getCodexManagerStorageRoot } from '../utils/storageRoot';

/** OS-local transport only. TCP headers can never select this authorization path. */
export class LocalMcpServer {
  private server?: http.Server;
  private starting?: Promise<void>;
  private revision = 0;

  start(handle: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>): Promise<void> {
    if (this.starting) return this.starting;
    if (this.server) return Promise.resolve();
    const revision = this.revision;
    const work = this.listen(handle, revision).finally(() => { if (this.starting === work) this.starting = undefined; });
    this.starting = work;
    return work;
  }

  private async listen(handle: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>, revision: number): Promise<void> {
    const endpoint = localMcpEndpoint(getCodexManagerStorageRoot());
    if (process.platform !== 'win32') {
      const directory = path.dirname(endpoint);
      await fs.mkdir(directory, { mode: 0o700, recursive: true });
      const info = await fs.lstat(directory);
      if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('The local MCP socket directory is not private to this user.');
      const stale = await fs.lstat(endpoint).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      if (stale) {
        if (!stale.isSocket() || stale.uid !== process.getuid?.()) throw new Error('The local MCP socket has an unexpected owner or type.');
        const active = await new Promise<boolean>((resolve, reject) => {
          const probe = net.createConnection(endpoint);
          probe.once('connect', () => { probe.destroy(); resolve(true); });
          probe.once('error', (error: NodeJS.ErrnoException) => { probe.destroy(); if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false); else reject(error); });
          probe.setTimeout(500, () => { probe.destroy(); reject(new Error('The local MCP owner did not respond.')); });
        });
        if (active) throw new Error('The local MCP socket is already owned by another host.');
        await fs.unlink(endpoint);
      }
    }
    if (revision !== this.revision) return;
    const server = http.createServer((request, response) => {
      if (request.headers.origin || !['/api/schema', '/api/state', '/api/message'].includes(new URL(request.url ?? '/', 'http://localhost').pathname)) {
        response.writeHead(403, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'Use the local MCP API endpoints without a browser origin.' })); return;
      }
      void handle(request, response).catch(error => {
        if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
        if (!response.writableEnded) response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Local MCP request failed.' }));
      });
    });
    server.requestTimeout = 16 * 60_000;
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ path: endpoint, readableAll: false, writableAll: false, exclusive: true }, () => { server.off('error', reject); resolve(); });
      });
      if (revision !== this.revision) {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        return;
      }
      if (process.platform !== 'win32') await fs.chmod(endpoint, 0o600);
      server.on('error', error => console.error('[codexManager] local MCP transport failed', error));
    } catch (error) { if (this.server === server) this.server = undefined; if (server.listening) server.close(); throw error; }
  }

  async stop(): Promise<void> {
    this.revision++;
    await this.starting?.catch(() => undefined);
    const server = this.server; this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
