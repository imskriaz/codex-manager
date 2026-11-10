import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  config: true,
  holdCapacity: false,
  locks: [] as string[],
  autoResume: true,
  live: undefined as any,
  summary: vi.fn(),
  resume: vi.fn(),
  preferences: new Map(),
  home: "/retry-home"
}));
vi.mock("../src/storage/sqliteState", () => ({
  getSqliteStateStore: () => ({
    get: (n: string, k: string) => m.data.get(n + k),
    set: (n: string, k: string, v: unknown) => {
      if (v === undefined) m.data.delete(n + k);
      else m.data.set(n + k, structuredClone(v));
    },
    keys: (n: string) => [...m.data.keys()].filter((k) => k.startsWith(n)).map((k) => k.slice(n.length))
  })
}));
vi.mock("../src/infrastructure/config/extensionSettings", () => ({
  getCodexManagerConfiguration: () => ({ get: () => m.config }),
  isAutoResumeEnabled: () => m.autoResume
}));
vi.mock("../src/services/codexSessionResume", () => ({
  resolveCodexHome: () => m.home,
  readCodexCliSessionSummary: m.summary
}));
vi.mock("../src/services/codexSessionLive", () => ({ getCodexSessionLiveState: () => m.live }));
vi.mock("../src/services/codexSessionPreferences", () => ({ readCodexSessionPreferences: () => m.preferences }));
vi.mock("../src/services/codexSessionRecovery", () => ({ resumeCodexSessionWork: m.resume }));
vi.mock("../src/utils/crossWindowOperations", () => ({
  runCrossWindowExclusive: async (key: string, _label: string, work: () => Promise<void>) => {
    m.locks.push(key);
    if (m.holdCapacity && key === `model-capacity:${m.home}`) throw new Error('Model capacity selection is still in progress');
    return work();
  }
}));
import { registerStandaloneCapacityRetry } from "../src/services/standaloneCapacityRetry";
import { publishDashboardRealtime } from "../src/services/dashboardRealtime";
import { subscribeDashboardRealtime } from "../src/services/dashboardRealtime";
import { isCodexPermissionInterruption } from "../src/domain/codexSessionState";
const subscriptions: Array<{ dispose(): void }> = [];
const emit = (streamId: string, status = "failed", error = "Selected model is at capacity") => {
  m.live = { sessionId: "session", streamId, status, error, updatedAt: Date.now() };
  publishDashboardRealtime({ type: "dashboard:codex-session-live", state: m.live });
};
const repo = { listAccounts: vi.fn(async () => [{ id: "active", isActive: true, enabled: true }]) };
let allowed = true;
const start = () => registerStandaloneCapacityRetry({ subscriptions } as never, repo as never, () => allowed);
beforeEach(() => {
  vi.useFakeTimers();
  repo.listAccounts.mockReset().mockResolvedValue([{ id: "active", isActive: true, enabled: true }]);
  m.data.clear();
  m.preferences.clear();
  m.live = undefined;
  m.config = true;
  m.holdCapacity = false; m.locks = [];
  m.autoResume = true;
  allowed = true;
  m.resume.mockReset().mockResolvedValue("continued");
  m.summary
    .mockReset()
    .mockResolvedValue({ id: "session", title: "Task", status: "idle", goal: null, interrupted: true });
});
afterEach(() => {
  for (const item of subscriptions.splice(0)) item.dispose();
  vi.useRealTimers();
});
it("retries capacity after a bounded wait, deduplicates terminal replay, and uses private recovery", async () => {
  start();
  emit("first");
  emit("first");
  await vi.advanceTimersByTimeAsync(4999);
  expect(m.resume).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1001);
  expect(m.resume).toHaveBeenCalledExactlyOnceWith("session", expect.any(AbortSignal), "automatic", "private");
});
it('waits for capacity account selection before retrying instead of racing the switch', async () => {
  start(); m.holdCapacity = true; emit('switching');
  await vi.advanceTimersByTimeAsync(6000);
  expect(m.resume).not.toHaveBeenCalled(); expect(m.locks).toContain(`model-capacity:${m.home}`);
  m.holdCapacity = false; await vi.advanceTimersByTimeAsync(1000);
  expect(m.resume).toHaveBeenCalledOnce();
});
it("honors global Auto Resume and the existing per-session opt-in", async () => {
  start();
  m.autoResume = false;
  emit("disabled");
  await vi.advanceTimersByTimeAsync(6000);
  expect(m.resume).not.toHaveBeenCalled();
  m.preferences.set("session", { autoResume: true });
  emit("opt-in");
  await vi.advanceTimersByTimeAsync(6000);
  expect(m.resume).toHaveBeenCalledOnce();
});
it("persists a four-attempt budget across failures and service restart", async () => {
  start();
  emit("first");
  await vi.advanceTimersByTimeAsync(6000);
  subscriptions.pop()!.dispose();
  start();
  for (let i = 1; i < 5; i++) {
    emit("failure-" + i);
    await vi.advanceTimersByTimeAsync(45000);
  }
  expect(m.resume).toHaveBeenCalledTimes(4);
});
it.each(["stop", "disabled", "foreign", "running", "archived", "complete", "paused"])(
  "does not replay %s sessions",
  async (scenario) => {
    start();
    emit("failed");
    if (scenario === "stop") m.preferences.set("session", { manualStop: true });
    if (scenario === "disabled") m.config = false;
    if (scenario === "foreign") allowed = false;
    if (scenario === "running") m.summary.mockResolvedValue({ status: "running" });
    if (scenario === "archived") m.summary.mockResolvedValue({ archived: true });
    if (scenario === "complete") m.summary.mockResolvedValue({ goal: { status: "complete" } });
    if (scenario === "paused") m.summary.mockResolvedValue({ goal: { status: "paused" }, interrupted: false });
    await vi.advanceTimersByTimeAsync(6000);
    expect(m.resume).not.toHaveBeenCalled();
  }
);
it("never retries an uncertain recovery failure and cancels after a newer manual turn", async () => {
  start();
  emit("failure");
  m.resume.mockRejectedValueOnce(new Error("Connection closed after send"));
  await vi.advanceTimersByTimeAsync(45000);
  expect(m.resume).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60000);
  expect(m.resume).toHaveBeenCalledOnce();
  emit("next");
  emit("manual", "running", "");
  await vi.advanceTimersByTimeAsync(45000);
  expect(m.resume).toHaveBeenCalledOnce();
});
it("preserves the attempt budget through repeated live updates on its own retry", async () => {
  start();
  m.resume.mockImplementationOnce(async () => {
    emit("retry", "running", "");
    return "continued";
  });
  emit("initial");
  await vi.advanceTimersByTimeAsync(6000);
  emit("retry", "running", "");
  emit("retry");
  await vi.advanceTimersByTimeAsync(11000);
  expect(m.resume).toHaveBeenCalledTimes(2);
});

it.each(['Windows sandbox setup failed', 'CreateProcessAsUserW failed: 5', 'approval request timed out'])("recovers confirmed policy failures quietly: %s", async error => {
  const notices: unknown[] = [];
  const stop = subscribeDashboardRealtime(message => { if (message.type === 'dashboard:notice') notices.push(message); });
  try {
    start(); emit('sandbox', 'failed', error);
    await vi.advanceTimersByTimeAsync(6000);
    expect(m.resume).toHaveBeenCalledExactlyOnceWith('session', expect.any(AbortSignal), 'automatic', 'private');
    await vi.advanceTimersByTimeAsync(120000);
    expect(m.resume).toHaveBeenCalledOnce();
    expect(notices).toEqual([]);
  } finally { stop(); }
});
it.each(['User cancelled', 'Approval denied by user', 'Permission denied opening report.txt', 'Connection lost after send', 'Sandbox settings changed', 'The user rejected approval'])("does not classify cancellation or uncertain/general errors as a policy failure: %s", message => {
  expect(isCodexPermissionInterruption(message)).toBe(false);
});
it('does not replay a completed session after restart when the old failure is no longer live', async () => {
  start(); emit('failed', 'failed', 'Windows sandbox setup failed');
  subscriptions.pop()!.dispose(); m.live = undefined;
  m.summary.mockResolvedValue({ id: 'session', status: 'idle', interrupted: false, goal: null });
  start(); await vi.advanceTimersByTimeAsync(6000);
  expect(m.resume).not.toHaveBeenCalled();
});
it('keeps the retry budget after a failed retry without blocking Stop', async () => {
  start(); emit('failed', 'failed', 'Sandbox setup failed');
  m.resume.mockRejectedValueOnce(new Error('Sandbox setup failed'));
  await vi.advanceTimersByTimeAsync(6000);
  m.preferences.set('session', { manualStop: true });
  await vi.advanceTimersByTimeAsync(60000);
  expect(m.resume).toHaveBeenCalledOnce();
});
it('leaves work untouched when the durable queue is full or cannot save', async () => {
  start();
  for (let i = 0; i < 128; i++) m.data.set('standalone-capacity-retryforeign-' + i, {});
  emit('full', 'failed', 'Sandbox setup failed');
  await vi.advanceTimersByTimeAsync(6000);
  expect(m.resume).not.toHaveBeenCalled();
  repo.listAccounts.mockReset().mockResolvedValue([{ id: "active", isActive: true, enabled: true }]);
  m.data.clear();
  const write = vi.spyOn(m.data, 'set').mockImplementation(() => { throw new Error('storage full'); });
  try {
    expect(() => emit('storage', 'failed', 'Sandbox setup failed')).not.toThrow();
    await vi.advanceTimersByTimeAsync(6000);
    expect(m.resume).not.toHaveBeenCalled();
  } finally { write.mockRestore(); }
});

it('defers capacity retries without consuming the budget while quota is exhausted, then recovers', async () => {
  repo.listAccounts.mockResolvedValue([{ id: 'active', isActive: true, enabled: true, quotaSummary: { hourlyPercentage: 0, hourlyWindowPresent: true, hourlyWindowMinutes: 300 } }] as never);
  start(); emit('quota-empty'); await vi.advanceTimersByTimeAsync(12000);
  expect(m.resume).not.toHaveBeenCalled();
  repo.listAccounts.mockResolvedValue([{ id: 'active', isActive: true, enabled: true }]);
  await vi.advanceTimersByTimeAsync(1000); expect(m.resume).toHaveBeenCalledOnce();
});
