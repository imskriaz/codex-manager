import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { recordNativeSessionStatus } from "./sessionRecording";
import { normalizeNativePath } from "../utils/nativePaths";
import { waitWithin } from "../utils/concurrency";

type Observation = {
  home: string; canonicalHome: string; id: string; owner?: string; revision?: number; running?: boolean; ready?: boolean; usedAt: number;
  waiters: Set<(running: boolean | undefined) => void>;
};
const observations = new Map<string, Observation>();
const readinessWaiters = new Map<string, number>();
let socket: net.Socket | undefined;
let connecting: Promise<void> | undefined;
let clientId = "initializing-client";
let connectionRevision = 0;
const requests = new Map<string, { resolve: (message: NativeMessage) => void; reject: (error: Error) => void; cleanup: () => void }>();

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
  if (following && clientId !== "initializing-client") send({ type: "request", requestId: randomUUID(), sourceClientId: clientId,
    method: "thread-owner-discovery", version: 1, timeoutMs: 3000, params: { hostId: "local", conversationId: entry.id } });
}
function settle(entry: Observation, running: boolean | undefined): void {
  entry.running = running;
  if (running === undefined) entry.ready = undefined;
  recordNativeSessionStatus(entry.home,entry.id,running);
  for (const resolve of entry.waiters) resolve(running);
  entry.waiters.clear();
}
function runtimeRunning(value: unknown): boolean | undefined {
  const type = value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
  return type === "active" ? true : type === "idle" || type === "notLoaded" || type === "systemError" ? false : undefined;
}
type NativeMessage = {
  type?: unknown; method?: unknown; version?: unknown; sourceClientId?: unknown; requestId?: string; resultType?: string; error?: unknown;
  result?: { clientId?: unknown; result?: { turn?: { id?: unknown } }; ok?: unknown; interruptedTurnId?: unknown; goalPauseError?: unknown };
  params?: { status?: unknown; clientId?: unknown; hostId?: unknown; conversationId?: unknown;
    change?: { type?: unknown; revision?: unknown; baseRevision?: unknown; patches?: unknown;
      conversationState?: { id?: unknown; rolloutPath?: unknown; threadRuntimeStatus?: unknown } } };
};
function receive(message: NativeMessage): void {
  if (message.type === "client-discovery-request") {
    send({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
    return;
  }
  if (message.type === "response" && message.requestId && requests.has(message.requestId)) {
    const request = requests.get(message.requestId)!;
    requests.delete(message.requestId); request.cleanup();
    if (message.resultType === "success") request.resolve(message);
    else request.reject(new Error("The Codex window did not accept the request. Open the conversation and retry.", { cause: message.error }));
    return;
  }
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
      const relative = path.relative(entry.canonicalHome, path.resolve(normalizeNativePath(state.rolloutPath)));
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) continue;
      if (entry.owner === message.sourceClientId && entry.revision !== undefined && change.revision <= entry.revision) continue;
      entry.owner = message.sourceClientId; entry.revision = change.revision;
      entry.ready = ["idle", "active"].includes(String((state.threadRuntimeStatus as { type?: unknown } | undefined)?.type));
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
          if (patch.path.length === 1) {
            entry.ready = patch.op !== "remove" && ["idle", "active"].includes(String((patch.value as { type?: unknown } | undefined)?.type));
            settle(entry, patch.op === "remove" ? undefined : runtimeRunning(patch.value));
          } else if (patch.path.length === 2 && patch.path[1] === "type") {
            entry.ready = patch.op !== "remove" && ["idle", "active"].includes(String(patch.value));
            settle(entry, patch.op === "remove" ? undefined : runtimeRunning({ type: patch.value }));
          }
        }
      }
    }
  }
}

export function getNativeCodexSessionRunning(home: string, id: string): boolean | undefined {
  const entry = socket ? observations.get(`${path.resolve(home)}:${id}`) : undefined;
  if (entry) entry.usedAt = Date.now();
  return entry?.running;
}

/** A published tab can still be loading; wait for its verified native runtime before recovery. */
export async function waitForNativeCodexSessionReady(home: string, id: string, signal?: AbortSignal, timeoutMs = 40_000): Promise<boolean | undefined> {
  const key = `${path.resolve(home)}:${id}`;
  readinessWaiters.set(key, (readinessWaiters.get(key) ?? 0) + 1);
  const deadline = Date.now() + timeoutMs;
  let rediscoverAt = 0;
  let connected = false;
  try {
    while (Date.now() < deadline) {
      await readNativeCodexSessionRunning(home, id, signal);
      signal?.throwIfAborted();
      const entry = observations.get(key);
      connected ||= Boolean(socket);
      if (entry?.ready) return true;
      if (socket && entry && Date.now() >= rediscoverAt) {
        // A resumed native owner can restart its revision sequence after notLoaded.
        entry.revision = undefined;
        follow(entry, true);
        rediscoverAt = Date.now() + 1_000;
      }
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
        const abort = () => { cleanup(); reject(signal?.reason instanceof Error ? signal.reason : new Error("Opening Codex was cancelled.")); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, 200);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    return connected ? false : undefined;
  } finally {
    const remaining = (readinessWaiters.get(key) ?? 1) - 1;
    if (remaining) readinessWaiters.set(key, remaining); else readinessWaiters.delete(key);
  }
}

export function disposeNativeCodexSessionStatus(): void {
  connectionRevision++;
  const old = socket; socket = undefined; clientId = "initializing-client";
  for (const request of requests.values()) { request.cleanup(); request.reject(new Error("The Codex owner disconnected. The request outcome is unconfirmed; check the conversation before retrying.")); }
  requests.clear();
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
      method: "initialize", version: 0, params: { clientType: "codex-manager-status" }, timeoutMs: 3000 }));
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

/** Send through the verified native owner; a missing owner is safe to fall back before sending. */
export async function startNativeCodexSessionTurn(home: string, id: string, turn: Record<string, unknown>, signal?: AbortSignal, onStarted?: (turnId: string) => void): Promise<boolean> {
  const reply = await requestNativeOwner(home, id, "thread-follower-start-turn", { conversationId: id, turnStart: { request: turn, context: { inheritThreadSettings: true } } }, signal);
  if (!reply) return false;
  const turnId = reply?.result?.result?.turn?.id;
  if (typeof turnId !== "string" || !turnId.trim() || turnId.length > 256)
    throw new Error("Codex did not confirm a started turn. The outcome is unconfirmed; check the conversation before retrying.");
  onStarted?.(turnId);
  return true;
}

/** Only the exact turn accepted from this caller may be interrupted. */
export async function cancelNativeCodexSessionTurn(home: string, id: string, expectedTurnId: string): Promise<boolean> {
  if (!expectedTurnId || expectedTurnId.length > 256) throw new Error("The turn to stop could not be verified. Refresh before retrying.");
  const reply = await requestNativeOwner(home, id, "thread-follower-interrupt-turn", { conversationId: id, mode: "user-stop", expectedTurnId });
  if (!reply) return false;
  if (reply.result?.ok !== true || reply.result.interruptedTurnId !== expectedTurnId) throw new Error("Codex did not confirm stopping this turn. It may have changed; refresh before retrying.");
  if (typeof reply.result.goalPauseError === "string" && reply.result.goalPauseError) throw new Error(`The turn stopped, but its goal could not pause: ${reply.result.goalPauseError}`);
  return true;
}

async function requestNativeOwner(home: string, id: string, method: "thread-follower-start-turn" | "thread-follower-interrupt-turn", params: Record<string, unknown>, signal?: AbortSignal): Promise<NativeMessage | undefined> {
  const running = await readNativeCodexSessionRunning(home, id, signal);
  signal?.throwIfAborted();
  const entry = observations.get(`${path.resolve(home)}:${id}`);
  if (!entry?.owner || running === undefined || !socket?.writable) return undefined;
  const canonicalHome = await waitWithin(fs.realpath(home), 1000, "Codex storage did not respond.", signal);
  if (path.resolve(normalizeNativePath(canonicalHome)) !== entry.canonicalHome) { entry.owner = undefined; settle(entry, undefined); return undefined; }
  if (!entry.owner || entry.running === undefined || !socket?.writable) return undefined;
  if (method === "thread-follower-start-turn" && !entry.ready) throw new Error("The Codex conversation is still loading. Wait for it to finish, then retry.");
  if (method === "thread-follower-start-turn" && entry.running) throw new Error("Codex is already working in this session. Refresh before sending another message.");
  if (requests.size >= 32 || socket.writableLength > 4 * 1024 * 1024) throw new Error("The Codex owner request queue is full. Wait before retrying.");
  const requestId = randomUUID();
  return new Promise<NativeMessage>((resolve, reject) => {
    const abort = () => fail(new Error("The request outcome is unconfirmed. Check Codex before retrying."));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const fail = (error: Error) => { requests.delete(requestId); cleanup(); reject(error); };
    const timer = setTimeout(() => fail(new Error("The Codex owner did not confirm the request. Check the conversation before retrying.")), 10_000);
    requests.set(requestId, { resolve, reject, cleanup });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      send({ type: "request", requestId, sourceClientId: clientId, method, version: method === "thread-follower-start-turn" ? 2 : 4,
        targetClientId: entry.owner, timeoutMs: 10_000,
        params });
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
}

/** Read native runtime state across windows; retained writer handles are not running turns. */
export async function readNativeCodexSessionRunning(home: string, id: string, signal?: AbortSignal): Promise<boolean | undefined> {
  signal?.throwIfAborted();
  const revision = connectionRevision;
  const key = `${path.resolve(home)}:${id}`;
  let entry = observations.get(key);
  if (!entry) {
    const canonicalHome = await waitWithin(fs.realpath(home), 1000, "Codex storage did not respond.", signal).catch(() => undefined);
    if (!canonicalHome) return undefined;
    if (revision !== connectionRevision) return undefined;
    signal?.throwIfAborted();
    entry = observations.get(key);
    if (!entry) {
      if (observations.size >= 256) {
        const oldest = [...observations].filter(([key, value]) => !value.waiters.size && !readinessWaiters.has(key))
          .sort((a, b) => Number(a[1].running === true)-Number(b[1].running === true) || a[1].usedAt-b[1].usedAt)[0];
        if (!oldest) return undefined;
        follow(oldest[1], false); observations.delete(oldest[0]);
      }
      entry = { home: path.resolve(home), canonicalHome: path.resolve(normalizeNativePath(canonicalHome)), id, usedAt: Date.now(), waiters: new Set() }; observations.set(key, entry);
    }
    if (clientId !== "initializing-client") follow(entry, true);
  }
  entry.usedAt = Date.now();
  await connect(home);
  if (revision !== connectionRevision) return undefined;
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
