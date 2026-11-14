import * as vscode from "vscode";
import type { DashboardCodexSessionLiveState } from '../domain/dashboard/types';
import type { AccountsRepository } from "../storage";
import { getSqliteStateStore } from "../storage/sqliteState";
import { getCodexHomeStateKey } from "../codex/authFile";
import { getCodexManagerConfiguration, isAutoResumeEnabled } from "../infrastructure/config/extensionSettings";
import { isCodexCapacityInterruption, isCodexPermissionInterruption } from "../domain/codexSessionState";
import { getCodexSessionLiveState } from "./codexSessionLive";
import { readCodexCliSessionSummary, resolveCodexHome } from "./codexSessionResume";
import { readCodexSessionPreferences } from "./codexSessionPreferences";
import { resumeCodexSessionWork } from "./codexSessionRecovery";
import { subscribeDashboardRealtime } from "./dashboardRealtime";
import { recordPersistentEvent } from "../utils/persistentLog";
import { runCrossWindowExclusive } from "../utils/crossWindowOperations";
import { waitWithin } from "../utils/concurrency";
import { accountQuotaAvailability } from '../utils/quotaWindows';
import { isConfirmedSessionDeleted } from '../storage/sqliteSessions';
import { isExplicitSessionGoalPause } from './codexSessionGoals';

type Retry = { sessionId: string; streamId: string; attempts: number; due: number; automaticStreamId?: string };
const NAMESPACE = "standalone-capacity-retry";
const DELAYS = [5000, 10000, 20000, 40000];

/** Continue verified interrupted work without requiring a reload. */
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
    return config.get<boolean>("cliIntegrationEnabled", true);
  };
  const recoverable = (message: string) => isCodexPermissionInterruption(message) ||
    isCodexCapacityInterruption(message) && getCodexManagerConfiguration().get<boolean>('modelCapacityAutoSwitchEnabled', true) && getCodexManagerConfiguration().get<boolean>('autoSwitchEnabled', true);
  const retryableState = (state: DashboardCodexSessionLiveState) => state.status === 'disconnected' || state.status === 'failed' && recoverable(state.error ?? '');
  const notice = (level: "info" | "warning", message: string) =>
    recordPersistentEvent(level, 'standalone-recovery', message);
  const key = (home: string, id: string) => `${getCodexHomeStateKey(home)}:${id}`;
  const stop = subscribeDashboardRealtime((message) => {
    if (disposed || message.type !== "dashboard:codex-session-live" || message.state.deviceId) return;
    const state = message.state,
      store = getSqliteStateStore();
    if (!store) return;
    const recordKey = key(resolveCodexHome(), state.sessionId);
    try {
      let previous = store.get<Retry>(NAMESPACE, recordKey);
      if (state.status === "running" && active.has(state.sessionId)) {
        ownedStreams.add(state.streamId);
        if (ownedStreams.size > 512) ownedStreams.delete(ownedStreams.values().next().value!);
        if (previous) {
          previous = { ...previous, automaticStreamId: state.streamId };
          store.set(NAMESPACE, recordKey, previous);
        }
      }
      if (
        state.status === "completed" ||
        state.status === "cancelled" ||
        (state.status === "running" && !active.has(state.sessionId) && !ownedStreams.has(state.streamId) &&
          previous?.automaticStreamId !== state.streamId && !(previous?.due === Number.MAX_SAFE_INTEGER && !previous.automaticStreamId))
      ) {
        store.set(NAMESPACE, recordKey, undefined);
        return;
      }
      if (!enabled() || !retryableState(state)) return;
      if (previous?.streamId === state.streamId) return;
      const attempts = previous?.attempts ?? 0;
      if (attempts >= DELAYS.length) {
        notice("warning", "Standalone recovery retry limit reached. Review the session before resuming manually.");
        return;
      }
      if (!previous && store.keys(NAMESPACE).length >= 128) {
        notice("warning", "Standalone recovery queue is full. Resume this session manually.");
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
        `Execution interrupted the turn. Standalone will retry in ${DELAYS[attempts]! / 1000}s (${attempts + 1}/${DELAYS.length}).`
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
          `model-capacity:${home}`,
          "Standalone execution recovery",
          async leaseSignal => {
            const runSignal = AbortSignal.any([controller.signal, leaseSignal]);
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
                (!retryableState(live) ||
                  live.streamId !== retry.streamId))
            ) {
              store.set(NAMESPACE, recordKey, undefined);
              return;
            }
            const account = (
              await waitWithin(repo.listAccounts(), 5000, "Retry account inspection timed out.", runSignal)
            ).find((item) => item.isActive);
            if (!account || account.enabled === false || !canUseAccount(account.id) || account.resetCreditAttempt || accountQuotaAvailability({ ...account, quotaError: undefined }) === 'exhausted') return;
            const session = await waitWithin(
              readCodexCliSessionSummary(retry.sessionId, home, false),
              5000,
              "Retry session inspection timed out.",
              runSignal
            );
            if (disposed || !enabled() || resolveCodexHome() !== home || !canUseAccount(account.id)) return;
            const latestPreference = readCodexSessionPreferences(home, [retry.sessionId]).get(retry.sessionId);
            if (
              latestPreference?.manualStop || isExplicitSessionGoalPause(home, retry.sessionId) ||
              latestPreference?.autoResume === false ||
              (!isAutoResumeEnabled() && latestPreference?.autoResume !== true)
            ) {
              store.set(NAMESPACE, recordKey, undefined);
              return;
            }
            if (isConfirmedSessionDeleted(store, home, retry.sessionId)) {
              store.set(NAMESPACE, recordKey, undefined);
              return;
            }
            if (!session) return;
            if (
              session.archived ||
              session.subAgent ||
              session.parentSessionId ||
              session.goal?.status === "complete" ||
              (session.goal?.status === "paused" && !session.interrupted)
            ) {
              store.set(NAMESPACE, recordKey, undefined);
              return;
            }
            if (session.status === 'unknown' || session.goal === undefined || !session.goal && session.interrupted === undefined) return;
            if (!session.goal && !session.interrupted) {
              store.set(NAMESPACE, recordKey, undefined);
              return;
            }
            if (session.status !== "idle" || session.locked) return;
            const pending = store.get<Retry>(NAMESPACE, recordKey);
            const latestLive = getCodexSessionLiveState(retry.sessionId);
            if (!pending || pending.streamId !== retry.streamId || pending.attempts !== retry.attempts ||
                latestLive && (latestLive.streamId !== retry.streamId || !retryableState(latestLive))) return;
            runSignal.throwIfAborted();
            store.set(NAMESPACE, recordKey, {
              ...retry,
              attempts: retry.attempts + 1,
              // Dispatch may succeed before a crash or timeout; only new failure evidence can re-arm it.
              due: Number.MAX_SAFE_INTEGER
            });
            active.add(retry.sessionId);
            try {
              const outcome = await waitWithin(
                resumeCodexSessionWork(retry.sessionId, runSignal, "automatic", vscode.env.appHost === 'node' ? 'private' : 'native'),
                30000,
                "Capacity retry was not confirmed. Review the session before retrying.",
                runSignal
              );
              if (outcome === "idle") {
                if (store.get<Retry>(NAMESPACE, recordKey)?.streamId === retry.streamId) store.set(NAMESPACE, recordKey, undefined);
              }
              else {
                const latest = store.get<Retry>(NAMESPACE, recordKey);
                if (latest?.streamId === retry.streamId) store.set(NAMESPACE, recordKey, { ...latest, due: Number.MAX_SAFE_INTEGER });
                notice("info", "Standalone recovery started.");
              }
            } catch (error) {
              const latest = store.get<Retry>(NAMESPACE, recordKey);
              if (latest?.streamId !== retry.streamId) return;
              if (recoverable(String(error))) {
                store.set(NAMESPACE, recordKey, { ...latest, due: Date.now() + DELAYS[Math.min(latest.attempts, DELAYS.length - 1)]! });
              } else {
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
