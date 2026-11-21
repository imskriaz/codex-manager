import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { setupCodexOwnerBridge } from '../src/services/codexOwnerBridgeSetup';
vi.mock('../src/utils/relayStartup', () => ({ resolveNodeExecutable: async () => process.execPath }));
vi.mock('../src/utils/crossWindowOperations', () => ({ runCrossWindowExclusive: (_key: string, _label: string, work: () => unknown) => work() }));
let root: string | undefined;
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); if (root) await fs.rm(root, { recursive: true, force: true }); });

it('installs an executable adapter, preserves a custom CLI, and forwards the actual Windows stdio and argument boundaries', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner setup with spaces '));
  vi.stubEnv('CODEX_MANAGER_STORAGE_ROOT', root); vi.stubEnv('CODEX_HOME', root);
  let selected: string = process.execPath;
  const update = vi.fn(async (_key: string, value: string) => { selected = value; });
  vi.mocked(vscode.extensions.getExtension).mockReturnValue({ extensionPath: root } as vscode.Extension<unknown>);
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback?: unknown) => key === 'cliExecutable' ? selected : fallback, update } as unknown as vscode.WorkspaceConfiguration);
  const context = { extensionPath: process.cwd() } as vscode.ExtensionContext;
  expect(await setupCodexOwnerBridge(context)).toBe(true);
  expect(update).toHaveBeenCalledWith('cliExecutable', selected, vscode.ConfigurationTarget.Global);
  const directory = path.dirname(selected);
  expect(JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8'))).toEqual({ cli: process.execPath, customCli: process.execPath });
  expect(await setupCodexOwnerBridge(context)).toBe(false);
  // Use the compiled executable, rather than a mocked compiler, to verify Windows pipe inheritance.
  const capture = path.join(root, 'capture args.cjs');
  await fs.writeFile(capture, `process.stdin.on('data',data=>process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:data.toString()})+'\\n'));`);
  await fs.writeFile(path.join(directory, 'launcher.txt'), [process.execPath, capture].join('\n'));
  if (process.platform !== 'win32') return;
  const args = ['hello world', 'quote"here', 'D:\\with space\\', '\u09ac\u09be\u0982\u09b2\u09be'];
  const result = await new Promise<{ args: string[]; input: string }>((resolve, reject) => {
    const child = spawn(selected, args, { windowsHide: true }); let output = '', error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Windows launcher did not forward stdio.')); }, 5000);
    child.on('error', reject); child.stdout.on('data', data => { output += data.toString(); }); child.stderr.on('data', data => { error += data.toString(); });
    child.on('exit', code => { clearTimeout(timer); if (code) reject(new Error(error)); else { try { resolve(JSON.parse(output)); } catch (cause) { reject(cause); } } });
    child.stdin.end('bridge stdin');
  });
  expect(result.args.slice(1)).toEqual(args); expect(result.input).toBe('bridge stdin');
}, 20_000);
