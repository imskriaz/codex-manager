import { createHash } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getSqliteStateStore } from '../storage/sqliteState';
import { getCodexHome, readAuthFile } from '../codex/authFile';
import { normalizeApiAccount, type ApiAccount, type ApiAccountInput, type ApiAccountProvider } from '../domain/apiAccounts';
import { runWithConcurrencyLimit, waitWithin } from '../utils/concurrency';

const namespace = 'api-accounts';
const runtime = new AsyncLocalStorage<{ accounts: Partial<Record<ApiAccountProvider, ApiAccount>>; keys: Map<string, string> }>();
export const hasApiAccountRuntime = () => runtime.getStore() !== undefined;
export function withApiAccountRuntime<T>(task: () => T): T {
  if (hasApiAccountRuntime()) return task();
  const accounts = { openai: activeApiAccount('openai'), anthropic: activeApiAccount('anthropic') };
  const keys = new Map(Object.values(accounts).flatMap(account => account ? [[account.id, apiAccountCredential(account)] as const] : []));
  return runtime.run({ accounts, keys }, task);
}
const scope = () => createHash('sha256').update(getCodexHome()).digest('hex');
const activeKey = (provider: ApiAccountProvider) => `${scope()}:${provider}`;
function storage() { const store = getSqliteStateStore(); if (!store) throw new Error('API account storage is unavailable. Retry after the host starts.'); return store; }
export const isApiAccountId = (id: string) => /^api:(openai|anthropic):[a-f0-9]{64}$/.test(id);
export function listApiAccounts(): ApiAccount[] { const store = getSqliteStateStore(); return store ? store.keys(namespace).flatMap(id => store.get<ApiAccount>(namespace, id) ?? []) : []; }
export function activeApiAccount(provider: ApiAccountProvider): ApiAccount | undefined {
  const captured = runtime.getStore();
  if (captured) return captured.accounts[provider];
  const store = getSqliteStateStore(), id = store?.get<string>('api-account-selection', activeKey(provider));
  return id ? store?.get<ApiAccount>(namespace, id) : undefined;
}
export function apiAccountIdentity(provider: ApiAccountProvider): string { const account = activeApiAccount(provider); return account ? `${account.id}:${account.updatedAt}` : 'native'; }
export function apiAccountCredential(account: ApiAccount): string {
  const key = runtime.getStore()?.keys.get(account.id) ?? storage().get<string>('secrets', account.id);
  if (!key) throw new Error('This API account has no stored key. Remove it and add it again.');
  return key;
}
export function saveApiAccount(input: ApiAccountInput): ApiAccount {
  const normalized = normalizeApiAccount(input), store = storage();
  const id = `api:${normalized.provider}:` + createHash('sha256').update(JSON.stringify([normalized.apiKey, normalized.baseUrl])).digest('hex');
  const previous = store.get<ApiAccount>(namespace, id), now = Date.now();
  const account: ApiAccount = { id, provider: normalized.provider, name: normalized.name, baseUrl: normalized.baseUrl, createdAt: previous?.createdAt ?? now, updatedAt: Math.max(now, (previous?.updatedAt ?? 0) + 1), enabled: previous?.enabled !== false, queuePriority: previous?.queuePriority === true };
  store.transaction(() => {
    store.set('secrets', id, normalized.apiKey);
    store.set(namespace, id, account);
    // Treat the first account for a provider like the first native login:
    // it becomes the current account immediately. Existing selections are
    // preserved when adding another account.
    if (!store.get<string>('api-account-selection', activeKey(normalized.provider)))
      store.set('api-account-selection', activeKey(normalized.provider), id);
  });
  return account;
}
export function selectApiAccount(id: string): ApiAccount {
  const account = storage().get<ApiAccount>(namespace, id);
  if (!account) throw new Error('That API account no longer exists. Refresh and retry.');
  if (account.enabled === false) throw new Error('That API account is disabled. Enable it before selecting it.');
  apiAccountCredential(account);
  storage().set('api-account-selection', activeKey(account.provider), id);
  return account;
}
export function setApiAccountEnabled(id: string, enabled: boolean): ApiAccount {
  const store = storage();
  const account = store.get<ApiAccount>(namespace, id);
  if (!account) throw new Error('That API account no longer exists. Refresh and retry.');
  const updated = { ...account, enabled, updatedAt: Math.max(Date.now(), account.updatedAt + 1) };
  store.transaction(() => {
    store.set(namespace, id, updated);
    if (!enabled && store.get<string>('api-account-selection', activeKey(account.provider)) === id) store.set('api-account-selection', activeKey(account.provider), undefined);
  });
  return updated;
}
export function setApiAccountQueuePriority(id: string, queuePriority: boolean): ApiAccount {
  const store = storage(), account = store.get<ApiAccount>(namespace, id);
  if (!account) throw new Error('That API account no longer exists. Refresh and retry.');
  const updated = { ...account, queuePriority, updatedAt: Math.max(Date.now(), account.updatedAt + 1) };
  store.set(namespace, id, updated);
  return updated;
}
export function clearApiAccountSelection(provider: ApiAccountProvider): void { getSqliteStateStore()?.set('api-account-selection', activeKey(provider), undefined); }
export function removeApiAccount(id: string): void {
  const store = storage();
  store.transaction(() => {
    for (const key of store.keys('api-account-selection')) if (store.get('api-account-selection', key) === id) store.set('api-account-selection', key, undefined);
    // Keep the secret tombstone so a retained legacy SecretStorage value cannot
    // reappear during a later migration pass.
    store.set('secrets', id, null); store.set(namespace, id, undefined);
  });
}

/** Validation never follows redirects or includes upstream text that could echo a key. */
export async function validateApiAccount(account: ApiAccount, signal = AbortSignal.timeout(10_000)): Promise<void> {
  try {
    const key = apiAccountCredential(account);
    await testApiAccount(account, key, signal);
    storage().set('api-account-validation', account.id, { revision: account.updatedAt, checkedAt: Date.now() });
  } catch (error) {
    storage().set('api-account-validation', account.id, { revision: account.updatedAt, checkedAt: Date.now(), error: error instanceof Error ? error.message : 'API key verification failed.' });
    throw error;
  }
}

export function apiAccountValidation(account: ApiAccount): { checkedAt: number; error?: string } | undefined {
  const result = getSqliteStateStore()?.get<{ revision: number; checkedAt: number; error?: string }>('api-account-validation', account.id);
  return result?.revision === account.updatedAt ? result : undefined;
}

export async function refreshApiAccounts(ids?: string[], gapMs = 0): Promise<import('../domain/dashboard/types').DashboardBatchResult> {
  const accounts = listApiAccounts().filter(account => ids ? ids.includes(account.id) : account.enabled !== false);
  const result: import('../domain/dashboard/types').DashboardBatchResult = { kind: 'batch_refresh', successCount: 0, failedCount: 0, failures: [] };
  await runWithConcurrencyLimit(accounts.filter(account => Date.now() - (apiAccountValidation(account)?.checkedAt ?? 0) >= gapMs), 3, async account => {
    try { await validateApiAccount(account); result.successCount++; }
    catch (error) {
      if (!apiAccountValidation(account)?.error) throw error;
      result.failedCount++;
      result.failures.push({ accountId: account.id, message: apiAccountValidation(account)!.error! });
    }
  });
  return result;
}

export async function saveValidatedApiAccount(input: ApiAccountInput, previousId?: string, revision?: number): Promise<ApiAccount> {
  const store = storage(), previous = previousId ? store.get<ApiAccount>(namespace, previousId) : undefined;
  if (previousId && (!previous || previous.updatedAt !== revision)) throw new Error('This API account changed. Reopen its details before saving.');
  if (previous && input.provider !== previous.provider) throw new Error('Add a new account to change providers.');
  const account = normalizeApiAccount(previous && !input.apiKey ? { ...input, apiKey: apiAccountCredential(previous) } : input);
  await testApiAccount(account, account.apiKey, AbortSignal.timeout(10_000));
  return store.transaction(() => {
    if (previous && store.get<ApiAccount>(namespace, previous.id)?.updatedAt !== previous.updatedAt) throw new Error('This API account changed during verification. Reopen its details before saving.');
    const newId = `api:${account.provider}:` + createHash('sha256').update(JSON.stringify([account.apiKey, account.baseUrl])).digest('hex');
    if (previous && newId !== previous.id && store.get(namespace, newId)) throw new Error('These credentials already belong to another API account. Select that account instead.');
    const selection = store.get<string>('api-account-selection', activeKey(account.provider));
    let saved = saveApiAccount(account);
    if (previous) {
      saved = { ...saved, enabled: previous.enabled, queuePriority: previous.queuePriority, createdAt: previous.createdAt };
      store.set(namespace, saved.id, saved);
      store.set('api-account-selection', activeKey(saved.provider), selection === previous.id ? saved.id : selection);
      if (saved.id !== previous.id) removeApiAccount(previous.id);
    }
    store.set('api-account-validation', saved.id, { revision: saved.updatedAt, checkedAt: Date.now() });
    return saved;
  });
}

async function testApiAccount(account: Pick<ApiAccount, 'provider' | 'baseUrl'>, key: string, signal: AbortSignal): Promise<void> {
  const modelsPath = account.provider === 'openai'
    ? '/models'
    : account.baseUrl.toLowerCase().endsWith('/v1') ? '/models' : '/v1/models';
  let response: Response;
  try { response = await fetch(`${account.baseUrl}${modelsPath}`, { signal, redirect: 'error', headers: account.provider === 'openai' ? { Authorization: `Bearer ${key}` } : { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }); }
  catch { throw new Error('API validation could not connect or timed out. Check the endpoint and retry.'); }
  await response.body?.cancel();
  if (!response.ok) throw new Error(`API validation failed (HTTP ${response.status}). Check the key, endpoint and provider permissions.`);
}

async function optionalJson(file: string): Promise<Record<string, unknown>> {
  try {
    if ((await fs.stat(file)).size > 1024 * 1024) throw new Error('Credential settings are too large to import.');
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Credential settings must be a JSON object.');
    return value as Record<string, unknown>;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('Current API credential settings could not be read. Fix the settings file and retry.'); }
}
const string = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
/** Read credential source names only; importing never executes auth commands or key helpers. */
async function codexApiConfig(): Promise<{ envKey?: string; baseUrl?: string }> {
  let raw: string;
  try { const file = path.join(getCodexHome(), 'config.toml'); if ((await fs.stat(file)).size > 1024 * 1024) throw new Error('Too large'); raw = await fs.readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('Codex API configuration could not be read. Fix config.toml and retry.'); }
  const values = new Map<string, Map<string, string>>(); let table = '';
  for (const line of raw.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]/);
    if (section) { table = section[1]!.trim().replace(/"([\w-]+)"/g, '$1'); continue; }
    const match = line.match(/^\s*([\w-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
    if (!match) continue;
    let value: string; try { value = match[2]!.startsWith('"') ? JSON.parse(match[2]!) as string : match[2]!.slice(1, -1); } catch { continue; }
    if (!values.has(table)) values.set(table, new Map()); values.get(table)!.set(match[1]!, value);
  }
  const provider = values.get('')?.get('model_provider');
  const settings = provider ? values.get(`model_providers.${provider}`) : undefined;
  return { envKey: settings?.get('env_key'), baseUrl: settings?.get('base_url') ?? values.get('')?.get('openai_base_url') };
}
export async function importCurrentApiAccounts(project?: string): Promise<ApiAccount[]> {
  const found: ApiAccountInput[] = [];
  const selectedOpenai = activeApiAccount('openai');
  // A selected Manager API account is already the authoritative Codex source;
  // do not let an unrelated broken auth/config file block importing it.
  const [auth, config] = await Promise.all([
    selectedOpenai ? Promise.resolve(undefined) : waitWithin(readAuthFile(), 2_000, 'Current Codex credentials could not be read within 2 seconds. Retry.'),
    selectedOpenai ? Promise.resolve({} as { envKey?: string; baseUrl?: string }) : waitWithin(codexApiConfig(), 2_000, 'Current Codex configuration could not be read within 2 seconds. Retry.')
  ]);
  const openai = selectedOpenai ? apiAccountCredential(selectedOpenai) : config.envKey ? string(process.env[config.envKey]) : string(process.env['CODEX_API_KEY']) ?? string(process.env['OPENAI_API_KEY']) ?? string(auth?.OPENAI_API_KEY);
  if (config.envKey && !openai) throw new Error('The configured Codex API key variable is unavailable to this host. Start Manager from the same environment, or add the key manually.');
  if (openai) found.push({ provider: 'openai', name: selectedOpenai?.name ?? 'OpenAI API (imported)', apiKey: openai, baseUrl: selectedOpenai?.baseUrl ?? config.baseUrl ?? string(process.env['OPENAI_BASE_URL']) ?? auth?.api_base_url ?? auth?.base_url });
  const home = path.resolve(process.env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude'));
  let env: Record<string, unknown> = {};
  for (const file of [path.join(home, 'settings.json'), ...(project ? [path.join(project, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.local.json')] : [])]) {
    const settings = await waitWithin(optionalJson(file), 2_000, 'Current Claude API settings could not be read within 2 seconds. Retry.');
    if (settings['env'] && typeof settings['env'] === 'object' && !Array.isArray(settings['env'])) env = { ...env, ...settings['env'] };
  }
  const selectedClaude = activeApiAccount('anthropic');
  const anthropic = selectedClaude ? apiAccountCredential(selectedClaude) : string(process.env['ANTHROPIC_API_KEY']) ?? string(env['ANTHROPIC_API_KEY']);
  if (anthropic) found.push({ provider: 'anthropic', name: selectedClaude?.name ?? 'Claude API (imported)', apiKey: anthropic, baseUrl: selectedClaude?.baseUrl ?? string(process.env['ANTHROPIC_BASE_URL']) ?? string(env['ANTHROPIC_BASE_URL']) });
  // Validate every source before committing, so malformed settings cannot leave a partial import.
  found.forEach(normalizeApiAccount);
  return found.length ? storage().transaction(() => found.map(saveApiAccount)) : [];
}

export function apiAccountEnvironment(provider: ApiAccountProvider, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const account = activeApiAccount(provider);
  if (!account) return { ...source };
  const env = { ...source };
  if (provider === 'openai') {
    // The inline Codex provider is the authority for this turn. Do not let a
    // process-level key silently win over the selected account.
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[key];
    env['CODEX_MANAGER_OPENAI_API_KEY'] = apiAccountCredential(account);
  }
  else {
    for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[key];
    env['ANTHROPIC_API_KEY'] = apiAccountCredential(account); env['ANTHROPIC_BASE_URL'] = account.baseUrl;
  }
  return env;
}
export function apiAccountCodexArgs(): string[] {
  const account = activeApiAccount('openai');
  return account ? ['-c', 'model_provider="manager_api"', '-c', `model_providers.manager_api={name="Manager API",base_url=${JSON.stringify(account.baseUrl)},env_key="CODEX_MANAGER_OPENAI_API_KEY",wire_api="responses",requires_openai_auth=false}`] : [];
}
