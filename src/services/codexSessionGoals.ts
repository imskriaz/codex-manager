import * as fs from "fs/promises";
import * as path from "path";
import type { DashboardCodexSessionGoal } from "../domain/dashboard/types";
import { getCodexHomeStateKey } from "../codex/authFile";
import { getSqliteStateStore } from "../storage/sqliteState";
import { createHash } from "node:crypto";
import { recordPersistentEvent } from "../utils/persistentLog";

const EXPLICIT_PAUSE_NAMESPACE = "session-goal-explicit-pause";
const explicitPauseFallback = new Set<string>();
const explicitPauseKey = (home: string, sessionId: string) => `${getCodexHomeStateKey(home)}:${sessionId.toLowerCase()}`;
const observedGoals = new Map<string, { status: string; observedAt: string }>();

function observeGoal(home: string, sessionId: string, status: string): void {
  const key = explicitPauseKey(home, sessionId);
  const previous = observedGoals.get(key);
  const observedAt = new Date().toISOString();
  // Observation time bounds a change; native storage does not identify its actor or exact time.
  if (previous && previous.status !== status) {
    recordPersistentEvent("info", "session-goal", "Goal state change observed", {
      sessionRef: createHash("sha256").update(sessionId).digest("hex").slice(0, 12),
      previousStatus: previous.status, status, previousObservedAt: previous.observedAt, observedAt,
      source: "official-goal-storage", actor: "unknown"
    });
  }
  observedGoals.delete(key);
  observedGoals.set(key, { status, observedAt });
  if (observedGoals.size > 10_000) { observedGoals.delete(observedGoals.keys().next().value!); }
}

/** Keep a user Pause distinct from a native/system interruption across windows and reloads. */
export function markExplicitSessionGoalPause(home: string, sessionId: string): void {
  const key = explicitPauseKey(home, sessionId);
  explicitPauseFallback.add(key);
  getSqliteStateStore()?.set(EXPLICIT_PAUSE_NAMESPACE, key, { at: Date.now() });
}

export function clearExplicitSessionGoalPause(home: string, sessionId: string): void {
  const key = explicitPauseKey(home, sessionId);
  explicitPauseFallback.delete(key);
  getSqliteStateStore()?.set(EXPLICIT_PAUSE_NAMESPACE, key, undefined);
}

export function isExplicitSessionGoalPause(home: string, sessionId: string): boolean {
  const key = explicitPauseKey(home, sessionId);
  return explicitPauseFallback.has(key) || getSqliteStateStore()?.get(EXPLICIT_PAUSE_NAMESPACE, key) !== undefined;
}

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
    const presentIds = new Set<string>();
    const columns = "SELECT thread_id, substr(objective, 1, 4096) AS objective, status, time_used_seconds FROM thread_goals";
    const ids = sessionIds ? [...new Set(sessionIds)] : undefined;
    for (let offset = 0; offset < (ids?.length ?? 1); offset += 500) {
      const batch = ids?.slice(offset,offset+500);
      const rows = batch ? db.prepare(`${columns} WHERE thread_id IN (${batch.map(() => "?").join(",")})`).all(...batch)
        : db.prepare(`${columns} LIMIT ${Math.max(1, Math.min(10001, Math.floor(limit)))}`).all();
      for (const row of rows) {
        const id = row["thread_id"], objective = row["objective"], status = row["status"], seconds = row["time_used_seconds"];
        if (typeof id === "string") { presentIds.add(id); }
        if (typeof id !== "string" || typeof objective !== "string" || !objective.trim() || typeof status !== "string" || !/^[a-z_]{1,40}$/.test(status)) continue;
        goals.set(id, { objective: objective.trim(), status,
          elapsedMs: typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined });
      }
    }
    for (const [id, goal] of goals) { observeGoal(home, id, goal.status); }
    for (const id of ids ?? []) {
      if (!presentIds.has(id) && observedGoals.has(explicitPauseKey(home, id))) { observeGoal(home, id, "none"); }
    }
    return goals;
  } catch { return undefined; } // Older hosts and unavailable goal storage retain transcript-based display.
  finally { db?.close(); }
}
