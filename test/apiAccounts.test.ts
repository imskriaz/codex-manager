import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { configureSqliteStateStore, SqliteStateStore } from '../src/storage/sqliteState';
import { normalizeApiAccount } from '../src/domain/apiAccounts';
import { activeApiAccount, apiAccountCodexArgs, apiAccountCredential, apiAccountEnvironment, apiAccountIdentity, clearApiAccountSelection, importCurrentApiAccounts, listApiAccounts, removeApiAccount, refreshApiAccounts, saveApiAccount, saveValidatedApiAccount, selectApiAccount, setApiAccountEnabled, validateApiAccount } from '../src/services/apiAccounts';
import { apiDashboardAccounts } from '../src/application/dashboard/apiAccounts';
import { withApiAccountRuntime } from '../src/services/apiAccounts';

let root: string, store: SqliteStateStore;
const input = { provider: 'openai' as const, name: 'Work API', apiKey: 'test-openai-secret' };
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'manager-api-accounts-'));
  for (const key of ['CODEX_API_KEY','OPENAI_API_KEY','OPENAI_BASE_URL','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL']) vi.stubEnv(key, '');
  vi.stubEnv('CODEX_HOME', root); vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude'));
  store = await SqliteStateStore.open(path.join(root, 'manager.sqlite')); configureSqliteStateStore(store);
});
afterEach(async () => { configureSqliteStateStore(undefined); store.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

it('saves credentials atomically and publishes only safe account details', () => {
  const account = saveApiAccount(input);
  expect(apiAccountCredential(account)).toBe(input.apiKey);
  expect(listApiAccounts()).toHaveLength(1);
  expect(JSON.stringify(apiDashboardAccounts())).not.toContain(input.apiKey);
  expect(JSON.stringify(listApiAccounts())).not.toContain(input.apiKey);
  expect(saveApiAccount({ ...input, name: 'Renamed' }).id).toBe(account.id);
  expect(listApiAccounts()).toHaveLength(1);
  expect(listApiAccounts()[0]?.name).toBe('Renamed');
  expect(activeApiAccount('openai')?.id).toBe(account.id);
  expect(apiDashboardAccounts()[0]).toMatchObject({ authMode: 'apiKey', authProviderLabel: 'OpenAI', isActive: true, isCurrentWindowAccount: true, metrics: [] });
});
it('rejects invalid providers, keys and credential-bearing or insecure endpoints before saving', () => {
  for (const patch of [{ provider: 'unknown' }, { name: '' }, { apiKey: 'key with spaces' }, { baseUrl: 'http://example.test' }, { baseUrl: 'https://user:secret@example.test' }, { baseUrl: 'https://example.test?key=secret' }]) {
    expect(() => saveApiAccount({ ...input, ...patch } as typeof input)).toThrow();
  }
  expect(listApiAccounts()).toEqual([]);
  expect(normalizeApiAccount({ ...input, baseUrl: 'http://127.0.0.1:1234/v1/' }).baseUrl).toBe('http://127.0.0.1:1234/v1');
});
it('selects each provider independently, scopes selections to Codex home and clears deleted keys', () => {
  const account = saveApiAccount(input), claude = saveApiAccount({ ...input, provider: 'anthropic', apiKey: 'test-claude-secret' });
  selectApiAccount(account.id); selectApiAccount(claude.id);
  expect(activeApiAccount('openai')?.id).toBe(account.id);
  expect(activeApiAccount('anthropic')?.id).toBe(claude.id);
  vi.stubEnv('CODEX_HOME', path.join(root, 'other'));
  expect(activeApiAccount('openai')).toBeUndefined();
  vi.stubEnv('CODEX_HOME', root);
  removeApiAccount(account.id);
  expect(activeApiAccount('openai')).toBeUndefined();
  expect(store.get('secrets', account.id)).toBeNull();
  expect(() => selectApiAccount(account.id)).toThrow('no longer exists');
  clearApiAccountSelection('anthropic'); expect(apiAccountIdentity('anthropic')).toBe('native');
});
it('supports disabling an API account and clears its active selection', () => {
  const account = saveApiAccount(input);
  expect(activeApiAccount('openai')?.id).toBe(account.id);
  setApiAccountEnabled(account.id, false);
  expect(listApiAccounts()[0]?.enabled).toBe(false);
  expect(activeApiAccount('openai')).toBeUndefined();
  expect(() => selectApiAccount(account.id)).toThrow('disabled');
  setApiAccountEnabled(account.id, true);
  expect(listApiAccounts()[0]?.enabled).toBe(true);
});
it('passes keys in child environments only and removes conflicting Claude credentials', () => {
  const account = saveApiAccount(input), claude = saveApiAccount({ ...input, provider: 'anthropic' });
  selectApiAccount(account.id); selectApiAccount(claude.id);
  expect(apiAccountEnvironment('openai', { OPENAI_API_KEY: 'old-openai', CODEX_API_KEY: 'old-codex' })['CODEX_MANAGER_OPENAI_API_KEY']).toBe(input.apiKey);
  expect(apiAccountEnvironment('openai', { OPENAI_API_KEY: 'old-openai', CODEX_API_KEY: 'old-codex' })).not.toHaveProperty('OPENAI_API_KEY');
  expect(apiAccountEnvironment('openai', { OPENAI_API_KEY: 'old-openai', CODEX_API_KEY: 'old-codex' })).not.toHaveProperty('CODEX_API_KEY');
  expect(apiAccountCodexArgs().join(' ')).toContain('requires_openai_auth=false');
  expect(apiAccountCodexArgs().join(' ')).not.toContain(input.apiKey);
  const source = { ANTHROPIC_AUTH_TOKEN: 'native-token', CLAUDE_CODE_OAUTH_TOKEN: 'native-oauth', CLAUDE_CODE_USE_BEDROCK: '1' };
  expect(apiAccountEnvironment('anthropic', source)).toEqual({ ANTHROPIC_API_KEY: input.apiKey, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' });
  expect(source.ANTHROPIC_AUTH_TOKEN).toBe('native-token');
});
it('keeps a pending turn bound to its selected credentials across account switches and removals', async () => {
  const first = saveApiAccount(input), second = saveApiAccount({ ...input, apiKey: 'replacement-key' });
  selectApiAccount(first.id);
  let release!: () => void;
  const pending = withApiAccountRuntime(async () => {
    await new Promise<void>(resolve => { release = resolve; });
    expect(activeApiAccount('openai')?.id).toBe(first.id);
    expect(apiAccountEnvironment('openai', {})['CODEX_MANAGER_OPENAI_API_KEY']).toBe(input.apiKey);
  });
  selectApiAccount(second.id); removeApiAccount(first.id); release(); await pending;
  expect(activeApiAccount('openai')?.id).toBe(second.id);
});
it('imports API-only Codex auth and Claude settings, deduplicates, and leaves native credentials untouched', async () => {
  const auth = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: input.apiKey });
  await writeFile(path.join(root, 'auth.json'), auth);
  await mkdir(path.join(root, 'claude')); await writeFile(path.join(root, 'claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'test-claude-secret' } }));
  expect(await importCurrentApiAccounts()).toHaveLength(2);
  expect(await importCurrentApiAccounts()).toHaveLength(2); expect(listApiAccounts()).toHaveLength(2);
  expect(activeApiAccount('openai')?.id).toBeDefined();
  const { readFile } = await import('fs/promises'); expect(await readFile(path.join(root, 'auth.json'), 'utf8')).toBe(auth);
});
it('uses inherited keys over settings and never executes a key helper', async () => {
  await mkdir(path.join(root, 'claude')); await writeFile(path.join(root, 'claude/settings.json'), JSON.stringify({ apiKeyHelper: 'do-not-run', env: { ANTHROPIC_API_KEY: 'settings-key' } }));
  vi.stubEnv('ANTHROPIC_API_KEY', 'inherited-key');
  const imported = await importCurrentApiAccounts(); expect(apiAccountCredential(imported[0]!)).toBe('inherited-key');
});
it('imports the selected Manager API account without replacing its label or native credentials', async () => {
  const account = saveApiAccount(input); selectApiAccount(account.id);
  await writeFile(path.join(root, 'config.toml'), 'this is not valid provider configuration');
  expect(await importCurrentApiAccounts()).toMatchObject([{ id: account.id, name: input.name }]);
  expect(listApiAccounts()).toHaveLength(1); expect(activeApiAccount('openai')?.id).toBe(account.id);
});
it('imports configured Codex provider environment keys and the matching endpoint', async () => {
  vi.stubEnv('CUSTOM_API_KEY', 'custom-api-secret');
  await writeFile(path.join(root, 'config.toml'), 'model_provider = "gateway"\n[model_providers.gateway]\nenv_key = "CUSTOM_API_KEY"\nbase_url = "https://gateway.example.test/v1"\n');
  const imported = await importCurrentApiAccounts();
  expect(imported[0]?.baseUrl).toBe('https://gateway.example.test/v1'); expect(apiAccountCredential(imported[0]!)).toBe('custom-api-secret');
});
it('keeps malformed credential imports atomic and preserves the existing native fallback', async () => {
  expect(await importCurrentApiAccounts()).toEqual([]);
  vi.stubEnv('OPENAI_API_KEY', input.apiKey);
  await mkdir(path.join(root, 'claude')); await writeFile(path.join(root, 'claude/settings.json'), '{invalid');
  await expect(importCurrentApiAccounts()).rejects.toThrow('could not be read'); expect(listApiAccounts()).toEqual([]);
});
it('validates with a bounded request without redirects or leaking upstream error text', async () => {
  const account = saveApiAccount(input), fetch = vi.fn().mockResolvedValue(new Response('echo-secret', { status: 401 }));
  vi.stubGlobal('fetch', fetch);
  await expect(validateApiAccount(account)).rejects.toThrow('HTTP 401');
  expect(fetch).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal), headers: { Authorization: `Bearer ${input.apiKey}` } }));
  fetch.mockRejectedValueOnce(new Error(input.apiKey));
  await expect(validateApiAccount(account)).rejects.toThrow('could not connect or timed out');
  expect(listApiAccounts()).toHaveLength(1);
  fetch.mockResolvedValueOnce(new Response('{}', { status: 200 })); await expect(validateApiAccount(account)).resolves.toBeUndefined();
});
it('validates Anthropic accounts against the provider base path without double-prefixing /v1', async () => {
  const defaultAccount = saveApiAccount({ provider: 'anthropic', name: 'Claude default', apiKey: 'test-claude-secret' });
  const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await expect(validateApiAccount(defaultAccount)).resolves.toBeUndefined();
  expect(fetch).toHaveBeenLastCalledWith('https://api.anthropic.com/v1/models', expect.objectContaining({ redirect: 'error', headers: { 'x-api-key': 'test-claude-secret', 'anthropic-version': '2023-06-01' } }));

  const gateway = saveApiAccount({ provider: 'anthropic', name: 'Claude gateway', apiKey: 'test-claude-gateway', baseUrl: 'https://gateway.example.test/v1/' });
  await expect(validateApiAccount(gateway)).resolves.toBeUndefined();
  expect(fetch).toHaveBeenLastCalledWith('https://gateway.example.test/v1/models', expect.objectContaining({ headers: { 'x-api-key': 'test-claude-gateway', 'anthropic-version': '2023-06-01' } }));
});

it('shows failed verification on the API card and clears it after a successful retry', async () => {
  const account = saveApiAccount(input);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('private upstream body', {status:401})).mockResolvedValueOnce(new Response('{}')));
  await expect(validateApiAccount(account)).rejects.toThrow('HTTP 401');
  expect(apiDashboardAccounts()[0]).toMatchObject({healthKind:'refresh_failed',healthLabel:'API key check failed',healthMessage:expect.stringContaining('HTTP 401')});
  expect(JSON.stringify(apiDashboardAccounts())).not.toContain('private upstream body');
  await validateApiAccount(account);
  expect(apiDashboardAccounts()[0]).toMatchObject({healthKind:'healthy',healthLabel:'API key verified',healthMessage:undefined});
});

it('uses the existing automatic refresh gap and skips disabled API accounts', async () => {
  saveApiAccount(input);
  const disabled = saveApiAccount({...input, apiKey:'disabled-test-key'});
  setApiAccountEnabled(disabled.id,false);
  const request=vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch',request);
  await refreshApiAccounts(undefined,60000);
  expect(request).toHaveBeenCalledTimes(1);
  await refreshApiAccounts(undefined,60000);
  expect(request).toHaveBeenCalledTimes(1);
  await refreshApiAccounts();
  expect(request).toHaveBeenCalledTimes(2);
});

it('editing a disabled API account does not implicitly select or enable it',async()=>{
  const account=saveApiAccount(input);const disabled=setApiAccountEnabled(account.id,false);
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{}')));
  const edited=await saveValidatedApiAccount({...input,apiKey:'replacement-disabled-key'},disabled.id,disabled.updatedAt);
  expect(edited.enabled).toBe(false);expect(activeApiAccount('openai')).toBeUndefined();
});
