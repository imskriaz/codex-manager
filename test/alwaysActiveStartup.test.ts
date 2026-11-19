import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { AlwaysOnlineServer } from '../src/services/alwaysOnlineServer';
import { installRelayStartup } from '../src/utils/relayStartup';
import { removeTestDirectory } from './testFilesystem';

vi.mock('../src/utils/relayStartup', () => ({
  installRelayStartup: vi.fn(async () => undefined),
  removeRelayStartup: vi.fn(async () => undefined),
  resolveNodeExecutable: vi.fn(async () => process.execPath)
}));
vi.mock('../src/utils/persistentLog', () => ({ recordPersistentEvent: vi.fn() }));

let root: string;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'manager-startup-'));
  vi.stubEnv('CODEX_MANAGER_STORAGE_ROOT', root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await removeTestDirectory(root);
});

function server(alwaysActive: boolean, startWithSystem: boolean) {
  const settings = { alwaysActive, alwaysActiveStartWithSystem: startWithSystem, webDashboardEnabled: true, webSocketServerEnabled: false };
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback: unknown) => settings[key as keyof typeof settings] ?? fallback } as never);
  const secrets = new Map<string, string>();
  const host = new AlwaysOnlineServer({
    extensionUri: { fsPath: root },
    secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); } }
  } as never, undefined, async () => true) as any;
  host.sessionActive = true;
  const spawn = vi.spyOn(host, 'spawnPreparedRelay').mockImplementation(() => undefined);
  return { host, spawn, settings };
}

it.each([false, true])('keeps shutdown handoff usable when boot-task setup fails (boot=%s)', async boot => {
  const error = new Error(boot ? 'Access is denied' : 'Task removal denied');
  vi.mocked(installRelayStartup).mockRejectedValueOnce(error);
  const { host, spawn } = server(true, boot);
  await expect(host.applyConfiguration()).resolves.toBe('paused');
  expect(installRelayStartup).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('start-node.cjs'), process.execPath, boot);
  expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining(error.message));
  await host.prepareForShutdown();
  host.dispose();
  expect(spawn).toHaveBeenCalledOnce();
});

it('prepares Windows boot with Always Active off without launching a shutdown host', async () => {
  const { host, spawn } = server(false, true);
  await expect(host.applyConfiguration()).resolves.toBe('paused');
  expect(installRelayStartup).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('start-node.cjs'), process.execPath, true);
  host.dispose();
  expect(spawn).not.toHaveBeenCalled();
});

it('can hand off while optional boot registration is still pending', async () => {
  let finish!: () => void;
  vi.mocked(installRelayStartup).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const { host, spawn } = server(true, true);
  const stop = vi.spyOn(host, 'stop').mockResolvedValue(undefined);
  const preparation = host.applyConfiguration();
  await vi.waitFor(() => expect(installRelayStartup).toHaveBeenCalledOnce());
  await host.prepareForShutdown();
  host.dispose();
  expect(spawn).toHaveBeenCalledOnce();
  finish();
  await expect(preparation).resolves.toBe('stopped');
  expect(stop).not.toHaveBeenCalled();
});

it('applies the latest boot toggle without disarming an existing Always Active handoff', async () => {
  let finish!: () => void;
  vi.mocked(installRelayStartup).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const { host, spawn, settings } = server(true, true);
  const stop = vi.spyOn(host, 'stop').mockResolvedValue(undefined);
  const preparation = host.applyConfiguration();
  await vi.waitFor(() => expect(installRelayStartup).toHaveBeenCalledOnce());
  settings.alwaysActiveStartWithSystem = false;
  const changed = host.applyConfiguration();
  await host.prepareForShutdown();
  finish();
  await expect(preparation).resolves.toBe('paused');
  await expect(changed).resolves.toBe('paused');
  expect(installRelayStartup).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), process.execPath, false);
  expect(stop).not.toHaveBeenCalled();
  host.dispose();
  expect(spawn).toHaveBeenCalledOnce();
});
