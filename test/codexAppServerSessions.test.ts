import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ open: vi.fn(), spawn: vi.fn() }));
vi.mock("child_process", async (original) => ({ ...await original<typeof import("child_process")>(), spawn: mocks.spawn }));
vi.mock("../src/services/codexAppServerRpc", () => ({ CodexAppServerRpc: { open: mocks.open }, CodexAppServerTurnInterruptedError: class extends Error {}, CodexAppServerDisconnectedError: class extends Error {} }));
import { observeRunningCodexSession, startCodexCliSession, sendCodexCliSessionMessage, cancelCodexCliSessionTurn, readNewCodexCliSessionSummary, steerCodexCliSessionTurn, resumeCodexSessionGoal, setCodexSessionGoalStatus, renameCodexCliSession, archiveCodexCliSession, unarchiveCodexCliSession, deleteCodexCliSession, clearCodexSessionGoal } from "../src/services/codexSessionResume";
import { getCodexSessionLiveState } from "../src/services/codexSessionLive";
import { cancelNativeCodexSessionTurn, getNativeCodexSessionRunning, startNativeCodexSessionTurn } from "../src/services/codexNativeSessionStatus";
import { subscribeDashboardRealtime } from "../src/services/dashboardRealtime";
import * as diagnostics from "../src/utils/persistentLog";
import { readCodexSessionPreferences } from '../src/services/codexSessionPreferences';

const id = "01a04882-d037-7a42-ad24-9afb61901199";
let root: string;
let previousHome: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codex-native-start-"));
  previousHome = process.env["CODEX_HOME"];
  process.env["CODEX_HOME"] = root;
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (_key: string, fallback?: unknown) => fallback, inspect: () => ({ globalValue: "app-server-stdio", workspaceValue: "cli" }) } as unknown as vscode.WorkspaceConfiguration);
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env["CODEX_HOME"]; else process.env["CODEX_HOME"] = previousHome;
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (_key: string, fallback?: unknown) => fallback } as vscode.WorkspaceConfiguration);
  vi.clearAllMocks();
  vi.mocked(startNativeCodexSessionTurn).mockReset().mockResolvedValue(false);
  vi.mocked(getNativeCodexSessionRunning).mockReturnValue(undefined);
  await rm(root, { recursive: true, force: true });
});

describe("native App Server new sessions", () => {
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
        const rpc = { request: vi.fn(), close: vi.fn() }; mocks.open.mockResolvedValue(rpc);
        await resumeCodexSessionGoal({ ...session, status: "idle", projectPath: root });
        expect(rpc.request).not.toHaveBeenCalled(); expect(rpc.close).toHaveBeenCalledOnce();
      }
      observeRunningCodexSession(session); observeRunningCodexSession(session);
      if (scenario === "delayed") await appendFile(transcript, event("task_started"));
      await vi.waitFor(() => expect(updates[0]?.status).toBe("running"));
      expect(await cancelCodexCliSessionTurn(id)).toBe(false);
      if (scenario !== "finished") await appendFile(transcript, scenario === "changed" ? event("task_started", "different-turn") + event("task_complete", "different-turn") : event(scenario === "cancelled" ? "turn_aborted" : "task_complete"));
      if (scenario === "changed") {
        await vi.waitFor(() => expect(log).toHaveBeenCalledWith("warning", "session-resume", "Restored native turn ended without confirmed completion", expect.anything(), expect.any(Error)));
        expect(updates).toHaveLength(1);
      } else {
        await vi.waitFor(() => expect(updates).toHaveLength(2));
        expect(updates[1]?.status).toBe(scenario === "cancelled" ? "cancelled" : "completed");
        expect(updates[1]?.streamId).toBe(updates[0]?.streamId);
        expect(log).not.toHaveBeenCalledWith("warning", "session-resume", "Restored native turn ended without confirmed completion", expect.anything(), expect.anything());
      }
      expect(startNativeCodexSessionTurn).not.toHaveBeenCalled(); expect(mocks.open).toHaveBeenCalledTimes(scenario === "raced" ? 1 : 0);
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

  it("stops a browser-initiated native turn once and reports its actual cancellation", async () => {
    const cancelled = vi.fn();
    const unsubscribe = subscribeDashboardRealtime(event => { if (event.type === "dashboard:codex-session-live" && event.state.status === "cancelled") cancelled(event.state); });
    await mkdir(path.join(root, "sessions"));
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
    vi.mocked(cancelNativeCodexSessionTurn).mockImplementationOnce(async () => {
      await stopping;
      await appendFile(transcript, JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "owned-native-turn" } }) + "\n");
      return true;
    });
    const accepted = vi.fn();
    const sending = expect(sendCodexCliSessionMessage({ sessionId: id, text: "Continue", onStarted: accepted })).rejects.toThrow("stopped");
    try {
      await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
      const first = cancelCodexCliSessionTurn(id), second = cancelCodexCliSessionTurn(id);
      await vi.waitFor(() => expect(cancelNativeCodexSessionTurn).toHaveBeenCalledOnce());
      expect(readCodexSessionPreferences(root, [id]).get(id)?.manualStop).toBe(true);
      stopped();
      expect(await first).toBe(true); expect(await second).toBe(true); await sending;
      expect(cancelNativeCodexSessionTurn).toHaveBeenCalledWith(root, id, "owned-native-turn");
      expect(cancelled).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id, turnId: "owned-native-turn", status: "cancelled" }));
      expect(await cancelCodexCliSessionTurn(id)).toBe(false);
      expect(mocks.open).not.toHaveBeenCalled();
    } finally { stopped(); unsubscribe(); vi.mocked(getNativeCodexSessionRunning).mockReturnValue(undefined); vi.mocked(cancelNativeCodexSessionTurn).mockReset().mockResolvedValue(false); }
  });
  it("confirms explicit goal controls in the recorded project without adding a user instruction", async () => {
    await mkdir(path.join(root, "sessions"));
    await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, cwd: root } }) + "\n");
    const rpc = { request: vi.fn(async (_method: string, params: { status: string }) => ({ goal: { status: params.status } })), close: vi.fn() }; mocks.open.mockResolvedValue(rpc);
    await setCodexSessionGoalStatus(id, "paused"); await setCodexSessionGoalStatus(id, "active");
    expect(rpc.request).toHaveBeenCalledWith("thread/goal/set", { threadId: id, status: "paused", origin: "automatic" }, expect.any(Number));
    expect(rpc.request).toHaveBeenCalledWith("thread/goal/set", { threadId: id, status: "active", origin: "automatic" }, expect.any(Number));
    expect(mocks.open.mock.calls.every(([, cwd]) => cwd === root)).toBe(true);
    rpc.request.mockResolvedValueOnce({ goal: { status: "active" } });
    await expect(setCodexSessionGoalStatus(id, "paused")).rejects.toThrow("did not confirm");
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
  it.each([true, false])("resumes a native-owned goal once without a prompt (known owner: %s)", async known => {
    await mkdir(path.join(root, "sessions"));
    const transcript = path.join(root, "sessions", `rollout-${id}.jsonl`);
    await writeFile(transcript, JSON.stringify({ type: "session_meta", payload: { id, cwd: root } }) + "\n");
    vi.mocked(getNativeCodexSessionRunning).mockReturnValue(known ? false : undefined);
    vi.mocked(startNativeCodexSessionTurn).mockImplementationOnce(async () => {
      await appendFile(transcript, ["task_started", "task_complete"].map(type => JSON.stringify({ type: "event_msg", payload: { type, turn_id: "native-goal" } })).join("\n") + "\n");
      return true;
    });
    const completed = vi.fn();
    const unsubscribe = subscribeDashboardRealtime(event => { if (event.type === "dashboard:codex-session-live" && event.state.status === "completed") completed(event.state); });
    const rpc = { request: vi.fn(async (method: string) => { if (method === "thread/resume") throw new Error("thread already has an active writer"); return { goal: { status: "usageLimited" } }; }), close: vi.fn(), onNotification: () => () => undefined, onServerRequest: () => () => undefined, onDisconnect: () => () => undefined }; mocks.open.mockResolvedValue(rpc);
    try {
      await resumeCodexSessionGoal({ id, title: "Native goal", status: "idle", projectPath: root });
      expect(rpc.request.mock.calls.map(([method]) => method)).toEqual(["thread/goal/get", "thread/goal/set", ...(!known ? ["thread/resume"] : [])]);
      expect(startNativeCodexSessionTurn).toHaveBeenCalledWith(root, id, { threadId: id, input: [], cwd: root }, undefined, expect.any(Function));
      expect(rpc.close).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(completed).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id, status: "completed" })));
      expect(completed).toHaveBeenCalledOnce();
    } finally { unsubscribe(); vi.mocked(getNativeCodexSessionRunning).mockReturnValue(undefined); }
  });
  it.each(["active", "committed", "recovered", "unchanged", "replaced", "paused"])("verifies native goal ownership without rewriting an active goal (%s)", async scenario => {
    const completed = vi.fn();
    const unsubscribe = subscribeDashboardRealtime(event => { if (event.type === "dashboard:codex-session-live" && event.state.status === "completed") completed(); });
    await mkdir(path.join(root, "sessions"));
    const transcript = path.join(root, "sessions", `rollout-${id}.jsonl`);
    await writeFile(transcript, JSON.stringify({ type: "session_meta", payload: { id, cwd: root } }) + "\n");
    vi.mocked(getNativeCodexSessionRunning).mockReturnValue(false);
    const native = vi.mocked(startNativeCodexSessionTurn).mockImplementationOnce(async () => {
      await appendFile(transcript, ["task_started", "task_complete"].map(type => JSON.stringify({ type: "event_msg", payload: { type, turn_id: "verified-goal" } })).join("\n") + "\n");
      return true;
    });
    let reads = 0;
    const rpc = { request: vi.fn(async (method: string, params?: { origin?: string }) => {
      if (method === "thread/goal/set") {
        if (scenario === "recovered" && params?.origin === "automatic") return { goal: { status: "active", objective: "Finish this task" } };
        throw new Error("failed to record goal instruction: thread already has an active writer");
      }
      reads++;
      return { goal: { status: reads > 1 && scenario === "paused" ? "paused" : scenario === "active" || reads > 1 && ["committed", "replaced"].includes(scenario) ? "active" : "usageLimited", objective: reads > 1 && scenario === "replaced" ? "Another task" : "Finish this task" } };
    }), close: vi.fn() }; mocks.open.mockResolvedValue(rpc);
    try {
      const action = resumeCodexSessionGoal({ id, title: "Native goal", status: "idle", projectPath: root }, undefined, scenario === "unchanged" ? "automatic" : "user");
      if (["unchanged", "replaced", "paused"].includes(scenario)) { await expect(action).rejects.toThrow("active writer"); expect(native).not.toHaveBeenCalled(); }
      else { await action; expect(native).toHaveBeenCalledOnce(); await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce()); }
      expect(rpc.request.mock.calls.filter(([method]) => method === "thread/goal/set")).toHaveLength(scenario === "active" ? 0 : scenario === "recovered" ? 2 : 1);
    } finally { unsubscribe(); vi.mocked(getNativeCodexSessionRunning).mockReturnValue(undefined); native.mockReset().mockResolvedValue(false); }
  });
  it("uses the recorded closed project for all lifecycle operations", async () => {
    const project = path.join(root, "recorded-project"); await mkdir(project); await mkdir(path.join(root, "sessions"));
    await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, cwd: project } }) + "\n");
    const rpc = { request: vi.fn(async () => ({})), close: vi.fn() }; mocks.open.mockResolvedValue(rpc);
    await renameCodexCliSession(id, "Renamed task"); await archiveCodexCliSession(id); await unarchiveCodexCliSession(id); await deleteCodexCliSession(id);
    expect(rpc.request.mock.calls.map(([method]) => method)).toEqual(["thread/name/set", "thread/archive", "thread/unarchive", "thread/delete"]);
    expect(mocks.open.mock.calls.every(([, cwd]) => cwd === project)).toBe(true);
    expect(mocks.spawn).not.toHaveBeenCalled(); expect(rpc.close).toHaveBeenCalledTimes(4);
  });
  it("rejects a different selected project instead of sending in an unrelated workspace", async () => {
    const project = path.join(root, "recorded-project"); await mkdir(project); await mkdir(path.join(root, "sessions"));
    await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, cwd: project } }) + "\n");
    await expect(sendCodexCliSessionMessage({ sessionId: id, text: "Continue", projectPath: root })).rejects.toThrow();
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it.each([false, true])("resumes a goal in its closed project without a prompt (native auto-start: %s)", async autoStart => {
    const project = path.join(root, "goal-project");
    await mkdir(project); await mkdir(path.join(root, "sessions"));
    await writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id, cwd: project } }) + "\n");
    const listeners = new Set<(method: string, params: unknown) => void>();
    const emit = (method: string) => [...listeners].forEach(fn => fn(method, { threadId: id, turn: { id: "goal-turn", status: "completed" } }));
    const rpc = {
      request: vi.fn(async (method: string, params?: { status?: string }) => {
        if ((autoStart && method === "thread/resume") || method === "turn/start") emit("turn/started");
        return { goal: { status: method === "thread/goal/set" ? params?.status : "usageLimited" } };
      }),
      onNotification: (fn: (method: string, params: unknown) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
      onServerRequest: () => () => undefined, onDisconnect: () => () => undefined, close: vi.fn()
    };
    mocks.open.mockResolvedValue(rpc);
    try {
      await resumeCodexSessionGoal({ id, title: "Goal task", status: "idle", projectPath: project });
      expect(mocks.open).toHaveBeenCalledWith(expect.anything(), project, undefined);
      expect(rpc.request).toHaveBeenCalledWith("thread/resume", { threadId: id, cwd: project });
      expect(rpc.request.mock.calls.some(([method]) => method === "thread/goal/set")).toBe(true);
      if (!autoStart) expect(rpc.request).toHaveBeenCalledWith("thread/goal/set", { threadId: id, status: "active", origin: "automatic" });
      expect(rpc.request.mock.calls.some(([method]) => method === "turn/start")).toBe(!autoStart);
      if (!autoStart) expect(rpc.request).toHaveBeenCalledWith("turn/start", { threadId: id, input: [], cwd: project });
      expect(getCodexSessionLiveState(id)?.status).toBe("running");
      await setCodexSessionGoalStatus(id, "paused");
      expect(mocks.open).toHaveBeenCalledOnce();
      expect(rpc.request).toHaveBeenCalledWith("thread/goal/set", { threadId: id, status: "paused", origin: "automatic" });
    } finally { emit("turn/completed"); }
    expect(rpc.close).toHaveBeenCalledOnce();
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
      expect(mocks.open).toHaveBeenCalledWith(expect.anything(), project, undefined);
      expect(rpc.request).toHaveBeenCalledWith("thread/resume", { threadId: id, cwd: project });
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
      await expect(steerCodexCliSessionTurn({ sessionId: id, expectedTurnId: "other", text: "Guide" })).rejects.toThrow(/turn changed/);
      await steerCodexCliSessionTurn({ sessionId: id, expectedTurnId: "turn-1", text: "Guide" });
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
