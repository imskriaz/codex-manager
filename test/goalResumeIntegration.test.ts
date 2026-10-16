import * as vscode from "vscode";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readAutoResumeCodexSessionIds } from "../src/services/codexSessionAutoResumeSelection";
import { readCodexSessionGoals } from "../src/services/codexSessionGoals";
import * as sessionEditor from "../src/services/codexSessionResume";
import * as diagnostics from "../src/utils/persistentLog";
import { readAutoResumeGoalCandidateIds } from "../src/services/codexSessionAutoResumeSelection";
import { AUTO_RESUME_OPEN_SESSION_IDS_KEY, persistOpenCodexSessions, AUTO_RESUME_SESSION_IDS_KEY, persistRunningCodexSessions, resumePersistedCodexSessions } from "../src/services/codexSessionAutoResume";

let home: string, db: DatabaseSync;
let goalOnly: boolean;
const previousHome = process.env.CODEX_HOME;
const ids = Array.from({ length: 7 }, (_, index) => `aaaaaaaa-aaaa-aaaa-aaaa-${String(index).padStart(12, "0")}`);
const states = ["active", "usage_limited", "paused", "complete", "budget_limited", "active", "active"];
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "goal-resume-integration-"));
  process.env.CODEX_HOME = home;
  goalOnly = true;
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: (key: string, fallback: unknown) => key === "autoResumeGoalOnlyEnabled" ? goalOnly :
      ["autoResumeEnabled", "autoSwitchEnabled"].includes(key) ? true : fallback
  } as never);
  await mkdir(path.join(home, "sessions"));
  db = new DatabaseSync(path.join(home, "goals_1.sqlite"));
  db.exec("CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, objective TEXT, status TEXT, time_used_seconds INTEGER)");
  for (const [index, id] of ids.entries()) {
    db.prepare("INSERT INTO thread_goals VALUES (?, 'Finish the requested task', ?, 12)").run(id, states[index]!);
    const source = index === 5 ? { subagent: { thread_spawn: { parent_thread_id: ids[0] } } } : "vscode";
    const directory = path.join(home, index === 6 ? "archived_sessions" : "sessions");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, source, cwd: home } }) + "\n");
  }
});
afterEach(async () => {
  db.close(); vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
function context() {
  const saved = new Map<string, unknown>();
  return { saved, context: { workspaceState: { get: (key: string) => saved.get(key),
    update: async (key: string, value: unknown) => { saved.set(key, value); } } } as never };
}
const select = () => readAutoResumeCodexSessionIds(home, undefined, ids, undefined, "running", goalOnly,
  ids.filter((_id, index) => index !== 1));

it("captures and restores active and quota-limited parent goals using real native goal storage", async () => {
  const state = context();
  expect(await persistRunningCodexSessions(state.context, select)).toEqual(ids.slice(0, 2));
  expect((await readCodexSessionGoals(home, ids))?.get(ids[1]!)?.status).toBe("usage_limited");
  const open = vi.fn(async (_sessionId: string) => undefined);
  expect(await resumePersistedCodexSessions(state.context, open)).toEqual({ attempted: 2, opened: 2, failed: [] });
  expect(open.mock.calls.map(call => call[0])).toEqual(ids.slice(0, 2));
  expect(state.saved.get(AUTO_RESUME_SESSION_IDS_KEY)).toBeUndefined();
});

it("rechecks each goal between editor opens and skips a newly paused goal", async () => {
  const state = context();
  await persistRunningCodexSessions(state.context, select);
  const open = vi.fn(async (_sessionId: string) => {
    db.prepare("UPDATE thread_goals SET status='paused' WHERE thread_id=?").run(ids[1]!);
  });
  const result = await resumePersistedCodexSessions(state.context, open);
  expect(result).toEqual({ attempted: 2, opened: 1, failed: [] });
  expect(open.mock.calls.map(call => call[0])).toEqual([ids[0]]);
});

it("preserves recovery without closing tabs when native goal storage becomes incompatible", async () => {
  const state = context();
  await persistRunningCodexSessions(state.context, select);
  db.exec("ALTER TABLE thread_goals RENAME TO incompatible_schema");
  const open = vi.fn();
  await expect(resumePersistedCodexSessions(state.context, open)).rejects.toThrow("Saved recovery was retained");
  expect(state.saved.get(AUTO_RESUME_SESSION_IDS_KEY)).toEqual(ids.slice(0, 2));
  expect(open).not.toHaveBeenCalled();
});

it("includes eligible parents without active goals when goal-only is turned off", async () => {
  goalOnly = false;
  const state = context();
  expect((await persistRunningCodexSessions(state.context, select)).sort()).toEqual(ids.slice(0, 5));
  const result = await resumePersistedCodexSessions(state.context, async () => undefined);
  expect(result).toEqual({ attempted: 5, opened: 5, failed: [] });
});

it("captures a running sidebar goal without any conversation tab, then restores it after reload", async () => {
  const state = context();
  vi.spyOn(sessionEditor, "readOpenCodexSessionIds").mockReturnValue([]);
  vi.spyOn(sessionEditor, "readRecentRunningCodexSessionIds").mockReturnValue([ids[0]!]);
  expect(await persistOpenCodexSessions(state.context)).toEqual(ids.slice(0, 2));
  expect(state.saved.get(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toEqual(ids.slice(0, 2));
  const open = vi.fn(async (_sessionId: string) => undefined);
  const events = vi.spyOn(diagnostics, "recordPersistentEvent");
  expect(await resumePersistedCodexSessions(state.context, open)).toMatchObject({ opened: 2, failed: [] });
  expect(open.mock.calls.map(call => call[0])).toEqual(ids.slice(0, 2));
  expect(events).toHaveBeenCalledWith("info", "auto-resume", "Startup recovery loaded", { savedCount: 2, goalOnly: true });
});

it("excludes idle active goals, child goals, and archived goals from the background snapshot", async () => {
  const state = context();
  vi.spyOn(sessionEditor, "readOpenCodexSessionIds").mockReturnValue([]);
  vi.spyOn(sessionEditor, "readRecentRunningCodexSessionIds").mockReturnValue([ids[5]!, ids[6]!]);
  expect(await persistOpenCodexSessions(state.context)).toEqual([ids[1]]);
});

it("retains the previous snapshot when sidebar goal storage is partial or corrupt", async () => {
  const state = context(); state.saved.set(AUTO_RESUME_OPEN_SESSION_IDS_KEY, [ids[0]]);
  vi.spyOn(sessionEditor, "readOpenCodexSessionIds").mockReturnValue([]);
  db.exec("ALTER TABLE thread_goals RENAME TO incompatible_schema");
  await expect(persistOpenCodexSessions(state.context)).rejects.toThrow();
  expect(state.saved.get(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toEqual([ids[0]]);
});

it("bounds goal discovery and rejects oversized native goal results", async () => {
  expect(await readAutoResumeGoalCandidateIds(home)).toEqual([ids[0], ids[1], ids[5], ids[6]]);
  const put = db.prepare("INSERT INTO thread_goals VALUES (?, 'task', 'active', 0)");
  db.exec("BEGIN");
  for (let i = 0; i < 10001; i++) put.run(`bbbbbbbb-bbbb-bbbb-bbbb-${String(i).padStart(12, "0")}`);
  db.exec("COMMIT");
  await expect(readAutoResumeGoalCandidateIds(home)).rejects.toThrow("safe discovery limit");
});
