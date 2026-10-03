import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { readAutoResumeCodexSessionIds } from "../src/services/codexSessionAutoResumeSelection";
import { getDashboardCopy } from "../src/application/dashboard/copy";

const roots: string[] = [];
const ids = ["01a04882-d037-7a42-ad24-9afb61901188", "01a04882-d037-7a42-ad24-9afb61901189", "01a04882-d037-7a42-ad24-9afb61901190"];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(sources: unknown[] = ["vscode", { subagent: { thread_spawn: { parent_thread_id: ids[0] } } }, "vscode"]) {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-auto-selection-"));
  roots.push(home);
  await mkdir(path.join(home, "thread-writer-locks"));
  await mkdir(path.join(home, "sessions"));
  for (const [index, id] of ids.entries()) {
    await writeFile(path.join(home, "thread-writer-locks", `${id}.lock`), "");
    await writeFile(path.join(home, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, source: sources[index], cwd: home } }) + "\n");
  }
  return home;
}
function goals(home: string, statuses: Array<string | null>) {
  const db = new DatabaseSync(path.join(home, "goals_1.sqlite"));
  db.exec("CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, status TEXT)");
  for (const [index, status] of statuses.entries()) if (status) db.prepare("INSERT INTO thread_goals VALUES (?, ?)").run(ids[index]!, status);
  db.close();
}
describe("goal-aware auto resume selection", () => {
  it("selects all running active-goal parents and excludes a child with its own goal", async () => {
    const home = await fixture(); goals(home, ["active", "active", "active"]);
    expect(await readAutoResumeCodexSessionIds(home, [home])).toEqual([ids[0], ids[2]]);
  });
  it.each(["paused", "blocked", "complete", "usage_limited", "budget_limited"])("does not resume %s or goal-less sessions", async (status) => {
    const home = await fixture(); goals(home, [status, "active", null]);
    expect(await readAutoResumeCodexSessionIds(home)).toEqual([]);
  });
  it("does not resume when goal state is unavailable", async () => {
    const home = await fixture(); expect(await readAutoResumeCodexSessionIds(home)).toEqual([]);
  });
  it("does not resume when the database is corrupt or its schema is unavailable", async () => {
    const home = await fixture(); await writeFile(path.join(home, "goals_1.sqlite"), "corrupt");
    expect(await readAutoResumeCodexSessionIds(home)).toEqual([]);
    await rm(path.join(home, "goals_1.sqlite"));
    const db = new DatabaseSync(path.join(home, "goals_1.sqlite")); db.exec("CREATE TABLE future_schema (id TEXT)"); db.close();
    expect(await readAutoResumeCodexSessionIds(home)).toEqual([]);
  });
  it("does not select sessions belonging to another workspace", async () => {
    const home = await fixture(); goals(home, ["active", "active", "active"]);
    expect(await readAutoResumeCodexSessionIds(home, [path.join(home, "other-project")])).toEqual([]);
  });
  it("uses state metadata to exclude children even when transcripts are missing", async () => {
    const home = await fixture(); goals(home, ["active", "active", "active"]); await rm(path.join(home, "sessions"), { recursive: true });
    const db = new DatabaseSync(path.join(home, "state_5.sqlite")); db.exec("CREATE TABLE threads (id TEXT, source TEXT, cwd TEXT)");
    db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(ids[1]!, JSON.stringify({ subagent: "review" }), home); db.close();
    expect(await readAutoResumeCodexSessionIds(home)).toEqual([ids[0], ids[2]]);
  });
  it("skips child metadata in a truncated record and retains unknown parent metadata", async () => {
    const home = await fixture(); goals(home, ["active", "active", "active"]);
    await writeFile(path.join(home, "sessions", `rollout-${ids[1]}.jsonl`), '{"type":"session_meta","payload":{"source":{"subagent":"review"},"instructions":"' + "x".repeat(1100000));
    await writeFile(path.join(home, "sessions", `rollout-${ids[2]}.jsonl`), "partial");
    expect(await readAutoResumeCodexSessionIds(home)).toEqual([ids[0], ids[2]]);
  });
  it("does not reopen stale locks after a stopped process or reboot", async () => {
    const home = await fixture(); const old = new Date(Date.now() - 60 * 60 * 1000);
    for (const id of ids) {
      await utimes(path.join(home, "thread-writer-locks", `${id}.lock`), old, old);
      await utimes(path.join(home, "sessions", `rollout-${id}.jsonl`), old, old);
    }
    expect(await readAutoResumeCodexSessionIds(home)).toEqual([]);
  });
  it("explains the goal requirement and fallback in Settings", () => {
    const copy = getDashboardCopy("en").autoResumeSub;
    expect(copy).toContain("Set a goal"); expect(copy).toContain("Sub-agents are skipped"); expect(copy).toContain("goal detection is unavailable");
  });
});
