import { recordPersistentEvent } from "../utils/persistentLog";
import { onDidChangeConfiguration } from "../storage/configurationEvents";
import * as vscode from "vscode";
import { isAutoResumeEnabled } from "../infrastructure/config/extensionSettings";
import { closeOpenCodexSessionTabs, openCodexSessionInVsCode, readOpenCodexSessionIds, readRecentRunningCodexSessionIds, onDidInspectRunningCodexSessions, resolveCodexHome, SESSION_ID_PATTERN } from "./codexSessionResume";
import * as path from "path";
import { filterAutoResumeGoalSessionIds, readAutoResumeGoalCandidateIds, isAutoResumeGoalOnlyEnabled, readAutoResumeCodexSessionIds } from "./codexSessionAutoResumeSelection";
import { getSqliteMementoStorage, getSqliteStateStore } from "../storage/sqliteState";
import { runCrossWindowExclusive } from "../utils/crossWindowOperations";
import { getCodexHomeStateKey } from "../codex/authFile";

export const AUTO_RESUME_SESSION_IDS_KEY = "codexManager.autoResumeSessionIds";
export const AUTO_RESUME_OPEN_SESSION_IDS_KEY = "codexManager.autoResumeOpenSessionIds";
const AUTO_RESUME_HOME_KEY = "codexManager.autoResumeCodexHome";
export const MAX_AUTO_RESUME_SESSIONS = 200;
const OPERATION_TIMEOUT_MS = 30_000;
const PER_SESSION_OPEN_TIMEOUT_MS = 8_000;
const STORAGE_TIMEOUT_MS = 5_000;
type AutoResumeContext = Pick<vscode.ExtensionContext, "workspaceState">;
type OperationKind = "capture" | "restore" | "track";
type Operations = { tail: Promise<unknown>; capture?: Promise<unknown>; restore?: Promise<unknown>; track?: Promise<unknown> };
const operations = new WeakMap<object, Operations>();
const pendingWrites = new WeakMap<object, Promise<void>>();
const recoveryIds = new WeakMap<object, string[]>();
const openRecoveryIds = new WeakMap<object, string[]>();
const unrestoredOpenSnapshots = new WeakSet<object>();
const restoreControllers = new Set<AbortController>();

/** Stop optional startup restoration before a manual account switch changes auth state. */
export function cancelCodexSessionAutoResume(): void {
  for (const controller of restoreControllers) controller.abort(new Error("Auto Resume was cancelled because the account is changing."));
}

// At most one capture and one restore: repeated requests join the original.
function serialize<T>(context: AutoResumeContext, kind: OperationKind, operation: () => Promise<T>): Promise<T> {
  let state = operations.get(context.workspaceState);
  if (!state) {
    state = { tail: Promise.resolve() };
    operations.set(context.workspaceState, state);
  }
  if (state[kind]) return state[kind] as Promise<T>;
  const next = state.tail
    .catch(() => undefined)
    .then(() => {
      if (pendingWrites.has(context.workspaceState))
        throw new Error("A previous auto-resume storage write is still pending. Retry Reload after storage responds.");
      return operation();
    });
  state[kind] = next;
  state.tail = next;
  const owner = state;
  void next
    .finally(() => {
      delete owner[kind];
      if (!owner.capture && !owner.restore && !owner.track) operations.delete(context.workspaceState);
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

async function writeIds(context: AutoResumeContext, ids: string[], deadline: number, open = false, options: { remove?: string[]; consumeOpen?: string[] } = {}): Promise<void> {
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
  if (options.consumeOpen) {
    const previousOpen = readPersistedSessionIds(context, true);
    const remainingOpen = previousOpen.filter(id => !options.consumeOpen!.includes(id));
    if (remainingOpen.length !== previousOpen.length) await writeIds(context, remainingOpen, deadline, true);
  }
}

async function clearIds(context: AutoResumeContext, deadline: number): Promise<void> {
  if (!recoveryIds.has(context.workspaceState) && !openRecoveryIds.has(context.workspaceState) &&
      context.workspaceState.get(AUTO_RESUME_SESSION_IDS_KEY) === undefined &&
      context.workspaceState.get(AUTO_RESUME_OPEN_SESSION_IDS_KEY) === undefined) return;
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
}

/** Add verified running parents without dropping unacknowledged recovery. */
export function persistRunningCodexSessions(
  context: AutoResumeContext,
  readRunningSessionIds: (signal?: AbortSignal) => Promise<string[]> = (signal) =>
    readAutoResumeCodexSessionIds(undefined, undefined, undefined, signal, "running", undefined, readRecentRunningCodexSessionIds()),
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
      const ids = await bounded(() => filterAutoResumeGoalSessionIds(normalizeIds([
        ...readPersistedSessionIds(context), ...normalizeIds(running)
      ]), undefined, controller.signal), deadline - Date.now(),
        "Auto Resume could not verify goals before saving recovery.", controller.signal);
      if (goalOnly !== isAutoResumeGoalOnlyEnabled()) throw new Error("The goal-only preference changed during capture. Retry after preferences settle.");
      controller.signal.throwIfAborted();
      await writeIds(context, ids, deadline);
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

/** Replace the open-tab snapshot; failed restoration remains in its separate recovery queue. */
export function persistOpenCodexSessions(
  context: AutoResumeContext,
  readOpenParents: (signal?: AbortSignal) => Promise<string[]> = async (signal) => {
    const open = readOpenCodexSessionIds();
    const goalOnly = isAutoResumeGoalOnlyEnabled();
    const candidates = [...new Set([...open, ...(goalOnly ? await readAutoResumeGoalCandidateIds(undefined, signal) : [])])];
    if (!candidates.length) return [];
    recordPersistentEvent("debug", "auto-resume", "Recovery tracking inspected tabs and sidebar goals", { open, candidates, goalOnly });
    return readAutoResumeCodexSessionIds(undefined, goalOnly ? undefined : [], open, signal, "running", goalOnly,
      readRecentRunningCodexSessionIds(undefined, candidates), candidates);
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
      await writeIds(context, normalizeIds([
        ...readPersistedSessionIds(context), ...readPersistedSessionIds(context, true)
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
      const ids = await bounded(() => filterAutoResumeGoalSessionIds(discovered, undefined, controller.signal), deadline - Date.now(),
        "Auto Resume could not verify goals before saving open tabs.", controller.signal);
      if (goalOnly !== isAutoResumeGoalOnlyEnabled()) throw new Error("The goal-only preference changed during capture. Saved tabs were retained for retry.");
      if (!isAutoResumeAvailable()) {
        await clearIds(context, deadline);
        return [];
      }
      controller.signal.throwIfAborted();
      const previous = readPersistedSessionIds(context, true);
      if (openRecoveryIds.has(context.workspaceState) || previous.length !== ids.length || previous.some((id, index) => id !== ids[index])) {
        await writeIds(context, ids, deadline, true);
        recordPersistentEvent("info", "auto-resume", "Background recovery snapshot updated", { previousCount: previous.length, savedCount: ids.length });
        recordPersistentEvent("debug", "auto-resume", "Background recovery session IDs", { ids });
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

/** Install after startup restoration, so an initially empty editor cannot erase saved tabs. */
export function registerCodexSessionAutoResumeTracking(context: AutoResumeContext): vscode.Disposable {
  const controller = new AbortController();
  let dirty = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let savedSignature: string | undefined;
  const capture = () => {
    if (controller.signal.aborted || !isAutoResumeAvailable()) return;
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
            const goalOnly = isAutoResumeGoalOnlyEnabled();
            const open = readOpenCodexSessionIds().sort();
            const signature = isAutoResumeAvailable()
              ? `${goalOnly}:${open.join(",")}:${readRecentRunningCodexSessionIds(undefined, open)?.sort().join(",")}` : "disabled";
            // A goal may become active while the same tabs remain open.
            if (signature !== savedSignature || (isAutoResumeAvailable() && goalOnly)) {
              await persistOpenCodexSessions(context, undefined, controller.signal);
              savedSignature = signature;
            }
          } catch (error) {
            if (controller.signal.aborted) break;
            console.warn("[codexManager] open Codex tabs could not be saved for auto resume", error);
            // One bounded retry timer also handles metadata arriving after the tab event.
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
      savedSignature = undefined;
      capture();
    } else {
      tabs?.dispose();
      tabs = undefined;
      if (timer) clearTimeout(timer);
      timer = undefined;
      dirty = false;
      void serialize(context, "track", () => clearIds(context, Date.now() + STORAGE_TIMEOUT_MS * 2)).catch((error) =>
        console.warn("[codexManager] disabled Auto Resume recovery could not be cleared", error)
      );
    }
  };
  const configuration = onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("codexManager.autoResumeGoalOnlyEnabled") || event.affectsConfiguration("codexManager.autoResumeEnabled") ||
        event.affectsConfiguration("codexManager.autoSwitchEnabled")) refreshSubscription();
  });
  const inspections = onDidInspectRunningCodexSessions(home => {
    if (home === path.resolve(resolveCodexHome())) capture();
  });
  const stopStorage = getSqliteStateStore()?.subscribe(["session-status"], () => { savedSignature = undefined; capture(); });
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

/** Acknowledge each successful tab; leave failed/uncertain opens durable for retry. */
export function resumePersistedCodexSessions(
  context: AutoResumeContext,
  openSession: (sessionId: string, signal?: AbortSignal) => Promise<void> = (sessionId, signal) =>
    openCodexSessionInVsCode(sessionId, signal, true),
  closeSessions: (signal?: AbortSignal) => Promise<void> = closeOpenCodexSessionTabs
): Promise<AutoResumeResult> {
  const controller = new AbortController();
  restoreControllers.add(controller);
  const restore = async (): Promise<AutoResumeResult> => {
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    if (!isAutoResumeAvailable()) {
      recordPersistentEvent("info", "auto-resume", "Startup recovery disabled; saved recovery cleared");
      await clearIds(context, deadline);
      return { attempted: 0, opened: 0, failed: [] };
    }
    const changed = onDidChangeConfiguration((event) => {
      if (!isAutoResumeAvailable())
        controller.abort(new Error("Auto Resume was turned off. Remaining sessions were not reopened."));
      else if (event.affectsConfiguration("codexManager.autoResumeGoalOnlyEnabled"))
        controller.abort(new Error("The goal-only preference changed. Remaining sessions will be checked again on the next activation."));
    });
    try {
      controller.signal.throwIfAborted();
      unrestoredOpenSnapshots.add(context.workspaceState);
      const goalOnly = isAutoResumeGoalOnlyEnabled();
      const savedIds = normalizeIds([...readPersistedSessionIds(context), ...readPersistedSessionIds(context, true)]);
      recordPersistentEvent("info", "auto-resume", "Startup recovery loaded", { savedCount: savedIds.length, goalOnly });
      recordPersistentEvent("debug", "auto-resume", "Startup recovery session IDs", { ids: savedIds });
      const ids = await bounded(() => filterAutoResumeGoalSessionIds(savedIds, undefined, controller.signal), deadline - Date.now(),
        "Auto Resume could not verify goals within 30 seconds. Saved recovery was retained.", controller.signal);
      if (!isAutoResumeAvailable()) {
        await clearIds(context, Date.now() + STORAGE_TIMEOUT_MS * 2);
        return { attempted: 0, opened: 0, failed: [] };
      }
      if (goalOnly !== isAutoResumeGoalOnlyEnabled()) throw new Error("The goal-only preference changed during discovery. Retry to verify the saved sessions.");
      recordPersistentEvent("info", "auto-resume", "Startup goal filtering completed", { savedCount: savedIds.length, eligibleCount: ids.length });
      if (savedIds.length) await writeIds(context, ids, deadline, false, { remove: savedIds, consumeOpen: savedIds });
      if (!ids.length) {
        unrestoredOpenSnapshots.delete(context.workspaceState);
        return { attempted: 0, opened: 0, failed: [] };
      }
      unrestoredOpenSnapshots.delete(context.workspaceState);
      let remaining = [...ids];
      const result: AutoResumeResult = { attempted: ids.length, opened: 0, failed: [] };
      try {
        controller.signal.throwIfAborted();
        await bounded(() => closeSessions(controller.signal), Math.min(8_000, deadline - Date.now()),
          "Previous Codex tabs did not finish closing within 8 seconds. Saved recovery was retained.", controller.signal);
        controller.signal.throwIfAborted();
        recordPersistentEvent("info", "auto-resume", "Previous conversation tabs closed before recovery", { count: ids.length });
      } catch (error) {
        controller.abort(error);
        result.failed = ids.map(sessionId => ({ sessionId, message: error instanceof Error ? error.message : String(error) }));
        recordPersistentEvent("warning", "auto-resume", "Previous tabs could not close; recovery retained", { count: ids.length }, error);
        if (!isAutoResumeAvailable()) await clearIds(context, Date.now() + STORAGE_TIMEOUT_MS * 2);
        return result;
      }
      for (const id of ids) {
        if (!isAutoResumeAvailable())
          controller.abort(new Error("Auto Resume was turned off. Remaining sessions were not reopened."));
        if (Date.now() >= deadline)
          controller.abort(
            new Error(
              "Auto Resume reached its 30 second deadline. Remaining sessions will retry on the next activation."
            )
          );
        try {
          controller.signal.throwIfAborted();
          if (!(await bounded(() => filterAutoResumeGoalSessionIds([id], undefined, controller.signal), deadline - Date.now(),
            "Auto Resume could not verify this session's goal before its deadline.", controller.signal)).length) {
            recordPersistentEvent("info", "auto-resume", "Session skipped because goal is no longer eligible", { sessionId: id });
            remaining = remaining.filter((candidate) => candidate !== id);
            await writeIds(context, remaining, deadline, false, { remove: [id] });
            continue;
          }
          recordPersistentEvent("debug", "auto-resume", "Opening saved conversation", { sessionId: id });
          const sessionController = new AbortController();
          const stopSession = () => sessionController.abort(controller.signal.reason);
          controller.signal.addEventListener("abort", stopSession, { once: true });
          try {
            await bounded(
            () => openSession(id, sessionController.signal),
            Math.min(PER_SESSION_OPEN_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
            "This Codex window did not finish opening within 8 seconds. The remaining sessions will continue opening; this one will retry on the next activation.",
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
          recordPersistentEvent("warning", "auto-resume", "Conversation open failed; recovery retained", { sessionId: id }, error);
          result.failed.push({ sessionId: id, message: error instanceof Error ? error.message : String(error) });
          continue;
        }
        recordPersistentEvent("info", "auto-resume", "Conversation reopened", { sessionId: id });
        result.opened += 1;
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
  return isAutoResumeEnabled();
}

export function formatAutoResumeResult(result: AutoResumeResult): string | undefined {
  if (!result.attempted) return undefined;
  if (!result.failed.length)
    return `Auto resume reopened ${result.opened} running VS Code Codex session${result.opened === 1 ? "" : "s"}.`;
  // Bound notification size even when every pending tab failed.
  const failures = result.failed
    .slice(0, 3)
    .map((failure) => `${failure.sessionId} (${failure.message.slice(0, 300)})`)
    .join(", ");
  const extra = result.failed.length > 3 ? `; and ${result.failed.length - 3} more` : "";
  return `Auto resume reopened ${result.opened} of ${result.attempted} running VS Code Codex sessions. Failed to open: ${failures}${extra}.`;
}
