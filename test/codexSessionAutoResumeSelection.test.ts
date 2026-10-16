import { mkdtemp, mkdir, writeFile, appendFile, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
// Selection fixtures own no OS locks; the writer-lock integration suite tests the actual probes.
vi.mock("child_process", async (original) => {
  const child = await original<typeof import("child_process")>();
  return { ...child, execFile: (...args: any[]) => {
    if (args[0] === "powershell.exe") { args.at(-1)(null, "[]"); return {}; }
    return (child.execFile as any)(...args);
  } };
});
import { filterAutoResumeGoalSessionIds, readAutoResumeCodexSessionIds as selectSessions } from "../src/services/codexSessionAutoResumeSelection";
import { getDashboardCopy } from "../src/application/dashboard/copy";
import * as sessionEditor from "../src/services/codexSessionResume";

const roots: string[] = [];
const readAutoResumeCodexSessionIds = (...args: Parameters<typeof selectSessions>) =>
  selectSessions(args[0], args[1], args[2], args[3], args[4], args[5] ?? false);
const ids = [
  "01a04882-d037-7a42-ad24-9afb61901188",
  "01a04882-d037-7a42-ad24-9afb61901189",
  "01a04882-d037-7a42-ad24-9afb61901190"
];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(
  sources: unknown[] = ["vscode", { subagent: { thread_spawn: { parent_thread_id: ids[0] } } }, "vscode"]
) {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-auto-selection-"));
  roots.push(home);
  await mkdir(path.join(home, "thread-writer-locks"));
  await mkdir(path.join(home, "sessions"));
  for (const [index, id] of ids.entries()) {
    await writeFile(path.join(home, "thread-writer-locks", `${id}.lock`), "");
    await writeFile(
      path.join(home, "sessions", `rollout-${id}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { id, source: sources[index], cwd: home } }) + "\n" + JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) + "\n"
    );
  }
  return home;
}
function goals(home: string, statuses: Array<string | null>) {
  const db = new DatabaseSync(path.join(home, "goals_1.sqlite"));
  db.exec("CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, status TEXT)");
  for (const [index, status] of statuses.entries())
    if (status) db.prepare("INSERT INTO thread_goals VALUES (?, ?)").run(ids[index]!, status);
  db.close();
}
describe("auto resume selection", () => {
  it("saves only eligible open parents when running-session discovery is unavailable", async () => {
    const home = await fixture();
    goals(home, ["active", "active", "complete"]);
    const running = vi.spyOn(sessionEditor, "readRunningCodexSessionIds")
      .mockRejectedValue(new Error("Running session discovery unavailable"));
    try {
      expect(await selectSessions(home, undefined, ids, undefined, "open", true)).toEqual([ids[0]]);
      expect(running).not.toHaveBeenCalled();
    } finally { running.mockRestore(); }
  });

  it("goal-only filters capture and open tabs to active parent goals", async () => {
    const home = await fixture();
    goals(home, ["active", "active", "complete"]);
    expect(await selectSessions(home, [home], ids, undefined, "running", true)).toEqual([ids[0]]);
    expect(await selectSessions(home, [], ids, undefined, "open", true)).toEqual([ids[0]]);
  });
  it.each(["paused", "blocked", "complete", "budget_limited"])(
    "goal-only excludes %s goals", async (status) => {
      const home = await fixture();
      goals(home, [status, "active", null]);
      expect(await selectSessions(home, [home], ids, undefined, "running", true)).toEqual([]);
    }
  );
  it("keeps quota-blocked parent goals eligible after the native turn stops", async () => {
    const home = await fixture();
    goals(home, ["usage_limited", "usage_limited", "complete"]);
    expect(await selectSessions(home, undefined, ids, undefined, "running", true, [])).toEqual([ids[0]]);
    expect(await filterAutoResumeGoalSessionIds(ids, home, undefined, true)).toEqual([ids[0], ids[1]]);
    await appendFile(path.join(home,"sessions",`rollout-${ids[0]}.jsonl`),JSON.stringify({type:"event_msg",payload:{type:"turn_aborted",reason:"user_cancelled"}})+"\n");
    expect(await selectSessions(home, undefined, ids, undefined, "running", true, [])).toEqual([]);
  });

  it("recovers quota failures without treating unrelated idle, cancelled, or completed sessions as running", async () => {
    const home = await fixture();
    const transcript = path.join(home, "sessions", `rollout-${ids[0]}.jsonl`);
    const event = (type: string, extra = {}) => JSON.stringify({type:"event_msg",payload:{type,turn_id:"turn-1",...extra}})+"\n";
    await appendFile(transcript, event("error", {message:"You've hit your usage limit"})+event("task_failed")+event("task_started"));
    expect(await sessionEditor.readRunningCodexSessionIds(home,undefined,[ids[0]!])).toEqual([]);
    expect(await selectSessions(home, undefined, ids, undefined, "running", false, [])).toEqual([ids[0]]);
    await appendFile(transcript,event("turn_aborted",{reason:"user_cancelled"}));
    expect(await selectSessions(home, undefined, ids, undefined, "running", false, [])).toEqual([]);
    await appendFile(transcript,JSON.stringify({type:"event_msg",payload:{type:"task_started",turn_id:"turn-2"}})+"\n"+JSON.stringify({type:"event_msg",payload:{type:"task_complete",turn_id:"turn-2"}})+"\n");
    expect(await selectSessions(home, undefined, ids, undefined, "running", false, [])).toEqual([]);
  });
  it("goal-only skips missing goals and retains recovery on corrupt or incompatible storage", async () => {
    const home = await fixture();
    expect(await filterAutoResumeGoalSessionIds(ids, home, undefined, true)).toEqual([]);
    await writeFile(path.join(home, "goals_1.sqlite"), "corrupt");
    await expect(filterAutoResumeGoalSessionIds(ids, home, undefined, true)).rejects.toThrow("Saved recovery was retained");
    await rm(path.join(home, "goals_1.sqlite"));
    const db = new DatabaseSync(path.join(home, "goals_1.sqlite"));
    db.exec("CREATE TABLE future_schema (id TEXT)");
    db.close();
    await expect(filterAutoResumeGoalSessionIds(ids, home, undefined, true)).rejects.toThrow("Saved recovery was retained");
    expect(await filterAutoResumeGoalSessionIds(ids, home, undefined, false)).toEqual(ids);
  });
  it("records open idle parents without running locks and skips open sub-agents", async () => {
    const home = await fixture();
    await rm(path.join(home, "thread-writer-locks"), { recursive: true });
    for (const id of ids) {
      await appendFile(path.join(home, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }) + "\n");
    }
    expect(await readAutoResumeCodexSessionIds(home, [], ids, undefined, "open")).toEqual([ids[0], ids[2]]);
    expect(await readAutoResumeCodexSessionIds(home, [home], ids)).toEqual([]);
  });
  it("selects every fresh running parent when the writer lock directory is missing", async () => {
    const home = await fixture();
    await rm(path.join(home, "thread-writer-locks"), { recursive: true });
    expect(await readAutoResumeCodexSessionIds(home, [home], ids)).toEqual([ids[0], ids[2]]);
  });
  it("selects all running active-goal parents and excludes a child with its own goal", async () => {
    const home = await fixture();
    goals(home, ["active", "active", "active"]);
    expect(await readAutoResumeCodexSessionIds(home, [home])).toEqual([ids[0], ids[2]]);
  });
  it.each(["paused", "blocked", "complete", "usage_limited", "budget_limited"])(
    "resumes %s parent sessions because goals are not required",
    async (status) => {
      const home = await fixture();
      goals(home, [status, "active", null]);
      expect(await readAutoResumeCodexSessionIds(home, [home])).toEqual([ids[0], ids[2]]);
    }
  );
  it("resumes parents when goal state is unavailable", async () => {
    const home = await fixture();
    expect(await readAutoResumeCodexSessionIds(home, [home])).toEqual([ids[0], ids[2]]);
  });
  it("resumes parents when the database is corrupt or its schema is unavailable", async () => {
    const home = await fixture();
    await writeFile(path.join(home, "goals_1.sqlite"), "corrupt");
    expect(await readAutoResumeCodexSessionIds(home, [home])).toEqual([ids[0], ids[2]]);
    await rm(path.join(home, "goals_1.sqlite"));
    const db = new DatabaseSync(path.join(home, "goals_1.sqlite"));
    db.exec("CREATE TABLE future_schema (id TEXT)");
    db.close();
    expect(await readAutoResumeCodexSessionIds(home, [home])).toEqual([ids[0], ids[2]]);
  });
  it("captures all local running parent windows by default across projects", async () => {
    const home = await fixture();
    await writeFile(path.join(home, "sessions", `rollout-${ids[2]}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { source: "vscode", cwd: path.join(path.dirname(home), "another-project") } }) + "\n" + JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) + "\n");
    expect(await readAutoResumeCodexSessionIds(home, undefined, [])).toEqual([ids[0], ids[2]]);
    expect(await readAutoResumeCodexSessionIds(home, undefined, [], undefined, "open")).toEqual([]);
  });
  it("does not select sessions belonging to another workspace", async () => {
    const home = await fixture();
    goals(home, ["active", "active", "active"]);
    expect(await readAutoResumeCodexSessionIds(home, [path.join(home, "other-project")])).toEqual([]);
  });
  it("uses state metadata to exclude children even when transcripts are missing", async () => {
    const home = await fixture();
    goals(home, ["active", "active", "active"]);
    await rm(path.join(home, "sessions"), { recursive: true });
    const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT, source TEXT, cwd TEXT)");
    const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?)");
    insert.run(ids[1]!, JSON.stringify({ subagent: "review" }), home);
    insert.run(ids[0]!, "vscode", home);
    insert.run(ids[2]!, "vscode", home);
    db.close();
    expect(await readAutoResumeCodexSessionIds(home, [home])).toEqual([]);
    expect(await readAutoResumeCodexSessionIds(home, [home], ids, undefined, "open")).toEqual([ids[0], ids[2]]);
  });
  it("skips child metadata in a truncated record and rejects incomplete parent metadata", async () => {
    const home = await fixture();
    goals(home, ["active", "active", "active"]);
    await writeFile(
      path.join(home, "sessions", `rollout-${ids[1]}.jsonl`),
      '{"type":"session_meta","payload":{"source":{"subagent":"review"},"instructions":"' + "x".repeat(1100000)
    );
    await writeFile(path.join(home, "sessions", `rollout-${ids[2]}.jsonl`), "partial");
    expect(await readAutoResumeCodexSessionIds(home, [home])).toEqual([ids[0]]);
    await expect(readAutoResumeCodexSessionIds(home, [home], ids, undefined, "open")).rejects.toThrow("metadata is missing or incomplete");
  });

  it("fills partial database metadata from transcripts and excludes child evidence", async () => {
    const home = await fixture();
    const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT, source TEXT, cwd TEXT, archived INTEGER)");
    db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run(ids[1]!, null, home, 0);
    db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run(ids[0]!, "vscode", null, 0);
    db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run(ids[2]!, "vscode", home, 1);
    db.close();
    expect(await readAutoResumeCodexSessionIds(home, [home])).toEqual([ids[0]]);
  });

  it("excludes truncated child evidence even when partial state calls it a parent", async () => {
    const home = await fixture();
    const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT, source TEXT, cwd TEXT, archived INTEGER)");
    db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run(ids[1]!, "vscode", null, 0);
    db.close();
    await writeFile(
      path.join(home, "sessions", `rollout-${ids[1]}.jsonl`),
      '{"type":"session_meta","payload":{"source":{"subagent":"review"},"instructions":"' + "x".repeat(1100000)
    );
    expect(await readAutoResumeCodexSessionIds(home, [home])).toEqual([ids[0], ids[2]]);
  });

  it("preserves running parent tabs explicitly open in this window across project changes", async () => {
    const home = await fixture();
    expect(await readAutoResumeCodexSessionIds(home, [path.join(home, "other-project")], [ids[0]!, ids[1]!])).toEqual([
      ids[0]
    ]);
  });

  it("limits an empty workspace to native parent tabs in that window", async () => {
    const home = await fixture();
    expect(await readAutoResumeCodexSessionIds(home, [], [])).toEqual([]);
    expect(await readAutoResumeCodexSessionIds(home, [], [ids[0]!, ids[1]!])).toEqual([ids[0]]);
  });

  it("does not infer workspace ownership when cwd is absent", async () => {
    const home = await fixture();
    await writeFile(
      path.join(home, "sessions", `rollout-${ids[0]}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { source: "vscode" } })
    );
    expect(await readAutoResumeCodexSessionIds(home, [home], [])).toEqual([ids[2]]);
  });

  it("rejects future-dated locks and transcripts instead of treating them as permanently live", async () => {
    const home = await fixture();
    const future = new Date(Date.now() + 60 * 60 * 1000);
    for (const id of ids) {
      await utimes(path.join(home, "thread-writer-locks", `${id}.lock`), future, future);
      await utimes(path.join(home, "sessions", `rollout-${id}.jsonl`), future, future);
    }
    expect(await readAutoResumeCodexSessionIds(home, [home])).toEqual([]);
  });

  it("accepts extended Windows drive and UNC paths without sibling-prefix matches", async () => {
    const home = await fixture();
    for (const [i, cwd] of [
      "\\\\?\\C:\\Projects\\demo\\child",
      "\\\\?\\UNC\\server\\share\\project",
      "C:\\Projects\\demo-sibling"
    ].entries()) {
      await writeFile(
        path.join(home, "sessions", `rollout-${ids[i]}.jsonl`),
        JSON.stringify({ type: "session_meta", payload: { source: "vscode", cwd } }) + "\n" + JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })
      );
    }
    expect(await readAutoResumeCodexSessionIds(home, ["c:\\projects\\DEMO", "\\\\server\\share\\project"], [])).toEqual(
      [ids[0], ids[1]]
    );
  });
  it("does not reopen stale locks after a stopped process or reboot", async () => {
    const home = await fixture();
    const old = new Date(Date.now() - 60 * 60 * 1000);
    for (const id of ids) {
      await utimes(path.join(home, "thread-writer-locks", `${id}.lock`), old, old);
      await utimes(path.join(home, "sessions", `rollout-${id}.jsonl`), old, old);
    }
    expect(await readAutoResumeCodexSessionIds(home, [home])).toEqual([]);
  });
  it("explains that all running parents resume and sub-agents are skipped", () => {
    const copy = getDashboardCopy("en").autoResumeSub;
    expect(copy).toContain("quota-interrupted parent sessions");
    expect(copy).toContain("VS Code restart");
    expect(copy).toContain("sub-agents are skipped");
  });
});
