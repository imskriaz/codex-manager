import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import type * as SDK from '@anthropic-ai/claude-agent-sdk';
import { createClaudeModelOptions } from '../domain/dashboard/claudeModels';
import type { DashboardCliModelOption } from '../domain/dashboard/types';
import { waitWithin } from '../utils/concurrency';
import { apiAccountEnvironment } from './apiAccounts';
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
const infrastructureKeys = ['ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD'];
const customInfrastructureWarning = 'Custom Claude infrastructure is excluded from native Claude models. Add it as an API account instead.';
export function isCustomClaudeInfrastructure(env: Record<string, unknown>, provider?: string): boolean {
  if (provider && provider !== 'firstParty') return true;
  if (infrastructureKeys.slice(1).some(key => env[key] === '1' || env[key] === 'true')) return true;
  const base = env['ANTHROPIC_BASE_URL'];
  if (typeof base !== 'string' || !base.trim()) return false;
  try { const url = new URL(base); return url.origin !== 'https://api.anthropic.com' || !!url.username || !!url.password; }
  catch { return true; }
}
async function claudeInfrastructure(): Promise<{custom: boolean; signature: string}> {
  const files = [path.join(claudeConfigHome(), 'settings.json')], folders: string[] = [];
  for (let folder = process.cwd();; folder = path.dirname(folder)) {
    folders.unshift(folder);
    if (path.dirname(folder) === folder) break;
  }
  for (const folder of folders) for (const name of ['settings.json', 'settings.local.json']) files.push(path.join(folder, '.claude', name));
  const markers: Array<Record<string, unknown>> = [Object.fromEntries(infrastructureKeys.map(key => [key, process.env[key]]))];
  for (const file of new Set(files)) {
    try {
      if ((await fs.stat(file)).size > 1024 * 1024) throw new Error('Too large');
      const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings');
      const env = (value as {env?: Record<string, unknown>}).env;
      if (env && typeof env === 'object') markers.push(Object.fromEntries(infrastructureKeys.map(key => [key, env[key]])));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Claude infrastructure settings could not be checked. Review Claude settings and refresh models.');
    }
  }
  return {custom: markers.some(env => isCustomClaudeInfrastructure(env)), signature: createHash('sha256').update(JSON.stringify(markers)).digest('hex')};
}
const connectionKey = () => JSON.stringify([claudeConfigHome(), process.cwd(), process.env['CLAUDE_CLI_PATH'], process.env['PATH'], ...infrastructureKeys.map(key => process.env[key]), managedClaudeCli(), isRuntimeModuleEnabled('claude')]);
let cached: ClaudeConnection & { key: string; baseKey: string } | undefined;
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
export function cachedClaudeConnection(): ClaudeConnection | undefined { return cached?.baseKey === connectionKey() ? cached : undefined; }
export async function discoverClaudeModels(refresh = false): Promise<ClaudeConnection> {
  if (!isRuntimeModuleEnabled('claude')) return { models: [] };
  const baseKey = connectionKey();
  let infrastructure: Awaited<ReturnType<typeof claudeInfrastructure>>;
  try { infrastructure = await waitWithin(claudeInfrastructure(), 1_000, 'Claude infrastructure detection timed out. Refresh models to retry.'); }
  catch (error) { cached = undefined; return {models: [], warning: error instanceof Error ? error.message : 'Claude infrastructure detection failed.'}; }
  const key = JSON.stringify([baseKey, infrastructure.signature]);
  if (infrastructure.custom) {
    cached = {key, baseKey, models: [], warning: customInfrastructureWarning};
    return cached;
  }
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
      const env: NodeJS.ProcessEnv = {...process.env, ELECTRON_RUN_AS_NODE: '1'};
      delete env['CLAUDECODE'];
      connection = native.query({ prompt: 'Reply with OK only.', options: { pathToClaudeCodeExecutable: executable, cwd: process.cwd(), model: 'haiku', maxTurns: 1, tools: [],
        env, abortController: controller, persistSession: false, settingSources: ['user','project','local'] } });
      const info = await waitWithin(connection.initializationResult(), 5_000, 'Claude model discovery timed out. Refresh to retry.');
      if (isCustomClaudeInfrastructure({}, info.account?.apiProvider)) return {models: [], warning: customInfrastructureWarning};
      // Model discovery only needs the initialization catalogue. A failed probe
      // turn must not hide models that the native runtime already reported.
      return { models: createClaudeModelOptions(info.models), account: { email: info.account?.email, organization: info.account?.organization, subscriptionType: info.account?.subscriptionType, apiProvider: info.account?.apiProvider } };
    } catch (error) { return { models: [], warning: `Claude models unavailable: ${error instanceof Error ? error.message : String(error)}` }; }
    finally { controller.abort(); connection?.close(); }
  })();
  discovery = { key, pending };
  try { const result = await pending; cached = { ...result, key, baseKey }; return result; }
  finally { if (discovery?.key === key) discovery = undefined; }
}
