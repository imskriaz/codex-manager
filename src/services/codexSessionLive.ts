import { randomUUID } from "node:crypto";
import type { DashboardCliSessionMessage, DashboardCodexSessionLiveState } from "../domain/dashboard/types";
import { CodexSessionLiveReducer } from "../domain/codexSessionLive";
import type { CodexAppServerRpc } from "./codexAppServerRpc";
import { publishDashboardRealtime } from "./dashboardRealtime";

const MAX_STREAMS = 30;
const TERMINAL_TTL_MS = 5 * 60_000;
const activeSlots = new Set<string>();
const streams = new Map<string, { reducer: CodexSessionLiveReducer; timer?: NodeJS.Timeout; finishedAt?: number }>();

export function getCodexSessionLiveState(sessionId: string): DashboardCodexSessionLiveState | undefined {
  prune();
  return streams.get(sessionId.toLowerCase())?.reducer.snapshot();
}

export function listCodexSessionLiveStates(): DashboardCodexSessionLiveState[] {
  prune();
  return [...streams.values()].map((stream) => stream.reducer.snapshot());
}

/** Reserve capacity before thread/start or turn/start can mutate the provider. */
export function reserveCodexSessionLive() {
  prune();
  if (activeSlots.size >= MAX_STREAMS) throw new Error("Codex Manager is already managing 30 turns. Stop a turn or wait for it to finish before starting another.");
  const streamId = randomUUID();
  activeSlots.add(streamId);
  let sessionId: string | undefined;
  let entry: ReturnType<typeof streams.get>;
  let off: (() => void) | undefined;
  let offDisconnect: (() => void) | undefined;
  let disposed = false;
  const flush = () => {
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    publishDashboardRealtime({ type: "dashboard:codex-session-live", state: entry.reducer.snapshot() });
  };
  return {
    attach(id: string, rpc: CodexAppServerRpc, parseItems: (value: unknown) => DashboardCliSessionMessage[], isCancellingBeforeStart = () => false) {
      if (entry) throw new Error("The live Codex stream is already attached.");
      if (disposed) throw new Error("The live Codex stream reservation has expired.");
      sessionId = id.toLowerCase();
      while (streams.size >= MAX_STREAMS && !streams.has(sessionId)) {
        const oldestTerminal = [...streams.entries()].find(([, value]) => value.finishedAt !== undefined);
        if (!oldestTerminal) throw new Error("No live Codex session slot is available.");
        streams.delete(oldestTerminal[0]);
      }
      const previousAt = streams.get(sessionId)?.reducer.snapshot().updatedAt ?? 0;
      entry = { reducer: new CodexSessionLiveReducer(sessionId, streamId, parseItems, previousAt) };
      streams.set(sessionId, entry);
      off = rpc.onNotification((method, params) => {
        if (!entry?.reducer.accept(method, params)) return;
        if (method === "turn/completed") { entry.finishedAt = Date.now(); flush(); }
        else if (!entry.timer) entry.timer = setTimeout(flush, 100);
      });
      offDisconnect = rpc.onDisconnect?.((error) => {
        if (!entry) return;
        entry.reducer.finish(isCancellingBeforeStart() ? "cancelled" : "disconnected", error.message);
        entry.finishedAt = Date.now();
        flush();
      });
      flush();
    },
    started(turnId: string) { entry?.reducer.started(turnId); flush(); },
    finish(status: "completed" | "cancelled" | "failed" | "disconnected", error?: string) {
      if (entry) { entry.reducer.finish(status, error); entry.finishedAt = Date.now(); flush(); }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      off?.();
      offDisconnect?.();
      flush();
      activeSlots.delete(streamId);
    }
  };
}

function prune(): void {
  const now = Date.now();
  for (const [id, stream] of streams) if (stream.finishedAt !== undefined && now - stream.finishedAt >= TERMINAL_TTL_MS) {
    if (stream.timer) clearTimeout(stream.timer);
    streams.delete(id);
  }
}
