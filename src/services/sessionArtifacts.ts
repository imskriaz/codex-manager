import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import * as http from 'node:http';
import { isIP } from 'node:net';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import type { SessionArtifact, SessionArtifactRequest } from '../domain/sessionArtifacts';
import { getSqliteStateStore } from '../storage/sqliteState';
import { waitWithin } from '../utils/concurrency';
import { readSafeFileSnapshot } from '../utils/safeFileReads';

const records = 'session-artifacts';
const files = 'session-artifact-files';
const maxFileBytes = 8 * 1024 * 1024;
const maxStorageBytes = 32 * 1024 * 1024;
const artifactLifetime = 24 * 60 * 60_000;
const artifactPath = '/artifacts/';
const previewPrefix = 'cm-preview-';
const idPattern = /^[a-f0-9]{32}$/;
const probeHeader = 'x-codex-artifact-check';
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

type Source =
  | { kind: 'file'; name: string; bytes: number; html: boolean }
  | { kind: 'app'; hostname: '127.0.0.1' | '::1'; port: number; entry: string }
  | { kind: 'link'; href: string };

type Record = SessionArtifact & { sessionId: string; source: Source };

function storage() {
  const store = getSqliteStateStore();
  if (!store) throw new Error('Session artifact storage is unavailable. Retry after the host starts.');
  return store;
}

function active(id: string): Record | undefined {
  const record = typeof id === 'string' && idPattern.test(id) ? getSqliteStateStore()?.get<Record>(records, id) : undefined;
  return record && record.expiresAt > Date.now() ? record : undefined;
}

function visible({ id, kind, title, url, expiresAt }: Record): SessionArtifact {
  return { id, kind, title, url, expiresAt };
}

function list(sessionId: string): SessionArtifact[] {
  return storage().entries<Record>(records)
    .map(([, record]) => record)
    .filter(record => record.sessionId === sessionId && record.expiresAt > Date.now())
    .sort((a, b) => b.expiresAt - a.expiresAt)
    .map(visible);
}

function httpUrl(value: string): URL {
  let url: URL | undefined;
  try { url = new URL(value); } catch { /* Report a validation error below. */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Enter an HTTP or HTTPS URL without credentials.');
  }
  return url;
}

export function artifactAppSource(value: string): Extract<Source, { kind: 'app' }> {
  const url = httpUrl(/^\d+$/.test(value) ? `http://127.0.0.1:${value}` : value);
  const port = Number(url.port || 80);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    port < 1 || port === 39875 || port === Number(process.env['CODEX_MANAGER_PORT'])) {
    throw new Error('Enter the port or loopback HTTP address of a running app.');
  }
  return { kind: 'app', hostname: url.hostname === '[::1]' ? '::1' : '127.0.0.1', port, entry: `${url.pathname}${url.search}${url.hash}` };
}

function previewDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  if (domain.length > 208 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(domain) ||
    isIP(domain)) {
    throw new Error('Set Session Artifact Domain to a DNS suffix for preview hosts and route it to the dashboard tunnel.');
  }
  return domain;
}

function safeRelative(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !!relative && !path.isAbsolute(relative) && relative.split(path.sep).every(part => part !== '..' && !part.includes(':'));
}

async function snapshot(project: string, file: string): Promise<{ source: Extract<Source, { kind: 'file' }>; data: Buffer }> {
  if (path.isAbsolute(file) || path.win32.isAbsolute(file) || file.includes(':') || file.includes('\0')) {
    throw new Error('Enter a file path relative to this session’s project.');
  }
  const resolveFile = async () => {
    const root = await realpath(project);
    const candidate = path.resolve(root, file);
    if (!safeRelative(root, candidate)) throw new Error('Choose a file inside this session’s project.');
    const resolved = await realpath(candidate);
    if (!safeRelative(root, resolved)) throw new Error('Choose a file inside this session’s project.');
    return resolved;
  };
  const resolved = await waitWithin(resolveFile(), 3_000, 'The artifact file path did not respond in time.');
  const { buffer } = await readSafeFileSnapshot(resolved, { maxBytes: maxFileBytes, rejectIfLarger: true, timeoutMs: 3_000 });
  const name = path.basename(file);
  return { source: { kind: 'file', name, bytes: buffer.length, html: /\.html?$/i.test(name) }, data: buffer };
}

function remove(store: ReturnType<typeof storage>, id: string): void {
  store.set(records, id, undefined);
  store.set(files, id, undefined);
}

export async function manageSessionArtifacts(
  sessionId: string | undefined,
  request: SessionArtifactRequest | undefined,
  options: { dashboardOrigin?: string; previewDomain: string; resolveProject: () => Promise<string>; confirmed: boolean }
): Promise<{ sessionArtifacts: SessionArtifact[]; artifact?: SessionArtifact; warning?: string }> {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256 || !request) throw new Error('Choose a session first.');
  if (request.operation === 'list') return { sessionArtifacts: list(sessionId) };
  if (request.operation === 'revoke') {
    const store = storage();
    store.transaction(() => {
      const record = active(request.id);
      if (!record || record.sessionId !== sessionId) throw new Error('This artifact link has already expired or been revoked.');
      remove(store, record.id);
    });
    return { sessionArtifacts: list(sessionId) };
  }
  if (request.operation !== 'create' || !options.confirmed) throw new Error('Confirm that anyone with the link may access the artifact.');
  if (typeof request.title !== 'string' || !request.title.trim() || request.title.length > 120 ||
    typeof request.source !== 'string' || !request.source.trim() || request.source.length > 2048) {
    throw new Error('Enter a title and an artifact source.');
  }
  if (!options.dashboardOrigin) throw new Error('Set the public HTTPS dashboard domain before sharing an artifact.');
  const dashboard = new URL(options.dashboardOrigin);
  const value = request.source.trim();
  let source: Source;
  let data: Buffer | undefined;
  if (request.kind === 'file') ({ source, data } = await snapshot(await options.resolveProject(), value));
  else if (request.kind === 'app') source = artifactAppSource(value);
  else if (request.kind === 'link') source = { kind: 'link', href: httpUrl(value).href };
  else throw new Error('Choose a file, running app, or existing URL.');

  const id = randomBytes(16).toString('hex');
  const url = source.kind === 'app' || (source.kind === 'file' && source.html)
    ? `https://${previewPrefix}${id}.${previewDomain(options.previewDomain)}${source.kind === 'app' ? source.entry : '/'}`
    : new URL(artifactPath + id, dashboard).href;
  const record: Record = { id, sessionId, url, source, kind: source.kind, title: request.title.trim(), expiresAt: Date.now() + artifactLifetime };
  const store = storage();
  store.transaction(() => {
    let count = 0;
    let bytes = data?.length ?? 0;
    for (const [key, saved] of store.entries<Record>(records)) {
      if (saved.expiresAt <= Date.now()) remove(store, key);
      else {
        count++;
        if (saved.source.kind === 'file') bytes += saved.source.bytes;
      }
    }
    if (count >= 100 || bytes > maxStorageBytes) throw new Error('Artifact storage is full. Revoke a link or wait for one to expire.');
    if (store.get(records, id)) throw new Error('An artifact link already uses this identifier. Retry once.');
    store.set(records, id, record);
    if (data) store.set(files, id, data.toString('base64'));
  });
  const publicReady = await fetch(url, {
    method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(4_000), headers: { [probeHeader]: '1' }
  }).then(response => response.status === 204 && response.headers.get(probeHeader) === id, () => false);
  const warning = publicReady ? undefined : 'Artifact saved, but the public link could not be verified. Check that its domain routes to this system.';
  return { artifact: visible(record), sessionArtifacts: list(sessionId), warning };
}

function requestHost(request: http.IncomingMessage): string {
  return request.headers.host?.toLowerCase() ?? '';
}

function previewRequest(request: http.IncomingMessage, pathname: string): boolean {
  return requestHost(request).startsWith(previewPrefix) || pathname.startsWith(artifactPath);
}

function lookup(request: http.IncomingMessage, pathname: string): Record | undefined {
  const host = requestHost(request);
  const preview = host.startsWith(previewPrefix);
  const id = preview ? host.slice(previewPrefix.length).split('.')[0] : pathname.slice(artifactPath.length);
  const record = active(id ?? '');
  if (!record) return;
  const url = new URL(record.url);
  if (host === url.host && (preview || pathname === url.pathname)) return record;
  return undefined;
}

function reply(response: http.ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(message);
}

export function handleSessionArtifact(request: http.IncomingMessage, response: http.ServerResponse, pathname: string): boolean {
  if (!previewRequest(request, pathname)) return false;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const record = lookup(request, pathname);
  if (!record) reply(response, 404, 'This artifact link is unavailable.');
  else if (request.method === 'HEAD' && request.headers[probeHeader] === '1') {
    if (record.source.kind === 'app') proxyHttp(request, response, record, true);
    else ready(response, record);
  } else if (record.source.kind === 'app') proxyHttp(request, response, record);
  else if (request.method !== 'GET' && request.method !== 'HEAD') reply(response, 405, 'Use GET or HEAD to open this artifact.');
  else if (record.source.kind === 'link') {
    response.writeHead(302, { Location: record.source.href });
    response.end();
  } else if (pathname !== new URL(record.url).pathname) reply(response, 404, 'This artifact contains one file.');
  else {
    const encoded = getSqliteStateStore()?.get<string>(files, record.id);
    if (encoded === undefined) reply(response, 404, 'This artifact file is unavailable.');
    else {
      response.setHeader('Content-Length', record.source.bytes);
      if (record.source.html) {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Content-Security-Policy', "worker-src 'none'; frame-ancestors 'none'");
      } else {
        response.setHeader('Content-Type', 'application/octet-stream');
        response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(record.source.name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16))}`);
      }
      response.end(request.method === 'HEAD' ? undefined : Buffer.from(encoded, 'base64'));
    }
  }
  return true;
}

function ready(response: http.ServerResponse, record: Record): void {
  response.writeHead(204, { [probeHeader]: record.id });
  response.end();
}

function endToEnd(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const copy = { ...headers };
  for (const name of [...hopHeaders, ...(headers.connection?.split(',') ?? []).map(value => value.trim().toLowerCase())]) delete copy[name];
  return copy;
}

function upstreamOptions(request: http.IncomingMessage, source: Extract<Source, { kind: 'app' }>, upgrade: boolean): http.RequestOptions {
  const headers = endToEnd(request.headers);
  const host = source.hostname === '::1' ? `[::1]:${source.port}` : `localhost:${source.port}`;
  for (const header of Object.keys(headers)) {
    if (/^(cf-|x-forwarded-|x-codex-)|^forwarded$/.test(header)) delete headers[header];
  }
  headers.host = host;
  headers['x-forwarded-host'] = requestHost(request);
  headers['x-forwarded-proto'] = 'https';
  if (headers.origin === `https://${requestHost(request)}`) headers.origin = `http://${host}`;
  if (typeof headers.cookie === 'string') {
    headers.cookie = headers.cookie.split(';').filter(cookie => !/^\s*codex_dashboard_session\s*=/.test(cookie)).join(';');
  }
  if (upgrade) {
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
  }
  const requestPath = request.url && /^\/(?![\\/])/.test(request.url) ? request.url : '/';
  return { hostname: source.hostname, port: source.port, method: request.method, path: requestPath, headers, agent: false };
}

function checkRevocation(record: Record, close: () => void): NodeJS.Timeout {
  const timer = setInterval(() => {
    try { if (active(record.id)) return; } catch { /* Storage failure closes the stream. */ }
    close();
  }, 5_000);
  timer.unref();
  return timer;
}

function proxyHttp(request: http.IncomingMessage, response: http.ServerResponse, record: Record, probe = false): void {
  if (record.source.kind !== 'app') return;
  const upstream = http.request(upstreamOptions(request, record.source, false), incoming => {
    if (probe) {
      incoming.destroy();
      ready(response, record);
      return;
    }
    const headers = endToEnd(incoming.headers);
    delete headers['clear-site-data'];
    delete headers['service-worker-allowed'];
    delete headers[probeHeader];
    headers['cache-control'] = 'no-store';
    headers['referrer-policy'] = 'no-referrer';
    if (Array.isArray(headers['set-cookie'])) {
      headers['set-cookie'] = headers['set-cookie'].filter(cookie => !/^codex_dashboard_session\s*=/i.test(cookie))
        .map(cookie => cookie.replace(/;\s*domain\s*=[^;]*/ig, ''));
    }
    if (typeof headers.location === 'string') {
      try {
        const location = new URL(headers.location);
        if (record.source.kind === 'app' && ['http:', 'https:'].includes(location.protocol) &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) && Number(location.port || 80) === record.source.port) {
          headers.location = `${new URL(record.url).origin}${location.pathname}${location.search}${location.hash}`;
        }
      } catch { /* Relative redirects are already scoped to the preview. */ }
    }
    response.writeHead(incoming.statusCode ?? 502, headers);
    incoming.on('error', () => response.destroy());
    incoming.pipe(response);
  });
  const timer = checkRevocation(record, () => upstream.destroy());
  upstream.setTimeout(probe ? 2_000 : 30_000, () => upstream.destroy(new Error('The app did not respond.')));
  upstream.on('error', () => {
    if (response.headersSent) response.destroy();
    else reply(response, 502, 'This app could not be reached on the host system.');
  });
  response.once('close', () => { clearInterval(timer); upstream.destroy(); });
  request.once('error', () => upstream.destroy());
  request.pipe(upstream);
}

export function upgradeSessionArtifact(request: http.IncomingMessage, socket: Duplex, head: Buffer, pathname: string): boolean {
  if (!previewRequest(request, pathname)) return false;
  const record = lookup(request, pathname);
  if (!record || record.source.kind !== 'app' || request.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.destroy();
    return true;
  }
  const upstream = http.request(upstreamOptions(request, record.source, true));
  const timer = checkRevocation(record, () => socket.destroy());
  socket.once('close', () => { clearInterval(timer); upstream.destroy(); });
  socket.once('error', () => upstream.destroy());
  upstream.setTimeout(5_000, () => upstream.destroy());
  upstream.once('error', () => socket.destroy());
  upstream.once('response', response => { response.destroy(); socket.destroy(); });
  upstream.once('upgrade', (response, peer, remaining) => {
    peer.setTimeout(0);
    const names = ['upgrade', 'connection', 'sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions'];
    const headers = names.flatMap(name => {
      const value = response.headers[name];
      return typeof value === 'string' ? [`${name}: ${value}`] : [];
    });
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (remaining.length) socket.write(remaining);
    if (head.length) peer.write(head);
    socket.once('close', () => peer.destroy());
    peer.once('close', () => socket.destroy());
    peer.once('error', () => socket.destroy());
    socket.pipe(peer).pipe(socket);
  });
  upstream.end();
  return true;
}
