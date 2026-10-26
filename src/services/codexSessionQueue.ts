import type * as vscode from 'vscode';
import type { DashboardCliSessionSummary } from '../domain/dashboard/types';
import { getCodexManagerConfiguration } from '../infrastructure/config/extensionSettings';
import { runCrossWindowExclusive, CrossWindowOperationBusyError } from '../utils/crossWindowOperations';
import { readQueuedCodexSessionPreferences, claimCodexSessionQueue, finishCodexSessionQueueClaim, type CodexSessionPreference } from './codexSessionPreferences';
import { readCodexCliSessions, resolveCodexHome } from './codexSessionResume';
import { availableCodexSessionLiveSlots, onDidReleaseCodexSessionLiveSlot } from './codexSessionLive';
import { resumeCodexSessionWork } from './codexSessionRecovery';
import { isExplicitSessionGoalPause } from './codexSessionGoals';
import { publishDashboardRealtime } from './dashboardRealtime';
import { getCodexHomeStateKey } from '../codex/authFile';
import { getSqliteStateStore } from '../storage/sqliteState';
import { onDidChangeConfiguration } from '../storage/configurationEvents';
import { waitWithin, runWithConcurrencyLimit } from '../utils/concurrency';

export function nextQueuedSessions(sessions: DashboardCliSessionSummary[], preferences: ReadonlyMap<string, CodexSessionPreference>): DashboardCliSessionSummary[] {
  if (sessions.some(session => !session.archived && (session.status === 'running' || session.status === 'unknown' || session.locked))) return [];
  if ([...preferences.values()].some(value => value.queueClaimId || value.queueClaimedAt || value.queueError)) return [];
  const eligible = sessions.filter(session => {
    const preference = preferences.get(session.id);
    return !session.archived && !session.subAgent && !session.parentSessionId && session.goal?.status !== 'complete' && (session.goal?.status !== 'paused' || session.interrupted === true) &&
      preference?.queue === true && !preference.manualStop && !preference.queueClaimedAt && !preference.queueError &&
      Number.isSafeInteger(preference.priority ?? 3) && (preference.priority ?? 3) >= 1;
  });
  if (!eligible.length) return [];
  const priority = Math.min(...eligible.map(session => preferences.get(session.id)?.priority ?? 3));
  return eligible.filter(session => (preferences.get(session.id)?.priority ?? 3) === priority);
}

/** Wake on committed state changes; failed reads get a bounded retry. */
export function registerCodexSessionQueue(context: vscode.ExtensionContext): void {
  let disposed = false;
  let running = false;
  let dirty = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let fingerprint = '';
  const controller = new AbortController();
  let activeRun: AbortController | undefined;

  const wake = (): void => {
    if (disposed) return;
    dirty = true;
    if (!running) queueMicrotask(() => { void run(); });
  };

  const run = async (): Promise<void> => {
    if (disposed || running || !dirty) return;
    running = true;
    dirty = false;
    try {
      if (!getCodexManagerConfiguration().get<boolean>('cliIntegrationEnabled', false)) return;
      const home = resolveCodexHome();
      const initial = readQueuedCodexSessionPreferences(home);
      if (!initial.size) return;
      const preferenceFingerprint = [...initial].sort().map(([id, value]) => `${id}:${JSON.stringify(value)}`).join('|');
      await runCrossWindowExclusive(`session-queue:${getCodexHomeStateKey(home)}`, 'Session queue', async signal => {
        const launch = new AbortController(); activeRun = launch;
        const launchSignal = AbortSignal.any([controller.signal, signal, launch.signal]);
        try {
          const sessions = await waitWithin(readCodexCliSessions(home, 10000, true), 10000, 'Session queue is waiting for verified running state.', launchSignal);
          if (disposed || launchSignal.aborted || resolveCodexHome() !== home || !getCodexManagerConfiguration().get<boolean>('cliIntegrationEnabled', false)) return;
          const statusFingerprint = sessions.filter(session => !session.archived).map(session => `${session.id}:${session.status}:${session.locked ? 1 : 0}:${session.goal?.status ?? ''}`).sort().join('|');
          const capacity = availableCodexSessionLiveSlots();
          const nextFingerprint = `${preferenceFingerprint}\n${statusFingerprint}\n${capacity}`;
          if (nextFingerprint === fingerprint) return;
          fingerprint = nextFingerprint;
          const eligible = new Map([...readQueuedCodexSessionPreferences(home)].filter(([id]) => !isExplicitSessionGoalPause(home, id)));
          const group = nextQueuedSessions(sessions, eligible);
          await runWithConcurrencyLimit(group.slice(0, capacity), 8, async session => {
            if (disposed || launchSignal.aborted || resolveCodexHome() !== home || !getCodexManagerConfiguration().get<boolean>('cliIntegrationEnabled', false)) return;
            if (availableCodexSessionLiveSlots() === 0) return;
            const preference = eligible.get(session.id);
            if (!preference?.queue || isExplicitSessionGoalPause(home, session.id)) return;
            const claimId = claimCodexSessionQueue(home, session.id, preference.queueRevision);
            if (!claimId) return;
            try {
              const outcome = await resumeCodexSessionWork(session.id, launchSignal, 'queue');
              finishCodexSessionQueueClaim(home, session.id, claimId);
              if (outcome === 'idle') publishDashboardRealtime({ type: 'dashboard:notice', level: 'info', message: `Queued session “${session.title}” has no eligible unfinished work. It was left idle.` });
            } catch (error) {
              let detail = error instanceof Error ? error.message : String(error);
              try { finishCodexSessionQueueClaim(home, session.id, claimId, detail); }
              catch (storageError) { detail += ` Result storage failed: ${storageError instanceof Error ? storageError.message : String(storageError)}`; }
              publishDashboardRealtime({ type: 'dashboard:notice', level: 'warning', message: `Queued session “${session.title}” was not confirmed: ${detail}. Review the session before requeuing it.` });
            }
          });
        } finally { if (activeRun === launch) activeRun = undefined; }
      }, { background: true });
    } catch (error) {
      fingerprint = '';
      if (!(error instanceof CrossWindowOperationBusyError)) {
        console.warn('[codexManager] session queue postponed', error);
        if (!retryTimer && !disposed) {
          retryTimer = setTimeout(() => { retryTimer = undefined; wake(); }, 5000);
          retryTimer.unref?.();
        }
      }
    } finally {
      running = false;
      if (!disposed && dirty) queueMicrotask(() => { void run(); });
    }
  };

  const store = getSqliteStateStore();
  const stopCapacity = onDidReleaseCodexSessionLiveSlot(wake);
  const stopStorage = store?.subscribe(['sessions', 'session-status', 'session-preferences', 'state'], () => wake());
  const stopConfiguration = onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('codexManager.cliIntegrationEnabled') || event.affectsConfiguration('codexManager.codexHome')) {
      if (!getCodexManagerConfiguration().get<boolean>('cliIntegrationEnabled', false) || event.affectsConfiguration('codexManager.codexHome'))
        activeRun?.abort(new Error('Session queue configuration changed before startup was confirmed.'));
      wake();
    }
  });
  context.subscriptions.push({ dispose: () => {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    stopStorage?.();
    stopCapacity();
    stopConfiguration.dispose();
    controller.abort();
  }});
  wake();
}
