import * as vscode from "vscode";
import { getCodexManagerConfiguration } from "../infrastructure/config/extensionSettings";
import { openCodexSessionInVsCode } from "./codexSessionResume";
import { readAutoResumeCodexSessionIds } from "./codexSessionAutoResumeSelection";

export const AUTO_RESUME_SESSION_IDS_KEY = "codexManager.autoResumeSessionIds";

type AutoResumeContext = Pick<vscode.ExtensionContext, "workspaceState">;
const pendingOperations = new WeakMap<object, Promise<unknown>>();

function serialize<T>(context: AutoResumeContext, operation: () => Promise<T>): Promise<T> {
  const previous = pendingOperations.get(context.workspaceState) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  pendingOperations.set(context.workspaceState, next);
  void next
    .finally(() => {
      if (pendingOperations.get(context.workspaceState) === next) pendingOperations.delete(context.workspaceState);
    })
    .catch(() => undefined);
  return next;
}

function readPersistedSessionIds(context: AutoResumeContext): string[] {
  const value = context.workspaceState.get<unknown>(AUTO_RESUME_SESSION_IDS_KEY);
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((id): id is string => typeof id === "string")
            .map((id) => id.trim())
            .filter(Boolean)
        )
      ]
    : [];
}

/**
 * Persist the sessions that are running at the reload boundary. The IDs are
 * intentionally stored in workspaceState so they survive both an extension
 * host restart and a full VS Code window reload without creating another file
 * format or exposing session metadata outside VS Code's storage.
 */
export async function persistRunningCodexSessions(
  context: AutoResumeContext,
  readRunningSessionIds: () => Promise<string[]> = () => readAutoResumeCodexSessionIds()
): Promise<string[]> {
  return serialize(context, async () => {
    if (!isAutoResumeAvailable()) {
      await context.workspaceState.update(AUTO_RESUME_SESSION_IDS_KEY, undefined);
      return [];
    }

    const runningSessionIds = await readRunningSessionIds();
    const sessionIds = [
      ...new Set([...readPersistedSessionIds(context), ...runningSessionIds.map((id) => id.trim()).filter(Boolean)])
    ];
    await context.workspaceState.update(AUTO_RESUME_SESSION_IDS_KEY, sessionIds.length ? sessionIds : undefined);
    return sessionIds;
  });
}

export async function consumePersistedCodexSessionIds(context: AutoResumeContext): Promise<string[]> {
  return serialize(context, async () => {
    const sessionIds = readPersistedSessionIds(context);
    await context.workspaceState.update(AUTO_RESUME_SESSION_IDS_KEY, undefined);
    return sessionIds;
  });
}

export type AutoResumeResult = {
  attempted: number;
  opened: number;
  failed: Array<{ sessionId: string; message: string }>;
};

/** Reopen each persisted session and keep failures visible to the caller. */
export async function resumePersistedCodexSessions(
  context: AutoResumeContext,
  openSession: (sessionId: string, signal?: AbortSignal) => Promise<void> = openCodexSessionInVsCode
): Promise<AutoResumeResult> {
  return serialize(context, async () => {
    if (!isAutoResumeAvailable()) {
      await context.workspaceState.update(AUTO_RESUME_SESSION_IDS_KEY, undefined);
      return { attempted: 0, opened: 0, failed: [] };
    }
    const sessionIds = readPersistedSessionIds(context);
    // Validate storage before opening, but keep the record until each editor
    // acknowledges success. Failed or interrupted opens survive the next reload.
    await context.workspaceState.update(AUTO_RESUME_SESSION_IDS_KEY, sessionIds.length ? sessionIds : undefined);
    let remaining = [...sessionIds];
    const result: AutoResumeResult = { attempted: sessionIds.length, opened: 0, failed: [] };
    for (const sessionId of sessionIds) {
      const controller = new AbortController();
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            openSession(sessionId, controller.signal),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(
                  new Error("The Codex editor did not respond within 30 seconds. Open conversation history to retry.")
                );
              }, 30_000);
            })
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        result.opened += 1;
      } catch (error) {
        result.failed.push({
          sessionId,
          message: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
      // A failed acknowledgement leaves the old record intact and stops replay;
      // reopening the same URI is safe if the host dies between open and save.
      remaining = remaining.filter((id) => id !== sessionId);
      await context.workspaceState.update(AUTO_RESUME_SESSION_IDS_KEY, remaining.length ? remaining : undefined);
    }
    return result;
  });
}

function isAutoResumeAvailable(): boolean {
  return getCodexManagerConfiguration().get<boolean>("autoResumeEnabled", false);
}

export function formatAutoResumeResult(result: AutoResumeResult): string | undefined {
  if (!result.attempted) {
    return undefined;
  }
  if (!result.failed.length) {
    return `Auto resume reopened ${result.opened} running VS Code Codex session${result.opened === 1 ? "" : "s"}.`;
  }
  const failedSessions = result.failed.map((failure) => `${failure.sessionId} (${failure.message})`).join(", ");
  return `Auto resume reopened ${result.opened} of ${result.attempted} running VS Code Codex sessions. Failed to open: ${failedSessions}.`;
}
