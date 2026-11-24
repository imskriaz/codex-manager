import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { configureSqliteStateStore, SqliteStateStore } from '../src/storage/sqliteState';
import { saveSessionLive } from '../src/storage/sqliteSessions';
import { saveApiAccount, selectApiAccount, withApiAccountRuntime } from '../src/services/apiAccounts';
import { apiDashboardAccounts } from '../src/application/dashboard/apiAccounts';
import { reserveCodexSessionLive } from '../src/services/codexSessionLive';
import { flushSessionRecording } from '../src/services/sessionRecording';
import type { DashboardCodexSessionLiveState } from '../src/domain/dashboard/types';

let root: string, store: SqliteStateStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'manager-api-token-usage-'));
  vi.stubEnv('CODEX_HOME', root);
  store = await SqliteStateStore.open(path.join(root, 'manager.sqlite'));
  configureSqliteStateStore(store);
});
afterEach(async () => { flushSessionRecording(); configureSqliteStateStore(undefined); store.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const account = (provider: 'openai' | 'anthropic', apiKey = provider) => saveApiAccount({ provider, name: `${provider} API`, apiKey });
function record(accountId: string, sessionId: string, input: number, cachedInput: number | undefined, output: number, updatedAt: number, provider: 'codex' | 'claude' = 'codex') {
  const state: DashboardCodexSessionLiveState = { sessionId, streamId: randomUUID(), sequence: 1, status: 'completed', updatedAt, provider, messages: [], tokenUsage: { input, cachedInput, output } };
  saveSessionLive(store, root, state, accountId);
  return state;
}
it('counts cumulative Codex usage once and attributes resumed increments to the captured account', () => {
  const first = account('openai'), second = account('openai', 'other-key'), session = randomUUID();
  record(first.id, session, 100, 30, 20, Date.now());
  const next = record(first.id, session, 150, 40, 30, Date.now() + 1);
  saveSessionLive(store, root, { ...next, sequence: 2, updatedAt: next.updatedAt + 1 }, first.id);
  record(second.id, session, 200, 60, 45, Date.now() + 3);
  const usage = new Map(apiDashboardAccounts().map(account => [account.id, account.apiTokenUsage]));
  expect(usage.get(first.id)).toEqual({ input: 150, cachedInput: 40, output: 30 });
  expect(usage.get(second.id)).toEqual({ input: 50, cachedInput: 20, output: 15 });
});
it('sums Claude stream totals, handles reset counters, and keeps missing usage unknown', () => {
  const claude = account('anthropic'), codex = account('openai'), unused = account('openai', 'unused-key');
  const claudeId = randomUUID(), codexId = randomUUID(), now = Date.now();
  record(claude.id, claudeId, 100, 25, 10, now, 'claude');
  record(claude.id, claudeId, 50, 15, 5, now + 1, 'claude');
  record(codex.id, codexId, 90, undefined, 10, now);
  record(codex.id, codexId, 20, undefined, 2, now + 1);
  const usage = new Map(apiDashboardAccounts().map(account => [account.id, account.apiTokenUsage]));
  expect(usage.get(claude.id)).toEqual({ input: 150, cachedInput: 40, output: 15 });
  expect(usage.get(codex.id)).toEqual({ input: 110, cachedInput: undefined, output: 12 });
  expect(usage.get(unused.id)).toBeUndefined();
});
it('invalidates account snapshots for token changes without republishing unchanged token counts', () => {
  const api = account('openai'), revision = store.revision('accounts');
  const state = record(api.id, randomUUID(), 100, 25, 10, Date.now());
  expect(store.revision('accounts')).toBeGreaterThan(revision);
  const recorded = store.revision('accounts');
  saveSessionLive(store, root, { ...state, sequence: 2, updatedAt: state.updatedAt + 1 }, api.id);
  expect(store.revision('accounts')).toBe(recorded);
  saveSessionLive(store, root, { ...state, sequence: 3, updatedAt: state.updatedAt + 2, tokenUsage: { input: 120, cachedInput: 30, output: 12 } }, api.id);
  expect(store.revision('accounts')).toBeGreaterThan(recorded);
});
it('records Claude usage against the turn credentials after the selected account changes', async () => {
  const first = account('anthropic'), second = account('anthropic', 'other-key');
  selectApiAccount(first.id);
  await withApiAccountRuntime(async () => {
    const live = reserveCodexSessionLive('claude'), sessionId = randomUUID();
    let listener!: (method: string, params: unknown) => void;
    try {
      live.attach(sessionId, { onNotification: callback => { listener = callback; return () => undefined; }, onDisconnect: () => () => undefined }, () => []);
      live.started('turn-1');
      selectApiAccount(second.id);
      listener('thread/tokenUsage/updated', { threadId: sessionId, tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 8 } } });
      live.finish('completed');
      flushSessionRecording();
      const usage = new Map(apiDashboardAccounts().map(account => [account.id, account.apiTokenUsage]));
      expect(usage.get(first.id)).toEqual({ input: 100, cachedInput: 40, output: 8 });
      expect(usage.get(second.id)).toBeUndefined();
    } finally { live.dispose(); }
  });
});
