import type * as vscode from "vscode";
import { readCodexSessionGoals } from "./codexSessionGoals";
import { clearCodexSessionGoal, resolveCodexHome } from "./codexSessionResume";
import { subscribeDashboardRealtime } from "./dashboardRealtime";
import { waitWithin } from "../utils/concurrency";

/** Only clear verified complete goals; the mutation rechecks status under its writer lease. */
export function registerCompletedGoalCleanup(context: vscode.ExtensionContext): void {
  let disposed = false,
    running = false;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  const retries = new Map<string, number>();
  const run = async () => {
    if (disposed || running) return;
    running = true;
    const home = resolveCodexHome();
    try {
      const goals = await readCodexSessionGoals(home, undefined, 10000);
      if (disposed || resolveCodexHome() !== home || !goals) return;
      for (const [id, goal] of goals) {
        if (disposed || resolveCodexHome() !== home) break;
        if (goal.status !== "complete" || Date.now() < (retries.get(id) ?? 0)) continue;
        try {
          await waitWithin(
            clearCodexSessionGoal(id, goal.objective),
            10_000,
            "Completed goal cleanup is still pending."
          );
          retries.delete(id);
        } catch (error) {
          retries.set(id, Date.now() + 60_000);
          if (retries.size > 1000) retries.delete(retries.keys().next().value!);
          console.warn("[codexManager] completed goal retained for cleanup retry", error);
        }
      }
    } finally {
      running = false;
    }
  };
  const wake = () => {
    if (!disposed && !wakeTimer) {
      wakeTimer = setTimeout(() => {
        wakeTimer = undefined;
        void run().catch((error) => console.warn("[codexManager] completed goal inspection deferred", error));
      }, 500);
      wakeTimer.unref?.();
    }
  };
  const stop = subscribeDashboardRealtime((message) => {
    if (
      message.type === "dashboard:codex-session-live" &&
      !message.state.deviceId &&
      ["completed", "failed", "cancelled"].includes(message.state.status)
    )
      wake();
  });
  const timer = setInterval(wake, 10_000);
  timer.unref?.();
  context.subscriptions.push({
    dispose: () => {
      disposed = true;
      clearInterval(timer);
      clearTimeout(wakeTimer);
      stop();
    }
  });
  wake();
}
