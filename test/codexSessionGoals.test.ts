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
