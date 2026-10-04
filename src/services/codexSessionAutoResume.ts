import * as vscode from "vscode";
import { getCodexManagerConfiguration } from "../infrastructure/config/extensionSettings";
import { openCodexSessionInVsCode, SESSION_ID_PATTERN } from "./codexSessionResume";
import { readAutoResumeCodexSessionIds } from "./codexSessionAutoResumeSelection";

export const AUTO_RESUME_SESSION_IDS_KEY = "codexManager.autoResumeSessionIds";
export const MAX_AUTO_RESUME_SESSIONS = 200;
const OPERATION_TIMEOUT_MS = 30_000;
const STORAGE_TIMEOUT_MS = 5_000;
type AutoResumeContext = Pick<vscode.ExtensionContext, "workspaceState">;
type OperationKind = "capture" | "restore";
type Operations = { tail: Promise<unknown>; capture?: Promise<unknown>; restore?: Promise<unknown> };
const operations = new WeakMap<object, Operations>();
const pendingWrites = new WeakMap<object, Promise<void>>();
const recoveryIds = new WeakMap<object, string[]>();

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
      if (!owner.capture && !owner.restore) operations.delete(context.workspaceState);
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

function readPersistedSessionIds(context: AutoResumeContext): string[] {
  return normalizeIds([
    ...normalizeIds(context.workspaceState.get<unknown>(AUTO_RESUME_SESSION_IDS_KEY)),
    ...(recoveryIds.get(context.workspaceState) ?? [])
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

async function writeIds(context: AutoResumeContext, ids: string[], deadline: number): Promise<void> {
  // Memento mutates its cache before the write resolves. Retain the previous
  // recovery IDs in this host too, until storage acknowledges the replacement.
  const previous = readPersistedSessionIds(context);
  recoveryIds.set(context.workspaceState, normalizeIds([...previous, ...ids]));
  const write = Promise.resolve().then(() =>
    context.workspaceState.update(AUTO_RESUME_SESSION_IDS_KEY, ids.length ? ids : undefined)
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
  recoveryIds.delete(context.workspaceState);
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
    const ids = readPersistedSessionIds(context);
    if (!ids.length) return { attempted: 0, opened: 0, failed: [] };
    await writeIds(context, ids, deadline);
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
  return getCodexManagerConfiguration().get<boolean>("autoResumeEnabled", false);
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
