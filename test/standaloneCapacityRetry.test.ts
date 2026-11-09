import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  config: true,
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
  runCrossWindowExclusive: async (_key: string, _label: string, work: () => Promise<void>) => work()
}));
import { registerStandaloneCapacityRetry } from "../src/services/standaloneCapacityRetry";
import { publishDashboardRealtime } from "../src/services/dashboardRealtime";
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
  m.data.clear();
  m.preferences.clear();
  m.live = undefined;
  m.config = true;
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
