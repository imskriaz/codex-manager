import * as vscode from "vscode";
import { getCodexManagerConfiguration } from "../infrastructure/config/extensionSettings";
import { openCodexCliSessionInVsCode, readRunningCodexSessionIds } from "./codexSessionResume";

export const AUTO_RESUME_SESSION_IDS_KEY = "codexManager.autoResumeSessionIds";

type AutoResumeContext = Pick<vscode.ExtensionContext, "workspaceState">;

/**
 * Persist the sessions that are running at the reload boundary. The IDs are
 * intentionally stored in workspaceState so they survive both an extension
 * host restart and a full VS Code window reload without creating another file
 * format or exposing session metadata outside VS Code's storage.
 */
export async function persistRunningCodexSessions(
  context: AutoResumeContext,
  readRunningSessionIds: () => Promise<string[]> = () => readRunningCodexSessionIds()
): Promise<string[]> {
  if (!isAutoResumeAvailable()) {
    await context.workspaceState.update(AUTO_RESUME_SESSION_IDS_KEY, undefined);
    return [];
  }

  const runningSessionIds = await readRunningSessionIds();
  const sessionIds = runningSessionIds.filter((id, index, values) => values.indexOf(id) === index);
  await context.workspaceState.update(AUTO_RESUME_SESSION_IDS_KEY, sessionIds.length ? sessionIds : undefined);
  return sessionIds;
}

export async function consumePersistedCodexSessionIds(context: AutoResumeContext): Promise<string[]> {
  const value = context.workspaceState.get<unknown>(AUTO_RESUME_SESSION_IDS_KEY);
  await context.workspaceState.update(AUTO_RESUME_SESSION_IDS_KEY, undefined);
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((id): id is string => typeof id === "string" && id.length > 0);
}

export type AutoResumeResult = {
  attempted: number;
  opened: number;
  failed: Array<{ sessionId: string; message: string }>;
};

/** Reopen each persisted session and keep failures visible to the caller. */
export async function resumePersistedCodexSessions(
  context: AutoResumeContext,
  openSession: (sessionId: string) => Promise<void> = openCodexCliSessionInVsCode
): Promise<AutoResumeResult> {
  const sessionIds = await consumePersistedCodexSessionIds(context);
  if (!isAutoResumeAvailable()) {
    return { attempted: 0, opened: 0, failed: [] };
  }
  const result: AutoResumeResult = { attempted: sessionIds.length, opened: 0, failed: [] };
  for (const sessionId of sessionIds) {
    try {
      await openSession(sessionId);
      result.opened += 1;
    } catch (error) {
      result.failed.push({
        sessionId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return result;
}

function isAutoResumeAvailable(): boolean {
  const configuration = getCodexManagerConfiguration();
  return (
    configuration.get<boolean>("autoResumeEnabled", false) &&
    configuration.get<boolean>("cliIntegrationEnabled", false)
  );
}

export function formatAutoResumeResult(result: AutoResumeResult): string | undefined {
  if (!result.attempted) {
    return undefined;
  }
  if (!result.failed.length) {
    return `Auto resume reopened ${result.opened} running Codex session${result.opened === 1 ? "" : "s"}.`;
  }
  const failedIds = result.failed.map((failure) => failure.sessionId).join(", ");
  return `Auto resume reopened ${result.opened} of ${result.attempted} running Codex sessions. Failed to open: ${failedIds}.`;
}
