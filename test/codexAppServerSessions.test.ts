import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ open: vi.fn(), spawn: vi.fn() }));
vi.mock("child_process", async (original) => ({ ...await original<typeof import("child_process")>(), spawn: mocks.spawn }));
vi.mock("../src/services/codexAppServerRpc", () => ({ CodexAppServerRpc: { open: mocks.open }, CodexAppServerTurnInterruptedError: class extends Error {}, CodexAppServerDisconnectedError: class extends Error {} }));
import { setCodexSessionAccess, observeRunningCodexSession, readCodexCliSessionSummary, startCodexCliSession, sendCodexCliSessionMessage, cancelCodexCliSessionTurn, readNewCodexCliSessionSummary, steerCodexCliSessionTurn, resumeCodexSessionGoal, setCodexSessionGoalStatus, renameCodexCliSession, archiveCodexCliSession, unarchiveCodexCliSession, deleteCodexCliSession, clearCodexSessionGoal, withCodexSessionMaintenance } from "../src/services/codexSessionResume";
import { getCodexSessionLiveState } from "../src/services/codexSessionLive";
import { updateNativeCodexSessionAccess, cancelNativeCodexSessionTurn, getNativeCodexSessionTurnId, getNativeCodexSessionRunning, readNativeCodexSessionRunning, startNativeCodexSessionTurn, steerNativeCodexSessionTurn } from "../src/services/codexNativeSessionStatus";
import { subscribeDashboardRealtime } from "../src/services/dashboardRealtime";
import * as diagnostics from "../src/utils/persistentLog";
import { readCodexSessionPreferences, writeCodexSessionPreference } from '../src/services/codexSessionPreferences';
import { configureSqliteStateStore, SqliteStateStore } from '../src/storage/sqliteState';
import { setCodexSessionAutoResume, setCodexSessionQueue } from '../src/services/codexSessionResume';

const id = "01a04882-d037-7a42-ad24-9afb61901199";
let root: string;
let preferenceStore: SqliteStateStore;
let previousHome: string | undefined;
function seedGoal(status: string) {
  const db = new DatabaseSync(path.join(root, "goals_1.sqlite"));
  try {
    db.exec("CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY, objective TEXT, status TEXT, time_used_seconds INTEGER)");
    db.prepare("INSERT INTO thread_goals VALUES (?, 'Finish this task', ?, 0)").run(id, status);
  } finally { db.close(); }
}
beforeEach(async () => {
  vi.mocked(readNativeCodexSessionRunning).mockResolvedValue(false);
  vi.mocked(updateNativeCodexSessionAccess).mockReset().mockResolvedValue(false);
  root = await mkdtemp(path.join(os.tmpdir(), "codex-native-start-"));
  preferenceStore = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
  configureSqliteStateStore(preferenceStore);
  previousHome = process.env["CODEX_HOME"];
  process.env["CODEX_HOME"] = root;
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (_key: string, fallback?: unknown) => fallback, inspect: () => ({ globalValue: "app-server-stdio", workspaceValue: "cli" }) } as unknown as vscode.WorkspaceConfiguration);
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env["CODEX_HOME"]; else process.env["CODEX_HOME"] = previousHome;
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (_key: string, fallback?: unknown) => fallback } as vscode.WorkspaceConfiguration);
  vi.clearAllMocks();
  vi.mocked(startNativeCodexSessionTurn).mockReset().mockResolvedValue(false);
  vi.mocked(steerNativeCodexSessionTurn).mockReset().mockResolvedValue(false);
  vi.mocked(getNativeCodexSessionRunning).mockReturnValue(undefined);
  vi.mocked(getNativeCodexSessionTurnId).mockReturnValue(undefined);
  configureSqliteStateStore(undefined); preferenceStore.close();
  await rm(root, { recursive: true, force: true });
});

describe("native App Server new sessions", () => {
  it.each([false, true])('switches between Auto Resume, off, and queue without losing uncertain starts (global %s)', globalEnabled => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback?: unknown) => key === 'autoResumeEnabled' ? globalEnabled : fallback } as vscode.WorkspaceConfiguration);
    setCodexSessionAutoResume(id, true);
    expect(readCodexSessionPreferences(root, [id]).get(id)?.autoResume).toBe(globalEnabled ? undefined : true);
    setCodexSessionQueue(id, true, 2);
    expect(readCodexSessionPreferences(root, [id]).get(id)).toMatchObject({ autoResume: false, queue: true, priority: 2 });
    setCodexSessionAutoResume(id, false);
    expect(readCodexSessionPreferences(root, [id]).get(id)).toMatchObject({ autoResume: false, queue: false });
    setCodexSessionQueue(id, true, 3);
    setCodexSessionAutoResume(id, true);
    expect(readCodexSessionPreferences(root, [id]).get(id)?.autoResume).toBe(globalEnabled ? undefined : true);
    expect(readCodexSessionPreferences(root, [id]).get(id)?.queue).not.toBe(true);
    writeCodexSessionPreference(root, id, { queue: true, queueClaimId: 'uncertain', queueError: 'Review this start' });
    expect(() => setCodexSessionAutoResume(id, true)).toThrow('Review the previous queue attempt');
    setCodexSessionAutoResume(id, false);
    expect(readCodexSessionPreferences(root, [id]).get(id)).toMatchObject({ autoResume: false, queue: false, queueClaimId: 'uncertain', queueError: 'Review this start' });
  });

  it('supplies document uploads to Codex as private file references instead of image or binary inline input', async () => {
    await mkdir(path.join(root, 'sessions'));
    await writeFile(path.join(root, 'sessions', `rollout-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: root } }) + '\n');
    const rpc = { request: vi.fn(async () => ({})), onServerRequest: () => () => undefined, onNotification: () => () => undefined, close: vi.fn(), startAndWaitForTurn: vi.fn(async (_id: string, _params: unknown, _timeout: number, started: (id: string) => void) => { started('document-turn'); }) };
    mocks.open.mockResolvedValue(rpc);
    await sendCodexCliSessionMessage({ sessionId: id, text: 'Read the document', projectPath: root, attachments: [{ id: 'report', name: 'report.pdf', kind: 'file', mimeType: 'application/pdf', data: 'data:application/pdf;base64,JVBERi0=', size: 5 }] });
    expect(rpc.startAndWaitForTurn).toHaveBeenCalledWith(id, expect.objectContaining({ input: [expect.objectContaining({ type: 'text', text: expect.stringContaining('attachment_paths') })] }), expect.any(Number), expect.any(Function));
    expect(JSON.stringify(rpc.startAndWaitForTurn.mock.calls)).not.toContain('JVBERi0=');
  });

  it('continues an active goal privately with empty input and never contacts the native owner', async () => {
    await mkdir(path.join(root, 'sessions'));
    await writeFile(path.join(root, 'sessions', `rollout-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: root } }) + '\n');
    seedGoal('active');
    const rpc = { request: vi.fn(async () => ({})), onServerRequest: () => () => undefined, onNotification: () => () => undefined, close: vi.fn(), startAndWaitForTurn: vi.fn(async (_id: string, _params: unknown, _timeout: number, started: (id: string) => void) => { started('private-goal-turn'); }) };
    mocks.open.mockResolvedValue(rpc);
    await resumeCodexSessionGoal({ id, title: 'Goal', status: 'idle', projectPath: root, goal: { objective: 'Finish', status: 'active' } }, undefined, 'automatic', true);
    expect(startNativeCodexSessionTurn).not.toHaveBeenCalled(); expect(rpc.startAndWaitForTurn).toHaveBeenCalledWith(id, expect.objectContaining({ input: [] }), expect.any(Number), expect.any(Function));
  });

  it.each(['manual-stop', 'paused', 'writer-conflict'])('keeps private goal recovery safe when %s', async scenario => {
    await mkdir(path.join(root, 'sessions'));
    await writeFile(path.join(root, 'sessions', `rollout-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: root } }) + '\n');
    seedGoal(scenario === 'paused' ? 'paused' : 'active');
    if (scenario === 'manual-stop') writeCodexSessionPreference(root, id, { manualStop: true });
    const rpc = { request: vi.fn(async () => { throw new Error('already has an active writer'); }), onNotification: () => () => undefined, onServerRequest: () => () => undefined, close: vi.fn(), startAndWaitForTurn: vi.fn() };
    mocks.open.mockResolvedValue(rpc);
    await expect(resumeCodexSessionGoal({ id, title: 'Goal', status: 'idle', projectPath: root }, undefined, 'automatic', true)).rejects.toThrow(scenario === 'manual-stop' ? 'explicitly stopped' : scenario === 'paused' ? 'paused' : 'active writer');
    expect(startNativeCodexSessionTurn).not.toHaveBeenCalled();
    expect(rpc.startAndWaitForTurn).not.toHaveBeenCalled();
    if (scenario !== 'writer-conflict') expect(mocks.open).not.toHaveBeenCalled();
    else expect(rpc.close).toHaveBeenCalled();
  });

  it('preserves the previous mode when storage fails or the queue is full', () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback?: unknown) => key === 'autoResumeEnabled' ? false : fallback } as vscode.WorkspaceConfiguration);
    setCodexSessionAutoResume(id, true);
    const write = vi.spyOn(preferenceStore, 'set').mockImplementation(() => { throw new Error('storage full'); });
    expect(() => setCodexSessionQueue(id, true)).toThrow('storage full');
    expect(readCodexSessionPreferences(root, [id]).get(id)?.autoResume).toBe(true);
    write.mockRestore();
    for (let index = 0; index < 256; index++) writeCodexSessionPreference(root, `${index}`.padStart(36, '0'), { queue: true });
    expect(() => setCodexSessionQueue(id, true)).toThrow('queue is full');
    expect(readCodexSessionPreferences(root, [id]).get(id)?.autoResume).toBe(true);
  });
  it.each(['thread not found','conversation does not exist','session has already been deleted','network offline'])("deletes Manager-only entries from obsolete projects with result: %s", async message => {
    const rpc = { request: vi.fn().mockRejectedValue(new Error(message)), close: vi.fn() };
    mocks.open.mockResolvedValue(rpc);
    const operation = deleteCodexCliSession(id);
    if (message === 'network offline') await expect(operation).rejects.toThrow(message);
    else await expect(operation).resolves.toBeUndefined();
    expect(mocks.open.mock.calls[0]?.[1]).toBe(root);
    expect(rpc.request).toHaveBeenCalledOnce();
  });

  it.each(['archive', 'delete'] as const)('retires queue preferences only after confirmed native %s', async operation => {
    await mkdir(path.join(root, 'sessions'));
    await writeFile(path.join(root, 'sessions', `rollout-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: root } }) + '\n');
    writeCodexSessionPreference(root, id, { queue: true, priority: 3, autoResume: false });
    const rpc = { request: vi.fn(async () => { throw new Error('Native operation failed'); }), close: vi.fn() };
    mocks.open.mockResolvedValue(rpc);
    const mutate = operation === 'archive' ? archiveCodexCliSession : deleteCodexCliSession;
    await expect(mutate(id)).rejects.toThrow('Native operation failed');
    expect(readCodexSessionPreferences(root, [id]).get(id)).toMatchObject({ queue: true, priority: 3, autoResume: false });
    rpc.request.mockResolvedValueOnce({} as never);
    await mutate(id);
    expect(readCodexSessionPreferences(root, [id]).get(id)).toMatchObject({ queue: false, autoResume: false });
    expect(readCodexSessionPreferences(root, [id]).get(id)?.priority).toBeUndefined();
  });

  it.each(['archive', 'delete'] as const)('reports a confirmed %s with unavailable queue storage without replaying it', async operation => {
    await mkdir(path.join(root, 'sessions'));
    await writeFile(path.join(root, 'sessions', `rollout-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: root } }) + '\n');
    const rpc = { request: vi.fn(async (_method: string) => ({})), close: vi.fn() };
    mocks.open.mockResolvedValue(rpc); configureSqliteStateStore(undefined);
    const mutate = operation === 'archive' ? archiveCodexCliSession : deleteCodexCliSession;
    await expect(mutate(id)).rejects.toThrow('queue cleanup could not be saved');
    expect(rpc.request).toHaveBeenCalledTimes(1);
    expect(rpc.request.mock.calls[0]?.[0]).toBe(`thread/${operation}`);
  });

  it.each(['completed', 'missing', 'during-resume', 'writer-conflict', 'truncated', 'cancelled', 'home-changed', 'resume-failed'])('does not send recovery after completion or unsafe startup (%s)', async scenario => {
    await mkdir(path.join(root, 'sessions'));
    const transcript = path.join(root, 'sessions', `rollout-${id}.jsonl`);
    const event = (type: string) => JSON.stringify({ type: 'event_msg', payload: { type, turn_id: 'finished-turn' } }) + '\n';
    await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id, cwd: root } }) + '\n' +
      (scenario === 'missing' ? '' : event('task_started') + event(scenario === 'completed' ? 'task_complete' : 'task_failed')));
    const controller = new AbortController();
    const rpc = {
      request: vi.fn(async () => {
        if (scenario === 'resume-failed') throw new Error('Storage full');
        if (scenario === 'truncated') await writeFile(transcript, '');
        else await appendFile(transcript, event('task_started').replaceAll('finished-turn', 'successful-turn') + event('task_complete').replaceAll('finished-turn', 'successful-turn'));
        if (scenario === 'cancelled') controller.abort(new Error('Recovery cancelled'));
        if (scenario === 'home-changed') process.env['CODEX_HOME'] = path.join(root, 'other');
        if (scenario === 'writer-conflict') throw new Error('thread already has an active writer');
        return {};
      }),
      close: vi.fn(), onNotification: () => () => undefined, onServerRequest: () => () => undefined, startAndWaitForTurn: vi.fn()
    };
    if (scenario === 'completed') vi.mocked(getNativeCodexSessionRunning).mockReturnValue(false);
    mocks.open.mockResolvedValue(rpc);
    const accepted = vi.fn(), updates = vi.fn();
    const off = subscribeDashboardRealtime(message => { if (message.type === 'dashboard:codex-session-live') updates(message); });
    try {
      const sending = sendCodexCliSessionMessage({ sessionId: id, text: 'Continue if not completed', interruptedOnly: true, onStarted: accepted, signal: controller.signal });
      const errors: Record<string, string> = { missing: 'could not be verified', truncated: 'could not be verified', cancelled: 'Recovery cancelled', 'home-changed': 'home changed', 'resume-failed': 'Storage full' };
      if (errors[scenario]) await expect(sending).rejects.toThrow(errors[scenario]); else await sending;
      expect(mocks.open).toHaveBeenCalledTimes(['completed', 'missing'].includes(scenario) ? 0 : 1);
      expect(rpc.startAndWaitForTurn).not.toHaveBeenCalled(); expect(startNativeCodexSessionTurn).not.toHaveBeenCalled();
      expect(accepted).not.toHaveBeenCalled(); expect(updates).not.toHaveBeenCalled();
      if (mocks.open.mock.calls.length) expect(rpc.close).toHaveBeenCalled();
    } finally { off(); process.env['CODEX_HOME'] = root; }
  });

  it('allows an explicit user message after a completed turn', async () => {
    await mkdir(path.join(root, 'sessions'));
    await writeFile(path.join(root, 'sessions', `rollout-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: root } }) + '\n' +
      ['task_started', 'task_complete'].map(type => JSON.stringify({ type: 'event_msg', payload: { type, turn_id: 'old-turn' } })).join('\n') + '\n');
    const rpc = { request: vi.fn(async () => ({})), close: vi.fn(), onNotification: () => () => undefined, onServerRequest: () => () => undefined,
      startAndWaitForTurn: vi.fn(async (_id: string, _params: unknown, _timeout: number, started: (id: string) => void) => { started('new-user-turn'); }) };
    mocks.open.mockResolvedValue(rpc);
    const accepted = vi.fn();
    await sendCodexCliSessionMessage({ sessionId: id, text: 'New instructions', onStarted: accepted });
    expect(rpc.startAndWaitForTurn).toHaveBeenCalledOnce(); expect(accepted).toHaveBeenCalledOnce();
  });

  it("reuses and closes one native process for concurrent cleanup without bypassing running protection", async () => {
    const secondId = "01a04882-d037-7a42-ad24-9afb61901200";
    const rpc = { request: vi.fn(async () => ({})), close: vi.fn() }; mocks.open.mockResolvedValue(rpc);
    vi.mocked(getNativeCodexSessionRunning).mockReturnValue(false);
    await withCodexSessionMaintenance([id, secondId], () => Promise.all([deleteCodexCliSession(id), unarchiveCodexCliSession(secondId)]));
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(expect.anything(), root, undefined, "stdio");
    expect(rpc.request.mock.calls.map(([method]) => method).sort()).toEqual(["thread/delete", "thread/unarchive"]);
    expect(rpc.close).toHaveBeenCalledOnce();
    mocks.open.mockClear(); rpc.close.mockClear(); rpc.request.mockClear();
    vi.mocked(getNativeCodexSessionRunning).mockReturnValue(true);
    await expect(withCodexSessionMaintenance([id], () => deleteCodexCliSession(id))).rejects.toThrow("Stop the active");
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("keeps failed cleanup outcomes and closes its process without replaying mutations", async () => {
    const rpc = { request: vi.fn().mockRejectedValueOnce(new Error("Storage full")).mockResolvedValue({}), close: vi.fn() }; mocks.open.mockResolvedValue(rpc);
    vi.mocked(getNativeCodexSessionRunning).mockReturnValue(false);
    await withCodexSessionMaintenance([id], async () => {
      await expect(deleteCodexCliSession(id)).rejects.toThrow("Storage full");
      await unarchiveCodexCliSession(id);
    });
    expect(mocks.open).toHaveBeenCalledOnce(); expect(rpc.close).toHaveBeenCalledOnce();
    expect(rpc.request).toHaveBeenCalledTimes(2);
  });

  it("does not open cleanup processes for missing selection, changed home, or failed startup", async () => {
    vi.mocked(getNativeCodexSessionRunning).mockReturnValue(false);
    await expect(withCodexSessionMaintenance([], () => deleteCodexCliSession(id))).rejects.toThrow("cleanup context changed");
    await expect(withCodexSessionMaintenance([id], async () => {
      process.env["CODEX_HOME"] = path.join(root, "other");
      try { await unarchiveCodexCliSession(id); } finally { process.env["CODEX_HOME"] = root; }
    })).rejects.toThrow("cleanup context changed");
    expect(mocks.open).not.toHaveBeenCalled();
    mocks.open.mockRejectedValue(new Error("Codex unavailable"));
    await withCodexSessionMaintenance([id], async () => {
      await expect(deleteCodexCliSession(id)).rejects.toThrow("Codex unavailable");
      await expect(unarchiveCodexCliSession(id)).rejects.toThrow("Codex unavailable");
    });
    expect(mocks.open).toHaveBeenCalledOnce();
  });

  it.each(["active", "finished", "delayed", "cancelled", "changed", "raced"])("observes restored native work without another prompt or Stop ownership (%s)", async scenario => {
    await mkdir(path.join(root, "sessions"));
    const transcript = path.join(root, "sessions", `rollout-${id}.jsonl`), startedAt = Date.now();
    const event = (type: string, turn = "restored-turn") => JSON.stringify({ timestamp: new Date(turn === "old-turn" ? startedAt - 60_000 : startedAt).toISOString(), type: "event_msg", payload: { type, turn_id: turn } }) + "\n";
    await writeFile(transcript, JSON.stringify({ type: "session_meta", payload: { id, cwd: root } }) + "\n" +
      (scenario === "delayed" ? event("task_started", "old-turn") + event("task_complete", "old-turn") : event("task_started")) +
      (scenario === "finished" ? event("task_complete") : ""));
    const updates: Array<{ streamId: string; status: string }> = [];
    const unsubscribe = subscribeDashboardRealtime(message => { if (message.type === "dashboard:codex-session-live" && message.state.sessionId === id) updates.push(message.state); });
    const log = vi.spyOn(diagnostics, "recordPersistentEvent");
    const session = { id, title: "Restored goal", status: "running" as const, runningSince: scenario === "delayed" ? undefined : startedAt };
    try {
      if (scenario === "raced") {
        vi.mocked(getNativeCodexSessionRunning).mockReturnValue(true);
        vi.mocked(readNativeCodexSessionRunning).mockResolvedValue(true);
        const rpc = { request: vi.fn(), close: vi.fn() }; mocks.open.mockResolvedValue(rpc);
        await resumeCodexSessionGoal({ ...session, status: "idle", projectPath: root });
        expect(mocks.open).not.toHaveBeenCalled();
      }
      observeRunningCodexSession(session); observeRunningCodexSession(session);
      if (scenario === "delayed") await appendFile(transcript, event("task_started"));
      await vi.waitFor(() => expect(updates[0]?.status).toBe("running"));
      if (scenario === 'active') {
        vi.mocked(getNativeCodexSessionRunning).mockReturnValue(true);
        vi.mocked(getNativeCodexSessionTurnId).mockReturnValue("restored-turn");
        expect((await readCodexCliSessionSummary(id, root, "display"))?.steerTurnId).toBe("restored-turn");
        vi.mocked(getNativeCodexSessionRunning).mockReturnValue(false);
        vi.mocked(getNativeCodexSessionTurnId).mockReturnValue(undefined);
        expect((await readCodexCliSessionSummary(id, root, "display"))?.steerTurnId).toBeUndefined();
        vi.mocked(getNativeCodexSessionRunning).mockReturnValue(true);
        expect((await readCodexCliSessionSummary(id, root, "display"))?.steerTurnId).toBeUndefined();
        await expect(steerCodexCliSessionTurn({ sessionId: id, expectedTurnId: "restored-turn", text: "Old observer" })).rejects.toThrow(/does not own/);
        expect(steerNativeCodexSessionTurn).not.toHaveBeenCalled();
        vi.mocked(getNativeCodexSessionTurnId).mockReturnValue('restored-turn');
        vi.mocked(steerNativeCodexSessionTurn).mockResolvedValueOnce(true);
        await steerCodexCliSessionTurn({sessionId:id,expectedTurnId:'restored-turn',text:'Follow up',projectPath:root});
        expect(steerNativeCodexSessionTurn).toHaveBeenCalledWith(root,id,'restored-turn',expect.any(Array),root);
      }
      expect(await cancelCodexCliSessionTurn(id)).toBe(false);
      if (scenario !== "finished") await appendFile(transcript, scenario === "changed" ? event("task_started", "different-turn") + event("task_complete", "different-turn") : event(scenario === "cancelled" ? "turn_aborted" : "task_complete"));
      if (scenario === "changed") {
        await vi.waitFor(() => expect(log).toHaveBeenCalledWith("warning", "session-resume", "Restored native turn ended without confirmed completion", expect.anything(), expect.any(Error)));
        expect(log).toHaveBeenCalledWith("warning", "session-turn", "Official native turn observation ended", expect.objectContaining({ status: "disconnected", completionConfirmed: false }), expect.any(Error));
        expect(updates).toHaveLength(1);
      } else {
        await vi.waitFor(() => expect(updates).toHaveLength(2));
        expect(updates[1]?.status).toBe(scenario === "cancelled" ? "cancelled" : "completed");
        expect(updates[1]?.streamId).toBe(updates[0]?.streamId);
        expect(log).toHaveBeenCalledWith("info", "session-turn", "Official native turn observation ended", expect.objectContaining({ status: scenario === "cancelled" ? "cancelled" : "completed", completionConfirmed: scenario !== "cancelled", source: "official-transcript" }), scenario === "cancelled" ? expect.any(Error) : undefined);
        expect(log).not.toHaveBeenCalledWith("warning", "session-resume", "Restored native turn ended without confirmed completion", expect.anything(), expect.anything());
      }
      expect(startNativeCodexSessionTurn).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled();
    } finally { unsubscribe(); log.mockRestore(); }
  });

  it.each([false, true])("does not replay old completion when restored work has no verified journal (missing: %s)", async missing => {
    await mkdir(path.join(root, "sessions"));
    if (!missing) await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), ["task_started", "task_complete"].map(type => JSON.stringify({ timestamp: new Date(Date.now() - 60_000).toISOString(), type: "event_msg", payload: { type, turn_id: "old-turn" } })).join("\n") + "\n");
    const log = vi.spyOn(diagnostics, "recordPersistentEvent"), update = vi.fn();
    const unsubscribe = subscribeDashboardRealtime(update);
    try {
      observeRunningCodexSession({ id, title: "Restored goal", status: "running" });
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith("warning", "session-resume", "Restored native turn ended without confirmed completion", expect.anything(), expect.any(Error)), { timeout: 6_500 });
      expect(update).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled();
    } finally { unsubscribe(); log.mockRestore(); }
  });

  it.each(["journal", "missing-journal", "goal-pause-failure"])("releases a stopped native turn without depending on its journal (%s)", async scenario => {
    const log = vi.spyOn(diagnostics, "recordPersistentEvent");
    const cancelled = vi.fn();
    const unsubscribe = subscribeDashboardRealtime(event => { if (event.type === "dashboard:codex-session-live" && event.state.status === "cancelled") cancelled(event.state); });
    await mkdir(path.join(root, "sessions"));
    await writeFile(path.join(root, "session_index.jsonl"), JSON.stringify({ id, thread_name: "Owned native task" }) + "\n");
    const transcript = path.join(root, "sessions", `rollout-${id}.jsonl`);
    await writeFile(transcript, JSON.stringify({ type: "session_meta", payload: { id, cwd: root } }) + "\n");
    vi.mocked(getNativeCodexSessionRunning).mockReturnValue(false);
    vi.mocked(startNativeCodexSessionTurn).mockImplementationOnce(async (_home, _id, _params, _signal, started) => {
      started?.("owned-native-turn");
      await appendFile(transcript, JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "owned-native-turn" } }) + "\n");
      return true;
    });
    let stopped!: () => void;
    const stopping = new Promise<void>(resolve => { stopped = resolve; });
    vi.mocked(cancelNativeCodexSessionTurn).mockImplementationOnce(async (_home, _id, _turn, onStopped) => {
      await stopping;
      if (scenario === "journal") await appendFile(transcript, JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "owned-native-turn" } }) + "\n");
      onStopped?.();
      if (scenario === "goal-pause-failure") throw new Error("The turn stopped, but its goal could not pause: storage full");
      return true;
    });
    const accepted = vi.fn();
    const sending = expect(sendCodexCliSessionMessage({ sessionId: id, text: "Continue", onStarted: accepted })).rejects.toThrow("stopped");
    try {
      await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
      expect(await readCodexCliSessionSummary(id)).toMatchObject({ locked: true, status: "running" });
      vi.mocked(getNativeCodexSessionTurnId).mockReturnValue('owned-native-turn');
      await expect(steerCodexCliSessionTurn({sessionId:id,expectedTurnId:'another-turn',text:'Follow up'})).rejects.toThrow('turn changed');
      vi.mocked(steerNativeCodexSessionTurn).mockResolvedValueOnce(true);
      await steerCodexCliSessionTurn({sessionId:id,expectedTurnId:'owned-native-turn',text:'Follow up',projectPath:root});
      expect(steerNativeCodexSessionTurn).toHaveBeenCalledWith(root,id,'owned-native-turn',[expect.objectContaining({type:'text',text:'Follow up'})],root);
      vi.mocked(steerNativeCodexSessionTurn).mockRejectedValueOnce(new Error('Steer outcome unconfirmed'));
      await expect(steerCodexCliSessionTurn({sessionId:id,expectedTurnId:'owned-native-turn',text:'Do not retry'})).rejects.toThrow('unconfirmed');
      expect(steerNativeCodexSessionTurn).toHaveBeenCalledTimes(2);
      const first = cancelCodexCliSessionTurn(id), second = cancelCodexCliSessionTurn(id);
      const results = scenario === "goal-pause-failure" ? Promise.all([expect(first).rejects.toThrow("goal could not pause"), expect(second).rejects.toThrow("goal could not pause")]) : Promise.all([expect(first).resolves.toBe(true), expect(second).resolves.toBe(true)]);
      await vi.waitFor(() => expect(cancelNativeCodexSessionTurn).toHaveBeenCalledOnce());
      expect(readCodexSessionPreferences(root, [id]).get(id)?.manualStop).toBe(true);
      stopped();
      await results; await sending;
      expect(await readCodexCliSessionSummary(id)).toMatchObject({ locked: false, status: "idle" });
      expect(cancelNativeCodexSessionTurn).toHaveBeenCalledWith(root, id, "owned-native-turn", expect.any(Function));
      expect(cancelled).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id, turnId: "owned-native-turn", status: "cancelled" }));
      expect(await cancelCodexCliSessionTurn(id)).toBe(false);
      expect(mocks.open).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("info", "session-turn", "Official native turn accepted", expect.objectContaining({ turnRef: expect.any(String), transport: "official-native" }));
      if (scenario !== "goal-pause-failure") expect(log).toHaveBeenCalledWith("info", "session-stop", "Official Stop confirmed", expect.objectContaining({ origin: "user", actor: "manager", goalPauseRequested: true }));
    } finally { stopped(); unsubscribe(); log.mockRestore(); vi.mocked(getNativeCodexSessionRunning).mockReturnValue(undefined); vi.mocked(cancelNativeCodexSessionTurn).mockReset().mockResolvedValue(false); }
  });

  it.each([true, false])('stops a restored private-server turn through its native owner (observed: %s)', async observed => {
    await mkdir(path.join(root, 'sessions'));
    const transcript = path.join(root, 'sessions', `rollout-${id}.jsonl`);
    const event = (type: string) => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type, turn_id: 'restored-stop' } }) + '\n';
    await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id, cwd: root } }) + '\n' + event('task_started'));
    await writeFile(path.join(root, 'session_index.jsonl'), JSON.stringify({ id, thread_name: 'Restored task' }) + '\n');
    vi.mocked(getNativeCodexSessionRunning).mockReturnValue(true);
    vi.mocked(readNativeCodexSessionRunning).mockResolvedValue(true);
    const updates: string[] = [];
    const stop = subscribeDashboardRealtime(message => { if (message.type === 'dashboard:codex-session-live' && message.state.sessionId === id) updates.push(message.state.status); });
    try {
      expect(await readCodexCliSessionSummary(id)).toMatchObject({ status: 'running', canStop: true });
      if (observed) {
        observeRunningCodexSession({ id, title: 'Restored task', status: 'running' });
        await vi.waitFor(() => expect(updates).toContain('running'));
      }
      vi.mocked(cancelNativeCodexSessionTurn).mockImplementationOnce(async (_home, _id, _turn, onStopped) => {
        await appendFile(transcript, event('turn_aborted'));
        vi.mocked(getNativeCodexSessionRunning).mockReturnValue(false);
        vi.mocked(readNativeCodexSessionRunning).mockResolvedValue(false);
        onStopped?.();
        return true;
      });
      expect(await cancelCodexCliSessionTurn(id)).toBe(true);
      expect(cancelNativeCodexSessionTurn).toHaveBeenCalledWith(root, id, 'restored-stop', expect.any(Function));
      if (observed) await vi.waitFor(() => expect(updates).toContain('cancelled'));
      expect(await readCodexCliSessionSummary(id)).toMatchObject({ status: 'idle', locked: false, canStop: false });
      expect(startNativeCodexSessionTurn).not.toHaveBeenCalled();
      expect(readCodexSessionPreferences(root, [id]).get(id)?.manualStop).toBe(true);
    } finally { stop(); }
  });
  it("confirms explicit goal controls in the recorded project without adding a user instruction", async () => {
    const log = vi.spyOn(diagnostics, "recordPersistentEvent");
    try {
    await mkdir(path.join(root, "sessions"));
    await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, cwd: root } }) + "\n");
    const rpc = { request: vi.fn(async (_method: string, params: { status: string }) => ({ goal: { status: params.status } })), close: vi.fn() }; mocks.open.mockResolvedValue(rpc);
    await setCodexSessionGoalStatus(id, "paused"); await setCodexSessionGoalStatus(id, "active");
    expect(rpc.request).toHaveBeenCalledWith("thread/goal/set", { threadId: id, status: "paused", origin: "automatic" }, expect.any(Number));
    expect(rpc.request).toHaveBeenCalledWith("thread/goal/set", { threadId: id, status: "active", origin: "automatic" }, expect.any(Number));
    expect(mocks.open.mock.calls.every(([, cwd]) => cwd === root)).toBe(true);
    rpc.request.mockResolvedValueOnce({ goal: { status: "active" } });
    await expect(setCodexSessionGoalStatus(id, "paused")).rejects.toThrow("did not confirm");
    expect(log).toHaveBeenCalledWith("info", "session-goal", "Goal status change confirmed", expect.objectContaining({ requestedStatus: "paused", actor: "manager", origin: "user" }));
    expect(log).toHaveBeenCalledWith("warning", "session-goal", "Goal status change failed", expect.objectContaining({ requestedStatus: "paused", confirmed: false, phase: "official-api" }), expect.any(Error));
    } finally { log.mockRestore(); }
  });
  it("rejects a goal paused after automatic recovery selection before activating or starting it", async () => {
    await mkdir(path.join(root, "sessions"));
    await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, cwd: root } }) + "\n");
    vi.mocked(getNativeCodexSessionRunning).mockReturnValue(false);
    seedGoal("paused");
    await expect(resumeCodexSessionGoal({ id, title: "Paused task", status: "idle", projectPath: root }, undefined, "automatic")).rejects.toThrow("no longer eligible");
    expect(mocks.open).not.toHaveBeenCalled();
    expect(startNativeCodexSessionTurn).not.toHaveBeenCalled();
  });
  it("allows storage cleanup for a deleted project without running a turn in another workspace", async () => {
    await mkdir(path.join(root, "sessions"));
    await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, cwd: path.join(root, "deleted-project") } }) + "\n");
    const rpc = { request: vi.fn(async () => ({})), close: vi.fn() }; mocks.open.mockResolvedValue(rpc);
    await archiveCodexCliSession(id); await unarchiveCodexCliSession(id); await clearCodexSessionGoal(id); await deleteCodexCliSession(id);
    expect(mocks.open.mock.calls.every(([, cwd]) => cwd === root)).toBe(true);
    expect(rpc.request.mock.calls.map(([method]) => method)).toEqual(["thread/archive", "thread/unarchive", "thread/goal/clear", "thread/delete"]);
    await expect(sendCodexCliSessionMessage({ sessionId: id, text: "Continue" })).rejects.toThrow();
    expect(mocks.open).toHaveBeenCalledTimes(4);
  });
  it.each([true, false])("continues through the native owner without duplicating its writer (known owner: %s)", async known => {
    const directory = path.join(root, "sessions"); await mkdir(directory);
    const transcript = path.join(directory, `rollout-${id}.jsonl`);
    await writeFile(transcript, JSON.stringify({ type: "session_meta", payload: { id, cwd: root } }) + "\n");
    const native = vi.mocked(startNativeCodexSessionTurn);
    native.mockImplementationOnce(async (_home, _id, params) => {
      expect(params).toMatchObject({ cwd: root, input: [{ text: "Continue" }] });
      await appendFile(transcript, ["task_started", "task_complete"].map(type => JSON.stringify({ type: "event_msg", payload: { type, turn_id: "native-continued" } })).join("\n") + "\n");
      return true;
    });
    if (known) vi.mocked(getNativeCodexSessionRunning).mockReturnValue(false);
    const rpc = { request: vi.fn(async () => { throw new Error("thread already has an active writer"); }), close: vi.fn(), onNotification: () => () => undefined, onServerRequest: () => () => undefined };
    mocks.open.mockResolvedValue(rpc);
    const accepted = vi.fn();
    const completed = vi.fn();
    const unsubscribe = subscribeDashboardRealtime(event => { if (event.type === "dashboard:codex-session-live" && event.state.status === "completed") completed(event.state); });
    try {
      await sendCodexCliSessionMessage({ sessionId: id, text: "Continue", onStarted: accepted });
      expect(accepted).toHaveBeenCalledOnce(); expect(native).toHaveBeenCalledOnce();
      expect(mocks.open).toHaveBeenCalledTimes(known ? 0 : 1);
      expect(completed).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id, status: "completed" }));
      expect(completed).toHaveBeenCalledOnce();
    } finally { unsubscribe(); vi.mocked(getNativeCodexSessionRunning).mockReturnValue(undefined); }
  });
  it.each(["active", "usage_limited", "paused"])("continues a native-owned %s goal once and reactivates interrupted paused work", async status => {
    await mkdir(path.join(root, "sessions"));
    const transcript = path.join(root, "sessions", `rollout-${id}.jsonl`);
    await writeFile(transcript, JSON.stringify({ type: "session_meta", payload: { id, cwd: root } }) + "\n" + JSON.stringify({ type: "event_msg", payload: { type: "task_failed", turn_id: "interrupted" } }) + "\n");
    vi.mocked(getNativeCodexSessionRunning).mockReturnValue(false);
    vi.mocked(startNativeCodexSessionTurn).mockImplementationOnce(async (_home, _id, _turn, _signal, onStarted) => {
      await appendFile(transcript, ["task_started", "task_complete"].map(type => JSON.stringify({ type: "event_msg", payload: { type, turn_id: "native-goal" } })).join("\n") + "\n");
      onStarted?.("native-goal"); return true;
    });
    const completed = vi.fn();
    const unsubscribe = subscribeDashboardRealtime(event => { if (event.type === "dashboard:codex-session-live" && event.state.status === "completed") completed(event.state); });
    seedGoal(status);
    const rpc = { request: vi.fn(async () => ({ goal: { status: "active" } })), close: vi.fn() };
    mocks.open.mockResolvedValue(rpc);
    try {
      await resumeCodexSessionGoal({ id, title: "Native goal", status: "idle", interrupted: true, projectPath: root });
      if (status === "paused") {
        expect(rpc.request).toHaveBeenCalledExactlyOnceWith("thread/goal/set", { threadId: id, status: "active", origin: "automatic" }, 10_000);
        expect(rpc.request.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(startNativeCodexSessionTurn).mock.invocationCallOrder[0]!);
        expect(rpc.close).toHaveBeenCalledOnce();
      } else expect(mocks.open).not.toHaveBeenCalled();
      expect(startNativeCodexSessionTurn).toHaveBeenCalledExactlyOnceWith(root, id, { threadId: id, input: [], cwd: root }, expect.any(AbortSignal), expect.any(Function));
      await vi.waitFor(() => expect(completed).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id, status: "completed" })));
    } finally { unsubscribe(); vi.mocked(getNativeCodexSessionRunning).mockReturnValue(undefined); }
  });
  it.each(["unavailable", "not-accepted", "unconfirmed", "complete", "blocked", "paused", "stopped"])("retains goal recovery without a prompt or private fallback when %s", async scenario => {
    await mkdir(path.join(root, "sessions"));
    await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, cwd: root } }) + "\n" + JSON.stringify({ type: "event_msg", payload: { type: scenario === "stopped" ? "turn_aborted" : "task_complete", ...(scenario === "stopped" ? { reason: "user_cancelled" } : {}) } }) + "\n");
    vi.mocked(getNativeCodexSessionRunning).mockReturnValue(scenario === "unavailable" ? undefined : false);
    seedGoal(["complete", "blocked", "paused"].includes(scenario) ? scenario : "active");
    if (scenario === "unavailable") vi.mocked(readNativeCodexSessionRunning).mockResolvedValue(undefined);
    if (scenario === "unconfirmed") vi.mocked(startNativeCodexSessionTurn).mockRejectedValueOnce(new Error("Unconfirmed native start"));
    await expect(resumeCodexSessionGoal({ id, title: "Goal", status: "idle", projectPath: root })).rejects.toThrow(scenario === "unconfirmed" ? "Unconfirmed" : scenario === "unavailable" ? "runtime is unavailable" : scenario === "not-accepted" ? "owner is unavailable" : "no longer eligible");
    expect(mocks.open).not.toHaveBeenCalled();
    expect(startNativeCodexSessionTurn).toHaveBeenCalledTimes(["not-accepted", "unconfirmed"].includes(scenario) ? 1 : 0);
  });
  it("uses the recorded project for lifecycle changes and storage for deletion", async () => {
    const project = path.join(root, "recorded-project"); await mkdir(project); await mkdir(path.join(root, "sessions"));
    await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, cwd: project } }) + "\n");
    const rpc = { request: vi.fn(async () => ({})), close: vi.fn() }; mocks.open.mockResolvedValue(rpc);
    await renameCodexCliSession(id, "Renamed task"); await archiveCodexCliSession(id); await unarchiveCodexCliSession(id); await deleteCodexCliSession(id);
    expect(rpc.request.mock.calls.map(([method]) => method)).toEqual(["thread/name/set", "thread/archive", "thread/unarchive", "thread/delete"]);
    expect(mocks.open.mock.calls.map(([, cwd]) => cwd)).toEqual([project,project,project,root]);
    expect(mocks.spawn).not.toHaveBeenCalled(); expect(rpc.close).toHaveBeenCalledTimes(4);
  });
  it("rejects a different selected project instead of sending in an unrelated workspace", async () => {
    const project = path.join(root, "recorded-project"); await mkdir(project); await mkdir(path.join(root, "sessions"));
    await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, cwd: project } }) + "\n");
    await expect(sendCodexCliSessionMessage({ sessionId: id, text: "Continue", projectPath: root })).rejects.toThrow();
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("continues a goal in its recorded closed project through the official owner without a prompt", async () => {
    const project = path.join(root, "goal-project");
    await mkdir(project); await mkdir(path.join(root, "sessions"));
    const transcript = path.join(root, "sessions", `rollout-${id}.jsonl`);
    await writeFile(transcript, JSON.stringify({ type: "session_meta", payload: { id, cwd: project } }) + "\n");
    vi.mocked(getNativeCodexSessionRunning).mockReturnValue(false);
    seedGoal("active");
    vi.mocked(startNativeCodexSessionTurn).mockImplementationOnce(async (_home, _id, _turn, _signal, onStarted) => {
      await appendFile(transcript, JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "closed-project-goal" } }) + "\n");
      onStarted?.("closed-project-goal"); return true;
    });
    await resumeCodexSessionGoal({ id, title: "Goal", status: "idle", projectPath: project });
    expect(startNativeCodexSessionTurn).toHaveBeenCalledWith(root, id, { threadId: id, input: [], cwd: project }, expect.any(AbortSignal), expect.any(Function));
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(getCodexSessionLiveState(id)?.status).toBe("completed"));
  });
  it("rejects an unavailable project before launching App Server", async () => {
    await expect(resumeCodexSessionGoal({ id, title: "Missing project", status: "idle", projectPath: path.join(root, "missing") })).rejects.toThrow();
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("does not continue an existing session without a recorded or selected project", async () => {
    await expect(sendCodexCliSessionMessage({ sessionId: id, text: "Continue" })).rejects.toThrow("no project folder");
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("uses the selected App Server transport to continue a closed transcript-only project with composer settings", async () => {
    const project = path.join(root, "closed-project"), workspace = path.join(root, "open-project");
    await Promise.all([project, workspace, path.join(root, "sessions")].map(directory => mkdir(directory)));
    await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, cwd: project } }) + "\n");
    const previousFolders = vscode.workspace.workspaceFolders;
    Object.assign(vscode.workspace, { workspaceFolders: [{ name: "open-project", uri: { fsPath: workspace } }] });
    const rpc = { request: vi.fn(async () => ({})), onServerRequest: () => () => undefined, onNotification: () => () => undefined, close: vi.fn(), startAndWaitForTurn: vi.fn(async (_id: string, _params: unknown, _timeout: number, started: (id: string) => void) => { started("resumed-turn"); }) };
    mocks.open.mockResolvedValue(rpc);
    try {
      await sendCodexCliSessionMessage({ sessionId: id, text: "continue", projectPath: project, model: "gpt-5", reasoningEffort: "high", sandboxMode: "read-only" });
      expect(mocks.open).toHaveBeenCalledWith(expect.anything(), project, undefined, "stdio");
      expect(rpc.request).toHaveBeenCalledWith("thread/resume", { threadId: id, cwd: project, excludeTurns: true });
      expect(rpc.startAndWaitForTurn).toHaveBeenCalledWith(id, expect.objectContaining({ cwd: project, model: "gpt-5", effort: "high", sandboxPolicy: expect.objectContaining({ type: "readOnly" }), input: [expect.objectContaining({ type: "text", text: "continue" })] }), expect.any(Number), expect.any(Function));
      expect(getCodexSessionLiveState(id)?.status).toBe("completed");
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(rpc.close).toHaveBeenCalled();
    } finally { Object.assign(vscode.workspace, { workspaceFolders: previousFolders }); }
  });
  it("steers only the expected owned turn through its existing connection", async () => {
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    const rpc = { request: vi.fn(async (method: string) => method === "turn/steer" ? { turnId: "turn-1" } : { thread: { id } }), onServerRequest: () => () => undefined, onNotification: () => () => undefined, close: vi.fn(), startAndWaitForTurn: vi.fn(async (_id: string, _params: unknown, _timeout: number, started: (id: string) => void) => { started("turn-1"); await completed; }) };
    mocks.open.mockResolvedValue(rpc);
    try {
      await startCodexCliSession({ text: "First prompt", projectPath: root });
      expect(readNewCodexCliSessionSummary(id)?.steerTurnId).toBe("turn-1");
      process.env["CODEX_HOME"] = path.join(root, "other-home");
      try {
        expect(readNewCodexCliSessionSummary(id)?.steerTurnId).toBeUndefined();
        await expect(steerCodexCliSessionTurn({ sessionId: id, expectedTurnId: "turn-1", text: "Wrong home" })).rejects.toThrow(/does not own/);
        expect(rpc.request).not.toHaveBeenCalledWith("turn/steer", expect.anything());
      } finally { process.env["CODEX_HOME"] = root; }
      await expect(steerCodexCliSessionTurn({ sessionId: id, expectedTurnId: "other", text: "Guide" })).rejects.toThrow(/turn changed/);
      vi.mocked(getNativeCodexSessionRunning).mockReturnValue(true);
      await steerCodexCliSessionTurn({ sessionId: id, expectedTurnId: "turn-1", text: "Guide" });
      expect(steerNativeCodexSessionTurn).not.toHaveBeenCalled();
      expect(rpc.request).toHaveBeenCalledWith("turn/steer", { threadId: id, expectedTurnId: "turn-1", input: [expect.objectContaining({ text: "Guide", type: "text" })] });
      expect(mocks.open).toHaveBeenCalledTimes(1);
      expect(getCodexSessionLiveState(id)?.status).toBe("running");
    } finally { finish(); await completed; await new Promise((resolve) => setTimeout(resolve, 0)); }
    await expect(steerCodexCliSessionTurn({ sessionId: id, expectedTurnId: "turn-1", text: "Guide" })).rejects.toThrow(/does not own/);
  });
  it("acknowledges the first accepted turn immediately and stops through App Server without launching exec", async () => {
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    const rpc = { request: vi.fn(async () => ({ thread: { id } })), onServerRequest: () => () => undefined, onNotification: () => () => undefined, close: vi.fn(), startAndWaitForTurn: vi.fn(async (_id: string, _params: unknown, _timeout: number, started: (id: string) => void) => { started("turn-1"); await completed; }) };
    mocks.open.mockResolvedValue(rpc);
    try {
      await expect(startCodexCliSession({ text: "First prompt", projectPath: root, reasoningEffort: "high", sandboxMode: "read-only" })).resolves.toBe(id);
      expect(rpc.request).toHaveBeenCalledWith("thread/start", expect.objectContaining({ cwd: root, sandbox: "read-only" }));
      expect(rpc.startAndWaitForTurn).toHaveBeenCalledWith(id, expect.objectContaining({ effort: "high", input: [expect.objectContaining({ type: "text", text: "First prompt" })] }), expect.any(Number), expect.any(Function));
      expect(readNewCodexCliSessionSummary(id)).toMatchObject({ status: "running", canStop: true });
      expect(await Promise.all([cancelCodexCliSessionTurn(id), cancelCodexCliSessionTurn(id)])).toEqual([true, true]);
      expect(rpc.request.mock.calls.filter(([method]) => method === 'turn/interrupt')).toHaveLength(1);
      expect(readCodexSessionPreferences(root, [id]).get(id)?.manualStop).toBe(true);
      expect(rpc.request).toHaveBeenCalledWith("turn/interrupt", { threadId: id, turnId: "turn-1" }, 10000);
      expect(mocks.spawn).not.toHaveBeenCalled();
    } finally { finish(); await completed; await new Promise((resolve) => setTimeout(resolve, 0)); }
    expect(rpc.close).toHaveBeenCalled();
  });
  it("reports initialization failure without silently falling back to CLI exec", async () => {
    mocks.open.mockRejectedValue(new Error("initialize unavailable"));
    await expect(startCodexCliSession({ text: "First prompt", projectPath: root })).rejects.toThrow("initialize unavailable");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("reports a rejected first turn and closes its App Server connection", async () => {
    const rpc = { request: vi.fn(async () => ({ thread: { id } })), onServerRequest: () => () => undefined, onNotification: () => () => undefined, close: vi.fn(), startAndWaitForTurn: vi.fn(async () => { throw new Error("Quota unavailable. Switch accounts."); }) };
    mocks.open.mockResolvedValue(rpc);
    await expect(startCodexCliSession({ text: "First prompt", projectPath: root })).rejects.toThrow("Quota unavailable");
    expect(rpc.close).toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

it('updates an idle session through Codex without starting or replaying a user turn', async () => {
  await mkdir(path.join(root,'sessions'));
  await writeFile(path.join(root,'session_index.jsonl'),JSON.stringify({id,thread_name:'Access session'})+'\n');
  await writeFile(path.join(root,'sessions',`rollout-${id}.jsonl`),JSON.stringify({type:'session_meta',payload:{id,cwd:root}})+'\n');
  const rpc={request:vi.fn(async()=>({})),close:vi.fn()};mocks.open.mockResolvedValue(rpc);
  const access=await setCodexSessionAccess(id,'read-only');expect(access.mode).toBe('read-only');
  expect(rpc.request.mock.calls.map(call=>call[0])).toEqual(['thread/resume','thread/settings/update']);
  expect(rpc.request).toHaveBeenLastCalledWith('thread/settings/update',{threadId:id,sandboxPolicy:{type:'readOnly',networkAccess:false}});
  expect(rpc.close).toHaveBeenCalledOnce();
  expect((await readCodexCliSessionSummary(id,root))?.access?.mode).toBe('read-only');
});
it('keeps access unchanged when the native owner cannot confirm the change', async () => {
  await mkdir(path.join(root,'sessions'));
  await writeFile(path.join(root,'session_index.jsonl'),JSON.stringify({id,thread_name:'Access session'})+'\n');
  await writeFile(path.join(root,'sessions',`rollout-${id}.jsonl`),JSON.stringify({type:'session_meta',payload:{id,cwd:root}})+'\n');
  vi.mocked(updateNativeCodexSessionAccess).mockRejectedValueOnce(new Error('Outcome unconfirmed'));
  await expect(setCodexSessionAccess(id,'danger-full-access')).rejects.toThrow('unconfirmed');
  expect(mocks.open).not.toHaveBeenCalled();expect((await readCodexCliSessionSummary(id,root))?.access).toBeUndefined();
});
