import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { getCodexManagerStorageRoot } from '../utils/storageRoot';
import { waitWithin } from '../utils/concurrency';

type Owner = { endpoint: string; token: string; home: string; pid: number };
export type OwnerThread = { id: string; path?: string; cwd?: string; status?: { type?: string }; turns?: Array<{ id: string; status: string }>; latestThreadSettings?: unknown };
type Reply = { owned?: boolean; thread?: OwnerThread; result?: unknown; error?: string };
type Observation = { owner: Owner; thread: OwnerThread; checkedAt: number };
const observations = new Map<string, Observation>();
const key = (home: string, id: string) => JSON.stringify([path.resolve(home), id]);
export const ownerBridgeDirectory = () => path.join(getCodexManagerStorageRoot(), 'runtime', 'native-owner');

function call(owner: Owner, id: string, method: string, params?: unknown, signal?: AbortSignal): Promise<Reply> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(owner.endpoint);
    socket.setEncoding('utf8');
    let buffer = '', sent = false;
    const cleanup = () => { signal?.removeEventListener('abort', abort); socket.destroy(); };
    const fail = (error: Error) => { cleanup(); reject(sent ? new Error(`${error.message} The Codex owner outcome is unconfirmed; do not resend automatically.`) : error); };
    const abort = () => fail(new Error('Codex owner control cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.setTimeout(20_000, () => fail(new Error('Codex owner confirmation timed out.')));
    socket.once('error', fail);
    socket.once('connect', () => { sent = true; socket.write(JSON.stringify({ token: owner.token, threadId: id, method, params }) + '\n'); });
    socket.on('data', (data: string) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) { fail(new Error('Codex owner response exceeds the limit.')); return; }
      if (!buffer.includes('\n')) return;
      try { const reply = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as Reply; cleanup(); if (reply.error) reject(new Error(reply.error)); else resolve(reply); }
      catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.once('end', () => { if (!buffer.includes('\n')) fail(new Error('Codex owner disconnected.')); });
  });
}

export function getOwnerBridgeState(home: string, id: string): Observation | undefined {
  const entry = observations.get(key(home, id));
  return entry && Date.now() - entry.checkedAt < 15_000 ? entry : undefined;
}
export function clearOwnerBridgeState(): void { observations.clear(); }
export function ownerBridgeRunning(thread: OwnerThread): boolean | undefined {
  if (thread.status?.type === 'active' || thread.turns?.at(-1)?.status === 'inProgress') return true;
  return thread.status?.type === 'idle' ? false : undefined;
}
export function ownerBridgeTurnId(thread: OwnerThread): string | undefined {
  const turn = thread.turns?.at(-1);
  return turn?.status === 'inProgress' ? turn.id : undefined;
}
export async function readOwnerBridgeState(home: string, id: string, signal?: AbortSignal): Promise<Observation | undefined> {
  const directory = ownerBridgeDirectory();
  const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  if (!names.length) return undefined;
  const canonicalHome = await fs.realpath(home);
  const candidates = await Promise.all(names.filter(name => /^\d+\.json$/.test(name)).slice(0, 32).map(async name => {
    try {
      const owner = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')) as Owner;
      if (path.resolve(owner.home) !== canonicalHome || typeof owner.token !== 'string' ||
        !(process.platform === 'win32' ? /^\\\\\.\\pipe\\codex-manager-owner-[0-9a-f-]+$/i.test(owner.endpoint) : path.dirname(owner.endpoint) === directory && owner.endpoint.endsWith('.sock'))) return undefined;
      const checking = new AbortController();
      try {
        const reply = await waitWithin(call(owner, id, 'status', undefined, signal ? AbortSignal.any([signal, checking.signal]) : checking.signal), 1500, 'Codex owner discovery timed out.', signal);
        return reply.owned && reply.thread?.id === id ? { owner, thread: reply.thread, checkedAt: Date.now() } : undefined;
      } finally { checking.abort(); }
    } catch (error) { signal?.throwIfAborted(); return undefined; }
  }));
  const matches = candidates.filter((item): item is Observation => !!item);
  if (matches.length > 1) throw new Error('More than one Codex process claims this conversation. No control was sent.');
  const found = matches[0];
  if (found) {
    if (observations.size >= 256) observations.delete(observations.keys().next().value!);
    observations.set(key(home, id), found);
  } else observations.delete(key(home, id));
  return found;
}

/** Once dispatched to a verified owner, a lost reply must never trigger a private replay. */
export async function requestOwnerBridge(home: string, id: string, method: string, params: unknown, signal?: AbortSignal): Promise<Reply | undefined> {
  const entry = await readOwnerBridgeState(home, id, signal);
  if (!entry) return undefined;
  const reply = await call(entry.owner, id, method, params, signal);
  if (!reply.owned) throw new Error('The Codex owner changed before dispatch. Your message was not sent.');
  observations.delete(key(home, id));
  return reply;
}
