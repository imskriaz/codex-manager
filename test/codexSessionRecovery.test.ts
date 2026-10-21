import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ summary: vi.fn(), stopped: vi.fn(), send: vi.fn(), goal: vi.fn(), observe: vi.fn(), files: vi.fn(), log: vi.fn() }));
vi.mock("../src/services/codexSessionResume", () => ({ observeRunningCodexSession: mocks.observe, readManuallyStoppedCodexSessionIds: mocks.stopped, readCodexCliSessionSummary: mocks.summary, sendCodexCliSessionMessage: mocks.send, resumeCodexSessionGoal: mocks.goal, resolveCodexHome: () => "recovery-test", toSessionLogRef: () => "session-ref" }));
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
  it('keeps a manually stopped active goal idle during automatic recovery', async () => {
    mocks.stopped.mockResolvedValue(['session']);
    mocks.summary.mockResolvedValue({ id: 'session', status: 'idle', interrupted: true, goal: { status: 'active' } });
    expect(await resumeCodexSessionWork('session')).toBe('idle');
    expect(mocks.goal).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
    expect(await resumeCodexSessionWork('session', undefined, 'user')).toBe('goal');
  });
  it("sends exactly Continue if not completed and records title after provider acceptance", async () => {
    expect(await resumeCodexSessionWork("session")).toBe("continued");
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ text: "Continue if not completed", projectPath: "project" }));
    expect(mocks.log).toHaveBeenCalledWith("info", "session-resume", "Continue accepted", { sessionId: "session", sessionRef: "session-ref", title: "Pending task" });
  });
  it("resumes an eligible native goal without a prompt", async () => {
    mocks.summary.mockResolvedValue({ id: "session", title: "Goal task", status: "idle", goal: { status: "usage_limited" } });
    expect(await resumeCodexSessionWork("session")).toBe("goal");
    expect(mocks.goal).toHaveBeenCalledOnce(); expect(mocks.send).not.toHaveBeenCalled();
  });
  it("resumes a paused goal recorded as an interruption while preserving explicit Pause", async () => {
    mocks.summary.mockResolvedValue({ id: "session", title: "Interrupted goal", status: "idle", interrupted: true, goal: { status: "paused" } });
    expect(await resumeCodexSessionWork("session")).toBe("goal");
    expect(mocks.goal).toHaveBeenCalledOnce();
  });
  it.each(["paused", "blocked", "complete", "budget_limited"])("preserves a %s goal", async status => {
    mocks.summary.mockResolvedValue({ id: "session", status: "idle", interrupted: true, goal: { status } });
    if (status === "paused") markExplicitSessionGoalPause("recovery-test", "session");
    expect(await resumeCodexSessionWork("session")).toBe("idle");
    expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.goal).not.toHaveBeenCalled();
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
  it("bounds an unconfirmed goal and keeps failures out of the prompt path", async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    mocks.summary.mockResolvedValue({ id: "session", title: "Goal task", status: "idle", goal: { status: "active" } });
    mocks.goal.mockImplementation((_session, abortSignal) => { signal = abortSignal; return new Promise(() => undefined); });
    const pending = expect(resumeCodexSessionWork("session")).rejects.toThrow("Goal resume was not confirmed");
    await vi.advanceTimersByTimeAsync(25_001); await pending;
    expect(signal?.aborted).toBe(true); expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith("warning", "session-resume", "Post-load recovery could not be confirmed", expect.objectContaining({ sessionId: "session", title: "Goal task", durationMs: 25_000 }), expect.any(Error));
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
    expect(mocks.log).toHaveBeenCalledWith("info", "session-resume", "Native session already running; no prompt sent", expect.objectContaining({ sessionRef: "session-ref", title: "Loaded native task" }));
  });
});
