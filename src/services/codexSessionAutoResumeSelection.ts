import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { findCliSessionTranscripts, readRunningCodexSessionIds, resolveCodexHome } from "./codexSessionResume";
import { readSubAgentMetadata } from "../domain/sessionSource";
import { readSafeFileSnapshot } from "../utils/safeFileReads";

type SqliteDatabase = {
  prepare(sql: string): { get(id: string): Record<string, unknown> | undefined };
  close(): void;
};
type SqliteModule = { DatabaseSync: new (file: string, options: { readOnly: boolean }) => SqliteDatabase };

/** Optional runtime capability: never create or migrate Codex's databases. */
async function openMetadataDatabase(home: string, prefix: string): Promise<SqliteDatabase | undefined> {
  try {
    const names = await fs.readdir(home);
    const candidates = names.filter((name) => new RegExp(`^${prefix}_[0-9]+\\.sqlite$`).test(name));
    candidates.sort((a, b) => Number(b.split("_")[1]?.split(".")[0]) - Number(a.split("_")[1]?.split(".")[0]));
    if (!candidates[0]) return undefined;
    const moduleName = "node:sqlite";
    const sqlite = await import(moduleName) as SqliteModule;
    return new sqlite.DatabaseSync(path.join(home, candidates[0]), { readOnly: true });
  } catch {
    // Older extension hosts, missing files, and locked/corrupt databases use
    // the documented parent-session fallback rather than blocking a reload.
    return undefined;
  }
}

/** Select running parent sessions in this workspace, using active goals when available. */
export async function readAutoResumeCodexSessionIds(
  home = resolveCodexHome(),
  workspacePaths = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []
): Promise<string[]> {
  const running = await readRunningCodexSessionIds(home);
  if (!running.length) return [];
  const transcripts = await findCliSessionTranscripts(home, new Set(running));
  const state = await openMetadataDatabase(home, "state");
  const goals = await openMetadataDatabase(home, "goals");
  try {
    const parents: string[] = [];
    for (const id of running) {
      let metadata: Record<string, unknown> | undefined;
      try { metadata = state?.prepare("SELECT source, cwd FROM threads WHERE id = ?").get(id); } catch { /* use transcript */ }
      const transcript = transcripts.get(id);
      if (!metadata && transcript) {
        const raw = await readSafeFileSnapshot(transcript, { maxBytes: 1024 * 1024 })
          .then((snapshot) => snapshot.buffer.toString("utf8")).catch(() => "");
        for (const line of raw.split(/\r?\n/).slice(0, 12)) {
          try {
            const record = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
            if (record.type === "session_meta") { metadata = record.payload; break; }
          } catch { /* partial JSONL record */ }
        }
        // Source can still identify a child when a large metadata line is truncated.
        if (!metadata && /"source"\s*:\s*(?:\{\s*"sub[_-]?agent"|"sub[_-]?agent)/i.test(raw)) continue;
      }
      if (readSubAgentMetadata(metadata?.["source"]).subAgent) continue;
      const cwd = metadata?.["cwd"];
      if (workspacePaths.length && typeof cwd === "string" && cwd.trim() &&
          !workspacePaths.some((workspace) => {
            const relative = path.relative(path.resolve(workspace), path.resolve(cwd));
            return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
          })) continue;
      parents.push(id);
    }
    if (!goals) return parents;
    try {
      const query = goals.prepare("SELECT status FROM thread_goals WHERE thread_id = ?");
      return parents.filter((id) => query.get(id)?.["status"] === "active");
    } catch {
      // A schema mismatch or busy read makes detection unavailable for the
      // entire selection; never mix confirmed goal results with guesses.
      return parents;
    }
  } finally {
    state?.close();
    goals?.close();
  }
}
