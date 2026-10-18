import * as fs from "fs/promises";
import * as path from "path";
import type { DashboardCodexSessionGoal } from "../domain/dashboard/types";

/** Optional native goal metadata; never create or migrate Codex's database. */
export async function readCodexSessionGoals(home: string, sessionIds?: readonly string[], limit = 2000): Promise<Map<string, DashboardCodexSessionGoal> | undefined> {
  if (sessionIds?.length === 0) return new Map();
  let db: { prepare(sql: string): { all(...ids: string[]): Record<string, unknown>[] }; close(): void } | undefined;
  try {
    const names = (await fs.readdir(home)).filter(name => /^goals_\d+\.sqlite$/.test(name));
    names.sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]));
    if (!names[0]) return undefined;
    const moduleName = "node:sqlite";
    const sqlite = await import(moduleName) as { DatabaseSync: new (file: string, options: { readOnly: boolean }) => NonNullable<typeof db> };
    db = new sqlite.DatabaseSync(path.join(home, names[0]), { readOnly: true });
    const goals = new Map<string, DashboardCodexSessionGoal>();
    const columns = "SELECT thread_id, substr(objective, 1, 4096) AS objective, status, time_used_seconds FROM thread_goals";
    const ids = sessionIds ? [...new Set(sessionIds)] : undefined;
    for (let offset = 0; offset < (ids?.length ?? 1); offset += 500) {
      const batch = ids?.slice(offset,offset+500);
      const rows = batch ? db.prepare(`${columns} WHERE thread_id IN (${batch.map(() => "?").join(",")})`).all(...batch)
        : db.prepare(`${columns} LIMIT ${Math.max(1, Math.min(10001, Math.floor(limit)))}`).all();
      for (const row of rows) {
        const id = row["thread_id"], objective = row["objective"], status = row["status"], seconds = row["time_used_seconds"];
        if (typeof id !== "string" || typeof objective !== "string" || !objective.trim() || typeof status !== "string" || !/^[a-z_]{1,40}$/.test(status)) continue;
        goals.set(id, { objective: objective.trim(), status,
          elapsedMs: typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined });
      }
    }
    return goals;
  } catch { return undefined; } // Older hosts and unavailable goal storage retain transcript-based display.
  finally { db?.close(); }
}
