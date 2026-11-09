import type * as vscode from "vscode";
import type { AccountsRepository } from "../storage";
import { getSqliteStateStore } from "../storage/sqliteState";
import { getCodexHomeStateKey } from "../codex/authFile";
import { getCodexManagerConfiguration, isAutoResumeEnabled } from "../infrastructure/config/extensionSettings";
import { isCodexCapacityInterruption } from "../domain/codexSessionState";
import { getCodexSessionLiveState } from "./codexSessionLive";
import { readCodexCliSessionSummary, resolveCodexHome } from "./codexSessionResume";
import { readCodexSessionPreferences } from "./codexSessionPreferences";
import { resumeCodexSessionWork } from "./codexSessionRecovery";
import { publishDashboardRealtime, subscribeDashboardRealtime } from "./dashboardRealtime";
import { runCrossWindowExclusive } from "../utils/crossWindowOperations";
import { waitWithin } from "../utils/concurrency";

type Retry = { sessionId: string; streamId: string; attempts: number; due: number };
const NAMESPACE = "standalone-capacity-retry";
const DELAYS = [5000, 10000, 20000, 40000];

/** Continue verified capacity interruptions without requiring an editor reload. */
export function registerStandaloneCapacityRetry(
  context: vscode.ExtensionContext,
  repo: AccountsRepository,
  canUseAccount: (id: string) => boolean
): void {
  let disposed = false,
    busy = false;
  const active = new Set<string>();
  const ownedStreams = new Set<string>();
  const controller = new AbortController();
  const enabled = () => {
    const config = getCodexManagerConfiguration();
    return (
      config.get<boolean>("cliIntegrationEnabled", true) &&
      config.get<boolean>("modelCapacityAutoSwitchEnabled", true) &&
      config.get<boolean>("autoSwitchEnabled", true)
    );
  };
  const notice = (level: "info" | "warning", message: string) =>
    publishDashboardRealtime({ type: "dashboard:notice", level, message });
  const key = (home: string, id: string) => `${getCodexHomeStateKey(home)}:${id}`;
  const stop = subscribeDashboardRealtime((message) => {
    if (disposed || message.type !== "dashboard:codex-session-live" || message.state.deviceId) return;
    const state = message.state,
      store = getSqliteStateStore();
    if (!store) return;
    const recordKey = key(resolveCodexHome(), state.sessionId),
      previous = store.get<Retry>(NAMESPACE, recordKey);
    try {
      if (state.status === "running" && active.has(state.sessionId)) {
        ownedStreams.add(state.streamId);
        if (ownedStreams.size > 512) ownedStreams.delete(ownedStreams.values().next().value!);
      }
      if (
        state.status === "completed" ||
        state.status === "cancelled" ||
        (state.status === "running" && !active.has(state.sessionId) && !ownedStreams.has(state.streamId))
      ) {
        store.set(NAMESPACE, recordKey, undefined);
        return;
      }
      if (!enabled() || state.status !== "failed" || !isCodexCapacityInterruption(state.error ?? "")) return;
      if (previous?.streamId === state.streamId) return;
      const attempts = previous?.attempts ?? 0;
      if (attempts >= DELAYS.length) {
        notice("warning", "Model capacity retry limit reached. Change the model/account or resume manually.");
        return;
      }
      if (!previous && store.keys(NAMESPACE).length >= 128) {
        notice("warning", "Capacity recovery queue is full. Resume this session manually.");
        return;
      }
      store.set(NAMESPACE, recordKey, {
        sessionId: state.sessionId,
        streamId: state.streamId,
        attempts,
        due: Date.now() + DELAYS[attempts]!
      });
      notice(
        "info",
        `Model capacity interrupted the turn. Standalone will retry in ${DELAYS[attempts]! / 1000}s (${attempts + 1}/${DELAYS.length}).`
      );
    } catch (error) {
      notice(
        "warning",
        `Capacity retry could not be saved. ${error instanceof Error ? error.message : "Storage unavailable."}`
      );
    }
  });
  const run = async () => {
    if (disposed || busy || !enabled()) return;
    busy = true;
    try {
      const store = getSqliteStateStore();
      if (!store) return;
      const home = resolveCodexHome(),
        prefix = `${getCodexHomeStateKey(home)}:`;
      for (const recordKey of store
        .keys(NAMESPACE)
        .filter((value) => value.startsWith(prefix))
        .slice(0, 128)) {
        const retry = store.get<Retry>(NAMESPACE, recordKey);
        if (
          !retry ||
          !Number.isSafeInteger(retry.attempts) ||
          retry.attempts < 0 ||
          retry.attempts >= DELAYS.length ||
          retry.due > Date.now()
        )
          continue;
        await runCrossWindowExclusive(
          `capacity-retry:${recordKey}`,
          "Standalone capacity retry",
          async () => {
            if (disposed || !enabled() || resolveCodexHome() !== home) return;
            const current = store.get<Retry>(NAMESPACE, recordKey);
            if (!current || current.streamId !== retry.streamId || current.attempts !== retry.attempts) return;
            const preference = readCodexSessionPreferences(home, [retry.sessionId]).get(retry.sessionId);
            const live = getCodexSessionLiveState(retry.sessionId);
            if (
              preference?.manualStop ||
              preference?.autoResume === false ||
              (!isAutoResumeEnabled() && preference?.autoResume !== true) ||
              (live &&
                (!isCodexCapacityInterruption(live.error ?? "") ||
                  live.status !== "failed" ||
                  live.streamId !== retry.streamId))
            ) {
              store.set(NAMESPACE, recordKey, undefined);
              return;
            }
            const account = (
              await waitWithin(repo.listAccounts(), 5000, "Retry account inspection timed out.", controller.signal)
            ).find((item) => item.isActive);
            if (!account || account.enabled === false || !canUseAccount(account.id)) return;
            const session = await waitWithin(
              readCodexCliSessionSummary(retry.sessionId, home, false),
              5000,
              "Retry session inspection timed out.",
              controller.signal
            );
            if (disposed || !enabled() || resolveCodexHome() !== home || !canUseAccount(account.id)) return;
            const latestPreference = readCodexSessionPreferences(home, [retry.sessionId]).get(retry.sessionId);
            if (
              latestPreference?.manualStop ||
              latestPreference?.autoResume === false ||
              (!isAutoResumeEnabled() && latestPreference?.autoResume !== true)
            ) {
              store.set(NAMESPACE, recordKey, undefined);
              return;
            }
            if (
              !session ||
              session.archived ||
              session.subAgent ||
              session.parentSessionId ||
              session.goal?.status === "complete" ||
              (session.goal?.status === "paused" && !session.interrupted)
            ) {
              store.set(NAMESPACE, recordKey, undefined);
              return;
            }
            if (session.status !== "idle" || session.locked) return;
            store.set(NAMESPACE, recordKey, {
              ...retry,
              attempts: retry.attempts + 1,
              due: Date.now() + DELAYS[Math.min(retry.attempts + 1, DELAYS.length - 1)]!
            });
            active.add(retry.sessionId);
            try {
              const outcome = await waitWithin(
                resumeCodexSessionWork(retry.sessionId, controller.signal, "automatic", "private"),
                30000,
                "Capacity retry was not confirmed. Review the session before retrying.",
                controller.signal
              );
              if (outcome === "idle") store.set(NAMESPACE, recordKey, undefined);
              else notice("info", "Standalone capacity recovery started.");
            } catch (error) {
              if (!isCodexCapacityInterruption(String(error))) {
                store.set(NAMESPACE, recordKey, undefined);
                notice(
                  "warning",
                  `Capacity recovery was not confirmed; it was not replayed. ${error instanceof Error ? error.message : "Check the session."}`
                );
              }
            } finally {
              active.delete(retry.sessionId);
            }
          },
          { background: true }
        );
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    void run().catch((error) => console.warn("[codexManager] capacity retry postponed", error));
  }, 1000);
  timer.unref?.();
  context.subscriptions.push({
    dispose: () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
      stop();
    }
  });
}
