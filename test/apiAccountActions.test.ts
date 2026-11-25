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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
});
afterEach(async () => { configureSqliteStateStore(undefined); store.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
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
it.each(['browser', 'webview'] as const)('rejects an invalid Claude key before saving or selecting it in %s', async host => {
  vi.mocked(fetch).mockResolvedValue(new Response('fixture-secret', { status: 401 }));
  const result = await executeDashboardActionMessage(context(host), { type: 'dashboard:action', action: 'saveApiAccount', requestId: 'bad-claude', payload: { apiAccount: { provider: 'anthropic', name: 'Claude', apiKey: 'fixture-secret' } } });
  expect(result).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('HTTP 401') });
  expect(JSON.stringify(result)).not.toContain('fixture-secret');
  expect(listApiAccounts()).toEqual([]);
  expect(activeApiAccount('anthropic')).toBeUndefined();
});

it('refreshes API accounts in the selected batch without passing them to the native account repository', async () => {
  const ctx=context('browser');
  const saved=await executeDashboardActionMessage(ctx,{type:'dashboard:action',action:'saveApiAccount',requestId:'batch-save',payload:{apiAccount:{provider:'anthropic',name:'Claude',apiKey:'fixture-secret'}}});
  const id=saved.payload!.apiAccountSaved!.id;
  vi.mocked(fetch).mockResolvedValue(new Response('private body',{status:401}));
  const result=await executeDashboardActionMessage(ctx,{type:'dashboard:action',action:'batchRefresh',requestId:'batch-check',payload:{accountIds:[id]}});
  expect(result.payload?.batchResult).toMatchObject({successCount:0,failedCount:1});
  expect(ctx.repo.getAccount).not.toHaveBeenCalled();
});

it('validates edited credentials before replacing the selected account and preserves it on failure', async () => {
  const ctx=context('browser');
  const send=(apiKey:string,apiAccountId?:string,apiAccountRevision?:number)=>executeDashboardActionMessage(ctx,{type:'dashboard:action',action:'saveApiAccount',requestId:'edit-key',payload:{apiAccount:{provider:'anthropic',name:'Claude edited',apiKey},apiAccountId,apiAccountRevision}});
  const first=await send('first-key'),id=first.payload!.apiAccountSaved!.id;
  const previous=listApiAccounts()[0];
  vi.mocked(fetch).mockResolvedValue(new Response('{}',{status:401}));
  expect(await send('bad-key',id,previous.updatedAt)).toMatchObject({status:'failed'});
  expect(activeApiAccount('anthropic')?.id).toBe(id);expect(listApiAccounts()).toHaveLength(1);
  vi.mocked(fetch).mockResolvedValue(new Response('{}'));
  const changed=await send('replacement-key',id,previous.updatedAt);
  expect(changed.status).toBe('completed');
  expect(changed.payload!.apiAccountSaved!.id).not.toBe(id);
  expect(activeApiAccount('anthropic')?.id).toBe(changed.payload!.apiAccountSaved!.id);
  expect(listApiAccounts()).toHaveLength(1);
  expect(await send('stale-key',id,previous.updatedAt)).toMatchObject({status:'failed'});
});
it('tests the saved secret without sending it back to the editor', async () => {
  const ctx=context('browser');
  const first=await executeDashboardActionMessage(ctx,{type:'dashboard:action',action:'saveApiAccount',requestId:'saved-key',payload:{apiAccount:{provider:'anthropic',name:'Claude',apiKey:'private-saved-key'}}});
  const previous=listApiAccounts()[0];
  const result=await executeDashboardActionMessage(ctx,{type:'dashboard:action',action:'saveApiAccount',requestId:'test-saved',payload:{apiAccountId:previous.id,apiAccountRevision:previous.updatedAt,apiAccount:{provider:'anthropic',name:'Renamed',apiKey:''}}});
  expect(result.status).toBe('completed');expect(result.payload?.apiAccountSaved?.id).toBe(first.payload?.apiAccountSaved?.id);
  expect(JSON.stringify(result)).not.toContain('private-saved-key');
});
