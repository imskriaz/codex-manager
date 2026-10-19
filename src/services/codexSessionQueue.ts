import type * as vscode from 'vscode';
import type { DashboardCliSessionSummary } from '../domain/dashboard/types';
import { getCodexManagerConfiguration } from '../infrastructure/config/extensionSettings';
import { runCrossWindowExclusive, CrossWindowOperationBusyError } from '../utils/crossWindowOperations';
import { readQueuedCodexSessionPreferences, claimCodexSessionQueue, finishCodexSessionQueueClaim, type CodexSessionPreference } from './codexSessionPreferences';
import { readCodexCliSessions, resolveCodexHome } from './codexSessionResume';
import { resumeCodexSessionWork } from './codexSessionRecovery';
import { isExplicitSessionGoalPause } from './codexSessionGoals';
import { publishDashboardRealtime } from './dashboardRealtime';
import { getCodexHomeStateKey } from '../codex/authFile';
import { waitWithin, runWithConcurrencyLimit } from '../utils/concurrency';

export function nextQueuedSessions(sessions: DashboardCliSessionSummary[], preferences: ReadonlyMap<string, CodexSessionPreference>): DashboardCliSessionSummary[] {
  if (sessions.some(session => !session.archived && (session.status === 'running' || session.status === 'unknown'))) return [];
  if ([...preferences.values()].some(value => value.queueClaimId || value.queueClaimedAt || value.queueError)) return [];
  const eligible = sessions.filter(session => !session.archived && !session.subAgent && !session.parentSessionId && preferences.get(session.id)?.queue && !preferences.get(session.id)?.queueClaimedAt && !preferences.get(session.id)?.queueError);
  if (!eligible.length) return [];
  const priority = Math.min(...eligible.map(session => preferences.get(session.id)?.priority ?? 3));
  return eligible.filter(session => (preferences.get(session.id)?.priority ?? 3) === priority);
}
export function registerCodexSessionQueue(context: vscode.ExtensionContext): void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout>;
  const controller = new AbortController();
  const tick = async () => {
    try {
      if (!getCodexManagerConfiguration().get<boolean>('cliIntegrationEnabled', false)) return;
      const home = resolveCodexHome();
      if (!readQueuedCodexSessionPreferences(home).size) return;
      await runCrossWindowExclusive(`session-queue:${getCodexHomeStateKey(home)}`, 'Session queue', async signal => {
        const preferences = readQueuedCodexSessionPreferences(home);
        const sessions = await waitWithin(readCodexCliSessions(home, 10000, true), 10000, 'Session queue is waiting for verified running state.', controller.signal);
        if (disposed || signal.aborted || resolveCodexHome() !== home || !getCodexManagerConfiguration().get<boolean>('cliIntegrationEnabled', false)) return;
        const eligible = new Map([...preferences].filter(([id]) => !isExplicitSessionGoalPause(home, id)));
        const group = nextQueuedSessions(sessions, eligible);
        await runWithConcurrencyLimit(group.slice(0, 8), 8, async session => {
          const preference = readQueuedCodexSessionPreferences(home).get(session.id);
          if (disposed || signal.aborted || resolveCodexHome() !== home || !getCodexManagerConfiguration().get<boolean>('cliIntegrationEnabled', false) || !preference?.queue) return;
          if (session.goal?.status === 'paused' && isExplicitSessionGoalPause(home, session.id)) return;
          const claimId = claimCodexSessionQueue(home, session.id, preference.queueRevision);
          if (!claimId) return;
          try {
            const outcome = await resumeCodexSessionWork(session.id, controller.signal, 'automatic');
            finishCodexSessionQueueClaim(home, session.id, claimId);
            if (outcome === 'idle') publishDashboardRealtime({ type: 'dashboard:notice', level: 'info', message: `Queued session “${session.title}” has no eligible unfinished work. It was left idle.` });
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            finishCodexSessionQueueClaim(home, session.id, claimId, detail);
            publishDashboardRealtime({ type: 'dashboard:notice', level: 'warning', message: `Queued session “${session.title}” was not confirmed: ${detail}. Review the session before requeuing it.` });
          }
        });
      }, { background: true });
    } catch (error) { if (!(error instanceof CrossWindowOperationBusyError)) console.warn('[codexManager] session queue postponed', error); }
    finally { if (!disposed) { timer = setTimeout(() => { void tick(); }, 3000); timer.unref?.(); } }
  };
  timer = setTimeout(() => { void tick(); }, 3000); timer.unref?.();
  context.subscriptions.push({ dispose: () => { disposed = true; clearTimeout(timer); controller.abort(); } });
}
