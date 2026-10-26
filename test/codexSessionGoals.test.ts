import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as diagnostics from "../src/utils/persistentLog";
import { readCodexSessionGoals } from "../src/services/codexSessionGoals";
import { normalizeCodexSessionGoal } from "../src/domain/codexSessionState";

let home: string;
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), "codex-goal-display-")); });
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await rm(home, { recursive: true, force: true }); });

describe("native browser goal state", () => {
  it("logs only verified transitions, bounds their time, and never guesses an external actor", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(diagnostics, "recordPersistentEvent").mockImplementation(() => undefined);
    const db = new DatabaseSync(path.join(home, "goals_1.sqlite"));
    try {
      db.exec("CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY, objective TEXT, status TEXT, time_used_seconds INTEGER)");
      db.prepare("INSERT INTO thread_goals VALUES ('private-session', 'Private objective', 'active', 0)").run();
      vi.setSystemTime(new Date("2026-10-26T08:00:00Z"));
      await readCodexSessionGoals(home, ["private-session"]);
      vi.setSystemTime(new Date("2026-10-26T08:01:00Z"));
      await readCodexSessionGoals(home, ["private-session"]);
      expect(log).not.toHaveBeenCalled();
      db.exec("ALTER TABLE thread_goals RENAME TO unavailable");
      expect(await readCodexSessionGoals(home, ["private-session"])).toBeUndefined();
      db.exec("ALTER TABLE unavailable RENAME TO thread_goals; UPDATE thread_goals SET status='paused'");
      vi.setSystemTime(new Date("2026-10-26T08:02:00Z"));
      await readCodexSessionGoals(home, ["private-session"]);
      expect(log).toHaveBeenCalledExactlyOnceWith("info", "session-goal", "Goal state change observed", expect.objectContaining({
        previousStatus: "active", status: "paused", actor: "unknown", source: "official-goal-storage",
        previousObservedAt: "2026-10-26T08:01:00.000Z", observedAt: "2026-10-26T08:02:00.000Z"
      }));
      await readCodexSessionGoals(home, ["private-session"]);
      await readCodexSessionGoals(path.join(home, "missing-home"), ["private-session"]);
      expect(log).toHaveBeenCalledOnce();
      db.exec("UPDATE thread_goals SET objective=''");
      await readCodexSessionGoals(home, ["private-session"]);
      expect(log).toHaveBeenCalledOnce();
      db.exec("DELETE FROM thread_goals");
      await readCodexSessionGoals(home, ["unrelated-session"]);
      expect(log).toHaveBeenCalledOnce();
      await readCodexSessionGoals(home, ["private-session"]);
      expect(log).toHaveBeenLastCalledWith("info", "session-goal", "Goal state change observed", expect.objectContaining({ previousStatus: "paused", status: "none" }));
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/Private objective|private-session/);
    } finally { db.close(); }
  });
  it("reads committed goal metadata while the main app holds a WAL write transaction",async()=>{
    const db=new DatabaseSync(path.join(home,"goals_1.sqlite"));
    try {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY,objective TEXT,status TEXT,time_used_seconds INTEGER)");
      db.prepare("INSERT INTO thread_goals VALUES ('session',?,'active',1)").run("Goal ".repeat(2000));
      db.exec("BEGIN IMMEDIATE; UPDATE thread_goals SET status='paused'");
      const prior=(await readCodexSessionGoals(home,["session"]))?.get("session");
      expect(prior?.status).toBe("active");expect(prior?.objective.length).toBeLessThanOrEqual(4096);
      db.exec("COMMIT");
      expect((await readCodexSessionGoals(home,["session"]))?.get("session")?.status).toBe("paused");
    } finally {db.close();}
  });
  it("finds selected goals beyond the history limit and handles multiple query batches", async () => {
    const db = new DatabaseSync(path.join(home, "goals_1.sqlite"));
    try {
      db.exec("CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, objective TEXT, status TEXT, time_used_seconds INTEGER)");
      const insert = db.prepare("INSERT INTO thread_goals VALUES (?, 'Saved goal', 'active', 1)");
      db.exec("BEGIN");
      for (let index = 0; index < 2600; index++) insert.run(`session-${index}`);
      db.exec("COMMIT");
      expect((await readCodexSessionGoals(home))?.size).toBe(2000);
      const ids = Array.from({ length: 600 }, (_, index) => `session-${index + 2000}`);
      const selected = await readCodexSessionGoals(home, [...ids, ids[0]!, "missing"]);
      expect(selected?.size).toBe(600);
      expect(selected?.get("session-2599")).toMatchObject({ status: "active", elapsedMs: 1000 });
      db.exec("UPDATE thread_goals SET status='usage_limited' WHERE thread_id='session-2599'");
      expect((await readCodexSessionGoals(home, ["session-2599"]))?.get("session-2599")?.status).toBe("usage_limited");
      db.exec("DELETE FROM thread_goals WHERE thread_id='session-2599'");
      expect((await readCodexSessionGoals(home, ["session-2599"]))?.size).toBe(0);
      expect((await readCodexSessionGoals(home, []))?.size).toBe(0);
    } finally { db.close(); }
  });

  it("shows an existing goal without message history and reflects pause and deletion", async () => {
    const db = new DatabaseSync(path.join(home, "goals_1.sqlite"));
    try {
      db.exec("CREATE TABLE thread_goals (thread_id TEXT, objective TEXT, status TEXT, time_used_seconds INTEGER)");
      db.prepare("INSERT INTO thread_goals VALUES ('session', 'Implement all', 'active', 46840)").run();
      expect((await readCodexSessionGoals(home))?.get("session")).toMatchObject({ objective: "Implement all", status: "active", elapsedMs: 46840000 });
      db.exec("UPDATE thread_goals SET status='paused'");
      expect((await readCodexSessionGoals(home))?.get("session")?.status).toBe("paused");
      db.exec("DELETE FROM thread_goals");
      expect((await readCodexSessionGoals(home))?.size).toBe(0);
    } finally { db.close(); }
  });

  it("supports older hosts and unavailable, malformed, or partial goal storage", async () => {
    expect(await readCodexSessionGoals(home)).toBeUndefined();
    await writeFile(path.join(home, "goals_1.sqlite"), "partial");
    expect(await readCodexSessionGoals(home)).toBeUndefined();
    await rm(path.join(home, "goals_1.sqlite"));
    const db = new DatabaseSync(path.join(home, "goals_1.sqlite"));
    db.exec("CREATE TABLE thread_goals (thread_id TEXT, status TEXT)");
    db.close();
    expect(await readCodexSessionGoals(home)).toBeUndefined();
  });

  it("rejects malformed peer goal data and distinguishes an explicitly removed goal", () => {
    expect(normalizeCodexSessionGoal(null)).toBeNull();
    for (const value of [{ objective: "Goal", status: 42 }, { objective: "", status: "active" }, { objective: "Goal", status: "active", elapsedMs: -1 }, { objective: "Goal", status: "active", elapsedMs: Infinity }])
      expect(normalizeCodexSessionGoal(value)).toBeUndefined();
    expect(normalizeCodexSessionGoal({ objective: "Goal", status: "budget_limited", elapsedMs: 1000 })).toMatchObject({ status: "budget_limited" });
  });
});
