import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { resolveClaudeCliExecutable } from './claudeCliRuntime';
import { installManagedClaudeCli, installManagedCodexCli, resolveCodexNpmBinary } from './codexCliRuntime';
import { resolveCodexCliExecutable } from './codexSessionResume';
import type { WorkspaceRuntime } from '../domain/dashboard/types';
import { waitWithin } from '../utils/concurrency';
import { getCodexManagerConfiguration } from '../infrastructure/config/extensionSettings';
import { runCrossWindowExclusive } from '../utils/crossWindowOperations';
import { updateConfigurationBatch } from '../storage/sqliteContext';
import { getSqliteStateStore } from '../storage/sqliteState';

type Provider = 'codex' | 'claude';
const pending = new Map<Provider, Promise<WorkspaceRuntime>>();
const label = (provider: Provider) => provider === 'codex' ? 'Codex' : 'Claude Code';
const quote = (value: string) => process.platform === 'win32' ? "'" + value.replace(/'/g, "''") + "'" : "'" + value.replace(/'/g, "'\\''") + "'";

/** Preserve previously working providers without installing anything at startup. */
export async function migrateWorkspaceRuntimeModules(providers: Provider[]): Promise<void> {
  const store = getSqliteStateStore();
  for (const provider of providers) {
    const intent = store?.get('runtime', `${provider}-module-intent`);
    try {
      const runtime = await inspectRuntime(provider);
      if (!runtime.available || pending.has(provider) || intent !== store?.get('runtime', `${provider}-module-intent`)) continue;
      await getCodexManagerConfiguration().update(`${provider}ModuleEnabled`, true, vscode.ConfigurationTarget.Global);
    } catch (error) { console.warn(`[codexManager] ${label(provider)} module needs setup; saved conversations were kept`, error); }
  }
}

export async function manageWorkspaceRuntime(provider: Provider, operation: 'check' | 'enable'): Promise<WorkspaceRuntime> {
  if (operation === 'check') return inspectRuntime(provider);
  const existing = pending.get(provider);
  if (existing) return existing;
  const setup = runCrossWindowExclusive(`runtime:${provider}-module-setup`, `${label(provider)} module setup`, async signal => {
    const store = getSqliteStateStore();
    const revision = store?.get('runtime', `${provider}-module-intent`);
    let runtime = await inspectRuntime(provider);
    const reused = runtime.available;
    if (!runtime.available) {
      const installed = await (provider === 'claude' ? installManagedClaudeCli() : installManagedCodexCli());
      runtime = await verifyRuntime(provider, installed);
    }
    signal.throwIfAborted();
    if (revision !== store?.get('runtime', `${provider}-module-intent`)) throw new Error('Module settings changed during setup. The runtime was kept, but the module was not enabled. Review Settings before retrying.');
    const config = getCodexManagerConfiguration();
    await updateConfigurationBatch(config, [['cliIntegrationEnabled', true], [`${provider}ModuleEnabled`, true]]);
    if (!config.get<boolean>(`${provider}ModuleEnabled`, false)) throw new Error(`${label(provider)} was verified, but enabling the module was not confirmed. Refresh Settings before retrying.`);
    return { ...runtime, enabled: true, message: `${label(provider)} module enabled. ${reused ? 'Existing runtime verified and reused.' : 'Runtime downloaded separately and verified.'} Sign in on this host if needed, then refresh the model list.` };
  }, { waitMs: 2_000 }).finally(() => pending.delete(provider));
  pending.set(provider, setup);
  return setup;
}

async function inspectRuntime(provider: Provider): Promise<WorkspaceRuntime> {
  let executable: string | undefined;
  if (provider === 'claude') executable = await waitWithin(resolveClaudeCliExecutable(), 2_000, 'Claude detection timed out. Retry before downloading.');
  else {
    try {
      const cli = await waitWithin(resolveCodexCliExecutable(), 5_000, 'Codex detection timed out. Retry before downloading.');
      if (cli.shell) throw new Error('The Codex launcher requires a shell. Set CODEX_CLI_PATH to its native executable or JavaScript entry before enabling it.');
      executable = cli.prefixArgs[0] ?? cli.command;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('Codex CLI was not found on this PC.')) throw error;
    }
  }
  return executable ? verifyRuntime(provider, executable) : { provider, available: false, message: `${label(provider)} was not found on this host. Enable the module to install it separately.` };
}

async function verifyRuntime(provider: Provider, original: string): Promise<WorkspaceRuntime> {
  const executable = provider === 'codex' ? await resolveCodexNpmBinary(original) : original;
  const script = /\.(?:c?js|mjs)$/i.test(executable);
  const version = await new Promise<string>((resolve, reject) => execFile(script ? process.execPath : executable, [...(script ? [executable] : []), '--version'], {
    windowsHide: true, timeout: 5_000, maxBuffer: 128 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  }, (error, stdout) => {
    if (error) reject(new Error(`${label(provider)} could not be verified. Setup did not enable the module. ${error.message}`, { cause: error }));
    else if (!/\d+\.\d+\.\d+/.test(stdout)) reject(new Error(`${label(provider)} returned no recognizable version. Check its installation before retrying.`));
    else resolve(stdout.trim());
  }));
  const command = script ? `node ${quote(executable)}` : `${process.platform === 'win32' ? '& ' : ''}${quote(executable)}`;
  return { provider, available: true, executable, version, loginCommand: `${command} ${provider === 'claude' ? 'auth login' : 'login'}`, message: `${label(provider)} verified on this host (${version}). Sign-in may still be required.` };
}
