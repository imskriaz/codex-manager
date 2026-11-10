import { randomUUID } from "node:crypto";
import type { DashboardCliSessionMessage, DashboardCodexSessionLiveState } from "../domain/dashboard/types";
import { CodexSessionLiveReducer, isNewerCodexSessionLiveState } from "../domain/codexSessionLive";
import type { CodexAppServerRpc } from "./codexAppServerRpc";
import { publishDashboardRealtime } from "./dashboardRealtime";
import { captureSessionAccount, recordSessionLive } from "./sessionRecording";
import { getSqliteStateStore } from "../storage/sqliteState";
import { listStoredSessionLive, readStoredSessionLive, isConfirmedSessionDeleted } from "../storage/sqliteSessions";
import { getCodexHome } from "../codex/authFile";
import { hydrateSessionImages } from './codexSessionImages';

const MAX_STREAMS = 30;
const TERMINAL_TTL_MS = 5 * 60_000;
const activeSlots = new Set<string>();
const slotReleased = new Set<() => void>();
const streams = new Map<string, { reducer: CodexSessionLiveReducer; timer?: NodeJS.Timeout; finishedAt?: number }>();

export function getCodexSessionLiveState(sessionId: string): DashboardCodexSessionLiveState | undefined {
  prune();
  const deletionStore = getSqliteStateStore();
  if (deletionStore && isConfirmedSessionDeleted(deletionStore,getCodexHome(),sessionId)) return undefined;
  const current = streams.get(sessionId.toLowerCase())?.reducer.snapshot();
  if (current?.status === "running" || current?.status === "starting") return current;
  const store = getSqliteStateStore();
  const stored = store ? readStoredSessionLive(store,getCodexHome(),sessionId.toLowerCase()) : undefined;
  return stored && isNewerCodexSessionLiveState(stored,current) ? stored : current ?? stored;
}

export function listCodexSessionLiveStates(): DashboardCodexSessionLiveState[] {
  prune();
  const store = getSqliteStateStore();
  const states = new Map((store ? listStoredSessionLive(store,getCodexHome()) : []).map(state=>[state.sessionId,state]));
  for (const [id,stream] of streams) {
    const current = stream.reducer.snapshot();
    if (isNewerCodexSessionLiveState(current,states.get(id))) states.set(id,current);
  }
  return [...states.values()].filter(state => state.deviceId || !store || !isConfirmedSessionDeleted(store,getCodexHome(),state.sessionId));
}

export function onDidReleaseCodexSessionLiveSlot(listener: () => void): () => void {
  slotReleased.add(listener);
  return () => { slotReleased.delete(listener); };
}

export function availableCodexSessionLiveSlots(): number {
  return MAX_STREAMS - activeSlots.size;
}

/** Reserve capacity before thread/start or turn/start can mutate the provider. */
export function reserveCodexSessionLive() {
  prune();
  if (activeSlots.size >= MAX_STREAMS) throw new Error("Codex Manager is already managing 30 turns. Stop a turn or wait for it to finish before starting another.");
  const streamId = randomUUID();
  const accountId = captureSessionAccount();
  activeSlots.add(streamId);
  let sessionId: string | undefined;
  let entry: ReturnType<typeof streams.get>;
  let off: (() => void) | undefined;
  let offDisconnect: (() => void) | undefined;
  let disposed = false;
  const imageSources = new Map<string, string>();
  const imageReads = new Set<string>();
  const flush = () => {
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    const state = entry.reducer.snapshot();
    recordSessionLive(state,accountId);
    publishDashboardRealtime({ type: "dashboard:codex-session-live", state });
    const localImages = state.messages.flatMap(message => message.images ?? []).filter(image => !/^(?:https?:\/\/|data:image\/)/i.test(image.src) && !imageReads.has(image.src));
    if (localImages.length) {
      for (const image of localImages) imageReads.add(image.src);
      const owner = entry;
      void hydrateSessionImages(localImages.map((image, index) => ({ id: String(index), text: '', images: [image] }))).then(messages => {
        if (streams.get(state.sessionId) !== owner) return;
        // shortcut: live previews share 512 KB per stream; persisted history carries larger images.
        let bytes = [...imageSources.values()].reduce((sum, source) => sum + source.length, 0);
        for (const [index, message] of messages.entries()) {
          const source = message.images?.[0]?.src;
          if (source && bytes + source.length < 512 * 1024) { imageSources.set(localImages[index]!.src, source); bytes += source.length; }
        }
        if (imageSources.size) { owner.reducer.refreshPresentation(); flush(); }
      }).catch(error => console.warn('[codexManager] live image preview unavailable', error));
    }
  };
  return {
    attach(id: string, rpc: CodexAppServerRpc, parseItems: (value: unknown) => DashboardCliSessionMessage[], isCancelled = () => false) {
      if (entry) throw new Error("The live Codex stream is already attached.");
      if (disposed) throw new Error("The live Codex stream reservation has expired.");
      sessionId = id.toLowerCase();
      while (streams.size >= MAX_STREAMS && !streams.has(sessionId)) {
        const oldestTerminal = [...streams.entries()].find(([, value]) => value.finishedAt !== undefined);
        if (!oldestTerminal) throw new Error("No live Codex session slot is available.");
        streams.delete(oldestTerminal[0]);
      }
      const previousAt = streams.get(sessionId)?.reducer.snapshot().updatedAt ?? 0;
      entry = { reducer: new CodexSessionLiveReducer(sessionId, streamId, value => parseItems(value).map(message => message.images?.length ? { ...message, images: message.images.map(image => imageSources.has(image.src) ? { ...image, src: imageSources.get(image.src)! } : image) } : message), previousAt) };
      streams.set(sessionId, entry);
      off = rpc.onNotification((method, params) => {
        if (!entry?.reducer.accept(method, params)) return;
        if (method === "turn/completed") { entry.finishedAt = Date.now(); flush(); }
        else if (!entry.timer) entry.timer = setTimeout(flush, 100);
      });
      offDisconnect = rpc.onDisconnect?.((error) => {
        if (!entry) return;
        entry.reducer.finish(isCancelled() ? "cancelled" : "disconnected", error.message);
        entry.finishedAt = Date.now();
        flush();
      });
      flush();
    },
    started(turnId: string) { entry?.reducer.started(turnId); flush(); },
    finish(status: "completed" | "cancelled" | "failed" | "disconnected", error?: string) {
      if (entry) { entry.reducer.finish(status, error); entry.finishedAt = Date.now(); flush(); }
    },
    dispose(discard = false) {
      if (disposed) return;
      disposed = true;
      off?.();
      offDisconnect?.();
      if (discard) {
        if (entry?.timer) clearTimeout(entry.timer);
        if (sessionId && streams.get(sessionId) === entry) streams.delete(sessionId);
        entry = undefined;
      } else flush();
      activeSlots.delete(streamId);
      for (const listener of slotReleased) {
        try { listener(); } catch (error) { console.warn('[codexManager] session capacity listener failed', error); }
      }
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
