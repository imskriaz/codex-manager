import * as fs from "fs/promises";
import * as path from "path";
import {
  findCliSessionTranscripts,
  readOpenCodexSessionIds,
  readRunningCodexSessionIds,
  readQuotaInterruptedCodexSessionIds,
  resolveCodexHome
} from "./codexSessionResume";
import { readSubAgentMetadata } from "../domain/sessionSource";
import { readSafeFileSnapshot } from "../utils/safeFileReads";
import { getCodexManagerConfiguration } from "../infrastructure/config/extensionSettings";

type SqliteDatabase = {
  prepare(sql: string): { get(id: string): Record<string, unknown> | undefined; all(): Record<string, unknown>[] };
  close(): void;
};
type SqliteModule = { DatabaseSync: new (file: string, options: { readOnly: boolean }) => SqliteDatabase };

export function isAutoResumeGoalOnlyEnabled(): boolean {
  return getCodexManagerConfiguration().get<boolean>("autoResumeGoalOnlyEnabled", true) === true;
}

/** Goal absence is ineligible; unreadable goal state retains recovery for retry. */
export async function filterAutoResumeGoalSessionIds(
  ids: string[], home = resolveCodexHome(), signal?: AbortSignal, goalOnly = isAutoResumeGoalOnlyEnabled()
): Promise<string[]> {
  signal?.throwIfAborted();
  if (!goalOnly || !ids.length) return ids;
  let db: SqliteDatabase | undefined;
  try {
    const names = await fs.readdir(home).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const candidates = names.filter((name) => /^goals_[0-9]+\.sqlite$/.test(name));
    candidates.sort((a, b) => Number(b.split("_")[1]?.split(".")[0]) - Number(a.split("_")[1]?.split(".")[0]));
    if (!candidates[0]) return [];
    const moduleName = "node:sqlite";
    const sqlite = await import(moduleName) as SqliteModule;
    db = new sqlite.DatabaseSync(path.join(home, candidates[0]), { readOnly: true });
    const statement = db.prepare("SELECT status FROM thread_goals WHERE thread_id = ?");
    return ids.filter((id) => {
      signal?.throwIfAborted();
      const status = statement.get(id)?.["status"];
      return status === "active" || status === "usage_limited";
    });
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`Auto Resume could not verify active goals. Saved recovery was retained; retry after goal storage is available. ${error instanceof Error ? error.message : String(error)}`);
  } finally { db?.close(); }
}

/** Optional runtime capability: never create or migrate Codex's databases. */
async function openMetadataDatabase(home: string, prefix: string): Promise<SqliteDatabase | undefined> {
  try {
    const names = await fs.readdir(home);
    const candidates = names.filter((name) => new RegExp(`^${prefix}_[0-9]+\\.sqlite$`).test(name));
    candidates.sort((a, b) => Number(b.split("_")[1]?.split(".")[0]) - Number(a.split("_")[1]?.split(".")[0]));
    if (!candidates[0]) return undefined;
    const moduleName = "node:sqlite";
    const sqlite = (await import(moduleName)) as SqliteModule;
    return new sqlite.DatabaseSync(path.join(home, candidates[0]), { readOnly: true });
  } catch {
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
  selection: "running" | "open" = "running",
  goalOnly = isAutoResumeGoalOnlyEnabled(),
  runningSessionIds?: string[],
  candidateSessionIds?: string[]
): Promise<string[]> {
  signal?.throwIfAborted();
  let running = openSessionIds;
  if (selection === "running") {
    const goals = await openMetadataDatabase(home, "goals");
    let limited: string[] = [];
    try {
      limited = goals?.prepare("SELECT thread_id FROM thread_goals WHERE status='usage_limited' LIMIT 10001").all()
        .map(row => row["thread_id"]).filter((id): id is string => typeof id === "string" && (!candidateSessionIds || candidateSessionIds.includes(id))) ?? [];
    } catch { /* Optional goal metadata; transcript evidence remains available. */ }
    finally { goals?.close(); }
    if (limited.length > 10000) throw new Error("Quota recovery exceeded its safe discovery limit. Saved recovery was retained.");
    const interrupted = await readQuotaInterruptedCodexSessionIds(home, candidateSessionIds, signal, limited);
    const inspect = candidateSessionIds?.filter(id => !interrupted.includes(id));
    const live = runningSessionIds ?? (inspect?.length === 0 ? [] : await readRunningCodexSessionIds(home, signal, inspect));
    running = [...new Set([...live, ...interrupted])];
  }
  signal?.throwIfAborted();
  if (!running.length) return [];
  const transcripts = await findCliSessionTranscripts(home, new Set(running), signal);
  const state = await openMetadataDatabase(home, "state");
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
        } catch {
          /* use transcript */
        }
      }
      const transcript = transcripts.get(id);
      if (metadata?.["archived"] === 1 || transcript?.startsWith(path.join(home,"archived_sessions")+path.sep)) continue;
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
      if (readSubAgentMetadata(metadata?.["source"]).subAgent) continue;
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
    return filterAutoResumeGoalSessionIds(parents, home, signal, goalOnly);
  } finally {
    state?.close();
  }
}

function normalizeWorkspacePath(value: string): string {
  const trimmed = value
    .trim()
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "");
  return /^(?:[a-z]:[\\/]|\\\\)/i.test(trimmed) ? path.win32.resolve(trimmed) : path.resolve(trimmed);
}
