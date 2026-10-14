import * as fs from "fs/promises";
import * as path from "path";
import type { DashboardCodexSessionGoal } from "../domain/dashboard/types";

/** Optional native goal metadata; never create or migrate Codex's database. */
export async function readCodexSessionGoals(home: string): Promise<Map<string, DashboardCodexSessionGoal> | undefined> {
  let db: { prepare(sql: string): { all(): Record<string, unknown>[] }; close(): void } | undefined;
  try {
    const names = (await fs.readdir(home)).filter(name => /^goals_\d+\.sqlite$/.test(name));
    names.sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]));
    if (!names[0]) return undefined;
    const moduleName = "node:sqlite";
    const sqlite = await import(moduleName) as { DatabaseSync: new (file: string, options: { readOnly: boolean }) => NonNullable<typeof db> };
    db = new sqlite.DatabaseSync(path.join(home, names[0]), { readOnly: true });
    const goals = new Map<string, DashboardCodexSessionGoal>();
    for (const row of db.prepare("SELECT thread_id, substr(objective, 1, 4096) AS objective, status, time_used_seconds FROM thread_goals LIMIT 2000").all()) {
      const id = row["thread_id"], objective = row["objective"], status = row["status"], seconds = row["time_used_seconds"];
      if (typeof id !== "string" || typeof objective !== "string" || !objective.trim() || typeof status !== "string" || !/^[a-z_]{1,40}$/.test(status)) continue;
      goals.set(id, { objective: objective.trim(), status,
        elapsedMs: typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined });
    }
    return goals;
  } catch { return undefined; } // Older hosts and unavailable goal storage retain transcript-based display.
  finally { db?.close(); }
}
