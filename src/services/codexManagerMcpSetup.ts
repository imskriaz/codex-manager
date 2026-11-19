import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { getCodexHome, getCodexHomeStateKey } from '../codex/authFile';
import { PROJECT_API_ACTIONS } from '../domain/dashboard/apiActions';
import { getCodexManagerConfiguration } from '../infrastructure/config/extensionSettings';
import { runCrossWindowExclusive } from '../utils/crossWindowOperations';
import { resolveNodeExecutable } from '../utils/relayStartup';
import { discoverBundledCodexCli } from './codexCliRuntime';
import { createDashboardApiToken, readDashboardApiToken, revokeDashboardApiToken } from './dashboardApiToken';

type Registration = { command: string; args: string[]; tokenId: string };
type McpEntry = { name: string; enabled?: boolean; transport?: { command?: string; args?: string[]; env?: Record<string, string> } };

function runCli(command: string, args: string[], home: string): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, {
    cwd: home, env: { ...process.env, CODEX_HOME: home }, windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024
  }, (error, stdout) => error ? reject(new Error('Codex MCP configuration command failed. Check that Codex config.toml is valid and writable.')) : resolve(stdout)));
}

/** Use Codex's own config writer so other servers, comments and settings survive. */
export async function setupCodexManagerMcp(context: vscode.ExtensionContext, automatic = false): Promise<string> {
  const config = getCodexManagerConfiguration();
  if (automatic && !config.get<boolean>('mcpAutoSetupEnabled', true)) return 'Automatic MCP setup is disabled.';
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
    let token = await context.secrets.get(key);
    if (entry?.enabled === false) return 'The existing Codex Manager MCP entry is disabled. Enable it in Codex to use it.';
    if (entry && (!previous || entry.transport?.command !== previous.command || JSON.stringify(entry.transport?.args) !== JSON.stringify(previous.args) || entry.transport?.env?.['CODEX_MANAGER_TOKEN'] !== token)) {
      return 'An existing user-managed Codex Manager MCP entry was preserved. Check its connection in Codex.';
    }
    if (previous && (!config.get<boolean>('apiAccessEnabled', false) || !config.get<boolean>('webDashboardEnabled', true))) {
      throw new Error('MCP requires Dashboard API and the local web dashboard. Enable them, then run Codex Manager: Set Up MCP.');
    }
    const command = await resolveNodeExecutable();
    const args = [path.join(context.extensionPath, 'tools', 'codex-manager-mcp.mjs')];
    await fs.access(args[0]!);
    let tokenId = previous?.tokenId;
    let created = false;
    const storedToken = token ? await readDashboardApiToken(context, token) : undefined;
    if (token && !storedToken) {
      if (automatic) throw new Error('The automatic MCP token was revoked. Run Codex Manager: Set Up MCP to create a replacement.');
      token = undefined;
    }
    // Upgrade only our unchanged automatic grant; never broaden a user-edited token.
    const legacyPermissions = ['state', ...PROJECT_API_ACTIONS].filter(permission => permission !== 'workspacePanel');
    if (storedToken && previous?.tokenId === storedToken.id && storedToken.name === 'Codex Manager MCP (automatic)' &&
      storedToken.permissions.length === legacyPermissions.length && legacyPermissions.every(permission => storedToken.permissions.includes(permission))) {
      await createDashboardApiToken(context, { id: storedToken.id, expected: storedToken, name: storedToken.name,
        permissions: [...storedToken.permissions, 'workspacePanel'] });
    }
    if (!token) {
      const result = await createDashboardApiToken(context, { name: 'Codex Manager MCP (automatic)', permissions: ['state', ...PROJECT_API_ACTIONS] });
      token = result.token; tokenId = result.record.id; created = true;
    }
    try {
      // Enable authenticated API access on first setup; respect later user opt-outs.
      if (!previous) {
        await config.update('apiAccessEnabled', true, vscode.ConfigurationTarget.Global);
        await config.update('webDashboardEnabled', true, vscode.ConfigurationTarget.Global);
      }
      await context.secrets.store(key, token);
      await context.globalState.update(key, { command, args, tokenId });
    } catch (error) {
      if (created && tokenId) await revokeDashboardApiToken(context, tokenId);
      throw error;
    }
    // Retain ownership on writer failure so retry repairs the same credential.
    const url = `http://127.0.0.1:${Number(process.env['CODEX_MANAGER_PORT'] ?? 39875)}`;
    const current = entry?.transport;
    if (current?.command !== command || JSON.stringify(current?.args) !== JSON.stringify(args) || current?.env?.['CODEX_MANAGER_TOKEN'] !== token || current?.env?.['CODEX_MANAGER_URL'] !== url) {
      await runCli(cli, ['mcp', 'add', 'codex-manager', '--env', `CODEX_MANAGER_URL=${url}`, '--env', `CODEX_MANAGER_TOKEN=${token}`, '--', command, ...args], home);
    }
    return 'Codex Manager MCP is configured for new Codex sessions. Restart an existing session to load its tools. Workspace permissions are enabled; account and settings permissions remain separate.';
  }, { waitMs: 500 });
}

export function registerCodexManagerMcpSetup(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand('codexManager.setupMcp', async () => {
    try { void vscode.window.showInformationMessage(await setupCodexManagerMcp(context)); }
    catch (error) { void vscode.window.showErrorMessage(`Codex Manager MCP setup failed: ${error instanceof Error ? error.message : String(error)}`); }
  }));
}
