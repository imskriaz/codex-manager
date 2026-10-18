import * as vscode from "vscode";
import { getCodexHome } from "../codex/authFile";
import { getSqliteStateStore } from "../storage/sqliteState";
import { currentSessionAccountId, initializeSessionStorage, listStoredSessionLive, pruneSessionCache, saveSessionLive, saveSessionStatus } from "../storage/sqliteSessions";
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
  if (!previous && pending.size >= 128) { warn(new Error("The session recording queue is full; an update could not be retained.")); return; }
  const serialized = JSON.stringify(state), bytes = Buffer.byteLength(serialized);
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
  if (!pendingStatus.has(key) && pendingStatus.size >= 1024) { warn(new Error("The session status recording queue is full.")); return; }
  pendingStatus.set(key,{home,id:id.toLowerCase(),status:running === undefined ? "unknown" : running ? "running" : "idle",at:Date.now()});
  if (!timer) schedule(250);
}

/** Discovery is optional background work; native status events share the same bounded writer. */
export function registerSessionRecording(context:vscode.ExtensionContext): void {
  const store = getSqliteStateStore();
  if (!store) return;
  const stopStorage = store.subscribe(["sessions"], () => {
    for (const state of listStoredSessionLive(store,getCodexHome())) {
      if (!isNewerCodexSessionLiveState(state,observed.get(state.sessionId))) continue;
      observed.set(state.sessionId,revision(state));
      if (observed.size > 30) observed.delete(observed.keys().next().value!);
      publishDashboardRealtime({type:"dashboard:codex-session-live",state});
    }
  });
  const controller = new AbortController();
  let inFlight = false, warnedScan = false;
  let lastCleanup = 0;
  const scan = async ():Promise<void> => {
    if (inFlight || controller.signal.aborted) return;
    inFlight = true;
    try {
      if (Date.now() - lastCleanup >= 60_000) {
        pruneSessionCache(store);
        lastCleanup = Date.now();
      }
      const sessions = await import("./codexSessionResume");
      const home = getCodexHome();
      if (!sessions.readRecentRunningCodexSessionIds(home))
        await runCrossWindowExclusive(`background:session-recording:${getCodexHomeStateKey(home)}`,"Session recording discovery",
          async signal => {
            if (!sessions.readRecentRunningCodexSessionIds(home))
              await sessions.readRunningCodexSessionIds(home,AbortSignal.any([controller.signal,signal]));
          },{background:true});
      warnedScan = false;
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof CrossWindowOperationBusyError) && !warnedScan) console.warn("[codexManager] session discovery recording delayed",error);
      warnedScan = true;
    } finally { inFlight = false; }
  };
  const start = setTimeout(() => { void scan(); },1_000);
  const interval = setInterval(() => { void scan(); },10_000);
  start.unref?.(); interval.unref?.();
  context.subscriptions.push({dispose:()=>{ controller.abort(); clearTimeout(start); clearInterval(interval); stopStorage(); observed.clear(); }});
}
