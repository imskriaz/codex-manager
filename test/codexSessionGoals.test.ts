import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCodexSessionGoals } from "../src/services/codexSessionGoals";
import { normalizeCodexSessionGoal } from "../src/domain/codexSessionState";

let home: string;
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), "codex-goal-display-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe("native browser goal state", () => {
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
