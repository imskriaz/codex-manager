import * as vscode from "vscode";
import { getCodexHome } from "../codex/authFile";
import { getSqliteStateStore } from "../storage/sqliteState";
import { currentSessionAccountId, saveSessionLive, saveSessionStatus } from "../storage/sqliteSessions";
import type { DashboardCodexSessionLiveState } from "../domain/dashboard/types";
import { isCodexSessionLiveState, isNewerCodexSessionLiveState } from "../domain/codexSessionLive";
import { publishDashboardRealtime } from "./dashboardRealtime";
import { runCrossWindowExclusive, CrossWindowOperationBusyError } from "../utils/crossWindowOperations";
import { getCodexHomeStateKey } from "../codex/authFile";

const pending = new Map<string,{ home:string; state:DashboardCodexSessionLiveState; accountId?:string }>();
let timer: NodeJS.Timeout | undefined;
let warned = false;
let retryStatusAt = 0;

function warn(error: unknown): void {
  console.warn("[codexManager] session recording delayed",error);
  if (warned) return;
  warned = true;
  const message = `Session recording is delayed; the latest snapshots will retry automatically. ${error instanceof Error ? error.message : String(error)}`;
  publishDashboardRealtime({ type:"dashboard:notice",level:"warning",message });
  void vscode.window.showWarningMessage(message);
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
  state = JSON.parse(JSON.stringify(state)) as DashboardCodexSessionLiveState;
  state.sessionId = state.sessionId.toLowerCase();
  state.streamId = state.streamId.toLowerCase();
  const home = getCodexHome(), key = JSON.stringify([getCodexHomeStateKey(home),state.deviceId ?? "",state.streamId]);
  const previous = pending.get(key);
  if (previous && !isNewerCodexSessionLiveState(state,previous.state)) return;
  if (!previous && pending.size >= 128) { warn(new Error("The session recording queue is full; an update could not be retained.")); return; }
  pending.set(key,{home,state,accountId:previous?.accountId ?? accountId});
  if (!timer) schedule(250);
}

function schedule(delay:number): void {
  timer = setTimeout(() => { timer = undefined; flushSessionRecording(); },delay);
  timer.unref?.();
}

export function flushSessionRecording(limit = 8): boolean {
  const store = getSqliteStateStore();
  if (!store) return pending.size === 0;
  let count = 0, failed = false;
  for (const [key,entry] of pending) {
    try { saveSessionLive(store,entry.home,entry.state,entry.accountId); }
    catch (error) { warn(error); failed = true; break; }
    pending.delete(key);
    if (++count >= limit) break;
  }
  if (!failed && !pending.size) warned = false;
  if (pending.size && !timer) schedule(failed ? 1_000 : 0);
  return pending.size === 0;
}

export function disposeSessionRecording(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (!flushSessionRecording(128)) console.warn("[codexManager] some session snapshots were not committed before shutdown; previously saved recovery remains available");
  if (timer) clearTimeout(timer);
  timer = undefined;
  pending.clear();
  warned = false;
  retryStatusAt = 0;
}

/** Native running checks are authoritative; their persistence must never delay a manual action. */
export function recordNativeSessionStatus(home:string,id:string,running:boolean|undefined): void {
  const store = getSqliteStateStore();
  if (!store || Date.now() < retryStatusAt) return;
  try { saveSessionStatus(store,home,id,running === undefined ? "unknown" : running ? "running" : "idle"); retryStatusAt = 0; }
  catch (error) { retryStatusAt = Date.now()+2_000; console.warn("[codexManager] session status recording delayed",error); }
}

/** Discovery is optional background work; native status events persist immediately once followed. */
export function registerSessionRecording(context:vscode.ExtensionContext): void {
  if (!getSqliteStateStore()) return;
  const controller = new AbortController();
  let inFlight = false, warnedScan = false;
  const scan = async ():Promise<void> => {
    if (inFlight || controller.signal.aborted) return;
    inFlight = true;
    try {
      const sessions = await import("./codexSessionResume");
      const home = getCodexHome();
      if (!sessions.readRecentRunningCodexSessionIds(home))
        await runCrossWindowExclusive(`background:session-recording:${getCodexHomeStateKey(home)}`,"Session recording discovery",
          async signal => { await sessions.readRunningCodexSessionIds(home,AbortSignal.any([controller.signal,signal])); },{background:true});
      warnedScan = false;
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof CrossWindowOperationBusyError) && !warnedScan) console.warn("[codexManager] session discovery recording delayed",error);
      warnedScan = true;
    } finally { inFlight = false; }
  };
  const start = setTimeout(() => { void scan(); },1_000);
  const interval = setInterval(() => { void scan(); },10_000);
  start.unref?.(); interval.unref?.();
  context.subscriptions.push({dispose:()=>{ controller.abort(); clearTimeout(start); clearInterval(interval); }});
}
