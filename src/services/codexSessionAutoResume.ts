import { setTimeout as delay } from "node:timers/promises";
import { recordPersistentEvent } from "../utils/persistentLog";
import { onDidChangeConfiguration } from "../storage/configurationEvents";
import * as vscode from "vscode";
import { isAutoResumeEnabled } from "../infrastructure/config/extensionSettings";
import { closeOpenCodexSessionTabs, openCodexSessionInVsCode, readCodexCliSessionRecoveryMetadata, toSessionLogRef, readOpenCodexSessionIds, readRecentRunningCodexSessionIds, onDidInspectRunningCodexSessions, resolveCodexHome, SESSION_ID_PATTERN } from "./codexSessionResume";
import { listCodexSessionLiveStates } from "./codexSessionLive";
import * as path from "path";
import { filterAutoResumeGoalSessionIds, readAutoResumeGoalCandidateIds, isAutoResumeGoalOnlyEnabled, readAutoResumeCodexSessionIds } from "./codexSessionAutoResumeSelection";
import { orderCodexSessionRecoveryIds, readQueuedCodexSessionPreferences, readCodexSessionPreferences, hasCodexSessionAutoResumeOptIn, isCodexSessionAutoResumeEnabled } from "./codexSessionPreferences";
import { getSqliteMementoStorage, getSqliteStateStore } from "../storage/sqliteState";
import { runCrossWindowExclusive } from "../utils/crossWindowOperations";
import { getCodexHomeStateKey } from "../codex/authFile";
import type { DashboardCliSessionSummary } from "../domain/dashboard/types";
import type { CodexSessionRecoveryMetadata } from "./codexSessionResume";
import { resumeCodexSessionWork } from "./codexSessionRecovery";

export const AUTO_RESUME_SESSION_IDS_KEY = "codexManager.autoResumeSessionIds";
export const AUTO_RESUME_OPEN_SESSION_IDS_KEY = "codexManager.autoResumeOpenSessionIds";
export const AUTO_RESUME_METADATA_KEY = "codexManager.autoResumeSessionMetadata";
const AUTO_RESUME_HOME_KEY = "codexManager.autoResumeCodexHome";
export const MAX_AUTO_RESUME_SESSIONS = 200;
const OPERATION_TIMEOUT_MS = 30_000;
const PER_SESSION_OPEN_TIMEOUT_MS = 135_000;
const STORAGE_TIMEOUT_MS = 5_000;
const EMPTY_STARTUP_RETRY_DELAYS_MS = [1_000, 2_000] as const;
type AutoResumeContext = Pick<vscode.ExtensionContext, "workspaceState">;
type OperationKind = "capture" | "restore" | "track" | "close";
type Operations = { tail: Promise<unknown>; capture?: Promise<unknown>; restore?: Promise<unknown>; track?: Promise<unknown>; close?: Promise<unknown> };
const operations = new WeakMap<object, Operations>();
const pendingWrites = new WeakMap<object, Promise<void>>();
const recoveryIds = new WeakMap<object, string[]>();

function filterSessionAutoResumeIds(home: string, ids: readonly string[]): string[] {
  const preferences = readCodexSessionPreferences(home, ids);
  return ids.filter(id => !preferences.get(id)?.manualStop && isCodexSessionAutoResumeEnabled(home, id));
}
const openRecoveryIds = new WeakMap<object, string[]>();
const unrestoredOpenSnapshots = new WeakSet<object>();
const restoreControllers = new Set<AbortController>();
const startupTimers = new Set<ReturnType<typeof setTimeout>>();
const autoResumeTitles = new WeakMap<object, Array<{ sessionId: string; title: string; status: "opened" | "failed" }>>();

/** Stop optional startup restoration before manual session or account work. */
export function cancelCodexSessionAutoResume(reason = "Auto Resume was cancelled because the account is changing."): void {
  for (const timer of startupTimers) clearTimeout(timer);
  startupTimers.clear();
  for (const controller of restoreControllers) controller.abort(new Error(reason));
}

export function scheduleCodexSessionAutoResume(start: () => void): vscode.Disposable {
  const timer = setTimeout(() => { startupTimers.delete(timer); start(); }, 1_000);
  timer.unref?.();
  startupTimers.add(timer);
  return { dispose: () => { clearTimeout(timer); startupTimers.delete(timer); } };
}

// Repeated requests for the same operation join; different operations run in order.
function serialize<T>(context: AutoResumeContext, kind: OperationKind, operation: () => Promise<T>): Promise<T> {
  let state = operations.get(context.workspaceState);
  if (!state) {
    state = { tail: Promise.resolve() };
    operations.set(context.workspaceState, state);
  }
  if (state[kind]) return state[kind] as Promise<T>;
  // SQLite merges are atomic; background snapshots must keep saving during slow editor restoration.
  const independentTracking = kind === "track" && getSqliteMementoStorage(context.workspaceState);
  const next = (independentTracking ? Promise.resolve() : state.tail)
    .catch(() => undefined)
    .then(() => {
      if (pendingWrites.has(context.workspaceState))
        throw new Error("A previous auto-resume storage write is still pending. Retry Reload after storage responds.");
      return operation();
    });
  state[kind] = next;
  if (!independentTracking) state.tail = next;
  const owner = state;
  void next
    .finally(() => {
      delete owner[kind];
      if (!owner.capture && !owner.restore && !owner.track && !owner.close) operations.delete(context.workspaceState);
    })
    .catch(() => undefined);
  return next;
}

function normalizeIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 10_000)
    throw new Error(
      "The saved auto-resume record is malformed or too large. Turn Auto Resume off to clear it, then enable it again."
    );
  const ids = [
    ...new Set(
      value
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim().toLowerCase())
        .filter((id) => SESSION_ID_PATTERN.test(id))
    )
  ];
  if (ids.length > MAX_AUTO_RESUME_SESSIONS)
    throw new Error("Auto Resume supports up to 200 pending sessions. Close unnecessary sessions and retry Reload.");
  return ids;
}

function readPersistedSessionIds(context: AutoResumeContext, open = false): string[] {
  const savedHome = context.workspaceState.get<unknown>(AUTO_RESUME_HOME_KEY);
  if (typeof savedHome === "string" && getCodexHomeStateKey(savedHome) !== getCodexHomeStateKey(resolveCodexHome()) &&
      (context.workspaceState.get(AUTO_RESUME_SESSION_IDS_KEY) !== undefined || context.workspaceState.get(AUTO_RESUME_OPEN_SESSION_IDS_KEY) !== undefined))
    throw new Error("Auto Resume belongs to a different Codex home. Saved sessions were retained; reopen the original isolated window or restore its Codex home before retrying.");
  if (open && openRecoveryIds.has(context.workspaceState)) return [...openRecoveryIds.get(context.workspaceState)!];
  return normalizeIds([
    ...normalizeIds(context.workspaceState.get<unknown>(open ? AUTO_RESUME_OPEN_SESSION_IDS_KEY : AUTO_RESUME_SESSION_IDS_KEY)),
    ...((open ? openRecoveryIds : recoveryIds).get(context.workspaceState) ?? [])
  ]);
}

/** Read retained reload recovery without consuming it or depending on automatic startup restoration. */
export function withCodexSessionRecovery(context: AutoResumeContext, sessions: DashboardCliSessionSummary[], strict = false): DashboardCliSessionSummary[] {
  let saved = new Set<string>();
  try {
    if (context.workspaceState) saved = new Set([...readPersistedSessionIds(context), ...readPersistedSessionIds(context, true)]);
  } catch (error) {
    recordPersistentEvent("warning", "session-list", "Saved recovery could not be read; native session metadata remains available", undefined, error);
    if (strict) throw error;
  }
  return sessions.map(session => session.archived || session.subAgent || session.parentSessionId || session.status === "running" ? session : {
    ...session,
    interrupted: session.interrupted === true || session.goal?.status === "usage_limited" ||
      (session.interrupted !== false && saved.has(session.id))
  });
}

async function bounded<T>(
  operation: () => PromiseLike<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
        onAbort = () => {
          const reason: unknown = signal?.reason;
          reject(
            reason instanceof Error
              ? reason
              : new Error(typeof reason === "string" ? reason : "Auto Resume was cancelled.")
          );
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function readSavedMetadata(context: AutoResumeContext): Record<string, CodexSessionRecoveryMetadata> {
  const value = context.workspaceState.get<unknown>(AUTO_RESUME_METADATA_KEY);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const records: Record<string, CodexSessionRecoveryMetadata> = {};
  for (const [id, entry] of Object.entries(value).slice(0, MAX_AUTO_RESUME_SESSIONS * 2)) {
    if (!SESSION_ID_PATTERN.test(id) || !entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (typeof row["updatedAt"] !== "number" || !Number.isFinite(row["updatedAt"]) || row["updatedAt"] < 0 || row["updatedAt"] > Date.now() + 60_000) continue;
    const title = typeof row["title"] === "string" ? row["title"].trim().slice(0, 256) || undefined : undefined;
    records[id.toLowerCase()] = {
      title: title === id || title === `Codex session ${id.slice(0, 8)}` ? "Untitled conversation" : title,
      projectPath: typeof row["projectPath"] === "string" && path.isAbsolute(row["projectPath"]) && row["projectPath"].length <= 4096 ? row["projectPath"] : undefined,
      updatedAt: row["updatedAt"]
    };
  }
  return records;
}

async function captureRecoveryMetadata(ids: string[], signal?: AbortSignal): Promise<Record<string, CodexSessionRecoveryMetadata>> {
  return bounded(() => readCodexCliSessionRecoveryMetadata(ids), 1_000, "Session titles are temporarily unavailable.", signal)
    .catch(error => {
      recordPersistentEvent("debug", "auto-resume", "Title refresh deferred; saved titles retained", { count: ids.length }, error);
      return {};
    });
}

async function writeIds(context: AutoResumeContext, ids: string[], deadline: number, open = false, options: { remove?: string[]; consumeOpen?: string[]; titles?: Record<string, CodexSessionRecoveryMetadata> } = {}): Promise<void> {
  const storage = getSqliteMementoStorage(context.workspaceState);
  if (storage) {
    const { store, namespace } = storage;
    store.transaction(() => {
      readPersistedSessionIds(context, open);
      const remove = new Set(options.remove ?? []);
      const next = open ? ids : normalizeIds([
        ...normalizeIds(store.get(namespace, AUTO_RESUME_SESSION_IDS_KEY)).filter(id => !remove.has(id)), ...ids
      ]);
      store.set(namespace, open ? AUTO_RESUME_OPEN_SESSION_IDS_KEY : AUTO_RESUME_SESSION_IDS_KEY, next.length ? next : undefined);
      if (options.consumeOpen) {
        const consumed = new Set(options.consumeOpen);
        const remaining = normalizeIds(store.get(namespace, AUTO_RESUME_OPEN_SESSION_IDS_KEY)).filter(id => !consumed.has(id));
        store.set(namespace, AUTO_RESUME_OPEN_SESSION_IDS_KEY, remaining.length ? remaining : undefined);
      }
      store.set(namespace, AUTO_RESUME_HOME_KEY, path.resolve(resolveCodexHome()));
      const retained = new Set([...next, ...normalizeIds(store.get(namespace, open ? AUTO_RESUME_SESSION_IDS_KEY : AUTO_RESUME_OPEN_SESSION_IDS_KEY))]);
      const titles = readSavedMetadata(context);
      for (const [id,entry] of Object.entries(options.titles ?? {}))
        if (!titles[id] || entry.updatedAt >= titles[id]!.updatedAt) titles[id] = entry;
      const keptTitles = Object.fromEntries(Object.entries(titles).filter(([id]) => retained.has(id)));
      store.set(namespace, AUTO_RESUME_METADATA_KEY, Object.keys(keptTitles).length ? keptTitles : undefined);
    });
    recoveryIds.delete(context.workspaceState);
    openRecoveryIds.delete(context.workspaceState);
    return;
  }
  // Memento mutates its cache before the write resolves. Retain the previous
  // recovery IDs in this host too, until storage acknowledges the replacement.
  const previous = readPersistedSessionIds(context, open);
  const recovery = open ? openRecoveryIds : recoveryIds;
  recovery.set(context.workspaceState, open ? previous : normalizeIds([...previous, ...ids]));
  const write = Promise.resolve().then(() =>
    context.workspaceState.update(open ? AUTO_RESUME_OPEN_SESSION_IDS_KEY : AUTO_RESUME_SESSION_IDS_KEY, ids.length ? ids : undefined)
  );
  pendingWrites.set(context.workspaceState, write);
  void write
    .finally(() => {
      if (pendingWrites.get(context.workspaceState) === write) pendingWrites.delete(context.workspaceState);
    })
    .catch(() => undefined);
  await bounded(
    () => write,
    Math.min(STORAGE_TIMEOUT_MS, deadline - Date.now()),
    "Auto-resume storage did not respond within its deadline. Retry Reload after storage responds."
  );
  recovery.delete(context.workspaceState);
  if (context.workspaceState.get(AUTO_RESUME_METADATA_KEY) !== undefined || Object.keys(options.titles ?? {}).length) {
    // IDs are already durable; a failed title write must not discard recovery.
    const retained = new Set([...ids, ...readPersistedSessionIds(context, !open)]);
    const titles = Object.fromEntries(Object.entries({ ...readSavedMetadata(context), ...options.titles }).filter(([id]) => retained.has(id)));
    const titleWrite = Promise.resolve().then(() => context.workspaceState.update(AUTO_RESUME_METADATA_KEY, Object.keys(titles).length ? titles : undefined));
    pendingWrites.set(context.workspaceState, titleWrite);
    void titleWrite.finally(() => {
      if (pendingWrites.get(context.workspaceState) === titleWrite) pendingWrites.delete(context.workspaceState);
    }).catch(() => undefined);
    await bounded(() => titleWrite,
      Math.min(STORAGE_TIMEOUT_MS, deadline - Date.now()), "Session titles could not be saved.")
      .catch(error => recordPersistentEvent("warning", "auto-resume", "Recovery saved without refreshed titles", undefined, error));
  }
  if (options.consumeOpen) {
    const previousOpen = readPersistedSessionIds(context, true);
    const remainingOpen = previousOpen.filter(id => !options.consumeOpen!.includes(id));
    if (remainingOpen.length !== previousOpen.length) await writeIds(context, remainingOpen, deadline, true);
  }
}

async function clearIds(context: AutoResumeContext, deadline: number): Promise<void> {
  if (!recoveryIds.has(context.workspaceState) && !openRecoveryIds.has(context.workspaceState) &&
      context.workspaceState.get(AUTO_RESUME_SESSION_IDS_KEY) === undefined &&
      context.workspaceState.get(AUTO_RESUME_OPEN_SESSION_IDS_KEY) === undefined &&
      context.workspaceState.get(AUTO_RESUME_METADATA_KEY) === undefined) return;
  const storage = getSqliteMementoStorage(context.workspaceState);
  if (storage) {
    storage.store.transaction(() => {
      for (const key of [AUTO_RESUME_SESSION_IDS_KEY, AUTO_RESUME_OPEN_SESSION_IDS_KEY, AUTO_RESUME_METADATA_KEY, AUTO_RESUME_HOME_KEY])
        storage.store.set(storage.namespace, key, undefined);
    });
    recoveryIds.delete(context.workspaceState);
    openRecoveryIds.delete(context.workspaceState);
    unrestoredOpenSnapshots.delete(context.workspaceState);
    return;
  }
  // Explicit disable also clears malformed records; no parsing is required.
  try {
    recoveryIds.set(context.workspaceState, readPersistedSessionIds(context));
  } catch {
    /* A malformed record must still be clearable. */
  }
  const write = Promise.resolve().then(() => context.workspaceState.update(AUTO_RESUME_SESSION_IDS_KEY, undefined));
  pendingWrites.set(context.workspaceState, write);
  void write
    .finally(() => {
      if (pendingWrites.get(context.workspaceState) === write) pendingWrites.delete(context.workspaceState);
    })
    .catch(() => undefined);
  await bounded(
    () => write,
    Math.min(STORAGE_TIMEOUT_MS, deadline - Date.now()),
    "Auto-resume storage did not respond while clearing recovery. Retry after storage responds."
  );
  recoveryIds.delete(context.workspaceState);
  try {
    openRecoveryIds.set(context.workspaceState, readPersistedSessionIds(context, true));
  } catch {
    /* Explicit disable must also clear a malformed open-tab snapshot. */
  }
  const openWrite = Promise.resolve().then(() => context.workspaceState.update(AUTO_RESUME_OPEN_SESSION_IDS_KEY, undefined));
  pendingWrites.set(context.workspaceState, openWrite);
  void openWrite.finally(() => {
    if (pendingWrites.get(context.workspaceState) === openWrite) pendingWrites.delete(context.workspaceState);
  }).catch(() => undefined);
  await bounded(() => openWrite, Math.min(STORAGE_TIMEOUT_MS, deadline - Date.now()),
    "Auto-resume storage did not respond while clearing saved tabs. Retry after storage responds.");
  openRecoveryIds.delete(context.workspaceState);
  unrestoredOpenSnapshots.delete(context.workspaceState);
  const metadataWrite = Promise.resolve().then(() => context.workspaceState.update(AUTO_RESUME_METADATA_KEY, undefined));
  pendingWrites.set(context.workspaceState, metadataWrite);
  void metadataWrite.finally(() => {
    if (pendingWrites.get(context.workspaceState) === metadataWrite) pendingWrites.delete(context.workspaceState);
  }).catch(() => undefined);
  await bounded(() => metadataWrite, Math.min(STORAGE_TIMEOUT_MS, deadline - Date.now()),
    "Saved recovery details could not be cleared. Retry after storage responds.");
}

/** Add verified running parents without dropping unacknowledged recovery. */
export function persistRunningCodexSessions(
  context: AutoResumeContext,
  readRunningSessionIds: (signal?: AbortSignal) => Promise<string[]> = (signal) =>
    readAutoResumeCodexSessionIds(undefined, undefined, undefined, signal, "running", undefined, readRecentRunningCodexSessionIds(), undefined,
      normalizeIds([...readPersistedSessionIds(context), ...readPersistedSessionIds(context, true)])),
  signal?: AbortSignal
): Promise<string[]> {
  return serialize(context, "capture", async () => {
    signal?.throwIfAborted();
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    if (!isAutoResumeAvailable()) {
      await clearIds(context, deadline);
      return [];
    }
    const goalOnly = isAutoResumeGoalOnlyEnabled();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const changed = onDidChangeConfiguration(() => {
      if (!isAutoResumeAvailable()) controller.abort(new Error("Auto Resume was turned off."));
    });
    try {
      let running: string[];
      try {
        running = await bounded(
          () => readRunningSessionIds(controller.signal),
          OPERATION_TIMEOUT_MS,
          "Codex session discovery did not respond within 30 seconds. Retry Reload after session storage responds.",
          controller.signal
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!controller.signal.aborted) {
          controller.abort(error);
          throw error;
        }
        await clearIds(context, deadline);
        return [];
      }
      signal?.throwIfAborted();
      if (controller.signal.aborted || !isAutoResumeAvailable()) {
        await clearIds(context, deadline);
        return [];
      }
      const home = resolveCodexHome();
      const ids = await bounded(async () => filterSessionAutoResumeIds(home, await filterAutoResumeGoalSessionIds(normalizeIds([
        ...readPersistedSessionIds(context), ...normalizeIds(running)
      ]), undefined, controller.signal, false, true)), deadline - Date.now(),
        "Auto Resume could not verify goals before saving recovery.", controller.signal);
      if (goalOnly !== isAutoResumeGoalOnlyEnabled()) throw new Error("The goal-only preference changed during capture. Retry after preferences settle.");
      controller.signal.throwIfAborted();
      const titles = await captureRecoveryMetadata(ids, controller.signal);
      controller.signal.throwIfAborted();
      await writeIds(context, ids, deadline, false, { titles });
      recordPersistentEvent("info", "auto-resume", "Reload recovery saved", { discovered: running.length, saved: ids.length });
      recordPersistentEvent("debug", "auto-resume", "Reload recovery session IDs", { ids });
      signal?.throwIfAborted();
      if (controller.signal.aborted || !isAutoResumeAvailable()) {
        await clearIds(context, deadline);
        return [];
      }
      return ids;
    } finally {
      changed?.dispose();
      signal?.removeEventListener("abort", abort);
    }
  });
}

/** Capture running parents and their open tabs before a managed reload. */
export async function prepareCodexSessionsForExtensionHostRestart(
  context: AutoResumeContext,
  autoResume: boolean,
  readRunningSessionIds?: (signal?: AbortSignal) => Promise<string[]>,
  readOpenParents?: (signal?: AbortSignal) => Promise<string[]>,
  signal?: AbortSignal
): Promise<void> {
  if (autoResume && !readRunningSessionIds && !readOpenParents) {
    // Reuse tab/sidebar goal capture; a full history scan cannot fit the reload budget.
    await persistOpenCodexSessions(context, undefined, signal);
    return;
  }
  const running = await persistRunningCodexSessions(context, readRunningSessionIds, signal);
  signal?.throwIfAborted();
  if (autoResume) await persistOpenCodexSessions(context, async signal => {
    const open = readOpenParents ? await readOpenParents(signal) : readOpenCodexSessionIds();
    return open.filter(id => running.includes(id));
  }, signal);
}

export type AutoResumeResult = {
  attempted: number;
  opened: number;
  failed: Array<{ sessionId: string; message: string }>;
};

/** Seal recovery before tab-close events can replace the open-tab snapshot. */
export async function closeCodexSessionsForExtensionHostRestart(context: AutoResumeContext, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  cancelCodexSessionAutoResume();
  await serialize(context, "close", async () => {
    signal?.throwIfAborted();
    if (isAutoResumeAvailable()) {
      const ids = normalizeIds([...readPersistedSessionIds(context), ...readPersistedSessionIds(context, true)]);
      await writeIds(context, ids, Date.now() + STORAGE_TIMEOUT_MS);
      recordPersistentEvent("info", "auto-resume", "Recovery sealed before closing reload tabs", { count: ids.length });
    }
    signal?.throwIfAborted();
    await closeOpenCodexSessionTabs(signal, true);
    recordPersistentEvent("info", "auto-resume", "Codex tabs closed before extension host restart");
  });
}

/** Replace the open-tab snapshot; failed restoration remains in its separate recovery queue. */
export function persistOpenCodexSessions(
  context: AutoResumeContext,
  readOpenParents: (signal?: AbortSignal) => Promise<string[]> = async (signal) => {
    const open = readOpenCodexSessionIds();
    const goalOnly = isAutoResumeGoalOnlyEnabled();
    const goals = await readAutoResumeGoalCandidateIds(undefined, signal);
    const previous = normalizeIds([...readPersistedSessionIds(context), ...readPersistedSessionIds(context, true)]);
    const live = listCodexSessionLiveStates().filter(state => !state.deviceId && ["running", "starting"].includes(state.status)).map(state => state.sessionId);
    const candidates = [...new Set([...open, ...goals, ...live, ...previous, ...(readRecentRunningCodexSessionIds() ?? [])])];
    if (!candidates.length) return [];
    return readAutoResumeCodexSessionIds(undefined, undefined, open, signal, "running", goalOnly,
      readRecentRunningCodexSessionIds(undefined, candidates), candidates, previous);
  },
  signal?: AbortSignal
): Promise<string[]> {
  return serialize(context, "track", async () => {
    signal?.throwIfAborted();
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    if (!isAutoResumeAvailable()) {
      await clearIds(context, deadline);
      return [];
    }
    if (unrestoredOpenSnapshots.has(context.workspaceState)) {
      // Startup may fail before it can durably transfer the previous tab snapshot.
      // Do that transfer before a current (possibly empty) tab list replaces it.
      const previousOpen = readPersistedSessionIds(context,true);
      if (previousOpen.length) await writeIds(context, normalizeIds([
        ...readPersistedSessionIds(context), ...previousOpen
      ]), deadline);
      unrestoredOpenSnapshots.delete(context.workspaceState);
    }
    const goalOnly = isAutoResumeGoalOnlyEnabled();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const changed = onDidChangeConfiguration(() => {
      if (!isAutoResumeAvailable()) controller.abort(new Error("Auto Resume was turned off."));
    });
    try {
      const discovered = normalizeIds(await bounded(() => readOpenParents(controller.signal), OPERATION_TIMEOUT_MS,
        "Open Codex session discovery did not respond within 30 seconds. Saved tabs will retry later.", controller.signal));
      const ids = await bounded(async () => filterSessionAutoResumeIds(resolveCodexHome(), await filterAutoResumeGoalSessionIds(discovered, undefined, controller.signal, goalOnly, true)), deadline - Date.now(),
        "Auto Resume could not verify goals before saving open tabs.", controller.signal);
      if (goalOnly !== isAutoResumeGoalOnlyEnabled()) throw new Error("The goal-only preference changed during capture. Saved tabs were retained for retry.");
      if (!isAutoResumeAvailable()) {
        await clearIds(context, deadline);
        return [];
      }
      controller.signal.throwIfAborted();
      const previous = readPersistedSessionIds(context, true);
      const savedTitles = readSavedMetadata(context);
      const refreshTitles = ids.filter(id => !savedTitles[id] || Date.now()-savedTitles[id]!.updatedAt >= 60_000);
      const titles = refreshTitles.length ? await captureRecoveryMetadata(refreshTitles, controller.signal) : {};
      controller.signal.throwIfAborted();
      const selected = new Set(ids);
      const idsChanged = previous.length !== ids.length || previous.some(id => !selected.has(id));
      if (openRecoveryIds.has(context.workspaceState) || idsChanged || Object.keys(titles).length > 0) {
        await writeIds(context, ids, deadline, true, { titles });
        if (idsChanged) {
          recordPersistentEvent("info", "auto-resume", "Background recovery snapshot updated", { previousCount: previous.length, savedCount: ids.length });
          recordPersistentEvent("debug", "auto-resume", "Background recovery session IDs", { ids });
        }
      }
      if (!isAutoResumeAvailable()) {
        await clearIds(context, deadline);
        return [];
      }
      return ids;
    } catch (error) {
      controller.abort(error);
      if (!isAutoResumeAvailable() && !signal?.aborted) {
        await clearIds(context, Date.now() + STORAGE_TIMEOUT_MS * 2);
        return [];
      }
      throw error;
    } finally {
      changed?.dispose();
      signal?.removeEventListener("abort", abort);
    }
  });
}

/** Track for the whole host lifetime; retain the previous host's snapshot before replacing it. */
export function registerCodexSessionAutoResumeTracking(context: AutoResumeContext): vscode.Disposable {
  unrestoredOpenSnapshots.add(context.workspaceState);
  const controller = new AbortController();
  let dirty = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryAfter = 0;
  const capture = () => {
    if (controller.signal.aborted || !isAutoResumeAvailable()) return;
    if (Date.now() < retryAfter) return;
    dirty = true;
    if (running) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    running = true;
    void (async () => {
      try {
        while (dirty && !controller.signal.aborted) {
          dirty = false;
          try {
            await persistOpenCodexSessions(context, undefined, controller.signal);
            retryAfter = 0;
          } catch (error) {
            if (controller.signal.aborted) break;
            recordPersistentEvent("warning", "auto-resume", "Background recovery capture failed; previous snapshot retained", undefined, error);
            // One bounded retry timer also handles metadata arriving after the tab event.
            retryAfter = Date.now() + 30_000;
            dirty = false;
            break;
          }
        }
      } finally {
        running = false;
        if (!controller.signal.aborted && isAutoResumeAvailable()) timer = setTimeout(capture, 30_000);
      }
    })();
  };
  let tabs: vscode.Disposable | undefined;
  const refreshSubscription = () => {
    if (isAutoResumeAvailable()) {
      tabs ??= vscode.window.tabGroups?.onDidChangeTabs?.(capture);
      capture();
    } else {
      tabs?.dispose();
      tabs = undefined;
      retryAfter = 0;
      if (timer) clearTimeout(timer);
      timer = undefined;
      dirty = false;
      void serialize(context, "track", () => clearIds(context, Date.now() + STORAGE_TIMEOUT_MS * 2)).catch((error) =>
        console.warn("[codexManager] disabled Auto Resume recovery could not be cleared", error)
      );
    }
  };
  const configuration = onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("codexManager.autoResumeEnabled") ||
        event.affectsConfiguration("codexManager.autoSwitchEnabled")) refreshSubscription();
  });
  const inspections = onDidInspectRunningCodexSessions(home => {
    if (!running && home === path.resolve(resolveCodexHome())) capture();
  });
  const stopStorage = getSqliteStateStore()?.subscribe(["session-status"], () => { if (!running) capture(); });
  refreshSubscription();
  return { dispose: () => {
    if (controller.signal.aborted) return;
    controller.abort(new Error("Codex Manager is shutting down."));
    if (timer) clearTimeout(timer);
    tabs?.dispose();
    inspections.dispose();
    stopStorage?.();
    configuration?.dispose();
  } };
}

/** Open official conversation tabs and resume only after readiness; retain uncertain work. */
export function resumePersistedCodexSessions(
  context: AutoResumeContext,
  openSession: (sessionId: string, signal?: AbortSignal) => Promise<void | Awaited<ReturnType<typeof resumeCodexSessionWork>>> = async (sessionId, signal) => {
    const startedAt = Date.now();
    const home = resolveCodexHome();
    const details = { sessionRef: toSessionLogRef(sessionId), recoveryPath: "vscode" };
    let phase = "eligibility";
    try {
      signal?.throwIfAborted();
      if (!(await filterAutoResumeGoalSessionIds([sessionId], home, signal, false, true)).length) {
        recordPersistentEvent("info", "auto-resume", "Recovery skipped before opening Codex", { ...details, reason: "no-longer-eligible" });
        return "idle";
      }
      if (resolveCodexHome() !== home) throw new Error("The Codex home changed. Saved recovery was retained.");
      phase = "readiness";
      recordPersistentEvent("info", "auto-resume", "Opening official Codex before recovery", details);
      await openCodexSessionInVsCode(sessionId, signal, true, 120_000, true);
      phase = "continuation";
      const outcome = await resumeCodexSessionWork(sessionId, signal);
      recordPersistentEvent("info", "auto-resume", "Official recovery path completed", { ...details, outcome, durationMs: Date.now() - startedAt });
      return outcome;
    } catch (error) {
      recordPersistentEvent("warning", "auto-resume", "Official recovery path failed", { ...details, phase, durationMs: Date.now() - startedAt, cancelled: signal?.aborted === true, recoveryRetained: true }, error);
      throw error;
    }
  },
  closeSessions: (signal?: AbortSignal) => Promise<void> = () => Promise.resolve()
): Promise<AutoResumeResult> {
  const controller = new AbortController();
  restoreControllers.add(controller);
  const restore = async (): Promise<AutoResumeResult> => {
    const deadline = Date.now() + 180_000;
    if (!isAutoResumeAvailable()) {
      recordPersistentEvent("info", "auto-resume", "Startup recovery disabled; saved recovery cleared");
      await clearIds(context, deadline);
      return { attempted: 0, opened: 0, failed: [] };
    }
    const changed = onDidChangeConfiguration((event) => {
      if (!isAutoResumeAvailable())
        controller.abort(new Error("Auto Resume was turned off. Remaining sessions were not reopened."));
      else if (event.affectsConfiguration("codexManager.codexHome"))
        controller.abort(new Error("The Codex home changed. Saved recovery was retained for its original home."));
    });
    try {
      controller.signal.throwIfAborted();
      unrestoredOpenSnapshots.add(context.workspaceState);
      const goalOnly = isAutoResumeGoalOnlyEnabled();
      const recoveryHome = resolveCodexHome();
      let startupVerificationHadError = false;
      // Retry read-only verification before dispatch; editor opens and turns are never replayed here.
      const verify = async (candidates: string[]): Promise<string[]> => {
        for (let attempt = 0; ; attempt++) {
          controller.signal.throwIfAborted();
          if (resolveCodexHome() !== recoveryHome) throw new Error("The Codex home changed. Saved recovery was retained.");
          try {
            return await readAutoResumeCodexSessionIds(recoveryHome, undefined, candidates, controller.signal, "recovery", goalOnly);
          } catch (error) {
            startupVerificationHadError = true;
            if (attempt >= 2 || controller.signal.aborted || !isAutoResumeAvailable()) throw error;
            recordPersistentEvent("warning", "auto-resume", "Startup verification will retry before opening sessions", { attempt: attempt + 1 }, error);
            await delay(250 * (attempt + 1), undefined, { signal: controller.signal });
          }
        }
      };
      const savedIds = normalizeIds([...readPersistedSessionIds(context), ...readPersistedSessionIds(context, true)]);
      recordPersistentEvent("info", "auto-resume", "Startup recovery loaded", { savedCount: savedIds.length, goalOnly });
      recordPersistentEvent("debug", "auto-resume", "Startup recovery session IDs", { ids: savedIds });
      const savedTitles = readSavedMetadata(context);
      const missingTitles = savedIds.filter(id => !savedTitles[id]);
      if (missingTitles.length) Object.assign(savedTitles, await captureRecoveryMetadata(missingTitles, controller.signal));
      const queuedIds = readQueuedCodexSessionPreferences(resolveCodexHome());
      const selectEligibleIds = (verified: string[]) =>
        orderCodexSessionRecoveryIds(resolveCodexHome(), filterSessionAutoResumeIds(resolveCodexHome(), verified)).filter(id => !queuedIds.has(id));
      let verifiedIds = await bounded(() => verify(savedIds), Math.min(OPERATION_TIMEOUT_MS, deadline - Date.now()),
        "Auto Resume could not verify saved sessions within 30 seconds. Saved recovery was retained.", controller.signal);
      let ids = selectEligibleIds(verifiedIds);
      // Codex can briefly expose an empty session set while its native databases finish opening.
      // Recheck a successful empty result before treating saved work as stale and consuming it.
      if (savedIds.length && !verifiedIds.length && !startupVerificationHadError) {
        for (const delayMs of EMPTY_STARTUP_RETRY_DELAYS_MS) {
          await delay(delayMs, undefined, { signal: controller.signal });
          verifiedIds = await bounded(() => verify(savedIds), Math.min(OPERATION_TIMEOUT_MS, deadline - Date.now()),
            "Auto Resume could not verify saved sessions within 30 seconds. Saved recovery was retained.", controller.signal);
          ids = selectEligibleIds(verifiedIds);
          if (ids.length) {
            recordPersistentEvent("info", "auto-resume", "Startup recovery retry found eligible sessions", { count: ids.length });
            break;
          }
        }
      }
      if (!isAutoResumeAvailable()) {
        await clearIds(context, Date.now() + STORAGE_TIMEOUT_MS * 2);
        return { attempted: 0, opened: 0, failed: [] };
      }
      if (goalOnly !== isAutoResumeGoalOnlyEnabled()) throw new Error("The goal-only preference changed during discovery. Retry to verify the saved sessions.");
      recordPersistentEvent("info", "auto-resume", "Startup goal filtering completed", { savedCount: savedIds.length, eligibleCount: ids.length });
      if (savedIds.length || context.workspaceState.get(AUTO_RESUME_METADATA_KEY) !== undefined)
        await writeIds(context, ids, deadline, false, { remove: savedIds, consumeOpen: savedIds, titles: savedTitles });
      if (!ids.length) {
        unrestoredOpenSnapshots.delete(context.workspaceState);
        return { attempted: 0, opened: 0, failed: [] };
      }
      unrestoredOpenSnapshots.delete(context.workspaceState);
      let remaining = [...ids];
      const result: AutoResumeResult = { attempted: ids.length, opened: 0, failed: [] };
      const titleRecords: Array<{ sessionId: string; title: string; status: "opened" | "failed" }> = [];
      autoResumeTitles.set(result, titleRecords);
      try {
        controller.signal.throwIfAborted();
        await bounded(() => closeSessions(controller.signal), Math.min(8_000, deadline - Date.now()),
          "Previous Codex tabs did not finish closing within 8 seconds. Background recovery was retained.", controller.signal);
        controller.signal.throwIfAborted();
        recordPersistentEvent("info", "auto-resume", "Startup UI preparation completed; existing Codex owners preserved", { count: ids.length });
      } catch (error) {
        controller.abort(error);
        result.failed = ids.map(sessionId => ({ sessionId, message: error instanceof Error ? error.message : String(error) }));
        recordPersistentEvent("warning", "auto-resume", "Startup UI preparation failed; recovery retained", { count: ids.length }, error);
        if (!isAutoResumeAvailable()) await clearIds(context, Date.now() + STORAGE_TIMEOUT_MS * 2);
        return result;
      }
      for (const id of ids) {
        const title = savedTitles[id]?.title;
        let outcome: Awaited<ReturnType<typeof openSession>>;
        if (!isAutoResumeAvailable())
          controller.abort(new Error("Auto Resume was turned off. Remaining sessions were not reopened."));
        if (Date.now() >= deadline)
          controller.abort(
            new Error(
              "Auto Resume reached its three minute deadline. Remaining sessions will retry on the next activation."
            )
          );
        try {
          controller.signal.throwIfAborted();
          if (!(await bounded(() => verify([id]), Math.min(OPERATION_TIMEOUT_MS,deadline - Date.now()),
            "Auto Resume could not verify this saved session before its deadline.", controller.signal)).length) {
            recordPersistentEvent("info", "auto-resume", "Session skipped because recovery is no longer eligible", { sessionId: id, sessionRef: toSessionLogRef(id) });
            remaining = remaining.filter((candidate) => candidate !== id);
            await writeIds(context, remaining, deadline, false, { remove: [id] });
            continue;
          }
          recordPersistentEvent("debug", "auto-resume", "Opening saved conversation", { sessionId: id, sessionRef: toSessionLogRef(id), ...(title ? { title } : {}) });
          const sessionController = new AbortController();
          const stopSession = () => sessionController.abort(controller.signal.reason);
          controller.signal.addEventListener("abort", stopSession, { once: true });
          try {
            const remainingMs = Math.max(1, deadline - Date.now());
            outcome = await bounded(
              () => openSession(id, sessionController.signal),
              Math.min(PER_SESSION_OPEN_TIMEOUT_MS, remainingMs),
              remainingMs < PER_SESSION_OPEN_TIMEOUT_MS
                ? "Auto Resume reached its three minute deadline. Remaining sessions will retry on the next activation."
                : "This Codex window did not finish recovery within 135 seconds. The remaining sessions will continue opening; this one will retry on the next activation.",
              sessionController.signal
            );
          } catch (error) {
            sessionController.abort(error);
            throw error;
          } finally {
            controller.signal.removeEventListener("abort", stopSession);
          }
        } catch (error) {
          // An editor command cannot be recalled once VS Code accepted it. Abort
          // before activation can dispatch it, and retain uncertain IDs for replay.
          // A single slow editor must not cancel the restore of other sessions.
          // Keep the ID durable so the failed window is retried next activation.
          recordPersistentEvent("warning", "auto-resume", "Conversation open failed; recovery retained", { sessionId: id, sessionRef: toSessionLogRef(id), ...(title ? { title } : {}) }, error);
          result.failed.push({ sessionId: id, message: error instanceof Error ? error.message : String(error) });
          if (title) titleRecords.push({ sessionId: id, title, status: "failed" });
          continue;
        }
        recordPersistentEvent("info", "auto-resume", "Conversation recovery confirmed", { sessionId: id, sessionRef: toSessionLogRef(id), outcome: outcome ?? "confirmed", ...(title ? { title } : {}) });
        if (outcome !== "idle") {
          if (title) titleRecords.push({ sessionId: id, title, status: "opened" });
          result.opened += 1;
        }
        remaining = remaining.filter((candidate) => candidate !== id);
        await writeIds(context, remaining, deadline, false, { remove: [id] });
      }
      if (!isAutoResumeAvailable()) await clearIds(context, Date.now() + STORAGE_TIMEOUT_MS);
      recordPersistentEvent("info", "auto-resume", "Startup recovery finished", { attempted: result.attempted, opened: result.opened, failed: result.failed.length, remaining: remaining.length });
      return result;
    } catch (error) {
      if (!isAutoResumeAvailable()) {
        await clearIds(context, Date.now() + STORAGE_TIMEOUT_MS * 2);
        return { attempted: 0, opened: 0, failed: [] };
      }
      throw error;
    } finally {
      controller.abort();
      changed?.dispose();
    }
  };
  return serialize(context, "restore", () => {
    const storage = getSqliteMementoStorage(context.workspaceState);
    return storage ? runCrossWindowExclusive(`auto-resume:${storage.namespace}`, "Auto Resume in this workspace", restore) : restore();
  }).finally(() => restoreControllers.delete(controller));
}

function isAutoResumeAvailable(): boolean {
  return isAutoResumeEnabled() || hasCodexSessionAutoResumeOptIn(resolveCodexHome());
}

export function formatAutoResumeResult(result: AutoResumeResult): string | undefined {
  if (!result.attempted) return undefined;
  if (!result.opened && !result.failed.length) return "Auto Resume checked saved conversations; none needed continuation.";
  const titles = autoResumeTitles.get(result) ?? [];
  const titleText = titles.filter((entry) => entry.status === "opened").slice(0, 3).map((entry) => `“${entry.title}”`).join(", ");
  if (!result.failed.length)
    return `Auto resume resumed ${result.opened} Codex conversation${result.opened === 1 ? "" : "s"} in VS Code${titleText ? `: ${titleText}` : ""}.`;
  const failures = result.failed.slice(0, 3).map(failure => titles.find(entry => entry.sessionId === failure.sessionId)?.title)
    .filter((title): title is string => Boolean(title)).map(title => `“${title}”`).join(", ");
  const extra = result.failed.length > 3 ? `; and ${result.failed.length - 3} more` : "";
  return `Auto resume resumed ${result.opened} of ${result.attempted} conversations in VS Code.${failures ? ` Pending: ${failures}${extra}.` : ` ${result.failed.length} still need recovery.`} Saved work was kept; open Codex to review.`;
}
