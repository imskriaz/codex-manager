import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import type * as SDK from '@anthropic-ai/claude-agent-sdk';
import { createClaudeModelOptions } from '../domain/dashboard/claudeModels';
import type { DashboardCliModelOption } from '../domain/dashboard/types';
import { waitWithin } from '../utils/concurrency';
import { activeApiAccount, apiAccountCredential, apiAccountEnvironment, apiAccountIdentity } from './apiAccounts';
import { managedClaudeCli } from './codexCliRuntime';
import { isRuntimeModuleEnabled } from '../infrastructure/config/extensionSettings';

// The supported Node 22.13+ host can load the native SDK's synchronous ESM graph.
const nativeRequire = createRequire(__filename);
let sdk: Promise<typeof SDK> | undefined;
export function claudeSdk(): Promise<typeof SDK> {
  return sdk ??= Promise.resolve().then(() => nativeRequire('@anthropic-ai/claude-agent-sdk') as typeof SDK);
}
export function claudeConfigHome(): string { return path.resolve(process.env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude')); }
export function claudeAccountKey(account?: Pick<SDK.AccountInfo, 'email' | 'organization' | 'apiProvider'>): string | undefined {
  return account?.email ? createHash('sha256').update(JSON.stringify([claudeConfigHome(), account.email, account.organization, account.apiProvider])).digest('hex') : undefined;
}

export function getClaudeCliPathCandidates(platform = process.platform, env = process.env): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const roots = [...(env['PATH'] ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)];
  if (platform === 'win32') roots.unshift(p.join(env['APPDATA'] || p.join(os.homedir(), 'AppData', 'Roaming'), 'npm'));
  const candidates = [env['CLAUDE_CLI_PATH'], p.join(os.homedir(), '.local', 'bin', platform === 'win32' ? 'claude.exe' : 'claude')];
  for (const root of roots) {
    // Resolve npm shims to the native executable; never invoke a shell with user prompts.
    candidates.push(p.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), p.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'), p.join(root, platform === 'win32' ? 'claude.exe' : 'claude'));
  }
  return [...new Set(candidates.filter((candidate): candidate is string => !!candidate))];
}

export async function resolveClaudeCliExecutable(): Promise<string | undefined> {
  for (const candidate of [...getClaudeCliPathCandidates(), managedClaudeCli()].filter((value): value is string => !!value)) {
    if (/\.(?:cmd|bat|ps1)$/i.test(candidate)) continue;
    if (await fs.stat(candidate).then(stat => stat.isFile()).catch(() => false)) return candidate;
  }
  return undefined;
}

export function claudeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env['CLAUDECODE'];
  return apiAccountEnvironment('anthropic', env);
}

type ClaudeConnection = { models: DashboardCliModelOption[]; warning?: string; account?: Pick<SDK.AccountInfo, 'email' | 'organization' | 'subscriptionType' | 'apiProvider'> };
const connectionKey = () => JSON.stringify([claudeConfigHome(), process.env['CLAUDE_CLI_PATH'], process.env['PATH'], managedClaudeCli(), isRuntimeModuleEnabled('claude'), apiAccountIdentity('anthropic')]);
let cached: ClaudeConnection & { key: string } | undefined;
let discovery: { key: string; pending: Promise<ClaudeConnection> } | undefined;
export async function verifyClaudeHaiku(connection: AsyncIterable<SDK.SDKMessage>): Promise<void> {
  await waitWithin((async () => {
    for await (const message of connection) {
      if (message.type !== 'result') continue;
      if (message.is_error) throw new Error('Claude Haiku verification failed. Check the Claude login or API key and refresh.');
      return;
    }
    throw new Error('Claude Haiku verification ended without a confirmed response.');
  })(), 15_000, 'Claude Haiku verification timed out. Refresh to retry.');
}
export function cachedClaudeConnection(): ClaudeConnection | undefined { return cached?.key === connectionKey() ? cached : undefined; }
export async function discoverClaudeModels(refresh = false): Promise<ClaudeConnection> {
  if (!isRuntimeModuleEnabled('claude')) return { models: [] };
  const key = connectionKey();
  if (refresh) cached = undefined;
  if (cached?.key === key) return cached;
  if (discovery?.key === key) return discovery.pending;
  const pending = (async () => {
    const controller = new AbortController();
    let connection: SDK.Query | undefined;
    try {
      const executable = await waitWithin(resolveClaudeCliExecutable(), 1_000, 'Claude detection timed out.');
      if (!executable) return { models: [] };
      const native = await claudeSdk();
      connection = native.query({ prompt: 'Reply with OK only.', options: { pathToClaudeCodeExecutable: executable, cwd: process.cwd(), model: 'haiku', maxTurns: 1, tools: [],
        env: claudeEnvironment(), abortController: controller, persistSession: false, settingSources: ['user','project','local'] } });
      const info = await waitWithin(connection.initializationResult(), 5_000, 'Claude model discovery timed out. Refresh to retry.');
      // Model discovery only needs the initialization catalogue. A failed probe
      // turn must not hide models that the native runtime already reported.
      return { models: createClaudeModelOptions(info.models), account: { email: info.account?.email, organization: info.account?.organization, subscriptionType: info.account?.subscriptionType, apiProvider: info.account?.apiProvider } };
    } catch (error) { return { models: [], warning: `Claude models unavailable: ${error instanceof Error ? error.message : String(error)}` }; }
    finally { controller.abort(); connection?.close(); }
  })();
  discovery = { key, pending };
  try { const result = await pending; cached = { ...result, key }; return result; }
  finally { if (discovery?.key === key) discovery = undefined; }
}

/** Discover models from a configured Anthropic-compatible gateway without requiring native Claude login. */
export async function discoverClaudeApiModels(): Promise<ClaudeConnection> {
  const account = activeApiAccount('anthropic');
  if (!account) return { models: [] };
  try {
    const key = apiAccountCredential(account);
    const path = account.baseUrl.toLowerCase().endsWith('/v1') ? '/models' : '/v1/models';
    const response = await fetch(`${account.baseUrl}${path}`, {
      signal: AbortSignal.timeout(5_000), redirect: 'error',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    });
    if (!response.ok) throw new Error(`Gateway returned HTTP ${response.status}.`);
    const payload: unknown = await response.json();
    const rows = payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data) ? (payload as { data: unknown[] }).data : [];
    const models = createClaudeModelOptions(rows.flatMap(row => {
      if (!row || typeof row !== 'object') return [];
      const value = (row as { id?: unknown }).id;
      if (typeof value !== 'string') return [];
      const displayName = (row as { display_name?: unknown; name?: unknown }).display_name ?? (row as { name?: unknown }).name;
      return [{ value, displayName: typeof displayName === 'string' && displayName.trim() ? displayName : value }];
    }));
    return { models };
  } catch (error) {
    return { models: [], warning: `Claude gateway model discovery unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
