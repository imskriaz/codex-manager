import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { configureSqliteStateStore, SqliteStateStore } from '../src/storage/sqliteState';
import { executeDashboardActionMessage, type DashboardActionContext } from '../src/presentation/dashboard/actionHandlers';
import { activeApiAccount, listApiAccounts } from '../src/services/apiAccounts';

let root: string, store: SqliteStateStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'manager-api-actions-'));
  vi.stubEnv('CODEX_HOME', root); vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude'));
  for (const key of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_BASE_URL']) vi.stubEnv(key, '');
  store = await SqliteStateStore.open(path.join(root, 'manager.sqlite')); configureSqliteStateStore(store);
});
afterEach(async () => { configureSqliteStateStore(undefined); store.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
function context(hostKind: 'browser' | 'webview'): DashboardActionContext {
  return { hostKind, context: {} as never, repo: { getAccount: vi.fn(), flush: vi.fn(async () => undefined) } as never, resolveLanguage: () => 'en', schedulePublishState: vi.fn(), publishState: vi.fn(), oauth: {} as never };
}
it.each(['browser', 'webview'] as const)('confirms safe API saves, selections and removals in the %s dashboard', async host => {
  const ctx = context(host);
  const saved = await executeDashboardActionMessage(ctx, { type: 'dashboard:action', action: 'saveApiAccount', requestId: 'api-save', payload: { apiAccount: { provider: 'openai', name: 'Team API', apiKey: 'fixture-secret' } } });
  expect(saved.status).toBe('completed'); expect(saved.payload?.apiAccountSaved?.id).toMatch(/^api:openai:/);
  expect(JSON.stringify(saved)).not.toContain('fixture-secret');
  const accountId = saved.payload!.apiAccountSaved!.id;
  expect(await executeDashboardActionMessage(ctx, { type: 'dashboard:action', action: 'switch', requestId: 'api-select', accountId })).toMatchObject({ status: 'completed' });
  expect(activeApiAccount('openai')?.id).toBe(accountId);
  expect(await executeDashboardActionMessage(ctx, { type: 'dashboard:action', action: 'remove', requestId: 'api-remove-unconfirmed', accountId })).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('Confirm removal') });
  expect(listApiAccounts()).toHaveLength(1);
  expect(await executeDashboardActionMessage(ctx, { type: 'dashboard:action', action: 'remove', requestId: 'api-remove', accountId, payload: { confirmed: true } })).toMatchObject({ status: 'completed' });
  expect(listApiAccounts()).toEqual([]);
});
it.each(['browser', 'webview'] as const)('imports API-only current auth in %s without requiring OAuth tokens', async host => {
  await writeFile(path.join(root, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'current-fixture-key' }));
  const ctx = context(host);
  const result = await executeDashboardActionMessage(ctx, { type: 'dashboard:action', action: 'importCurrent', requestId: 'api-import' });
  expect(result).toMatchObject({ status: 'completed', payload: { notice: { message: expect.stringContaining('Imported 1 API account') } } });
  expect(listApiAccounts()).toHaveLength(1); expect(ctx.repo.getAccount).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('current-fixture-key');
});
it('returns validation failures to the initiating UI without saving malformed credentials', async () => {
  const result = await executeDashboardActionMessage(context('browser'), { type: 'dashboard:action', action: 'saveApiAccount', requestId: 'api-invalid', payload: { apiAccount: { provider: 'openai', name: 'Bad key', apiKey: '' } } });
  expect(result).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('valid API key') });
  expect(listApiAccounts()).toEqual([]);
});
