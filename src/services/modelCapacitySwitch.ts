import { listCodexSessionLiveStates } from './codexSessionLive';
import { waitWithin } from '../utils/concurrency';
import * as vscode from 'vscode';
import type { AccountsRepository } from '../storage';
import type { RefreshView } from '../application/accounts/quota';
import { maybeAutoSwitchForActiveQuota } from '../application/accounts/quota';
import { isCodexCapacityInterruption } from '../domain/codexSessionState';
import { getCodexManagerConfiguration, normalizeModelCapacityFailures } from '../infrastructure/config/extensionSettings';
import { getSqliteStateStore } from '../storage/sqliteState';
import { onDidChangeConfiguration } from '../storage/configurationEvents';
import { runCrossWindowExclusive } from '../utils/crossWindowOperations';
import { captureSessionAccount } from './sessionRecording';
import { onDidInspectRunningCodexSessions, readRecentRunningCodexSessionIds, observeRunningCodexSession, readRunningCodexSessionIds, resolveCodexHome } from './codexSessionResume';
import { publishDashboardRealtime, subscribeDashboardRealtime } from './dashboardRealtime';

type CapacityFailures = { accountId: string; count: number; seen: string[] };
export const CAPACITY_TAG_TTL_MS = 2 * 60 * 60_000;
type CapacityTagLedger = Record<string, number>;
export function isCapacityTagExpired(taggedAt: number, now = Date.now()): boolean {
  return Number.isFinite(taggedAt) && now - taggedAt >= CAPACITY_TAG_TTL_MS;
}

async function setCapacityTag(repo: AccountsRepository, view: RefreshView, accountId: string, add: boolean): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const account = (await waitWithin(repo.listAccounts(), 5000, 'Accounts could not be read for the Capacity tag.')).find(item => item.id === accountId);
    if (!account) return;
    const tags = (account.tags ?? []).filter(tag => tag.toLowerCase() !== 'capacity');
    const next = add ? [...tags, 'Capacity'] : tags;
    if (next.length === (account.tags ?? []).length && next.every((tag, index) => tag === account.tags?.[index])) return;
    try { await waitWithin(repo.setAccountTags(accountId, next, account.tags ?? []), 5000, 'The Capacity tag save was not confirmed.'); view.refresh(); return; }
    catch (error) { if (attempt || !/tags changed/i.test(String(error))) throw error; }
  }
}

async function expireCapacityTags(repo: AccountsRepository, view: RefreshView, home: string): Promise<void> {
  const store = getSqliteStateStore();
  if (!store) return;
  const key = JSON.stringify([home]);
  const ledger = store.get<CapacityTagLedger>('model-capacity-tags', key);
  if (!ledger) return;
  const accounts = await waitWithin(repo.listAccounts(), 5000, 'Accounts could not be read while expiring Capacity tags.');
  let changed = false;
  for (const [accountId, taggedAt] of Object.entries(ledger)) {
    if (!isCapacityTagExpired(taggedAt)) continue;
    const account = accounts.find(item => item.id === accountId);
    if (account?.tags?.some(tag => tag.toLowerCase() === 'capacity')) await setCapacityTag(repo, view, accountId, false);
    delete ledger[accountId];
    changed = true;
  }
  if (changed) store.set('model-capacity-tags', key, ledger);
}
export function countModelCapacityOutcome(previous: CapacityFailures | undefined, accountId: string, eventId: string, capacity: boolean | undefined): CapacityFailures {
  const state = previous?.accountId === accountId && Number.isSafeInteger(previous.count) && previous.count >= 0 && Array.isArray(previous.seen) && previous.seen.every(id => typeof id === 'string') ? previous : { accountId, count: 0, seen: [] };
  return state.seen.includes(eventId) ? state : { accountId, count: capacity === undefined ? state.count : capacity ? Math.min(1000, state.count + 1) : 0, seen: [...state.seen, eventId].slice(-512) };
}

/** Count terminal attempts once across sessions and reloads, using the normal switch guards. */
export function registerModelCapacitySwitch(repo: AccountsRepository, view: RefreshView, canUseAccount: (id: string) => boolean): vscode.Disposable {
  const sources = new Map<string, { home: string; accountId: string }>();
  const startedAt = Date.now();
  const observed = new Set<string>();
  let disposed = false, revision = 0, queued = 0;
  let pending = Promise.resolve();
  const expiryTimer = setInterval(() => { void expireCapacityTags(repo, view, resolveCodexHome()).catch(error => console.warn('[codexManager] Capacity tag expiry failed', error)); }, 5 * 60_000);
  expiryTimer.unref?.();
  void expireCapacityTags(repo, view, resolveCodexHome()).catch(error => console.warn('[codexManager] Capacity tag expiry failed', error));
  const enabled = () => {
    const config = getCodexManagerConfiguration();
    return config.get<boolean>('autoSwitchEnabled', true) && config.get<boolean>('modelCapacityAutoSwitchEnabled', true);
  };
  const stop = subscribeDashboardRealtime(message => {
    if (disposed || message.type !== 'dashboard:codex-session-live' || message.state.deviceId) return;
    const state = message.state, home = resolveCodexHome(), accountId = captureSessionAccount();
    if (!accountId || state.updatedAt < startedAt) return;
    if (!sources.has(state.streamId)) {
      sources.set(state.streamId, { home, accountId });
      if (sources.size > 512) sources.delete(sources.keys().next().value!);
    }
    const source = sources.get(state.streamId)!;
    if (source.home !== home || source.accountId !== accountId) return;
    if (['running', 'starting'].includes(state.status)) { revision++; return; }
    if (!['failed', 'completed', 'cancelled', 'disconnected'].includes(state.status)) return;
    const eventId = JSON.stringify([state.sessionId, state.turnId ?? state.streamId]);
    const capacity = state.status === 'failed' && isCodexCapacityInterruption(state.error ?? JSON.stringify(state.messages.filter(item => item.kind === 'error')));
    const policyEnabled = enabled();
    if (observed.has(eventId)) return;
    observed.add(eventId); if (observed.size > 512) observed.delete(observed.values().next().value!);
    const anotherRunning = listCodexSessionLiveStates().some(other => other.sessionId !== state.sessionId && !other.deviceId && ['running', 'starting'].includes(other.status));
    const epoch = ++revision;
    if (queued >= 128) { observed.delete(eventId); publishDashboardRealtime({ type: 'dashboard:notice', level: 'warning', message: 'Model-capacity recovery is busy. This failure was not counted; no switch was requested.' }); return; }
    queued++;
    pending = pending.then(() => runCrossWindowExclusive(`model-capacity:${home}`, 'Model capacity recovery', async () => {
      if (disposed || home !== resolveCodexHome() || captureSessionAccount() !== accountId) return;
      try { await expireCapacityTags(repo, view, home); }
      catch (error) { console.warn('[codexManager] Capacity tag expiry deferred', error); }
      const store = getSqliteStateStore();
      if (!store) throw new Error('Model capacity recovery could not save its failure count. No account was switched.');
      const key = JSON.stringify([home]);
      const previous = store.get<CapacityFailures>('model-capacity', key);
      let outcome: boolean | undefined = policyEnabled && enabled() && capacity;
      if (capacity && policyEnabled && enabled()) {
        const running = anotherRunning || (await waitWithin(readRunningCodexSessionIds(home), 5000, 'Running sessions could not be verified. The model-capacity failure was not counted.')).some(id => id !== state.sessionId);
        if (running) outcome = undefined;
      }
      const next = countModelCapacityOutcome(previous, accountId, eventId, outcome);
      if (next === previous) return;
      store.set('model-capacity', key, next);
      const threshold = normalizeModelCapacityFailures(getCodexManagerConfiguration().get<number>('modelCapacityFailureCount', 3));
      if (outcome !== true || disposed || !enabled() || next.count < threshold || !canUseAccount(accountId)) return;
      const switched = await maybeAutoSwitchForActiveQuota(repo, view, { canUseAccount, modelCapacityAccountId: accountId, capacityStillNeeded: () => !disposed && epoch === revision && enabled() && next.count >= normalizeModelCapacityFailures(getCodexManagerConfiguration().get<number>('modelCapacityFailureCount', 3)) && home === resolveCodexHome() && captureSessionAccount() === accountId });
      if (!switched) return;
      try {
        await setCapacityTag(repo, view, accountId, true);
        const tags = getSqliteStateStore()?.get<CapacityTagLedger>('model-capacity-tags', key) ?? {};
        tags[accountId] = Date.now();
        getSqliteStateStore()?.set('model-capacity-tags', key, tags);
      } catch (error) {
        publishDashboardRealtime({ type: 'dashboard:notice', level: 'warning', message: `The Capacity tag could not be saved. Existing tags were kept. ${error instanceof Error ? error.message : ''}` });
      }
    })).catch(error => {
      observed.delete(eventId);
      console.warn('[codexManager] model capacity recovery could not complete', error);
      publishDashboardRealtime({ type: 'dashboard:notice', level: 'warning', message: error instanceof Error ? error.message : 'Model capacity recovery could not complete. Refresh before retrying.' });
    }).finally(() => { queued--; });
  });
  const changed = onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('codexManager.autoSwitchEnabled') && !event.affectsConfiguration('codexManager.modelCapacityAutoSwitchEnabled')) return;
    revision++;
    const store = getSqliteStateStore(), accountId = captureSessionAccount();
    if (!store || !accountId) return;
    try { store.set('model-capacity', JSON.stringify([resolveCodexHome()]), { accountId, count: 0, seen: [] }); }
    catch (error) { console.warn('[codexManager] model capacity counter reset failed', error); }
  });
  const inspections = onDidInspectRunningCodexSessions(home => {
    if (disposed || home !== resolveCodexHome()) return;
    for (const id of readRecentRunningCodexSessionIds(home) ?? []) observeRunningCodexSession({ id, title: id, status: 'running' });
  });
  return { dispose() { disposed = true; revision++; clearInterval(expiryTimer); stop(); changed.dispose(); inspections.dispose(); sources.clear(); observed.clear(); } };
}
