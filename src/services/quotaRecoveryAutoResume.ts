import * as vscode from "vscode";
import type { AccountsRepository } from "../storage";
import { accountQuotaAvailability } from "../utils/quotaWindows";
import { waitWithin } from "../utils/concurrency";
import { recordPersistentEvent } from "../utils/persistentLog";
import { getAccountAutoQueuePolicy, toAutoQueueOrderValue } from "../application/accounts/autoQueueOrder";
import { isAutoQueueSnapshotFresh } from "../domain/autoQueuePolicy";
import { needsWindowReloadForAccount } from "../presentation/workbench/windowRuntimeAccount";
import { resolveCodexHome } from "./codexSessionResume";
import {
  formatAutoResumeResult,
  isAutoResumeAvailable,
  persistRunningCodexSessions,
  resumePersistedCodexSessions
} from "./codexSessionAutoResume";
import { publishDashboardRealtime, subscribeDashboardRealtime } from "./dashboardRealtime";
import { isCodexQuotaInterruption } from '../domain/codexSessionState';
import { getQuotaIssueKind } from '../utils/quotaIssue';
import { onDidRecordAccountQuotaCheck } from "./quotaCheckCoordination";
import type { CodexManagerAccountRecord } from "../core/types";
import { getSqliteStateStore } from "../storage/sqliteState";
import { onDidChangeConfiguration } from "../storage/configurationEvents";

/** Remember exhaustion across restarts; resume through the existing verified native recovery path. */
export function registerQuotaRecoveryAutoResume(
  context: vscode.ExtensionContext,
  repo: AccountsRepository,
  canUseAccount: (id: string) => boolean
): vscode.Disposable {
  let disposed = false,
    running = false,
    dirty = false,
    retryAt = 0;
  let exhaustionHome: string | undefined;
  let observedAccountId: string | undefined;
  const interrupted = new Set<string>();
  const observedFailures = new Set<string>();
  let quotaRefresh: { accountId?: string } | undefined, lastFailureAt = 0;
  let lastFailureAccountId: string | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRetry = () => {
    retryAt = Date.now() + 60_000;
    if (retryTimer) clearTimeout(retryTimer);
    if (disposed) return;
    retryTimer = setTimeout(() => { retryTimer = undefined; void check(); }, 60_000);
    retryTimer.unref?.();
  };
  const check = async () => {
    if (disposed) return;
    if (running) { dirty = true; return; }
    running = true;
    dirty = false;
    try {
      const home = resolveCodexHome(),
        key = `codexManager.quotaRecovery:${home}`;
      let pending = context.workspaceState.get<boolean>(key) === true;
      if (!isAutoResumeAvailable()) {
        exhaustionHome = undefined;
        interrupted.clear();
        if (pending)
          await waitWithin(
            Promise.resolve(context.workspaceState.update(key, undefined)),
            5_000,
            "Quota recovery state could not be cleared."
          );
        return;
      }
      if (exhaustionHome === home) {
        await waitWithin(
          Promise.resolve(context.workspaceState.update(key, true)),
          5_000,
          "Quota recovery could not save exhaustion."
        );
        exhaustionHome = undefined;
        pending = true;
      }
      if (interrupted.size) {
        const captured = [...interrupted];
        await persistRunningCodexSessions(context, () => Promise.resolve(captured));
        for (const id of captured) interrupted.delete(id);
        await waitWithin(Promise.resolve(context.workspaceState.update(key, true)), 5_000, 'Session recovery could not be saved.');
        pending = true;
      }
      const accounts = await waitWithin(repo.listAccounts(), 5_000, "Quota recovery could not read accounts.");
      if (disposed || home !== resolveCodexHome() || !isAutoResumeAvailable()) return;
      const active = accounts.find((account) => account.isActive);
      if (!active || active.enabled === false || !canUseAccount(active.id)) return;
      const switched = vscode.env.appHost === 'node' && observedAccountId !== undefined && observedAccountId !== active.id;
      observedAccountId = active.id;
      // A replacement account must not inherit the failed account's retry delay.
      if (Date.now() < retryAt && !switched) return;
      if (switched) {
        retryAt = 0;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      if (switched) {
        await waitWithin(Promise.resolve(context.workspaceState.update(key, true)), 5_000, 'Account switch recovery could not be saved.');
        pending = true;
      }
      const availability = accountQuotaAvailability(active);
      // A failed refresh does not erase previously confirmed exhaustion.
      if (availability === "exhausted" || accountQuotaAvailability({ ...active, quotaError: undefined }) === "exhausted") {
        if (!pending)
          await waitWithin(
            Promise.resolve(context.workspaceState.update(key, true)),
            5_000,
            "Quota recovery could not save its pending state."
          );
        return;
      }
      if (
        !pending ||
        (quotaRefresh && (!quotaRefresh.accountId || quotaRefresh.accountId === active.id)) ||
        (lastFailureAt > 0 && (!lastFailureAccountId || lastFailureAccountId === active.id) && (active.lastQuotaAt ?? 0) < lastFailureAt) ||
        availability !== "available" ||
        active.resetCreditAttempt ||
        needsWindowReloadForAccount(active.id) ||
        !isAutoQueueSnapshotFresh(toAutoQueueOrderValue(active), getAccountAutoQueuePolicy())
      )
        return;
      scheduleRetry();
      await persistRunningCodexSessions(context);
      const latest = (
        await waitWithin(repo.listAccounts(), 5_000, "Quota recovery could not verify the active account.")
      ).find((account) => account.isActive);
      if (
        disposed ||
        home !== resolveCodexHome() ||
        !isAutoResumeAvailable() ||
        latest?.id !== active.id ||
        latest.enabled === false ||
        (quotaRefresh && (!quotaRefresh.accountId || quotaRefresh.accountId === latest?.id)) ||
        (lastFailureAt > 0 && (!lastFailureAccountId || lastFailureAccountId === latest.id) && (latest.lastQuotaAt ?? 0) < lastFailureAt) ||
        !canUseAccount(active.id) ||
        latest.resetCreditAttempt ||
        needsWindowReloadForAccount(latest.id) ||
        accountQuotaAvailability(latest) !== "available" ||
        !isAutoQueueSnapshotFresh(toAutoQueueOrderValue(latest), getAccountAutoQueuePolicy())
      )
        return;
      const result = await resumePersistedCodexSessions(context);
      const message = formatAutoResumeResult(result);
      if (vscode.env.appHost === 'node') {
        if (message) recordPersistentEvent(result.failed.length ? 'warning' : 'info', 'auto-resume', message);
      } else if (message) {
        publishDashboardRealtime({ type: 'dashboard:notice', level: result.failed.length ? 'warning' : 'info', message });
        if (result.failed.length) void vscode.window.showWarningMessage(message);
        else void vscode.window.showInformationMessage(message);
      }
      if (!result.failed.length) {
        await waitWithin(
          Promise.resolve(context.workspaceState.update(key, undefined)),
          5_000,
          "Quota recovery completion could not be saved."
        );
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = undefined;
        retryAt = 0;
      }
    } catch (error) {
      if (Date.now() >= retryAt) {
        scheduleRetry();
        console.warn("[codexManager] quota recovery deferred; saved work retained", error);
      }
    } finally {
      running = false;
      if (dirty && !disposed) queueMicrotask(() => { void check(); });
    }
  };
  const stopQuotaChecks = onDidRecordAccountQuotaCheck((account) => {
    if (!account.isActive || !isAutoResumeAvailable() || !canUseAccount(account.id)) return;
    if (accountQuotaAvailability(account as CodexManagerAccountRecord) === "exhausted")
      exhaustionHome = resolveCodexHome();
    void check();
  });
  const stopStorage = getSqliteStateStore()?.subscribe(["accounts", "usage", "state"], () => { void check(); });
  const stopLive = subscribeDashboardRealtime(message => {
    if (vscode.env.appHost !== 'node' || message.type !== 'dashboard:codex-session-live' || message.state.deviceId ||
        !['failed', 'disconnected'].includes(message.state.status) || !isAutoResumeAvailable()) return;
    const detail = message.state.error ?? '';
    if (!isCodexQuotaInterruption(detail) && getQuotaIssueKind({ message: detail, timestamp: Date.now() }) !== 'auth') return;
    if (observedFailures.has(message.state.streamId)) return;
    observedFailures.add(message.state.streamId);
    if (observedFailures.size > 256) observedFailures.delete(observedFailures.values().next().value!);
    if (interrupted.size >= 200) { recordPersistentEvent('warning', 'auto-resume', 'Session recovery queue is full; automatic recovery retained'); return; }
    interrupted.add(message.state.sessionId);
    retryAt = 0;
    lastFailureAt = Date.now();
    lastFailureAccountId = observedAccountId;
    if (!quotaRefresh || quotaRefresh.accountId !== observedAccountId) {
      const refresh = { accountId: observedAccountId };
      quotaRefresh = refresh;
      void waitWithin((async () => {
        const active = (await repo.listAccounts()).find(account => account.isActive);
        if (active && active.enabled !== false && canUseAccount(active.id) && (!refresh.accountId || refresh.accountId === active.id)) {
          refresh.accountId = active.id;
          await vscode.commands.executeCommand('codexManager.refreshQuota', active);
        }
      })(), 30_000, 'Quota refresh is still pending. Saved recovery will retry.')
        .catch(error => console.warn('[codexManager] quota failure refresh deferred', error))
        .finally(() => { if (quotaRefresh === refresh) quotaRefresh = undefined; void check(); });
    }
    void check();
  });
  const stopConfiguration = onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('codexManager.autoResumeEnabled') || event.affectsConfiguration('codexManager.codexHome')) void check();
  });
  void check();
  const timer = setInterval(() => {
    void check();
  }, 60_000);
  timer.unref?.();
  return {
    dispose() {
      disposed = true;
      stopQuotaChecks();
      stopLive();
      stopStorage?.();
      stopConfiguration.dispose();
      clearInterval(timer);
      if (retryTimer) clearTimeout(retryTimer);
    }
  };
}
