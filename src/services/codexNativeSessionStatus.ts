import { saveCodexSessionAccess } from './codexSessionAccessState';
import { parseCodexSessionAccess, type CodexSessionAccess } from '../domain/codexSessionAccess';
import { publishDashboardRealtime } from './dashboardRealtime';
import { MAX_CHAT_WIRE_BYTES } from "../domain/chatAttachments";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { recordNativeSessionStatus } from "./sessionRecording";
import { normalizeNativePath } from "../utils/nativePaths";
import { waitWithin } from "../utils/concurrency";
import type { AppServerRequest } from "./codexAppServerRpc";
import { clearNativeCodexPrompts, CodexPromptNotSentError, syncNativeCodexPrompts } from "./codexAppServerPrompts";

type Observation = {
  home: string; canonicalHome: string; id: string; owner?: string; revision?: number; running?: boolean; ready?: boolean; turnId?: string; needsTurnSnapshot?: boolean; usedAt: number; verifiedAt?: number;
  access?: CodexSessionAccess; threadSettings?: unknown; accessWaiters?: Set<() => void>;
  prompts?: AppServerRequest[];
  promptResponses?: Map<string, Promise<void>>;
  waiters: Set<(running: boolean | undefined) => void>;
};
const observations = new Map<string, Observation>();
const NATIVE_STATUS_LEASE_MS = 15_000;
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
  entry.running = running; entry.verifiedAt = Date.now();
  if (running !== true) entry.turnId = undefined;
  if (running === undefined) { entry.ready = undefined; entry.access = undefined; }
  if (running === undefined) entry.threadSettings = undefined;
  for (const changed of entry.accessWaiters ?? []) changed();
  recordNativeSessionStatus(entry.home,entry.id,running);
  for (const resolve of entry.waiters) resolve(running);
  entry.waiters.clear();
}
function runtimeRunning(value: unknown): boolean | undefined {
  const type = value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
  return type === "active" ? true : type === "idle" || type === "notLoaded" || type === "systemError" ? false : undefined;
}
type NativeConversationState = {
  id?: unknown; rolloutPath?: unknown; threadRuntimeStatus?: unknown; requests?: unknown;
  latestThreadSettings?: unknown;
  turns?: unknown; turnHistory?: { kind?: unknown; history?: { entitiesByKey?: unknown; islands?: Array<{ newerBoundary?: { status?: unknown }; entries?: Array<{ value?: unknown }> }> } };
};

function activeNativeTurnId(state: NativeConversationState): string | undefined {
  let turns = state.turns;
  if (state.turnHistory?.kind === "canonical") {
    const history = state.turnHistory.history;
    const island = Array.isArray(history?.islands) ? history.islands.at(-1) : undefined;
    if (island?.newerBoundary?.status !== "exhausted" || !Array.isArray(island.entries) ||
        !history?.entitiesByKey || typeof history.entitiesByKey !== "object" || Array.isArray(history.entitiesByKey)) return undefined;
    const entities = history.entitiesByKey as Record<string, unknown>;
    turns = island.entries.map(entry => typeof entry?.value === "string" && Object.hasOwn(entities, entry.value) ? entities[entry.value] : undefined);
    if ((turns as unknown[]).some(turn => turn === undefined)) return undefined;
  }
  if (!Array.isArray(turns)) return undefined;
  const turn = turns.at(-1) as { status?: unknown; turnId?: unknown } | null;
  return turn?.status === "inProgress" && typeof turn.turnId === "string" && turn.turnId.trim() && turn.turnId.length <= 256 ? turn.turnId : undefined;
}

type NativeMessage = {
  type?: unknown; method?: unknown; version?: unknown; sourceClientId?: unknown; requestId?: string; resultType?: string; error?: unknown;
  result?: { clientId?: unknown; result?: { turn?: { id?: unknown }; turnId?: unknown }; ok?: unknown; applied?: unknown; interruptedTurnId?: unknown; goalPauseError?: unknown };
  params?: { status?: unknown; clientId?: unknown; hostId?: unknown; conversationId?: unknown;
    change?: { type?: unknown; revision?: unknown; baseRevision?: unknown; patches?: unknown;
      conversationState?: NativeConversationState } };
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
  if (message.method === "ipc-connection-reset") { disposeNativeCodexSessionStatus(); return; }
  if (message.method === "client-status-changed" && message.params?.status === "disconnected") {
    for (const entry of observations.values()) if (entry.owner === message.params.clientId) {
      clearNativeCodexPrompts(entry); entry.prompts = undefined;
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
      if (entry.owner === message.sourceClientId && entry.revision !== undefined && (change.revision < entry.revision || change.revision === entry.revision && !entry.needsTurnSnapshot)) continue;
      if (entry.owner !== message.sourceClientId) { clearNativeCodexPrompts(entry); entry.promptResponses = undefined; }
      entry.owner = message.sourceClientId; entry.revision = change.revision;
      updateAccess(entry, parseCodexSessionAccess(state.latestThreadSettings), state.latestThreadSettings);
      entry.turnId = activeNativeTurnId(state); entry.needsTurnSnapshot = false;
      entry.prompts = readNativePrompts(state.requests, entry.id);
      for (const key of entry.promptResponses?.keys() ?? []) if (!entry.prompts.some(request => JSON.stringify(request) === key)) entry.promptResponses?.delete(key);
      syncPrompts(entry);
      entry.ready = ["idle", "active"].includes(String((state.threadRuntimeStatus as { type?: unknown } | undefined)?.type));
      settle(entry, runtimeRunning(state.threadRuntimeStatus));
    } else if (change.type === "patches" && entry.owner === message.sourceClientId) {
      if (entry.revision !== undefined && change.revision <= entry.revision) continue;
      if (entry.revision !== change.baseRevision || !Array.isArray(change.patches)) {
        clearNativeCodexPrompts(entry); entry.prompts = undefined;
        entry.revision = undefined; settle(entry, undefined); follow(entry, false); follow(entry, true); continue;
      }
      entry.revision = change.revision;
      for (const value of change.patches as unknown[]) {
        if (!value || typeof value !== "object") continue;
        const patch = value as { path?: unknown; op?: unknown; value?: unknown };
        if (!Array.isArray(patch.path)) continue;
        if (!patch.path.length) { clearNativeCodexPrompts(entry); entry.prompts = undefined; entry.revision = undefined; settle(entry, undefined); follow(entry, false); follow(entry, true); break; }
        if (patch.path[0] === "id" || patch.path[0] === "rolloutPath") {
          clearNativeCodexPrompts(entry); entry.owner = undefined; entry.revision = undefined; settle(entry, undefined); follow(entry, true); break;
        }
        if (patch.path[0] === "turns" && (patch.path.length <= 2 || ["turnId", "status"].includes(String(patch.path[2]))) ||
            patch.path[0] === "turnHistory" && !(patch.path[1] === "history" && patch.path[2] === "entitiesByKey" && patch.path.length > 4 && !["turnId", "status"].includes(String(patch.path[4])))) {
          entry.turnId = undefined;
        }
        if (patch.path[0] === 'latestThreadSettings') {
          if (patch.path.length === 1) updateAccess(entry, patch.op === 'remove' ? undefined : parseCodexSessionAccess(patch.value), patch.value);
          else if (!applySettingsPatch(entry, patch)) { entry.access = undefined; entry.threadSettings = undefined; entry.needsTurnSnapshot = true; follow(entry, true); }
        }
        if (patch.path[0] === "requests") {
          if (!applyPromptPatch(entry, patch)) {
            clearNativeCodexPrompts(entry); entry.prompts = undefined; entry.revision = undefined;
            follow(entry, false); follow(entry, true); break;
          }
          syncPrompts(entry);
        }
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
      if (entry.running === true && !entry.turnId && !entry.needsTurnSnapshot) { entry.needsTurnSnapshot = true; follow(entry, true); }
    }
  }
}

function updateAccess(entry: Observation, access: CodexSessionAccess | undefined, settings?: unknown): void {
  entry.threadSettings = settings && JSON.stringify(settings).length <= 64_000 ? structuredClone(settings) : undefined;
  if (JSON.stringify(access && { ...access, updatedAt: 0 }) === JSON.stringify(entry.access && { ...entry.access, updatedAt: 0 })) return;
  if (access) access = { ...access, updatedAt: Math.max(access.updatedAt, (entry.access?.updatedAt ?? 0) + 1) };
  entry.access = access;
  for (const changed of entry.accessWaiters ?? []) changed();
  if (access) saveCodexSessionAccess(entry.home,entry.id,access,settings);
  if (access) publishDashboardRealtime({ type: 'dashboard:codex-session-access', sessionId: entry.id, access });
}
export function getNativeCodexSessionAccess(home: string, id: string): CodexSessionAccess | undefined {
  const entry = observations.get(`${path.resolve(home)}:${id}`);
  return socket?.writable && entry?.owner && entry.ready && entry.revision !== undefined ? entry.access : undefined;
}
export async function updateNativeCodexSessionAccess(home: string, id: string, settings: Record<string, unknown>): Promise<boolean> {
  await readNativeCodexSessionRunning(home, id);
  const entry = observations.get(`${path.resolve(home)}:${id}`), owner = entry?.owner, revision = connectionRevision;
  const expected = parseCodexSessionAccess(settings);
  if (!expected?.mode) throw new Error('The requested access mode is invalid.');
  let changed!: () => void;
  const initialAccess = entry?.access;
  const confirmation = new Promise<void>(resolve => { changed = () => { if (!socket?.writable || entry?.owner !== owner || entry?.access !== initialAccess) resolve(); }; });
  if (entry) (entry.accessWaiters ??= new Set()).add(changed);
  try {
    const reply = await requestNativeOwner(home, id, 'thread-follower-update-thread-settings', { conversationId: id, threadSettings: settings });
    if (!reply) return false;
    if (entry?.owner !== owner || connectionRevision !== revision || observations.get(`${path.resolve(home)}:${id}`) !== entry) throw new Error('The Codex owner changed while applying access. Refresh before changing it again.');
    if (reply.result?.applied !== true) throw new Error('Codex did not confirm the access change. Refresh its settings before retrying.');
    if (entry?.access?.mode !== expected.mode) await waitWithin(confirmation, 3000, 'Codex did not report its applied permissions. Refresh before retrying.');
    if (!socket?.writable || entry?.owner !== owner || connectionRevision !== revision || entry?.access?.mode !== expected.mode) throw new Error('Codex permissions changed or could not be confirmed. Refresh before retrying.');
    return true;
  } finally { entry?.accessWaiters?.delete(changed); }
}

function applySettingsPatch(entry: Observation, patch: { path?: unknown; op?: unknown; value?: unknown }): boolean {
  const keys = (patch.path as unknown[]).slice(1);
  if (!entry.threadSettings || keys.length > 8 || keys.some(key => typeof key !== 'string' && typeof key !== 'number' || ['__proto__','constructor','prototype'].includes(String(key))) || !['add','replace','remove'].includes(String(patch.op))) return false;
  const settings = structuredClone(entry.threadSettings);
  let target: unknown = settings;
  for (const key of keys.slice(0,-1)) {
    if (!target || typeof target !== 'object' || !Object.hasOwn(target,key as string)) return false;
    target = (target as Record<string, unknown>)[String(key)];
  }
  const key = keys.at(-1) as string | number;
  if (!target || typeof target !== 'object') return false;
  if (Array.isArray(target)) {
    if (!Number.isInteger(key) || Number(key) < 0 || Number(key) > target.length || patch.op !== 'add' && Number(key) === target.length) return false;
    if (patch.op === 'add') target.splice(Number(key),0,patch.value);
    else if (patch.op === 'remove') target.splice(Number(key),1);
    else target[Number(key)] = patch.value;
  } else {
    const fields = target as Record<string, unknown>;
    if (patch.op !== 'add' && !Object.hasOwn(fields,key)) return false;
    if (patch.op === 'remove') delete fields[String(key)]; else fields[String(key)] = patch.value;
  }
  updateAccess(entry,parseCodexSessionAccess(settings),settings);
  return true;
}

export function getNativeCodexSessionTurnId(home: string, id: string): string | undefined {
  const entry = socket?.writable ? observations.get(`${path.resolve(home)}:${id}`) : undefined;
  return entry?.owner && entry.revision !== undefined && entry.ready && entry.running === true ? entry.turnId : undefined;
}

export function getNativeCodexSessionRunning(home: string, id: string): boolean | undefined {
  const entry = socket ? observations.get(`${path.resolve(home)}:${id}`) : undefined;
  if (entry) entry.usedAt = Date.now();
  return entry?.verifiedAt !== undefined && Date.now() - entry.verifiedAt < NATIVE_STATUS_LEASE_MS ? entry.running : undefined;
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
      await waitWithin(readNativeCodexSessionRunning(home, id, signal), Math.max(1, deadline - Date.now()), 'Native readiness check timed out.', signal).catch(error => {
        signal?.throwIfAborted(); if (Date.now() < deadline) throw error;
      });
      signal?.throwIfAborted();
      if (Date.now() >= deadline) break;
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
  for (const entry of observations.values()) { clearNativeCodexPrompts(entry); settle(entry, undefined); }
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
            if (!remaining || remaining > MAX_CHAT_WIRE_BYTES) { reset(); return; }
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
export async function cancelNativeCodexSessionTurn(home: string, id: string, expectedTurnId: string, onStopped?: () => void): Promise<boolean> {
  if (!expectedTurnId || expectedTurnId.length > 256) throw new Error("The turn to stop could not be verified. Refresh before retrying.");
  await readNativeCodexSessionRunning(home, id);
  const entry = observations.get(`${path.resolve(home)}:${id}`);
  const owner = entry?.owner, revision = entry?.revision;
  const reply = await requestNativeOwner(home, id, "thread-follower-interrupt-turn", { conversationId: id, mode: "user-stop", expectedTurnId });
  if (!reply) return false;
  if (reply.result?.ok !== true || reply.result.interruptedTurnId !== expectedTurnId) throw new Error("Codex did not confirm stopping this turn. It may have changed; refresh before retrying.");
  // A late acknowledgement must never overwrite a newer owner's runtime state.
  if (entry && observations.get(`${path.resolve(home)}:${id}`) === entry && entry.owner === owner && entry.revision === revision) settle(entry, false);
  onStopped?.();
  if (typeof reply.result.goalPauseError === "string" && reply.result.goalPauseError) throw new Error(`The turn stopped, but its goal could not pause: ${reply.result.goalPauseError}`);
  return true;
}

export async function steerNativeCodexSessionTurn(home: string, id: string, expectedTurnId: string, input: unknown[], cwd: string): Promise<boolean> {
  if (!expectedTurnId.trim() || expectedTurnId.length > 256) throw new Error('The active turn could not be verified. Refresh before steering.');
  await readNativeCodexSessionRunning(home, id);
  const key = `${path.resolve(home)}:${id}`, entry = observations.get(key), owner = entry?.owner, revision = connectionRevision;
  if (!entry?.ready || !entry.running) throw new Error('The active Codex turn finished or is unavailable. Your follow-up was not sent; refresh before retrying.');
  if (getNativeCodexSessionTurnId(home, id) !== expectedTurnId) throw new Error('The active Codex turn changed or could not be verified. Your follow-up was not sent; refresh before retrying.');
  const messageId = randomUUID();
  const reply = await requestNativeOwner(home, id, 'thread-follower-steer-turn', {
    conversationId: id, input, clientUserMessageId: messageId,
    restoreMessage: { id: messageId, cwd, context: { workspaceRoots: [cwd] } }
  }, undefined, () => observations.get(key) === entry && connectionRevision === revision && entry.owner === owner && getNativeCodexSessionTurnId(home, id) === expectedTurnId);
  if (!reply) return false;
  // Native follower v1 may hand guidance to a newer turn; a valid acceptance must not be replayed.
  const acceptedTurnId = reply.result?.result?.turnId;
  if (typeof acceptedTurnId !== "string" || !acceptedTurnId.trim() || acceptedTurnId.length > 256)
    throw new Error('Codex did not confirm guidance. The outcome is unconfirmed; check the conversation before retrying.');
  return true;
}

async function requestNativeOwner(home: string, id: string, method: "thread-follower-start-turn" | "thread-follower-interrupt-turn" | 'thread-follower-steer-turn' | 'thread-follower-update-thread-settings' | NativePromptMethod, params: Record<string, unknown>, signal?: AbortSignal, verify?: () => boolean, onSent?: () => void): Promise<NativeMessage | undefined> {
  const running = await readNativeCodexSessionRunning(home, id, signal);
  signal?.throwIfAborted();
  const entry = observations.get(`${path.resolve(home)}:${id}`);
  if (!entry?.owner || running === undefined || !socket?.writable) return undefined;
  const canonicalHome = await waitWithin(fs.realpath(home), 1000, "Codex storage did not respond.", signal);
  if (path.resolve(normalizeNativePath(canonicalHome)) !== entry.canonicalHome) { clearNativeCodexPrompts(entry); entry.prompts = undefined; entry.owner = undefined; settle(entry, undefined); return undefined; }
  if (!entry.owner || entry.running === undefined || !socket?.writable) return undefined;
  if (verify && !verify()) throw new Error("The Codex request or owner changed. Refresh before responding.");
  if (["thread-follower-start-turn", "thread-follower-update-thread-settings"].includes(method) && !entry.ready) throw new Error("The Codex conversation is still loading. Wait for it to finish, then retry.");
  if (method === "thread-follower-start-turn" && entry.running) throw new Error("Codex is already working in this session. Refresh before sending another message.");
  if (method === 'thread-follower-steer-turn' && (!entry.ready || !entry.running)) throw new Error('The active Codex turn finished or is unavailable. Your follow-up was not sent; refresh before retrying.');
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
      send({ type: "request", requestId, sourceClientId: clientId, method, version: method === "thread-follower-start-turn" || method === "thread-follower-update-thread-settings" ? 2 : method === 'thread-follower-interrupt-turn' ? 4 : 1,
        targetClientId: entry.owner, timeoutMs: 10_000,
        params });
      onSent?.();
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
}

type NativePromptMethod = "thread-follower-command-approval-decision" | "thread-follower-file-approval-decision" | "thread-follower-permissions-request-approval-response" | "thread-follower-submit-user-input";
const nativePromptMethods: Record<string, NativePromptMethod> = {
  "item/commandExecution/requestApproval": "thread-follower-command-approval-decision",
  "item/fileChange/requestApproval": "thread-follower-file-approval-decision",
  "item/permissions/requestApproval": "thread-follower-permissions-request-approval-response",
  "item/tool/requestUserInput": "thread-follower-submit-user-input"
};
function readNativePrompts(value: unknown, threadId: string): AppServerRequest[] {
  if (!Array.isArray(value) || value.length > 64) return [];
  return value.filter((value): value is AppServerRequest => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const request = value as Record<string, unknown>;
    const id = request["id"], method = request["method"], params = request["params"];
    return (typeof id === "string" && id.length <= 256 || typeof id === "number" && Number.isSafeInteger(id))
      && typeof method === "string" && Object.hasOwn(nativePromptMethods, method)
      && !!params && typeof params === "object" && !Array.isArray(params)
      && (params as Record<string, unknown>)["threadId"] === threadId;
  });
}
function syncPrompts(entry: Observation): void {
  const owner = entry.owner, revision = entry.revision;
  syncNativeCodexPrompts(entry, entry.id, entry.prompts ?? [], (request, result) => {
    const key = JSON.stringify(request);
    const previous = entry.promptResponses?.get(key);
    if (previous) return previous;
    let sent = false;
    const responding = (async () => {
    const verify = () => observations.get(`${entry.home}:${entry.id}`) === entry && entry.owner === owner &&
      revision !== undefined && entry.revision !== undefined && entry.revision >= revision &&
      entry.prompts?.some(current => JSON.stringify(current) === JSON.stringify(request)) === true;
    if (!verify()) throw new Error("The Codex request or owner changed. Refresh before responding.");
    const method = nativePromptMethods[request.method]!;
    const response = result as { decision?: unknown };
    const reply = await requestNativeOwner(entry.home, entry.id, method, {
      conversationId: entry.id, requestId: request.id,
      ...(method.endsWith("-decision") ? { decision: response.decision } : { response: result })
    }, undefined, verify, () => { sent = true; });
    if (!reply || reply.result?.ok !== true) throw new Error("Codex did not confirm this answer. Check the original conversation before retrying.");
    })().catch(error => {
      if (!sent) { entry.promptResponses?.delete(key); throw new CodexPromptNotSentError(error instanceof Error ? error.message : String(error)); }
      throw error;
    });
    (entry.promptResponses ??= new Map()).set(key, responding);
    return responding;
  });
}
function applyPromptPatch(entry: Observation, patch: { path?: unknown; op?: unknown; value?: unknown }): boolean {
  const path = patch.path as unknown[];
  if (path.length === 1) {
    if (patch.op !== "remove" && !Array.isArray(patch.value)) return false;
    entry.prompts = readNativePrompts(patch.op === "remove" ? [] : patch.value, entry.id); return true;
  }
  // Nested patches require a fresh snapshot: filtered request indexes cannot be trusted.
  return false;
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
        clearNativeCodexPrompts(oldest[1]); follow(oldest[1], false); observations.delete(oldest[0]);
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
  if (entry.running !== undefined && entry.verifiedAt !== undefined && Date.now() - entry.verifiedAt < NATIVE_STATUS_LEASE_MS) return entry.running;
  if (entry.running !== undefined) {
    // Refresh missed completion events without trusting a retained writer handle.
    entry.needsTurnSnapshot = true; settle(entry, undefined); follow(entry, true);
  }
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
