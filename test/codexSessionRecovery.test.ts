import { CodexNativeOwnerUnavailableError } from '../src/services/codexSessionResume';
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ summary: vi.fn(), stopped: vi.fn(), send: vi.fn(), goal: vi.fn(), observe: vi.fn(), files: vi.fn(), log: vi.fn() }));
vi.mock("../src/services/codexSessionResume", () => ({ CodexNativeOwnerUnavailableError: class extends Error {}, observeRunningCodexSession: mocks.observe, readManuallyStoppedCodexSessionIds: mocks.stopped, readCodexCliSessionSummary: mocks.summary, sendCodexCliSessionMessage: mocks.send, resumeCodexSessionGoal: mocks.goal, resolveCodexHome: () => "recovery-test", toSessionLogRef: () => "session-ref" }));
vi.mock("node:fs/promises", () => ({ readdir: mocks.files }));
vi.mock("../src/utils/persistentLog", () => ({ recordPersistentEvent: mocks.log }));
import { resumeCodexSessionWork } from "../src/services/codexSessionRecovery";
import { clearExplicitSessionGoalPause, markExplicitSessionGoalPause } from "../src/services/codexSessionGoals";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.summary.mockResolvedValue({ id: "session", title: "Pending task", status: "idle", interrupted: true, goal: null, projectPath: "project" });
  mocks.files.mockResolvedValue([]);
  mocks.stopped.mockResolvedValue([]);
  mocks.goal.mockResolvedValue(undefined);
  mocks.send.mockImplementation(async options => { options.onStarted(); });
});
afterEach(() => vi.useRealTimers());

describe("post-load session recovery", () => {
  it.each(['automatic', 'user'] as const)('uses the same private goal, interrupted-chat, and reconnect rules for %s recovery', async origin => {
    Object.defineProperty(vscode.env, 'appHost', { configurable: true, value: 'node' });
    try {
      mocks.summary.mockResolvedValueOnce({ id: 'session', status: 'running', locked: true });
      expect(await resumeCodexSessionWork('session', undefined, origin)).toBe('running');
      expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.goal).not.toHaveBeenCalled();
      mocks.summary.mockResolvedValueOnce({ id: 'session', status: 'idle', goal: { status: 'active' } });
      expect(await resumeCodexSessionWork('session', undefined, origin)).toBe('goal');
      expect(mocks.goal).toHaveBeenCalledWith(expect.objectContaining({ id: 'session' }), expect.any(AbortSignal), origin, true);
      expect(mocks.send).not.toHaveBeenCalled();
      expect(await resumeCodexSessionWork('session', undefined, origin)).toBe('continued');
      expect(mocks.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: 'Continue if not completed', interruptedOnly: true, preferPrivate: true, clearManualStop: origin === 'user' }));
    } finally { Reflect.deleteProperty(vscode.env, 'appHost'); }
  });
  it('starts manual Play after startup verification is cancelled without replaying a launch', async () => {
    mocks.summary.mockImplementationOnce(() => new Promise(() => undefined));
    const controller = new AbortController();
    const automatic = resumeCodexSessionWork('session', controller.signal, 'automatic', 'private');
    const failed = expect(automatic).rejects.toThrow();
    controller.abort();
    const manual = resumeCodexSessionWork('session', undefined, 'user', 'private');
    await failed; expect(await manual).toBe('continued'); expect(mocks.send).toHaveBeenCalledOnce();
  });
  it('promotes pending automatic verification when the user clicks Play, without starting a duplicate turn', async () => {
    let verify!: (ids: string[]) => void;
    mocks.stopped.mockReturnValue(new Promise<string[]>(resolve => { verify = resolve; }));
    const automatic = resumeCodexSessionWork('session', undefined, 'automatic', 'private');
    await vi.waitFor(() => expect(mocks.stopped).toHaveBeenCalled());
    expect(resumeCodexSessionWork('session', undefined, 'user', 'private')).toBe(automatic);
    verify(['session']);
    expect(await automatic).toBe('continued'); expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ clearManualStop: true }));
  });
  it("uses the private writer in Node without depending on a VS Code tab", async () => {
    Object.defineProperty(vscode.env, "appHost", { configurable: true, value: "node" });
    try {
      expect(await resumeCodexSessionWork("session")).toBe("continued");
      expect(mocks.summary).toHaveBeenCalledWith("session", "recovery-test", false);
      expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ preferPrivate: true }));
    } finally { Reflect.deleteProperty(vscode.env, "appHost"); }
  });
  it('keeps a manually stopped active goal idle during automatic recovery', async () => {
    mocks.stopped.mockResolvedValue(['session']);
    mocks.summary.mockResolvedValue({ id: 'session', status: 'idle', interrupted: true, goal: { status: 'active' } });
    expect(await resumeCodexSessionWork('session')).toBe('idle');
    expect(mocks.goal).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith("info", "session-resume", "Recovery skipped", expect.objectContaining({ reason: "manual-stop", origin: "automatic", goalStatus: "active" }));
    expect(await resumeCodexSessionWork('session', undefined, 'user')).toBe('goal');
  });
  it("sends exactly Continue if not completed and records title after provider acceptance", async () => {
    expect(await resumeCodexSessionWork("session")).toBe("continued");
    expect(mocks.summary).toHaveBeenCalledWith("session", "recovery-test", true);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ text: "Continue if not completed", projectPath: "project", interruptedOnly: true }));
    expect(mocks.log).toHaveBeenCalledWith("info", "session-resume", "Continue accepted", { sessionId: "session", sessionRef: "session-ref", title: "Pending task" });
  });
  it("leaves a session idle when it finishes before provider acceptance", async () => {
    mocks.send.mockResolvedValue(undefined);
    expect(await resumeCodexSessionWork("session")).toBe("idle");
    expect(mocks.log).not.toHaveBeenCalledWith("info", "session-resume", "Continue accepted", expect.anything());
  });
  it("resumes an eligible native goal without a prompt", async () => {
    mocks.summary.mockResolvedValue({ id: "session", title: "Goal task", status: "idle", goal: { status: "usage_limited" } });
    expect(await resumeCodexSessionWork("session")).toBe("goal");
    expect(mocks.goal).toHaveBeenCalledOnce(); expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each(["automatic", "queue"] as const)("resumes an interrupted paused goal during %s recovery", async origin => {
    mocks.summary.mockResolvedValue({ id: "session", title: "Interrupted goal", status: "idle", interrupted: true, goal: { status: "paused" } });
    expect(await resumeCodexSessionWork("session", undefined, origin)).toBe("goal");
    expect(mocks.goal).toHaveBeenCalledOnce(); expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith("info", "session-resume", "Goal recovery requested", expect.objectContaining({ goalStatus: "paused", reason: "interrupted-paused-goal", origin, promptKind: "none" }));
  });
  it("allows an explicit user Resume of a paused goal", async () => {
    mocks.summary.mockResolvedValue({ id: "session", title: "Paused task", status: "idle", interrupted: true, goal: { status: "paused" } });
    expect(await resumeCodexSessionWork("session", undefined, "user")).toBe("goal");
    expect(mocks.goal).toHaveBeenCalledOnce(); expect(mocks.send).not.toHaveBeenCalled();
  });
  it.each(["paused", "blocked", "complete", "budget_limited"])("preserves a %s goal", async status => {
    mocks.summary.mockResolvedValue({ id: "session", status: "idle", interrupted: true, goal: { status } });
    if (status === "paused") markExplicitSessionGoalPause("recovery-test", "session");
    expect(await resumeCodexSessionWork("session")).toBe("idle");
    expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.goal).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith("info", "session-resume", "Goal left unchanged", expect.objectContaining({ goalStatus: status, reason: status === "paused" ? "explicit-pause" : "goal-not-eligible" }));
    clearExplicitSessionGoalPause("recovery-test", "session");
  });
  it("does not duplicate a native goal that resumed while the editor loaded", async () => {
    mocks.summary.mockResolvedValue({ id: "session", status: "running", locked: true });
    expect(await resumeCodexSessionWork("session")).toBe("running");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.observe).toHaveBeenCalledWith(expect.objectContaining({ id: "session", status: "running" }));
  });
  it.each([undefined, { status: "unknown" }, { archived: true }, { subAgent: true }])("fails closed for unsafe metadata %j", async session => {
    mocks.summary.mockResolvedValue(session);
    await expect(resumeCodexSessionWork("session")).rejects.toThrow();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("does not mistake unavailable goal storage for a non-goal session", async () => {
    mocks.summary.mockResolvedValue({ status: "idle", interrupted: true }); mocks.files.mockResolvedValue(["goals_1.sqlite"]);
    await expect(resumeCodexSessionWork("session")).rejects.toThrow("Goal status is unavailable");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("retains non-goal recovery when transcript interruption evidence is unavailable", async () => {
    mocks.summary.mockResolvedValue({ id: "session", title: "Partial history", status: "idle", goal: null });
    await expect(resumeCodexSessionWork("session")).rejects.toThrow("Interrupted work could not be verified");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("recognizes older hosts with no native goal database", async () => {
    mocks.summary.mockResolvedValue({ status: "idle", interrupted: true });
    expect(await resumeCodexSessionWork("session")).toBe("continued");
  });
  it("coalesces duplicate recovery and returns without waiting for a long accepted turn", async () => {
    let finish!: () => void;
    mocks.send.mockImplementation(options => { options.onStarted(); return new Promise<void>(resolve => { finish = resolve; }); });
    const first = resumeCodexSessionWork("session");
    expect(resumeCodexSessionWork("session")).toBe(first);
    expect(await first).toBe("continued"); expect(mocks.send).toHaveBeenCalledOnce(); finish();
  });
  it("reports launch failures without claiming Continue was sent", async () => {
    mocks.send.mockRejectedValue(new Error("Project folder is missing"));
    await expect(resumeCodexSessionWork("session")).rejects.toThrow("Project folder is missing");
    expect(mocks.log).not.toHaveBeenCalledWith("info", "session-resume", "Continue accepted", expect.anything());
  });
  it("bounds a missing acceptance and aborts a late launch", async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    mocks.send.mockImplementation(options => { signal = options.signal; return new Promise(() => undefined); });
    const pending = expect(resumeCodexSessionWork("session")).rejects.toThrow("Continue was not confirmed");
    await vi.advanceTimersByTimeAsync(15_001); await pending;
    expect(signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds an unconfirmed goal continuation and retains recovery", async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    mocks.summary.mockResolvedValue({ id: "session", title: "Goal task", status: "idle", goal: { status: "active" } });
    mocks.goal.mockImplementation((_session, abortSignal) => { signal = abortSignal; return new Promise(() => undefined); });
    const pending = expect(resumeCodexSessionWork("session")).rejects.toThrow("Goal resume was not confirmed");
    await vi.advanceTimersByTimeAsync(25_001); await pending;
    expect(signal?.aborted).toBe(true); expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith("warning", "session-resume", "Post-load recovery could not be confirmed", expect.objectContaining({ sessionId: "session", title: "Goal task", durationMs: 25_000 }), expect.any(Error));
    expect(mocks.log).toHaveBeenCalledWith("warning", "session-resume", "Post-load recovery could not be confirmed", expect.objectContaining({ phase: "goal-continuation", origin: "automatic", goalStatus: "active", recoveryRetained: true }), expect.any(Error));
  });
  it("never sends after cancellation during the state check", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(resumeCodexSessionWork("session", controller.signal)).rejects.toThrow();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("allows the native three-second state check and keeps one traceable session reference", async () => {
    vi.useFakeTimers();
    mocks.summary.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ id: "session", title: "Loaded native task", status: "running" }), 3_000)));
    const pending = resumeCodexSessionWork("session");
    await vi.advanceTimersByTimeAsync(3_001);
    expect(await pending).toBe("running"); expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith("info", "session-resume", "Native session already running; no prompt sent", expect.objectContaining({ sessionRef: "session-ref", title: "Loaded native task", activitySource: "official-native", nativeRunning: true }));
  });
  it('falls back to private continuation only after idle and unlocked state is verified', async () => {
    mocks.summary.mockResolvedValueOnce({ id: 'session', status: 'unknown' }).mockResolvedValueOnce({ id: 'session', status: 'idle', interrupted: true, goal: null });
    expect(await resumeCodexSessionWork('session')).toBe('continued'); expect(mocks.summary).toHaveBeenLastCalledWith('session', 'recovery-test', false); expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ preferPrivate: true, interruptedOnly: true }));
  });
  it('preserves paused goals and active writer ownership in private recovery', async () => {
    mocks.summary.mockResolvedValue({ id: 'session', status: 'idle', locked: true, interrupted: true, goal: null });
    await expect(resumeCodexSessionWork('session', undefined, 'automatic', 'private')).rejects.toThrow(/writer/); expect(mocks.send).not.toHaveBeenCalled();
    mocks.summary.mockResolvedValue({ id: 'session', status: 'idle', interrupted: true, goal: { status: 'paused' } }); markExplicitSessionGoalPause('recovery-test', 'session');
    expect(await resumeCodexSessionWork('session', undefined, 'automatic', 'private')).toBe('idle'); expect(mocks.goal).not.toHaveBeenCalled(); clearExplicitSessionGoalPause('recovery-test', 'session');
  });
  it('resumes an eligible goal through the private connection without adding a user message', async () => {
    mocks.summary.mockResolvedValue({ id: 'session', status: 'idle', goal: { status: 'active' } });
    expect(await resumeCodexSessionWork('session', undefined, 'automatic', 'private')).toBe('goal'); expect(mocks.goal).toHaveBeenCalledWith(expect.objectContaining({ id: 'session' }), expect.any(AbortSignal), 'automatic', true); expect(mocks.send).not.toHaveBeenCalled();
  });

  it('uses a private goal fallback after a confirmed unavailable owner without replaying an uncertain start', async () => {
    mocks.summary.mockResolvedValue({ id: 'session', status: 'idle', goal: { status: 'active' } });
    mocks.goal.mockRejectedValueOnce(new CodexNativeOwnerUnavailableError('Owner unavailable')).mockResolvedValueOnce(undefined);
    expect(await resumeCodexSessionWork('session')).toBe('goal'); expect(mocks.goal).toHaveBeenCalledTimes(2); expect(mocks.goal.mock.calls[1]![3]).toBe(true);
    mocks.goal.mockReset().mockRejectedValue(new Error('Goal resume was not confirmed'));
    await expect(resumeCodexSessionWork('session')).rejects.toThrow(/not confirmed/); expect(mocks.goal).toHaveBeenCalledOnce();
  });

});
