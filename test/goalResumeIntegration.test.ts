import * as vscode from "vscode";
import { appendFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../src/services/codexAppServerRpc", () => ({ CodexAppServerRpc: { open: mocks.open }, CodexAppServerTurnInterruptedError: class extends Error {}, CodexAppServerDisconnectedError: class extends Error {} }));
import { readAutoResumeCodexSessionIds } from "../src/services/codexSessionAutoResumeSelection";
import { clearExplicitSessionGoalPause, readCodexSessionGoals } from "../src/services/codexSessionGoals";
import * as sessionEditor from "../src/services/codexSessionResume";
import * as diagnostics from "../src/utils/persistentLog";
import { readAutoResumeGoalCandidateIds } from "../src/services/codexSessionAutoResumeSelection";
import { AUTO_RESUME_OPEN_SESSION_IDS_KEY, persistOpenCodexSessions, AUTO_RESUME_SESSION_IDS_KEY, persistRunningCodexSessions, resumePersistedCodexSessions, prepareCodexSessionsForExtensionHostRestart } from "../src/services/codexSessionAutoResume";
import { getNativeCodexSessionRunning, readNativeCodexSessionRunning, startNativeCodexSessionTurn, waitForNativeCodexSessionReady } from "../src/services/codexNativeSessionStatus";
import { subscribeDashboardRealtime } from "../src/services/dashboardRealtime";

let home: string, db: DatabaseSync;
let goalOnly: boolean;
let previousTabs: typeof vscode.window.tabGroups;
const previousHome = process.env.CODEX_HOME;
const originalGoalResume = sessionEditor.resumeCodexSessionGoal;
const ids = Array.from({ length: 7 }, (_, index) => `aaaaaaaa-aaaa-aaaa-aaaa-${String(index).padStart(12, "0")}`);
const states = ["active", "usage_limited", "paused", "complete", "budget_limited", "active", "active"];
beforeEach(async () => {
  vi.mocked(readNativeCodexSessionRunning).mockResolvedValue(false);
  vi.mocked(waitForNativeCodexSessionReady).mockResolvedValue(true);
  previousTabs = vscode.window.tabGroups;
  const tabs: Array<{ input: unknown; isPreview: boolean }> = [];
  Object.assign(vscode.window, { tabGroups: { all: [{ tabs }] } });
  vi.mocked(vscode.extensions.getExtension).mockReturnValue({ activate: async () => undefined } as never);
  vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command, uri, viewType) => {
    if (command === "vscode.openWith") tabs.push({ input: { uri, viewType }, isPreview: false });
  });
  home = await mkdtemp(path.join(tmpdir(), "goal-resume-integration-"));
  process.env.CODEX_HOME = home;
  goalOnly = true;
  mocks.open.mockImplementation(async () => ({ request: vi.fn(async (method: string, params: { threadId: string }) => {
    if (method !== "thread/goal/get") throw new Error("Unsupported official mutation");
    const goals = await readCodexSessionGoals(home, [params.threadId]);
    if (!goals) throw new Error("Native goal storage unavailable");
    return { goal: goals.get(params.threadId) ?? null };
  }), close: vi.fn() }));
  vi.spyOn(sessionEditor, "closeOpenCodexSessionTabs").mockResolvedValue(undefined);
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
  Object.assign(vscode.window, { tabGroups: previousTabs });
  ids.forEach(id => clearExplicitSessionGoalPause(home, id));
  db.close(); vi.restoreAllMocks();
  mocks.open.mockReset();
  vi.mocked(getNativeCodexSessionRunning).mockReturnValue(undefined);
  vi.mocked(startNativeCodexSessionTurn).mockReset().mockResolvedValue(false);
  if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
function context() {
  const saved = new Map<string, unknown>();
  return { saved, context: { workspaceState: { get: (key: string) => saved.get(key),
    update: async (key: string, value: unknown) => { saved.set(key, value); } } } as never };
}
const select = () => readAutoResumeCodexSessionIds(home, undefined, ids, undefined, "running", goalOnly,
  ids.filter((_id, index) => index !== 1), undefined, [ids[1]!]);

it("sends the non-goal continuation through the official owner without opening a private RPC", async () => {
  const state = context(), id = ids[0]!;
  db.prepare("DELETE FROM thread_goals WHERE thread_id=?").run(id);
  state.saved.set(AUTO_RESUME_SESSION_IDS_KEY, [id]);
  await writeFile(path.join(home, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Non-goal task" }) + "\n");
  const transcript = path.join(home, "sessions", `rollout-${id}.jsonl`);
  await appendFile(transcript, ["task_started", "task_failed"].map(type => JSON.stringify({ type: "event_msg", payload: { type, turn_id: "interrupted" } })).join("\n") + "\n");
  vi.mocked(getNativeCodexSessionRunning).mockReturnValue(false);
  vi.mocked(startNativeCodexSessionTurn).mockImplementationOnce(async (_home, _id, turn, _signal, started) => {
    expect(turn.input).toEqual([{ type: "text", text: "Continue if not completed", text_elements: [] }]);
    await appendFile(transcript, ["task_started", "task_complete"].map(type => JSON.stringify({ type: "event_msg", payload: { type, turn_id: "official-turn" } })).join("\n") + "\n");
    started?.("official-turn"); return true;
  });
  expect(await resumePersistedCodexSessions(state.context)).toEqual({ attempted: 1, opened: 1, failed: [] });
  expect(startNativeCodexSessionTurn).toHaveBeenCalledOnce();
  expect(mocks.open).not.toHaveBeenCalled();
  expect(state.saved.get(AUTO_RESUME_SESSION_IDS_KEY)).toBeUndefined();
});

it.each(["active", "none"])("recovers %s work despite a recent writer lock and orphaned task_started", async status => {
  const id = ids[0]!, state = context();
  if (status === "none") db.prepare("DELETE FROM thread_goals WHERE thread_id=?").run(id);
  state.saved.set(AUTO_RESUME_SESSION_IDS_KEY, [id]);
  await writeFile(path.join(home, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Interrupted at reload" }) + "\n");
  const transcript = path.join(home, "sessions", `rollout-${id}.jsonl`);
  await appendFile(transcript, JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "orphaned-turn" } }) + "\n");
  await mkdir(path.join(home, "thread-writer-locks"));
  await writeFile(path.join(home, "thread-writer-locks", `${id}.lock`), "");
  vi.mocked(readNativeCodexSessionRunning).mockResolvedValue(undefined);
  expect((await sessionEditor.readCodexCliSessionSummary(id, home))?.status).toBe("running");
  const open = vi.spyOn(sessionEditor, "openCodexSessionInVsCode").mockImplementationOnce(async () => {
    vi.mocked(readNativeCodexSessionRunning).mockResolvedValue(false);
    vi.mocked(getNativeCodexSessionRunning).mockReturnValue(false);
  });
  vi.mocked(startNativeCodexSessionTurn).mockImplementationOnce(async (_home, _id, turn, _signal, onStarted) => {
    expect(turn.input).toEqual(status === "none" ? [{ type: "text", text: "Continue if not completed", text_elements: [] }] : []);
    await appendFile(transcript, ["task_started", "task_complete"].map(type => JSON.stringify({ type: "event_msg", payload: { type, turn_id: "official-recovered" } })).join("\n") + "\n");
    onStarted?.("official-recovered");return true;
  });
  expect(await resumePersistedCodexSessions(state.context)).toEqual({ attempted: 1, opened: 1, failed: [] });
  expect(open).toHaveBeenCalledOnce(); expect(startNativeCodexSessionTurn).toHaveBeenCalledOnce();
  expect(mocks.open).not.toHaveBeenCalled();
  expect(state.saved.get(AUTO_RESUME_SESSION_IDS_KEY)).toBeUndefined();
});
it.each(["active", "none"])("retains %s recovery when the official runtime is unavailable after opening", async status => {
  const id = ids[0]!, state = context();
  if (status === "none") db.prepare("DELETE FROM thread_goals WHERE thread_id=?").run(id);
  await writeFile(path.join(home, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Unknown runtime" }) + "\n");
  await appendFile(path.join(home, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "orphaned-turn" } }) + "\n");
  state.saved.set(AUTO_RESUME_SESSION_IDS_KEY, [id]);
  vi.mocked(readNativeCodexSessionRunning).mockResolvedValue(undefined);
  const result = await resumePersistedCodexSessions(state.context);
  expect(result).toMatchObject({ opened: 0, failed: [{ sessionId: id, message: expect.stringContaining("could not be verified") }] });
  expect(startNativeCodexSessionTurn).not.toHaveBeenCalled();
  expect(state.saved.get(AUTO_RESUME_SESSION_IDS_KEY)).toEqual([id]);
});

it("keeps recovery for a non-goal session whose partial history has no turn state", async () => {
  const id = ids[0]!, state = context();
  db.prepare("DELETE FROM thread_goals WHERE thread_id=?").run(id);
  await writeFile(path.join(home, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Partial history" }) + "\n");
  state.saved.set(AUTO_RESUME_SESSION_IDS_KEY, [id]);
  const result = await resumePersistedCodexSessions(state.context);
  expect(result).toMatchObject({ opened: 0, failed: [{ sessionId: id, message: expect.stringContaining("Interrupted work could not be verified") }] });
  expect(startNativeCodexSessionTurn).not.toHaveBeenCalled();
  expect(state.saved.get(AUTO_RESUME_SESSION_IDS_KEY)).toEqual([id]);
});

it("captures and restores active and quota-limited parent goals using real native goal storage", async () => {
  const state = context();
  expect(await persistRunningCodexSessions(state.context, select)).toEqual(ids.slice(0, 2));
  expect((await readCodexSessionGoals(home, ids))?.get(ids[1]!)?.status).toBe("usage_limited");
  const open = vi.fn(async (_sessionId: string) => undefined);
  expect(await resumePersistedCodexSessions(state.context, open)).toEqual({ attempted: 2, opened: 2, failed: [] });
  expect(open.mock.calls.map(call => call[0])).toEqual(ids.slice(0, 2));
  expect(state.saved.get(AUTO_RESUME_SESSION_IDS_KEY)).toBeUndefined();
});

it.each(["active", "usage_limited", "paused", "none"])("opens the official tab and confirms %s recovery, adding a prompt only for non-goal work", async status => {
  const state = context(), id = ids[0]!;
  state.saved.set(AUTO_RESUME_SESSION_IDS_KEY, [id]);
  if (status === "none") db.prepare("DELETE FROM thread_goals WHERE thread_id=?").run(id);
  else db.prepare("UPDATE thread_goals SET status=? WHERE thread_id=?").run(status, id);
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (_key: string, fallback: unknown) => fallback === false ? true : fallback } as never);
  await writeFile(path.join(home, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Unfinished goal" }) + "\n");
  const transcript = path.join(home, "sessions", `rollout-${id}.jsonl`);
  await appendFile(transcript, JSON.stringify({ type: "event_msg", payload: { type: status === "paused" || status === "none" ? "task_failed" : "task_complete", turn_id: "previous-turn" } }) + "\n");
  const previousTabs = vscode.window.tabGroups;
  const tabs: Array<{ input: unknown; isPreview: boolean }> = [];
  Object.assign(vscode.window, { tabGroups: { all: [{ tabs }] } });
  vi.mocked(vscode.extensions.getExtension).mockReturnValue({ activate: async () => undefined } as never);
  vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command, uri, viewType) => {
    if (command === "vscode.openWith") tabs.push({ input: { uri, viewType }, isPreview: false });
  });
  vi.mocked(getNativeCodexSessionRunning).mockReturnValue(false);
  const completed = vi.fn();
  const unsubscribe = subscribeDashboardRealtime(message => { if (message.type === "dashboard:codex-session-live" && message.state.sessionId === id && message.state.status === "completed") completed(); });
  vi.mocked(startNativeCodexSessionTurn).mockImplementationOnce(async (_home, _id, _turn, _signal, onStarted) => {
    await appendFile(transcript, ["task_started", "task_complete"].map(type => JSON.stringify({ type: "event_msg", payload: { type, turn_id: "confirmed-goal-turn" } })).join("\n") + "\n");
    onStarted?.("confirmed-goal-turn");
    return true;
  });
  try {
    expect(await resumePersistedCodexSessions(state.context)).toEqual({ attempted: 1, opened: 1, failed: [] });
    expect(tabs).toHaveLength(1);
    expect(waitForNativeCodexSessionReady).toHaveBeenCalledWith(home, id, expect.any(AbortSignal), 120_000);
    expect(startNativeCodexSessionTurn).toHaveBeenCalledExactlyOnceWith(home, id, { threadId: id, input: status === "none" ? [{ type: "text", text: "Continue if not completed", text_elements: [] }] : [], cwd: home }, expect.any(AbortSignal), expect.any(Function));
    expect(mocks.open).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(state.saved.get(AUTO_RESUME_SESSION_IDS_KEY)).toBeUndefined();
  } finally { unsubscribe(); Object.assign(vscode.window, { tabGroups: previousTabs }); }
});

it.each(["paused", "complete", "corrupt", "user-stop"])("rechecks %s goal state immediately before sending and sends nothing", async change => {
  const id = ids[0]!, state = context();
  state.saved.set(AUTO_RESUME_SESSION_IDS_KEY, [id]);
  await writeFile(path.join(home, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Pending goal" }) + "\n");
  const transcript = path.join(home, "sessions", `rollout-${id}.jsonl`);
  await appendFile(transcript, JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "previous" } }) + "\n");
  vi.mocked(getNativeCodexSessionRunning).mockReturnValue(false);
  vi.spyOn(sessionEditor, "resumeCodexSessionGoal").mockImplementationOnce(async (session, signal, origin) => {
    if (change === "corrupt") db.exec("ALTER TABLE thread_goals RENAME TO incompatible_schema");
    else if (change === "user-stop") {
      db.exec("UPDATE thread_goals SET status='paused'");
      await appendFile(transcript, JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", reason: "user_cancelled" } }) + "\n");
    } else db.prepare("UPDATE thread_goals SET status=? WHERE thread_id=?").run(change, id);
    return originalGoalResume(session, signal, origin);
  });
  const result = await resumePersistedCodexSessions(state.context);
  expect(result.opened).toBe(0);
  expect(result.failed).toHaveLength(1);
  expect(startNativeCodexSessionTurn).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
  if (change === "corrupt") expect(state.saved.get(AUTO_RESUME_SESSION_IDS_KEY)).toEqual([id]);
});

it("retains goal recovery when the tab opens but the native turn start is unconfirmed", async () => {
  const state = context(), id = ids[0]!;
  state.saved.set(AUTO_RESUME_SESSION_IDS_KEY, [id]);
  await writeFile(path.join(home, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Unfinished goal" }) + "\n");
  vi.spyOn(sessionEditor, "openCodexSessionInVsCode").mockResolvedValue(undefined);
  vi.mocked(getNativeCodexSessionRunning).mockReturnValue(false);
  mocks.open.mockResolvedValue({ request: vi.fn(async () => ({ goal: { status: "active" } })), close: vi.fn() });
  vi.mocked(startNativeCodexSessionTurn).mockRejectedValueOnce(new Error("Codex did not confirm a started turn. The outcome is unconfirmed."));
  const result = await resumePersistedCodexSessions(state.context);
  expect(result).toMatchObject({ attempted: 1, opened: 0, failed: [{ sessionId: id, message: expect.stringContaining("did not confirm a started turn") }] });
  expect(startNativeCodexSessionTurn).toHaveBeenCalledOnce();
  expect(state.saved.get(AUTO_RESUME_SESSION_IDS_KEY)).toEqual([id]);
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

it.each([true, false])("drops stale completed, archived, and child recovery before closing editors with goal-only=%s", async onlyGoals => {
  goalOnly = onlyGoals;
  const state = context();
  state.saved.set(AUTO_RESUME_SESSION_IDS_KEY, [ids[0], ids[1], ids[5], ids[6]]);
  const metadata = new DatabaseSync(path.join(home, "state_5.sqlite"));
  metadata.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, source TEXT, cwd TEXT, archived INTEGER)");
  metadata.prepare("INSERT INTO threads VALUES (?, 'vscode', ?, 1)").run(ids[1]!, home);
  metadata.close();
  db.prepare("UPDATE thread_goals SET status='complete' WHERE thread_id=?").run(ids[0]!);
  await appendFile(path.join(home, "sessions", `rollout-${ids[0]}.jsonl`), JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "finished" } }) + "\n");
  const open = vi.fn();
  expect(await resumePersistedCodexSessions(state.context, open)).toEqual({ attempted: 0, opened: 0, failed: [] });
  expect(open).not.toHaveBeenCalled();
  expect(sessionEditor.closeOpenCodexSessionTabs).not.toHaveBeenCalled();
  expect(state.saved.get(AUTO_RESUME_SESSION_IDS_KEY)).toBeUndefined();
});

it.each(["archive", "completion"])("rechecks %s between editor opens and consumes the obsolete queued ID", async change => {
  const state = context();
  state.saved.set(AUTO_RESUME_SESSION_IDS_KEY, ids.slice(0, 2));
  const metadata = new DatabaseSync(path.join(home, "state_5.sqlite"));
  metadata.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, source TEXT, cwd TEXT, archived INTEGER)");
  for (const id of ids.slice(0, 2)) metadata.prepare("INSERT INTO threads VALUES (?, 'vscode', ?, 0)").run(id!, home);
  try {
    const open = vi.fn(async () => {
      if (change === "archive") metadata.prepare("UPDATE threads SET archived=1 WHERE id=?").run(ids[1]!);
      else {
        db.prepare("UPDATE thread_goals SET status='complete' WHERE thread_id=?").run(ids[1]!);
        await appendFile(path.join(home, "sessions", `rollout-${ids[1]}.jsonl`), JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }) + "\n");
      }
    });
    expect(await resumePersistedCodexSessions(state.context, open)).toEqual({ attempted: 2, opened: 1, failed: [] });
    expect(open).toHaveBeenCalledExactlyOnceWith(ids[0], expect.any(AbortSignal));
    expect(state.saved.get(AUTO_RESUME_SESSION_IDS_KEY)).toBeUndefined();
  } finally { metadata.close(); }
});

it.each(["corrupt", "schema", "missing", "partial"])("keeps recovery without opening or closing editors when session metadata is %s", async failure => {
  const state = context();
  const saved = failure === "missing" ? "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" : ids[0]!;
  state.saved.set(AUTO_RESUME_SESSION_IDS_KEY, [saved]);
  if (failure === "corrupt") await writeFile(path.join(home, "state_5.sqlite"), "corrupt");
  if (failure === "schema") {
    const metadata = new DatabaseSync(path.join(home, "state_5.sqlite"));
    metadata.exec("CREATE TABLE incompatible_schema(id TEXT)"); metadata.close();
  }
  if (failure === "partial") await writeFile(path.join(home, "sessions", `rollout-${saved}.jsonl`), '{"type":"session_meta","payload":');
  const open = vi.fn();
  await expect(resumePersistedCodexSessions(state.context, open)).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();
  expect(sessionEditor.closeOpenCodexSessionTabs).not.toHaveBeenCalled();
  expect(state.saved.get(AUTO_RESUME_SESSION_IDS_KEY)).toEqual([saved]);
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
  expect((await persistRunningCodexSessions(state.context, select)).sort()).toEqual(ids.slice(0, 2));
  const result = await resumePersistedCodexSessions(state.context, async () => undefined);
  expect(result).toEqual({ attempted: 2, opened: 2, failed: [] });
});

it("captures a running sidebar goal without any conversation tab, then restores it after reload", async () => {
  const state = context();
  vi.spyOn(sessionEditor, "readOpenCodexSessionIds").mockReturnValue([]);
  vi.spyOn(sessionEditor, "readRecentRunningCodexSessionIds").mockReturnValue([ids[0]!]);
  const history = vi.spyOn(sessionEditor, "readQuotaInterruptedCodexSessionIds");
  expect(await persistOpenCodexSessions(state.context)).toEqual([ids[0]]);
  expect(history.mock.calls.every(call => Array.isArray(call[1]))).toBe(true);
  expect(state.saved.get(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toEqual([ids[0]]);
  const open = vi.fn(async (_sessionId: string) => undefined);
  const events = vi.spyOn(diagnostics, "recordPersistentEvent");
  expect(await resumePersistedCodexSessions(state.context, open)).toMatchObject({ opened: 1, failed: [] });
  expect(open.mock.calls.map(call => call[0])).toEqual([ids[0]]);
  expect(events).toHaveBeenCalledWith("info", "auto-resume", "Startup recovery loaded", { savedCount: 1, goalOnly: false });
});

it("captures reload recovery from tabs and sidebar goals without scanning running history", async () => {
  const state = context();
  vi.spyOn(sessionEditor, "readOpenCodexSessionIds").mockReturnValue([ids[0]!]);
  vi.spyOn(sessionEditor, "readRecentRunningCodexSessionIds").mockReturnValue([ids[0]!]);
  const scan = vi.spyOn(sessionEditor, "readRunningCodexSessionIds").mockReturnValue(new Promise(() => undefined));
  await prepareCodexSessionsForExtensionHostRestart(state.context, true);
  expect(scan).not.toHaveBeenCalled();
  expect(state.saved.get(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toEqual([ids[0]]);
});

it("excludes idle active goals, child goals, and archived goals from the background snapshot", async () => {
  const state = context();
  vi.spyOn(sessionEditor, "readOpenCodexSessionIds").mockReturnValue([]);
  vi.spyOn(sessionEditor, "readRecentRunningCodexSessionIds").mockReturnValue([ids[5]!, ids[6]!]);
  expect(await persistOpenCodexSessions(state.context)).toEqual([]);
});

it("retains the previous snapshot when sidebar goal storage is partial or corrupt", async () => {
  const state = context(); state.saved.set(AUTO_RESUME_OPEN_SESSION_IDS_KEY, [ids[0]]);
  vi.spyOn(sessionEditor, "readOpenCodexSessionIds").mockReturnValue([]);
  db.exec("ALTER TABLE thread_goals RENAME TO incompatible_schema");
  await expect(persistOpenCodexSessions(state.context)).rejects.toThrow();
  expect(state.saved.get(AUTO_RESUME_OPEN_SESSION_IDS_KEY)).toEqual([ids[0]]);
});

it.each([true, false])("never opens a previously paused goal without a Manager pause marker, goal-only=%s", async onlyGoals => {
  goalOnly = onlyGoals;
  const state = context(); state.saved.set(AUTO_RESUME_SESSION_IDS_KEY, [ids[2]]);
  const open = vi.fn();
  expect(await resumePersistedCodexSessions(state.context, open)).toEqual({ attempted: 0, opened: 0, failed: [] });
  expect(open).not.toHaveBeenCalled();
  expect(db.prepare("SELECT status FROM thread_goals WHERE thread_id=?").get(ids[2]!)?.status).toBe("paused");
});

it("keeps a quota-interrupted goal only when a previous running snapshot recorded it", async () => {
  const state = context();
  vi.spyOn(sessionEditor, "readOpenCodexSessionIds").mockReturnValue([]);
  vi.spyOn(sessionEditor, "readRecentRunningCodexSessionIds").mockReturnValue([]);
  expect(await persistOpenCodexSessions(state.context)).toEqual([]);
  state.saved.set(AUTO_RESUME_OPEN_SESSION_IDS_KEY, [ids[1]]);
  expect(await persistOpenCodexSessions(state.context)).toEqual([ids[1]]);
});

it("bounds goal discovery and rejects oversized native goal results", async () => {
  expect(await readAutoResumeGoalCandidateIds(home)).toEqual([ids[0], ids[1], ids[5], ids[6]]);
  const put = db.prepare("INSERT INTO thread_goals VALUES (?, 'task', 'active', 0)");
  db.exec("BEGIN");
  for (let i = 0; i < 10001; i++) put.run(`bbbbbbbb-bbbb-bbbb-bbbb-${String(i).padStart(12, "0")}`);
  db.exec("COMMIT");
  await expect(readAutoResumeGoalCandidateIds(home)).rejects.toThrow("safe discovery limit");
});
