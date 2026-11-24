import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { configureSqliteStateStore, SqliteStateStore } from '../src/storage/sqliteState';
import { activeApiAccount, listApiAccounts, saveApiAccount, setApiAccountQueuePriority } from '../src/services/apiAccounts';
import { apiDashboardAccounts } from '../src/application/dashboard/apiAccounts';
import { executeDashboardActionMessage, type DashboardActionContext } from '../src/presentation/dashboard/actionHandlers';

let root: string, store: SqliteStateStore;
const input = { provider: 'openai' as const, name: 'Work API', apiKey: 'priority-fixture-secret' };
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'manager-api-priority-'));
  vi.stubEnv('CODEX_HOME', root);
  store = await SqliteStateStore.open(path.join(root, 'manager.sqlite'));
  configureSqliteStateStore(store);
});
afterEach(async () => { configureSqliteStateStore(undefined); store.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
function context(hostKind: 'browser' | 'webview'): DashboardActionContext {
  return { hostKind, context: {} as never, repo: { getAccount: vi.fn() } as never, resolveLanguage: () => 'en', schedulePublishState: vi.fn(), publishState: vi.fn(), oauth: {} as never };
}
it.each(['openai', 'anthropic'] as const)('retains %s stars through re-save and reopening storage without changing selection', async provider => {
  const account = saveApiAccount({ ...input, provider });
  expect(apiDashboardAccounts()[0]?.queuePriority).toBe(false);
  expect(setApiAccountQueuePriority(account.id, true).updatedAt).toBeGreaterThan(account.updatedAt);
  saveApiAccount({ ...input, provider, name: 'Renamed API' });
  store.close();
  store = await SqliteStateStore.open(path.join(root, 'manager.sqlite'));
  configureSqliteStateStore(store);
  expect(apiDashboardAccounts()[0]).toMatchObject({ queuePriority: true, displayName: 'Renamed API', metrics: [] });
  expect(activeApiAccount(provider)?.id).toBe(account.id);
  expect(JSON.stringify(apiDashboardAccounts())).not.toContain(input.apiKey);
  setApiAccountQueuePriority(account.id, false);
  expect(listApiAccounts()[0]?.queuePriority).toBe(false);
});
it.each(['browser', 'webview'] as const)('reports star, enablement, verification, missing-account and storage outcomes in %s', async hostKind => {
  const ctx = context(hostKind), account = saveApiAccount(input);
  const action = (name: 'setAccountQueuePriority' | 'toggleAccountEnabled' | 'switch' | 'refresh', payload = {}) => executeDashboardActionMessage(ctx, { type: 'dashboard:action', action: name, requestId: 'api-outcome', accountId: account.id, payload });
  expect(await action('setAccountQueuePriority', { queuePriority: true })).toMatchObject({ status: 'completed', payload: { notice: { message: expect.stringContaining('starred') } } });
  expect(ctx.schedulePublishState).toHaveBeenCalled();
  expect(await action('toggleAccountEnabled', { enabled: false })).toMatchObject({ status: 'completed' });
  expect(activeApiAccount('openai')).toBeUndefined();
  expect(await action('switch')).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('disabled') });
  expect(await action('toggleAccountEnabled', { enabled: true })).toMatchObject({ status: 'completed' });
  expect(listApiAccounts()[0]?.queuePriority).toBe(true);
  const fetchMock = vi.fn().mockRejectedValue(new Error('connection failed'));
  vi.stubGlobal('fetch', fetchMock);
  try {
    expect(await action('refresh')).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('timed out') });
  } finally { vi.unstubAllGlobals(); }
  const set = vi.spyOn(store, 'set').mockImplementation(() => { throw new Error('Fixture storage unavailable'); });
  expect(await action('setAccountQueuePriority', { queuePriority: false })).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('storage unavailable') });
  set.mockRestore();
  expect(listApiAccounts()[0]?.queuePriority).toBe(true);
  expect(await executeDashboardActionMessage(ctx, { type: 'dashboard:action', action: 'setAccountQueuePriority', requestId: 'missing', accountId: 'api:openai:' + '0'.repeat(64), payload: { queuePriority: true } })).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('no longer exists') });
  expect(ctx.repo.getAccount).not.toHaveBeenCalled();
});
