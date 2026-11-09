import { afterEach, expect, it, vi } from "vitest";
import { registerCompletedGoalCleanup } from "../src/services/completedGoalCleanup";
import { readCodexSessionGoals } from "../src/services/codexSessionGoals";
import { clearCodexSessionGoal } from "../src/services/codexSessionResume";
import { publishDashboardRealtime } from "../src/services/dashboardRealtime";
vi.mock("../src/services/codexSessionGoals", () => ({ readCodexSessionGoals: vi.fn() }));
vi.mock("../src/services/codexSessionResume", () => ({
  clearCodexSessionGoal: vi.fn(),
  resolveCodexHome: () => "/test-goals"
}));
const subscriptions: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const item of subscriptions.splice(0)) item.dispose();
  vi.useRealTimers();
  vi.resetAllMocks();
});
it("clears only complete goals on startup and live completion, retains failed cleanup for bounded retry", async () => {
  vi.useFakeTimers();
  const goals = new Map([
    ["complete", { status: "complete", objective: "Done" }],
    ["active", { status: "active", objective: "Work" }],
    ["paused", { status: "paused", objective: "Wait" }]
  ]);
  vi.mocked(readCodexSessionGoals).mockResolvedValue(goals);
  vi.mocked(clearCodexSessionGoal)
    .mockRejectedValueOnce(new Error("writer busy"))
    .mockImplementation(async (id) => {
      goals.delete(id);
    });
  registerCompletedGoalCleanup({ subscriptions } as never);
  await vi.advanceTimersByTimeAsync(501);
  expect(clearCodexSessionGoal).toHaveBeenCalledExactlyOnceWith("complete", "Done");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(clearCodexSessionGoal).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(40_000);
  expect(clearCodexSessionGoal).toHaveBeenCalledTimes(2);
  vi.mocked(readCodexSessionGoals).mockResolvedValue(
    new Map([["next", { status: "complete", objective: "Next done" }]])
  );
  publishDashboardRealtime({
    type: "dashboard:codex-session-live",
    state: { sessionId: "next", status: "completed" } as never
  });
  await vi.advanceTimersByTimeAsync(501);
  expect(clearCodexSessionGoal).toHaveBeenLastCalledWith("next", "Next done");
  subscriptions[0]!.dispose();
  const calls = vi.mocked(clearCodexSessionGoal).mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(clearCodexSessionGoal).toHaveBeenCalledTimes(calls);
});
it("does not delete when goal storage is unavailable", async () => {
  vi.useFakeTimers();
  vi.mocked(readCodexSessionGoals).mockResolvedValue(undefined);
  registerCompletedGoalCleanup({ subscriptions } as never);
  await vi.advanceTimersByTimeAsync(501);
  expect(clearCodexSessionGoal).not.toHaveBeenCalled();
});
