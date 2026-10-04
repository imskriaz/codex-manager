import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import {
  findCliSessionTranscripts,
  readOpenCodexSessionIds,
  readRunningCodexSessionIds,
  resolveCodexHome
} from "./codexSessionResume";
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
    const sqlite = (await import(moduleName)) as SqliteModule;
    return new sqlite.DatabaseSync(path.join(home, candidates[0]), { readOnly: true });
  } catch {
    // Older extension hosts, missing files, and locked/corrupt databases use
    // the documented parent-session fallback rather than blocking a reload.
    return undefined;
  }
}

/** Select every running parent session in this workspace; sub-agents are excluded. */
export async function readAutoResumeCodexSessionIds(
  home = resolveCodexHome(),
  workspacePaths = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
  openSessionIds = readOpenCodexSessionIds(),
  signal?: AbortSignal
): Promise<string[]> {
  signal?.throwIfAborted();
  const running = await readRunningCodexSessionIds(home);
  signal?.throwIfAborted();
  if (!running.length) return [];
  const transcripts = await findCliSessionTranscripts(home, new Set(running));
  const state = await openMetadataDatabase(home, "state");
  try {
    const parents: string[] = [];
    for (const id of running) {
      signal?.throwIfAborted();
      if (!workspacePaths.length && !openSessionIds.includes(id)) continue;
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
      if (metadata?.["archived"] === 1) continue;
      const transcript = transcripts.get(id);
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
        workspacePaths.length &&
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
    return parents;
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
