import { recordPersistentEvent } from "../utils/persistentLog";
import * as fs from "fs/promises";
import * as path from "path";
import {
  findCliSessionTranscripts,
  readOpenCodexSessionIds,
  readRunningCodexSessionIds,
  readCompletedCodexSessionIds,
  readQuotaInterruptedCodexSessionIds,
  resolveCodexHome,
  SESSION_ID_PATTERN
} from "./codexSessionResume";
import { readSubAgentMetadata } from "../domain/sessionSource";
import { readSafeFileSnapshot } from "../utils/safeFileReads";
import { getCodexManagerConfiguration } from "../infrastructure/config/extensionSettings";
import { normalizeNativePath } from "../utils/nativePaths";
import { isExplicitSessionGoalPause } from "./codexSessionGoals";

type SqliteDatabase = {
  prepare(sql: string): { get(id: string): Record<string, unknown> | undefined; all(): Record<string, unknown>[] };
  close(): void;
};
type SqliteModule = { DatabaseSync: new (file: string, options: { readOnly: boolean }) => SqliteDatabase };

export function isAutoResumeGoalOnlyEnabled(): boolean {
  return getCodexManagerConfiguration().get<boolean>("autoResumeGoalOnlyEnabled", true) === true;
}

/** Explicitly paused or terminal goals never auto-resume; interrupted pauses are checked separately. */
export async function filterAutoResumeGoalSessionIds(
  ids: string[], home = resolveCodexHome(), signal?: AbortSignal, goalOnly = isAutoResumeGoalOnlyEnabled(), includeInterruptedPaused = false
): Promise<string[]> {
  signal?.throwIfAborted();
  if (!ids.length) return ids;
  let db: SqliteDatabase | undefined;
  try {
    db = await openGoalDatabase(home);
    if (!db) {
      return goalOnly ? [] : ids;
    }
    const statement = db.prepare("SELECT status FROM thread_goals WHERE thread_id = ?");
    return ids.filter((id) => {
      signal?.throwIfAborted();
      const status = statement.get(id)?.["status"];
      const eligible = status === "active" || status === "usage_limited" || (status === "paused" && includeInterruptedPaused && !isExplicitSessionGoalPause(home, id)) || (status === undefined && !goalOnly);
      return eligible;
    });
  } catch (error) {
    signal?.throwIfAborted();
    recordPersistentEvent("warning", "auto-resume", "Goal verification failed; recovery retained", { count: ids.length }, error);
    throw new Error(`Auto Resume could not verify active goals. Saved recovery was retained; retry after goal storage is available. ${error instanceof Error ? error.message : String(error)}`);
  } finally { db?.close(); }
}

async function openGoalDatabase(home: string): Promise<SqliteDatabase | undefined> {
  const names = await fs.readdir(home).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const candidates = names.filter(name => /^goals_[0-9]+\.sqlite$/.test(name));
  candidates.sort((a, b) => Number(b.split("_")[1]?.split(".")[0]) - Number(a.split("_")[1]?.split(".")[0]));
  if (!candidates[0]) return undefined;
  const moduleName = "node:sqlite";
  const sqlite = await import(moduleName) as SqliteModule;
  return new sqlite.DatabaseSync(path.join(home, candidates[0]), { readOnly: true });
}

/** Sidebar goals have no conversation tab; inspect only these bounded candidates. */
export async function readAutoResumeGoalCandidateIds(home = resolveCodexHome(), signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const db = await openGoalDatabase(home);
  if (!db) return [];
  try {
    const rows = db.prepare("SELECT thread_id FROM thread_goals WHERE status IN ('active','usage_limited') LIMIT 10001").all();
    signal?.throwIfAborted();
    if (rows.length > 10000) throw new Error("Goal recovery exceeded its safe discovery limit. Saved recovery was retained.");
    return rows.map(row => row["thread_id"]).filter((id): id is string => typeof id === "string" && SESSION_ID_PATTERN.test(id));
  } finally { db.close(); }
}

/** Optional runtime capability: never create or migrate Codex's databases. */
async function openMetadataDatabase(home: string, prefix: string, strict = false): Promise<SqliteDatabase | undefined> {
  try {
    const names = await fs.readdir(home);
    const candidates = names.filter((name) => new RegExp(`^${prefix}_[0-9]+\\.sqlite$`).test(name));
    candidates.sort((a, b) => Number(b.split("_")[1]?.split(".")[0]) - Number(a.split("_")[1]?.split(".")[0]));
    if (!candidates[0]) return undefined;
    const moduleName = "node:sqlite";
    const sqlite = (await import(moduleName)) as SqliteModule;
    return new sqlite.DatabaseSync(path.join(home, candidates[0]), { readOnly: true });
  } catch (error) {
    if (strict) throw error;
    // Older extension hosts, missing files, and locked/corrupt databases use
    // the documented parent-session fallback rather than blocking a reload.
    return undefined;
  }
}

/** Capture all local running parents by default; explicit workspace paths can restrict a caller. */
export async function readAutoResumeCodexSessionIds(
  home = resolveCodexHome(),
  workspacePaths?: string[],
  openSessionIds = readOpenCodexSessionIds(),
  signal?: AbortSignal,
  selection: "running" | "open" | "recovery" = "running",
  goalOnly = isAutoResumeGoalOnlyEnabled(),
  runningSessionIds?: string[],
  candidateSessionIds?: string[],
  previouslyRunningSessionIds: string[] = []
): Promise<string[]> {
  signal?.throwIfAborted();
  let running = openSessionIds;
  if (selection === "running") {
    const goals = previouslyRunningSessionIds.length ? await openMetadataDatabase(home, "goals") : undefined;
    let pendingGoals: string[] = [];
    try {
      pendingGoals = goals?.prepare("SELECT thread_id, status FROM thread_goals WHERE status IN ('active','usage_limited','paused') LIMIT 10001").all()
        .filter(row => row["status"] !== "paused" || !isExplicitSessionGoalPause(home, String(row["thread_id"])))
        .map(row => row["thread_id"]).filter((id): id is string => typeof id === "string" && previouslyRunningSessionIds.includes(id)) ?? [];
    } catch { /* Optional goal metadata; transcript evidence remains available. */ }
    finally { goals?.close(); }
    if (pendingGoals.length > 10000) throw new Error("Goal recovery exceeded its safe discovery limit. Saved recovery was retained.");
    const interrupted = previouslyRunningSessionIds.length ? await readQuotaInterruptedCodexSessionIds(home, previouslyRunningSessionIds, signal, pendingGoals, true) : [];
    const retained = [...new Set([...pendingGoals, ...interrupted])];
    const inspect = candidateSessionIds?.filter(id => !retained.includes(id));
    const live = runningSessionIds ?? (inspect?.length === 0 ? [] : await readRunningCodexSessionIds(home, signal, inspect));
    running = [...new Set([...live, ...retained])];
  }
  signal?.throwIfAborted();
  if (!running.length) return [];
  if (selection === "recovery") {
    const completed = new Set(await readCompletedCodexSessionIds(home, running, signal));
    const goals = completed.size ? await openGoalDatabase(home) : undefined;
    try {
      const status = goals?.prepare("SELECT status FROM thread_goals WHERE thread_id = ?");
      // A finished turn does not finish an active goal.
      running = running.filter(id => {
        if (!completed.has(id)) return true;
        const rawStatus = status?.get(id)?.["status"];
        const goalStatus = typeof rawStatus === "string" ? rawStatus : "";
        return ["active", "usage_limited"].includes(goalStatus) || (goalStatus === "paused" && !isExplicitSessionGoalPause(home, id));
      });
    } finally { goals?.close(); }
    if (!running.length) return [];
  }
  const transcripts = await findCliSessionTranscripts(home, new Set(running), signal);
  const state = await openMetadataDatabase(home, "state", selection === "recovery");
  try {
    const parents: string[] = [];
    for (const id of running) {
      signal?.throwIfAborted();
      if (workspacePaths && !workspacePaths.length && !openSessionIds.includes(id)) continue;
      let metadata: Record<string, unknown> | undefined;
      try {
        metadata = state?.prepare("SELECT source, cwd, archived FROM threads WHERE id = ?").get(id);
      } catch {
        try {
          metadata = state?.prepare("SELECT source, cwd FROM threads WHERE id = ?").get(id);
        } catch (error) {
          if (selection === "recovery") throw error;
          /* use transcript */
        }
      }
      const transcript = transcripts.get(id);
      if (metadata?.["archived"] === 1 || (metadata?.["archived"] !== 0 && transcript?.startsWith(path.join(home,"archived_sessions")+path.sep))) {
        continue;
      }
      if ((typeof metadata?.["source"] !== "string" || !metadata?.["source"] || !metadata?.["cwd"]) && transcript) {
        let parsedMetadata = false;
        const raw = await readSafeFileSnapshot(transcript, { maxBytes: 1024 * 1024 })
          .then((snapshot) => snapshot.buffer.toString("utf8"))
          .catch(() => "");
        for (const line of raw.split(/\r?\n/).slice(0, 12)) {
          try {
            const record = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
            if (record.type === "session_meta" && record.payload && typeof record.payload === "object") {
              parsedMetadata = true;
              const payload = record.payload;
              if (readSubAgentMetadata(payload["source"]).subAgent) {
                metadata = payload;
                break;
              }
              metadata = {
                ...payload,
                ...metadata,
                source: metadata?.["source"] || payload["source"],
                cwd: metadata?.["cwd"] || payload["cwd"]
              };
              break;
            }
          } catch {
            /* partial JSONL record */
          }
        }
        // Source can still identify a child when a large metadata line is truncated.
        if (
          !parsedMetadata &&
          /"source"\s*:\s*(?:\{\s*"sub[_-]?agent"|"sub[_-]?agent)/i.test(raw.split(/\r?\n/)[0] ?? "")
        )
          continue;
      }
      if (readSubAgentMetadata(metadata?.["source"]).subAgent) {
        continue;
      }
      if (typeof metadata?.["source"] !== "string" || !metadata["source"].trim()) {
        throw new Error(
          "Running Codex session metadata is missing or incomplete. Retry Reload after Codex finishes writing it."
        );
      }
      const cwd = metadata?.["cwd"];
      if (
        !openSessionIds.includes(id) &&
        workspacePaths?.length &&
        (!(typeof cwd === "string" && cwd.trim()) ||
          !workspacePaths.some((workspace) => {
            const root = normalizeWorkspacePath(workspace);
            const paths = /^(?:[a-z]:[\\/]|\\\\)/i.test(root) ? path.win32 : path;
            const relative = paths.relative(root, normalizeWorkspacePath(cwd));
            return (
              relative === "" ||
              (!relative.startsWith(`..${paths.sep}`) && relative !== ".." && !paths.isAbsolute(relative))
            );
          }))
      )
        continue;
      parents.push(id);
    }
    return filterAutoResumeGoalSessionIds(parents, home, signal, goalOnly, selection === "recovery" || (selection === "running" && previouslyRunningSessionIds.length > 0));
  } finally {
    state?.close();
  }
}

function normalizeWorkspacePath(value: string): string {
  const trimmed = normalizeNativePath(value.trim());
  return /^(?:[a-z]:[\\/]|\\\\)/i.test(trimmed) ? path.win32.resolve(trimmed) : path.resolve(trimmed);
}
