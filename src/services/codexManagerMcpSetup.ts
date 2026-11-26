import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { getCodexHome, getCodexHomeStateKey } from '../codex/authFile';
import { getCodexManagerConfiguration } from '../infrastructure/config/extensionSettings';
import { runCrossWindowExclusive } from '../utils/crossWindowOperations';
import { resolveNodeExecutable } from '../utils/relayStartup';
import { discoverBundledCodexCli } from './codexCliRuntime';
import { getCodexManagerStorageRoot } from '../utils/storageRoot';

type Registration = { command: string; args: string[]; tokenId?: string; transport?: 'local' };
type McpEntry = { name: string; enabled?: boolean; transport?: { command?: string; args?: string[]; env?: Record<string, string> } };

function runCli(command: string, args: string[], home: string): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, {
    cwd: home, env: { ...process.env, CODEX_HOME: home }, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024
  }, (error, stdout) => error ? reject(new Error('Codex MCP configuration command failed. Check that Codex config.toml is valid and writable.')) : resolve(stdout)));
}

/** Use Codex's own config writer so other servers, comments and settings survive. */
export async function setupCodexManagerMcp(context: vscode.ExtensionContext, automatic = false): Promise<string> {
  const config = getCodexManagerConfiguration();
  if (automatic && !config.get<boolean>('mcpAutoSetupEnabled', false)) return 'Automatic MCP setup is disabled.';
  const home = getCodexHome();
  const key = `codexManager.mcp.${getCodexHomeStateKey(home)}`;
  return runCrossWindowExclusive('config:codex-manager-mcp', 'Codex Manager MCP setup', async () => {
    await fs.mkdir(home, { recursive: true });
    const candidates = await discoverBundledCodexCli();
    let cli: string | undefined;
    for (const candidate of candidates) {
      if (await fs.access(candidate).then(() => true, () => false)) { cli = candidate; break; }
    }
    if (!cli) throw new Error('Install or update the official Codex extension, then run Codex Manager: Set Up MCP.');
    const entries: unknown = JSON.parse(await runCli(cli, ['mcp', 'list', '--json'], home));
    if (!Array.isArray(entries)) throw new Error('Codex returned an invalid MCP server list. Existing configuration was preserved.');
    const entry = (entries as McpEntry[]).find(item => item.name === 'codex-manager');
    const previous = context.globalState.get<Registration>(key);
    const token = await context.secrets.get(key);
    if (entry?.enabled === false) return 'The existing Codex Manager MCP entry is disabled. Enable it in Codex to use it.';
    if (entry && (!previous || entry.transport?.command !== previous.command || JSON.stringify(entry.transport?.args) !== JSON.stringify(previous.args) || (previous.transport === 'local' ? Boolean(entry.transport?.env?.['CODEX_MANAGER_URL'] || entry.transport?.env?.['CODEX_MANAGER_TOKEN']) : entry.transport?.env?.['CODEX_MANAGER_TOKEN'] !== token))) {
      return 'An existing user-managed Codex Manager MCP entry was preserved. Check its connection in Codex.';
    }
    const command = await resolveNodeExecutable();
    const args = [path.join(context.extensionPath, 'tools', 'codex-manager-mcp.mjs')];
    await fs.access(args[0]!);
    const current = entry?.transport;
    const storageRoot = getCodexManagerStorageRoot();
    if (current?.command !== command || JSON.stringify(current?.args) !== JSON.stringify(args) ||
        current?.env?.['CODEX_MANAGER_URL'] || current?.env?.['CODEX_MANAGER_TOKEN'] ||
        current?.env?.['CODEX_MANAGER_TRANSPORT'] !== 'local' || current?.env?.['CODEX_MANAGER_STORAGE_ROOT'] !== storageRoot) {
      await runCli(cli, ['mcp', 'add', 'codex-manager', '--env', 'CODEX_MANAGER_TRANSPORT=local', '--env', `CODEX_MANAGER_STORAGE_ROOT=${storageRoot}`, '--', command, ...args], home);
    }
    await context.globalState.update(key, { command, args, transport: 'local' } satisfies Registration);
    // Existing tokens may still serve open sessions; no token is created or required here.
    return 'Codex Manager MCP is configured for new Codex sessions through the local transport. No API token is required.';
  });
}

export function registerCodexManagerMcpSetup(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('codexManager.setupMcp', async () => {
    try { void vscode.window.showInformationMessage(await setupCodexManagerMcp(context)); }
    catch (error) { void vscode.window.showErrorMessage(`Codex Manager MCP setup failed: ${error instanceof Error ? error.message : String(error)}`); }
  }));
}
