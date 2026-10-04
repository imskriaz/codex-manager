import * as vscode from "vscode";
import { isAutoResumeEnabled } from "../infrastructure/config/extensionSettings";
import { openCodexSessionInVsCode, readOpenCodexSessionIds, SESSION_ID_PATTERN } from "./codexSessionResume";
import { readAutoResumeCodexSessionIds } from "./codexSessionAutoResumeSelection";

export const AUTO_RESUME_SESSION_IDS_KEY = "codexManager.autoResumeSessionIds";
export const AUTO_RESUME_OPEN_SESSION_IDS_KEY = "codexManager.autoResumeOpenSessionIds";
export const MAX_AUTO_RESUME_SESSIONS = 200;
const OPERATION_TIMEOUT_MS = 30_000;
const STORAGE_TIMEOUT_MS = 5_000;
type AutoResumeContext = Pick<vscode.ExtensionContext, "workspaceState">;
type OperationKind = "capture" | "restore" | "track";
type Operations = { tail: Promise<unknown>; capture?: Promise<unknown>; restore?: Promise<unknown>; track?: Promise<unknown> };
const operations = new WeakMap<object, Operations>();
const pendingWrites = new WeakMap<object, Promise<void>>();
const recoveryIds = new WeakMap<object, string[]>();
const openRecoveryIds = new WeakMap<object, string[]>();
const unrestoredOpenSnapshots = new WeakSet<object>();

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

async function writeIds(context: AutoResumeContext, ids: string[], deadline: number, open = false): Promise<void> {
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
}

async function clearIds(context: AutoResumeContext, deadline: number): Promise<void> {
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

/** Save running parent IDs at a managed reload boundary without losing pending recovery. */
export function persistRunningCodexSessions(
  context: AutoResumeContext,
  readRunningSessionIds: (signal?: AbortSignal) => Promise<string[]> = (signal) =>
    readAutoResumeCodexSessionIds(undefined, undefined, undefined, signal)
): Promise<string[]> {
  return serialize(context, "capture", async () => {
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    if (!isAutoResumeAvailable()) {
      await clearIds(context, deadline);
      return [];
    }
    const controller = new AbortController();
    const changed = vscode.workspace.onDidChangeConfiguration(() => {
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
        if (!controller.signal.aborted) {
          controller.abort(error);
          throw error;
        }
        await clearIds(context, deadline);
        return [];
      }
      if (controller.signal.aborted || !isAutoResumeAvailable()) {
        await clearIds(context, deadline);
        return [];
      }
      const ids = normalizeIds([...readPersistedSessionIds(context), ...normalizeIds(running)]);
      await writeIds(context, ids, deadline);
      if (controller.signal.aborted || !isAutoResumeAvailable()) {
        await clearIds(context, deadline);
        return [];
      }
      return ids;
    } finally {
      changed?.dispose();
    }
  });
}

export type AutoResumeResult = {
  attempted: number;
  opened: number;
  failed: Array<{ sessionId: string; message: string }>;
};

/** Replace the open-tab snapshot; failed restoration remains in its separate recovery queue. */
export function persistOpenCodexSessions(
  context: AutoResumeContext,
  readOpenParents: (signal?: AbortSignal) => Promise<string[]> = (signal) =>
    readAutoResumeCodexSessionIds(undefined, undefined, undefined, signal, "open"),
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
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const changed = vscode.workspace.onDidChangeConfiguration(() => {
      if (!isAutoResumeAvailable()) controller.abort(new Error("Auto Resume was turned off."));
    });
    try {
      const ids = normalizeIds(await bounded(() => readOpenParents(controller.signal), OPERATION_TIMEOUT_MS,
        "Open Codex session discovery did not respond within 30 seconds. Saved tabs will retry later.", controller.signal));
      if (!isAutoResumeAvailable()) {
        await clearIds(context, deadline);
        return [];
      }
      controller.signal.throwIfAborted();
      const previous = readPersistedSessionIds(context, true);
      if (openRecoveryIds.has(context.workspaceState) || previous.length !== ids.length || previous.some((id, index) => id !== ids[index]))
        await writeIds(context, ids, deadline, true);
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
  let reported = false;
  let savedSignature: string | undefined;
  const capture = () => {
    if (controller.signal.aborted) return;
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
            const signature = `${isAutoResumeAvailable()}:${readOpenCodexSessionIds().sort().join(",")}`;
            if (signature !== savedSignature) {
              await persistOpenCodexSessions(context, undefined, controller.signal);
              savedSignature = signature;
            }
            reported = false;
          } catch (error) {
            if (controller.signal.aborted) break;
            console.warn("[codexManager] open Codex tabs could not be saved for auto resume", error);
            if (!reported) {
              reported = true;
              void vscode.window.showWarningMessage(
                `Auto Resume could not save open Codex tabs: ${error instanceof Error ? error.message : String(error)}. It will retry automatically.`
              );
            }
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
  const tabs = vscode.window.tabGroups?.onDidChangeTabs?.(capture);
  const configuration = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("codexManager.autoResumeEnabled") ||
        event.affectsConfiguration("codexManager.autoSwitchEnabled")) capture();
  });
  capture();
  return { dispose: () => {
    if (controller.signal.aborted) return;
    controller.abort(new Error("Codex Manager is shutting down."));
    if (timer) clearTimeout(timer);
    tabs?.dispose();
    configuration?.dispose();
  } };
}

/** Acknowledge each successful tab; leave failed/uncertain opens durable for retry. */
export function resumePersistedCodexSessions(
  context: AutoResumeContext,
  openSession: (sessionId: string, signal?: AbortSignal) => Promise<void> = openCodexSessionInVsCode
): Promise<AutoResumeResult> {
  return serialize(context, "restore", async () => {
    const deadline = Date.now() + OPERATION_TIMEOUT_MS;
    if (!isAutoResumeAvailable()) {
      await clearIds(context, deadline);
      return { attempted: 0, opened: 0, failed: [] };
    }
    unrestoredOpenSnapshots.add(context.workspaceState);
    const ids = normalizeIds([...readPersistedSessionIds(context), ...readPersistedSessionIds(context, true)]);
    if (!ids.length) {
      unrestoredOpenSnapshots.delete(context.workspaceState);
      return { attempted: 0, opened: 0, failed: [] };
    }
    await writeIds(context, ids, deadline);
    unrestoredOpenSnapshots.delete(context.workspaceState);
    let remaining = [...ids];
    const result: AutoResumeResult = { attempted: ids.length, opened: 0, failed: [] };
    const controller = new AbortController();
    const changed = vscode.workspace.onDidChangeConfiguration(() => {
      if (!isAutoResumeAvailable())
        controller.abort(new Error("Auto Resume was turned off. Remaining sessions were not reopened."));
    });
    try {
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
          await bounded(
            () => openSession(id, controller.signal),
            deadline - Date.now(),
            "The Codex editor did not respond within 30 seconds. Remaining sessions will retry on the next activation.",
            controller.signal
          );
        } catch (error) {
          // An editor command cannot be recalled once VS Code accepted it. Abort
          // before activation can dispatch it, and retain uncertain IDs for replay.
          if (Date.now() >= deadline) controller.abort(error);
          result.failed.push({ sessionId: id, message: error instanceof Error ? error.message : String(error) });
          continue;
        }
        result.opened += 1;
        remaining = remaining.filter((candidate) => candidate !== id);
        await writeIds(context, remaining, deadline);
      }
      if (!isAutoResumeAvailable()) await clearIds(context, Date.now() + STORAGE_TIMEOUT_MS);
      return result;
    } finally {
      changed?.dispose();
    }
  });
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
