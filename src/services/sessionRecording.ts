import * as vscode from "vscode";
import * as fs from "node:fs";
import { getCodexHome } from "../codex/authFile";
import { getSqliteStateStore } from "../storage/sqliteState";
import { currentSessionAccountId, initializeSessionStorage, listStoredSessionLive, pruneSessionCache, readSessionDiscovery, readSessionStatuses, saveSessionLive, saveSessionStatus } from "../storage/sqliteSessions";
import type { DashboardCodexSessionLiveState } from "../domain/dashboard/types";
import { isCodexSessionLiveState, isNewerCodexSessionLiveState } from "../domain/codexSessionLive";
import { publishDashboardRealtime } from "./dashboardRealtime";
import { runCrossWindowExclusive, CrossWindowOperationBusyError } from "../utils/crossWindowOperations";
import { getCodexHomeStateKey } from "../codex/authFile";

const pending = new Map<string,{ home:string; state:DashboardCodexSessionLiveState; accountId?:string; bytes:number }>();
let pendingBytes = 0;
let timer: NodeJS.Timeout | undefined;
let warned = false;
const pendingStatus = new Map<string,{home:string;id:string;status:"running"|"idle"|"unknown";at:number}>();
type Revision = Pick<DashboardCodexSessionLiveState,"sessionId"|"deviceId"|"streamId"|"sequence"|"updatedAt"|"status">;
const observed = new Map<string,Revision>();
const revision = ({sessionId,deviceId,streamId,sequence,updatedAt,status}:DashboardCodexSessionLiveState):Revision => ({sessionId,deviceId,streamId,sequence,updatedAt,status});

function evictOldestLive(skipKey?: string): boolean {
  const terminal = [...pending.entries()].find(([key, entry]) => key !== skipKey && ["completed", "failed", "cancelled", "disconnected"].includes(entry.state.status));
  const entry = terminal ?? [...pending.entries()].find(([key]) => key !== skipKey);
  if (!entry) return false;
  pending.delete(entry[0]);
  pendingBytes -= entry[1].bytes;
  return true;
}

function evictOldestStatus(): void {
  const idle = [...pendingStatus.entries()].find(([, entry]) => entry.status !== "running");
  const entry = idle ?? [...pendingStatus.entries()][0];
  if (entry) pendingStatus.delete(entry[0]);
}

function warn(error: unknown): void {
  console.warn("[codexManager] session recording delayed",error);
  if (warned) return;
  warned = true;
}

export function captureSessionAccount(): string | undefined {
  const store = getSqliteStateStore();
  try { return store ? currentSessionAccountId(store,getCodexHome()) : undefined; }
  catch (error) { warn(error); return undefined; }
}

/** Keep the newest bounded snapshot per turn while storage is unavailable. */
export function recordSessionLive(state:DashboardCodexSessionLiveState,accountId?:string): void {
  if (!getSqliteStateStore()) return;
  if (!isCodexSessionLiveState(state)) { warn(new Error("Invalid live session snapshot.")); return; }
  state = { ...state, sessionId: state.sessionId.toLowerCase(), streamId: state.streamId.toLowerCase() };
  const home = getCodexHome(), key = JSON.stringify([getCodexHomeStateKey(home),state.deviceId ?? "",state.streamId]);
  const previous = pending.get(key);
  if (previous && !isNewerCodexSessionLiveState(state,previous.state)) return;
  const serialized = JSON.stringify(state), bytes = Buffer.byteLength(serialized);
  if (bytes > 8 * 1024 * 1024) { warn(new Error("The session recording byte limit was reached; an update could not be retained.")); return; }
  let evicted = false, byteEvicted = false;
  while ((!previous && pending.size >= 128) || pendingBytes - (previous?.bytes ?? 0) + bytes > 8 * 1024 * 1024) {
    if (pendingBytes - (previous?.bytes ?? 0) + bytes > 8 * 1024 * 1024) byteEvicted = true;
    if (!evictOldestLive(previous ? key : undefined)) break;
    evicted = true;
  }
  if (evicted) warn(new Error("The session recording queue is full; older queued updates were evicted to retain the newest state."));
  if (byteEvicted) warn(new Error("The session recording byte limit was reached; older queued updates were evicted to retain the newest state."));
  if (pendingBytes - (previous?.bytes ?? 0) + bytes > 8 * 1024 * 1024) { warn(new Error("The session recording byte limit was reached; an update could not be retained.")); return; }
  state = JSON.parse(serialized) as DashboardCodexSessionLiveState;
  pendingBytes += bytes - (previous?.bytes ?? 0);
  pending.set(key,{home,state,accountId:previous?.accountId ?? accountId,bytes});
  if (!state.deviceId) {
    observed.set(state.sessionId,revision(state));
    if (observed.size > 30) observed.delete(observed.keys().next().value!);
  }
  if (!timer) schedule(250);
}

function schedule(delay:number): void {
  timer = setTimeout(() => { timer = undefined; flushSessionRecording(); },delay);
  timer.unref?.();
}

export function flushSessionRecording(limit = 8): boolean {
  const store = getSqliteStateStore();
  if (!store) return pending.size === 0 && pendingStatus.size === 0;
  const states = [...pending].slice(0,limit), statuses = [...pendingStatus].slice(0,limit >= 128 ? 1024 : 64);
  let failed = false;
  if (states.length || statuses.length) {
    try {
      initializeSessionStorage(store);
      store.transaction(() => {
        for (const [,entry] of states) saveSessionLive(store,entry.home,entry.state,entry.accountId);
        for (const [,entry] of statuses) saveSessionStatus(store,entry.home,entry.id,entry.status,entry.at);
      });
      for (const [key,entry] of states) if (pending.get(key) === entry) { pending.delete(key); pendingBytes -= entry.bytes; }
      for (const [key,entry] of statuses) if (pendingStatus.get(key) === entry) pendingStatus.delete(key);
    } catch (error) { warn(error); failed = true; }
  }
  const empty = pending.size === 0 && pendingStatus.size === 0;
  if (!failed && empty) warned = false;
  if (!empty && !timer) schedule(failed ? 1_000 : 0);
  return empty;
}

export function disposeSessionRecording(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (!flushSessionRecording(128)) console.warn("[codexManager] some session snapshots were not committed before shutdown; previously saved recovery remains available");
  if (timer) clearTimeout(timer);
  timer = undefined;
  pending.clear();
  pendingBytes = 0;
  warned = false;
  pendingStatus.clear();
  observed.clear();
}

/** Native running checks are authoritative; their persistence must never delay a manual action. */
export function recordNativeSessionStatus(home:string,id:string,running:boolean|undefined): void {
  if (!getSqliteStateStore()) return;
  const key = JSON.stringify([getCodexHomeStateKey(home),id.toLowerCase()]);
  if (!pendingStatus.has(key) && pendingStatus.size >= 1024) {
    warn(new Error("The session status recording queue is full; the oldest queued status was evicted to retain the newest state."));
    evictOldestStatus();
  }
  pendingStatus.set(key,{home,id:id.toLowerCase(),status:running === undefined ? "unknown" : running ? "running" : "idle",at:Date.now()});
  if (!timer) schedule(250);
}

/** Discovery is optional background work; native status events share the same bounded writer. */
export function registerSessionRecording(context:vscode.ExtensionContext): void {
  const store = getSqliteStateStore();
  if (!store) return;
  const controller = new AbortController();
  const home = getCodexHome();
  let inFlight = false, warnedScan = false, lastCleanup = 0, lastScan = 0, fullDueAt = 0;
  let scanTimer: NodeJS.Timeout | undefined, timerAt = Infinity;
  let knownRunning = new Set<string>();
  const dirty = new Set<string>();
  const schedule = (delay: number): void => {
    if (controller.signal.aborted) return;
    const at = Date.now() + Math.max(500, delay);
    if (scanTimer && timerAt <= at) return;
    if (scanTimer) clearTimeout(scanTimer);
    timerAt = at;
    scanTimer = setTimeout(() => { scanTimer = undefined; timerAt = Infinity; void scan(); }, Math.max(0, at - Date.now()));
    scanTimer.unref?.();
  };
  const stopStorage = store.subscribe(["sessions", "session-status"], topics => {
    if (topics.has("sessions")) for (const state of listStoredSessionLive(store,home)) {
      if (!isNewerCodexSessionLiveState(state,observed.get(state.sessionId))) continue;
      observed.set(state.sessionId,revision(state));
      if (observed.size > 30) observed.delete(observed.keys().next().value!);
      publishDashboardRealtime({type:"dashboard:codex-session-live",state});
    }
    if (topics.has("session-status")) {
      for (const [id,status] of readSessionStatuses(store,home)) {
        if (status === "running" || status === "starting") knownRunning.add(id);
        else if (status === "idle") knownRunning.delete(id);
      }
      if (knownRunning.size) schedule(10_000);
    }
  });
  const scan = async ():Promise<void> => {
    if (inFlight || controller.signal.aborted) return;
    inFlight = true;
    lastScan = Date.now();
    const changed = [...dirty]; dirty.clear();
    let failed = false;
    try {
      if (Date.now() - lastCleanup >= 60_000) { pruneSessionCache(store); lastCleanup = Date.now(); }
      const sessions = await import("./codexSessionResume");
      const shared = readSessionDiscovery(store,home);
      if (!changed.length && shared && Date.now() - shared.checkedAt < 5_000) {
        knownRunning = new Set(shared.ids);
        fullDueAt = shared.checkedAt + 60_000;
      } else {
        const full = Date.now() >= fullDueAt;
        const ids = full ? undefined : [...new Set([...knownRunning, ...changed])];
        if (full || ids?.length) await runCrossWindowExclusive(`background:session-recording:${getCodexHomeStateKey(home)}`,"Session recording discovery", async signal => {
          const peer = readSessionDiscovery(store,home);
          if (!changed.length && peer && Date.now() - peer.checkedAt < 5_000) {
            knownRunning = new Set(peer.ids); fullDueAt = peer.checkedAt + 60_000; return;
          }
          const running = await sessions.readRunningCodexSessionIds(home,AbortSignal.any([controller.signal,signal]),ids);
          knownRunning = new Set(running);
          if (full) fullDueAt = Date.now() + 60_000;
        },{background:true});
      }
      warnedScan = false;
    } catch (error) {
      failed = true;
      for (const id of changed) dirty.add(id);
      if (!controller.signal.aborted && !(error instanceof CrossWindowOperationBusyError) && !warnedScan) console.warn("[codexManager] session discovery recording delayed",error);
      warnedScan = true;
    } finally {
      inFlight = false;
      schedule(failed || knownRunning.size || dirty.size ? 10_000 : Math.max(1_000, fullDueAt - Date.now()));
    }
  };
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(home, { recursive: true }, (_event, filename) => {
      const name = String(filename ?? "").replace(/\\/g, "/");
      if (name && !/^(?:sessions\/|archived_sessions\/|thread-writer-locks\/|session_index\.jsonl$|state_\d+\.sqlite(?:-wal)?$)/i.test(name)) return;
      const id = name.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)?.[0]?.toLowerCase();
      if (id && dirty.size < 500) { dirty.add(id); schedule(10_000 - (Date.now() - lastScan)); }
      else { fullDueAt = Math.min(fullDueAt, Date.now() + 30_000); schedule(30_000); }
    });
    watcher.on("error", () => { watcher?.close(); watcher = undefined; });
    watcher.unref();
  } catch { /* The bounded idle scan also covers unsupported watchers and offline storage. */ }
  schedule(1_000);
  context.subscriptions.push({dispose:()=>{ controller.abort(); if (scanTimer) clearTimeout(scanTimer); watcher?.close(); stopStorage(); observed.clear(); }});
}
