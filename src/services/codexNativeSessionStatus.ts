import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { recordNativeSessionStatus } from "./sessionRecording";

type Observation = {
  home: string; id: string; owner?: string; revision?: number; running?: boolean; usedAt: number;
  waiters: Set<(running: boolean | undefined) => void>;
};
const observations = new Map<string, Observation>();
let socket: net.Socket | undefined;
let connecting: Promise<void> | undefined;
let clientId = "initializing-client";
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function send(value: unknown): void {
  if (!socket?.writable) return;
  const body = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32LE(body.length); body.copy(frame, 4);
  socket.write(frame);
}
function follow(entry: Observation, following: boolean): void {
  send({ type: "broadcast", method: "thread-stream-following-changed", version: 1,
    sourceClientId: clientId, params: { conversationId: entry.id, hostId: "local", following } });
}
function settle(entry: Observation, running: boolean | undefined): void {
  entry.running = running;
  recordNativeSessionStatus(entry.home,entry.id,running);
  for (const resolve of entry.waiters) resolve(running);
  entry.waiters.clear();
}
function runtimeRunning(value: unknown): boolean | undefined {
  const type = value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
  return type === "active" ? true : type === "idle" || type === "notLoaded" || type === "systemError" ? false : undefined;
}
type NativeMessage = {
  type?: unknown; method?: unknown; version?: unknown; sourceClientId?: unknown; result?: { clientId?: unknown };
  params?: { status?: unknown; clientId?: unknown; hostId?: unknown; conversationId?: unknown;
    change?: { type?: unknown; revision?: unknown; baseRevision?: unknown; patches?: unknown;
      conversationState?: { id?: unknown; rolloutPath?: unknown; threadRuntimeStatus?: unknown } } };
};
function receive(message: NativeMessage): void {
  if (message.type === "response" && message.method === "initialize" && typeof message.result?.clientId === "string") {
    clientId = message.result.clientId;
    for (const entry of observations.values()) follow(entry, true);
    return;
  }
  if (message.type !== "broadcast") return;
  if (message.method === "client-status-changed" && message.params?.status === "disconnected") {
    for (const entry of observations.values()) if (entry.owner === message.params.clientId) {
      entry.owner = undefined; entry.revision = undefined; settle(entry, undefined); follow(entry, true);
    }
    return;
  }
  if (message.method !== "thread-stream-state-changed" || message.version !== 11 || !message.params || message.params.hostId !== "local") return;
  const { conversationId, change } = message.params;
  if (!change || typeof change.revision !== "number" || !Number.isSafeInteger(change.revision) || change.revision < 0 || typeof message.sourceClientId !== "string") return;
  for (const entry of observations.values()) {
    if (entry.id !== conversationId) continue;
    if (change.type === "snapshot") {
      const state = change.conversationState;
      if (state?.id !== entry.id || typeof state.rolloutPath !== "string") continue;
      const relative = path.relative(entry.home, path.resolve(state.rolloutPath.replace(/^\\\\\?\\/, "")));
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) continue;
      if (entry.owner === message.sourceClientId && entry.revision !== undefined && change.revision <= entry.revision) continue;
      entry.owner = message.sourceClientId; entry.revision = change.revision;
      settle(entry, runtimeRunning(state.threadRuntimeStatus));
    } else if (change.type === "patches" && entry.owner === message.sourceClientId) {
      if (entry.revision !== undefined && change.revision <= entry.revision) continue;
      if (entry.revision !== change.baseRevision || !Array.isArray(change.patches)) {
        entry.revision = undefined; settle(entry, undefined); follow(entry, false); follow(entry, true); continue;
      }
      entry.revision = change.revision;
      for (const value of change.patches as unknown[]) {
        if (!value || typeof value !== "object") continue;
        const patch = value as { path?: unknown; op?: unknown; value?: unknown };
        if (!Array.isArray(patch.path)) continue;
        if (!patch.path.length) { entry.revision = undefined; settle(entry, undefined); follow(entry, false); follow(entry, true); break; }
        if (patch.path[0] === "threadRuntimeStatus") {
          if (patch.path.length === 1) settle(entry, patch.op === "remove" ? undefined : runtimeRunning(patch.value));
          else if (patch.path.length === 2 && patch.path[1] === "type") settle(entry, runtimeRunning({ type: patch.value }));
        }
      }
    }
  }
}

export function getNativeCodexSessionRunning(home: string, id: string): boolean | undefined {
  return socket ? observations.get(`${path.resolve(home)}:${id}`)?.running : undefined;
}

export function disposeNativeCodexSessionStatus(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  const old = socket; socket = undefined; clientId = "initializing-client";
  for (const entry of observations.values()) settle(entry, undefined);
  observations.clear(); old?.destroy();
}

async function endpoint(home: string): Promise<string | undefined> {
  if (process.platform === "win32") return "\\\\.\\pipe\\codex-ipc";
  const uid = process.getuid?.();
  for (const candidate of [path.join(home, "ipc", "ipc.sock"), path.join(os.tmpdir(), "codex-ipc", uid ? `ipc-${uid}.sock` : "ipc.sock")]) {
    try {
      const [file, parent] = await Promise.all([fs.lstat(candidate), fs.lstat(path.dirname(candidate))]);
      if (uid !== undefined && file.isSocket() && file.uid === uid && !(file.mode & 0o022) && parent.isDirectory() && parent.uid === uid && !(parent.mode & 0o022)) return candidate;
    } catch { /* Native IPC is optional on older installations. */ }
  }
  return undefined;
}
async function connect(home: string): Promise<void> {
  if (socket || connecting) return connecting;
  const work = (async () => {
    const target = await endpoint(home);
    if (!target) return;
    const current = net.createConnection(target); socket = current; current.unref();
    let header = Buffer.alloc(0), chunks: Buffer[] = [], remaining = 0;
    const reset = () => { if (socket === current) disposeNativeCodexSessionStatus(); };
    const handshakeTimer = setTimeout(reset, 3000); handshakeTimer.unref();
    current.once("close", () => clearTimeout(handshakeTimer));
    current.on("error", reset); current.on("close", reset);
    current.on("connect", () => send({ type: "request", requestId: randomUUID(), sourceClientId: clientId,
      method: "initialize", params: { clientType: "codex-manager-status" }, timeoutMs: 3000 }));
    current.on("data", (data: Buffer) => {
      try {
        let offset = 0;
        while (offset < data.length) {
          if (!remaining) {
            const length = Math.min(4 - header.length, data.length - offset);
            header = Buffer.concat([header, data.subarray(offset, offset + length)]); offset += length;
            if (header.length < 4) continue;
            remaining = header.readUInt32LE(0); header = Buffer.alloc(0);
            if (!remaining || remaining > 64 * 1024 * 1024) { reset(); return; }
          }
          const length = Math.min(remaining, data.length - offset);
          chunks.push(data.subarray(offset, offset + length)); remaining -= length; offset += length;
          if (chunks.length > 16_384) { reset(); return; }
          if (!remaining) { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as NativeMessage; chunks = []; if (value?.type === "response" && value.method === "initialize" && typeof value.result?.clientId === "string") clearTimeout(handshakeTimer); receive(value); }
        }
      } catch { reset(); }
    });
  })();
  connecting = work;
  try { await work; } finally { if (connecting === work) connecting = undefined; }
}

/** Read native runtime state across windows; retained writer handles are not running turns. */
export async function readNativeCodexSessionRunning(home: string, id: string, signal?: AbortSignal): Promise<boolean | undefined> {
  signal?.throwIfAborted();
  const key = `${path.resolve(home)}:${id}`;
  let entry = observations.get(key);
  if (!entry) {
    if (observations.size >= 256) {
      const oldest = [...observations].filter(([, value]) => !value.waiters.size).sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
      if (!oldest) return undefined;
      follow(oldest[1], false); observations.delete(oldest[0]);
    }
    entry = { home: path.resolve(home), id, usedAt: Date.now(), waiters: new Set() }; observations.set(key, entry);
    if (clientId !== "initializing-client") follow(entry, true);
  }
  entry.usedAt = Date.now();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(disposeNativeCodexSessionStatus, 30_000); idleTimer.unref();
  await connect(home);
  if (!socket) { observations.delete(key); return undefined; }
  if (signal?.aborted) {
    if (!entry.waiters.size && entry.running === undefined) { follow(entry, false); observations.delete(key); }
    return undefined;
  }
  if (entry.running !== undefined) return entry.running;
  return new Promise(resolve => {
    let settled = false;
    const cleanup = (drop = false) => {
      if (settled) return;
      settled = true;
      entry!.waiters.delete(finish);
      if (drop && !entry!.waiters.size && entry!.running === undefined) {
        follow(entry!, false);
        if (observations.get(key) === entry) observations.delete(key);
      }
      signal?.removeEventListener("abort", abort);
    };
    const finish = (running: boolean | undefined) => { clearTimeout(timer); cleanup(); resolve(running); };
    const abort = () => { clearTimeout(timer); cleanup(true); resolve(undefined); };
    const timer = setTimeout(abort, 3000);
    entry!.waiters.add(finish);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
