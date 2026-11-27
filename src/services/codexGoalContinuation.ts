import * as vscode from "vscode";
import { getCodexHomeStateKey } from "../codex/authFile";
import { getCodexManagerConfiguration, isAutoResumeEnabled, isRuntimeModuleEnabled } from "../infrastructure/config/extensionSettings";
import type { AccountsRepository } from "../storage";
import { getSqliteStateStore } from "../storage/sqliteState";
import { waitWithin } from "../utils/concurrency";
import { CrossWindowOperationBusyError } from "../utils/crossWindowOperations";
import { accountQuotaAvailability } from "../utils/quotaWindows";
import { readAutoResumeGoalCandidateIds } from "./codexSessionAutoResumeSelection";
import { isExplicitSessionGoalPause } from "./codexSessionGoals";
import { availableCodexSessionLiveSlots } from "./codexSessionLive";
import { readCodexSessionPreferences } from "./codexSessionPreferences";
import { CodexNativeOwnerUnavailableError, readCodexCliSessionSummary, readCompletedCodexSessionTurns, resolveCodexHome, resumeCodexSessionGoal } from "./codexSessionResume";
import { publishDashboardRealtime, subscribeDashboardRealtime } from "./dashboardRealtime";

const NAMESPACE = "goal-continuation-turn";
const SCAN_INTERVAL_MS = 15_000;
const MAX_STARTS_PER_SCAN = 4;

/** Continue verified active goals after successful turns without replaying an uncertain start. */
export function registerCodexGoalContinuation(
  context: vscode.ExtensionContext,
  repo: Pick<AccountsRepository, "listAccounts">,
  canUseAccount: (id: string) => boolean
): void {
  const controller = new AbortController();
  const failed = new Map<string, string>();
  let running = false;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  const enabled = () => isRuntimeModuleEnabled("codex") && getCodexManagerConfiguration().get<boolean>("cliIntegrationEnabled", false);

  const run = async () => {
    const store = getSqliteStateStore();
    if (!store || running || controller.signal.aborted || !enabled() || availableCodexSessionLiveSlots() === 0) return;
    running = true;
    const home = resolveCodexHome();
    const prefix = getCodexHomeStateKey(home) + ":";
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    const isCurrent = () => !controller.signal.aborted && resolveCodexHome() === home && enabled();
    const eligible = (id: string, preference = readCodexSessionPreferences(home, [id]).get(id)) =>
      preference?.autoResume !== false && (isAutoResumeEnabled() || preference?.autoResume === true) &&
      !preference?.manualStop && !preference?.queue && !preference?.queueClaimId && !preference?.queueClaimedAt &&
      !preference?.queueError && !isExplicitSessionGoalPause(home, id);
    try {
      const goalIds = await readAutoResumeGoalCandidateIds(home, signal);
      const preferences = readCodexSessionPreferences(home, goalIds);
      const ids = goalIds.filter(id => eligible(id, preferences.get(id)));
      if (!ids.length || !isCurrent()) return;
      const completed = await waitWithin(readCompletedCodexSessionTurns(home, ids, signal), 10_000, "Goal turn inspection timed out.", signal);
      let remaining = MAX_STARTS_PER_SCAN;
      for (const [id, turnId] of completed) {
        if (!isCurrent() || !remaining || availableCodexSessionLiveSlots() === 0) break;
        const key = prefix + id;
        if (store.get(NAMESPACE, key) === turnId || failed.get(key) === turnId) continue;
        const account = (await waitWithin(repo.listAccounts(), 5_000, "Goal account inspection timed out.", controller.signal)).find(item => item.isActive);
        if (!account || account.enabled === false || account.resetCreditAttempt || !canUseAccount(account.id) || accountQuotaAvailability(account) === "exhausted") break;
        const privateHost = vscode.env.appHost === "node";
        const session = await waitWithin(readCodexCliSessionSummary(id, home, false), 5_000, "Goal session inspection timed out.", controller.signal);
        if (!isCurrent()) break;
        if (!session || session.archived || session.subAgent || session.parentSessionId || session.stopped ||
            session.status !== "idle" || session.statusError || session.interrupted ||
            session.goal?.status !== "active" || (privateHost && session.locked)) continue;
        remaining--;
        let claimed = false;
        const claim = (latestTurnId: string) => {
          if (!isCurrent() || latestTurnId !== turnId || !canUseAccount(account.id) || !eligible(id)) return false;
          claimed = store.transaction(() => {
            if (store.get(NAMESPACE, key) === turnId) return false;
            store.set(NAMESPACE, key, turnId);
            return true;
          });
          return claimed;
        };
        try {
          try {
            await resumeCodexSessionGoal(session, controller.signal, "automatic", privateHost, claim);
          } catch (error) {
            if (privateHost || claimed || !(error instanceof CodexNativeOwnerUnavailableError)) throw error;
            const verified = await waitWithin(readCodexCliSessionSummary(id, home, false), 5_000, "Goal session inspection timed out.", controller.signal);
            if (!isCurrent()) return;
            if (!verified || verified.status !== "idle" || verified.locked ||
                verified.archived || verified.subAgent || verified.parentSessionId) throw error;
            await resumeCodexSessionGoal(verified, controller.signal, "automatic", true, claim);
          }
        } catch (error) {
          if (!(error instanceof CrossWindowOperationBusyError) && isCurrent()) {
            failed.set(key, turnId);
            if (failed.size > 1_000) failed.delete(failed.keys().next().value!);
            const detail = error instanceof Error ? error.message : String(error);
            const next = !claimed && error instanceof CodexNativeOwnerUnavailableError ? "Open the conversation in Codex to continue." : "Check the conversation before retrying.";
            publishDashboardRealtime({ type: "dashboard:notice", level: "warning",
              message: `Goal continuation for “${session.title}” could not be confirmed. ${detail} ${next}` });
          }
        }
      }
    } finally {
      running = false;
    }
  };

  const wake = () => {
    if (controller.signal.aborted || wakeTimer) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      void run().catch(error => {
        if (!controller.signal.aborted) console.warn("[codexManager] goal continuation inspection deferred", error);
      });
    }, 500);
    wakeTimer.unref?.();
  };
  const stop = subscribeDashboardRealtime(message => {
    if (message.type === "dashboard:codex-session-live" && !message.state.deviceId &&
        message.state.provider !== "claude" && message.state.status === "completed") wake();
  });
  const interval = setInterval(wake, SCAN_INTERVAL_MS);
  interval.unref?.();
  context.subscriptions.push({ dispose: () => {
    controller.abort();
    clearInterval(interval);
    clearTimeout(wakeTimer);
    stop();
  } });
  wake();
}
