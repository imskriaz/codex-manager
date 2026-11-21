import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { bundledCodexCli } from './codexCliRuntime';
import { ownerBridgeDirectory } from './codexOwnerBridge';
import { resolveNodeExecutable } from '../utils/relayStartup';
import { runCrossWindowExclusive } from '../utils/crossWindowOperations';

/** An executable adapter keeps official Codex UI and dashboard on the same writer. */
export async function setupCodexOwnerBridge(context: vscode.ExtensionContext): Promise<boolean> {
  if (vscode.env.appHost === 'node') return false;
  return runCrossWindowExclusive('codex:owner-bridge-setup', 'Connect the Codex owner', () => install(context), { waitMs: 500 });
}

async function install(context: vscode.ExtensionContext): Promise<boolean> {
  const extension = vscode.extensions.getExtension('openai.chatgpt');
  if (!extension || vscode.env.remoteName === 'wsl' || vscode.workspace.getConfiguration('chatgpt').get('runCodexInWindowsSubsystemForLinux', false)) return false;
  const root = ownerBridgeDirectory(), launcher = path.join(root, process.platform === 'win32' ? 'codex-owner.exe' : 'codex-owner');
  const config = vscode.workspace.getConfiguration('chatgpt');
  const current = config.get<string>('cliExecutable');
  const previous = await fs.readFile(path.join(root, 'owner.json'), 'utf8').then(value => JSON.parse(value) as { customCli?: string }).catch(() => undefined);
  const customCli = current && current !== launcher ? current : previous?.customCli;
  const cli = customCli || bundledCodexCli(extension.extensionPath);
  await fs.access(cli);
  const node = await resolveNodeExecutable();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const script = path.join(root, 'codex-owner-bridge.cjs');
  await fs.copyFile(path.join(context.extensionPath, 'tools', 'codex-owner-bridge.cjs'), script);
  await fs.writeFile(path.join(root, 'owner.json'), JSON.stringify({ cli, ...(customCli ? { customCli } : {}) }), { mode: 0o600 });
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(root, 'launcher.txt'), [node, script].join('\n'), { mode: 0o600 });
    if (!await fs.stat(launcher).then(() => true, () => false)) {
      const source = path.join(context.extensionPath, 'tools', 'codex-owner-launcher.cs');
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      await new Promise<void>((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -Path ${quote(source)} -OutputAssembly ${quote(launcher)} -OutputType ConsoleApplication`], { windowsHide: true, timeout: 15_000 }, error => error ? reject(new Error('Codex owner launcher could not be built.', { cause: error })) : resolve()));
    }
  } else {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await fs.writeFile(launcher, `#!/bin/sh\nexec ${quote(node)} ${quote(script)} ${quote(path.join(root, 'owner.json'))} "$@"\n`, { mode: 0o700 });
  }
  if (current === launcher) return false;
  await config.update('cliExecutable', launcher, vscode.ConfigurationTarget.Global);
  return true;
}
