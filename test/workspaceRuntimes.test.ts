import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ resolveCodex: vi.fn(), resolveClaude: vi.fn(), installCodex: vi.fn(), installClaude: vi.fn(), exec: vi.fn(), values: new Map<string, unknown>(), intents: new Map<string, unknown>(), update: vi.fn() }));
vi.mock('../src/services/codexSessionResume', () => ({ resolveCodexCliExecutable: fixture.resolveCodex }));
vi.mock('../src/services/claudeCliRuntime', () => ({ resolveClaudeCliExecutable: fixture.resolveClaude }));
vi.mock('../src/services/codexCliRuntime', () => ({ installManagedCodexCli: fixture.installCodex, installManagedClaudeCli: fixture.installClaude, resolveCodexNpmBinary: async (file: string) => file }));
vi.mock('node:child_process', () => ({ execFile: fixture.exec }));
vi.mock('../src/storage/sqliteState', () => ({ getSqliteStateStore: () => ({ get: (_namespace: string, key: string) => fixture.intents.get(key) }) }));
vi.mock('../src/storage/sqliteContext', () => ({ updateConfigurationBatch: async (config: { update: (key: string, value: unknown) => Promise<void> }, updates: Array<[string, unknown]>) => { for (const [key, value] of updates) await config.update(key, value); } }));
vi.mock('../src/infrastructure/config/extensionSettings', () => ({ getCodexManagerConfiguration: () => ({ get: (key: string, fallback?: unknown) => fixture.values.get(key) ?? fallback, update: fixture.update }), isRuntimeModuleEnabled: vi.fn(() => false), assertRuntimeModuleEnabled: vi.fn() }));
import { manageWorkspaceRuntime, migrateWorkspaceRuntimeModules } from '../src/services/workspaceRuntimes';

beforeEach(() => {
  vi.clearAllMocks(); fixture.values.clear(); fixture.intents.clear();
  fixture.resolveCodex.mockResolvedValue({ command: '/installed/codex', prefixArgs: [] }); fixture.resolveClaude.mockResolvedValue('/installed/claude');
  fixture.installCodex.mockResolvedValue('/managed/codex.js'); fixture.installClaude.mockResolvedValue('/managed/claude.exe');
  fixture.exec.mockImplementation((_command, _args, _options, callback) => queueMicrotask(() => callback(null, '2.1.330 (Claude Code)')));
  fixture.update.mockImplementation(async (key, value) => { fixture.values.set(key, value); });
});

it.each(['codex', 'claude'] as const)('verifies and reuses installed %s without downloading or querying a model', async provider => {
  const result = await manageWorkspaceRuntime(provider, 'enable');
  expect(result).toMatchObject({ provider, available: true, enabled: true, executable: `/installed/${provider}`, version: '2.1.330 (Claude Code)' });
  expect(fixture.exec.mock.calls[0][1]).toEqual(['--version']);
  expect(fixture.installClaude).not.toHaveBeenCalled(); expect(fixture.installCodex).not.toHaveBeenCalled();
  expect(fixture.values.get(`${provider}ModuleEnabled`)).toBe(true); expect(fixture.values.get('cliIntegrationEnabled')).toBe(true);
  expect(fixture.values.has(`${provider === 'codex' ? 'claude' : 'codex'}ModuleEnabled`)).toBe(false);
  expect(result.loginCommand).toContain(provider === 'claude' ? 'auth login' : 'login');
});

it.each(['codex', 'claude'] as const)('installs missing %s only on enable and verifies before enabling', async provider => {
  if (provider === 'codex') fixture.resolveCodex.mockRejectedValue(new Error('Codex CLI was not found on this PC. Open Settings.'));
  else fixture.resolveClaude.mockResolvedValue(undefined);
  expect(await manageWorkspaceRuntime(provider, 'check')).toMatchObject({ available: false });
  expect(fixture.installClaude).not.toHaveBeenCalled(); expect(fixture.installCodex).not.toHaveBeenCalled();
  const [one, two] = await Promise.all([manageWorkspaceRuntime(provider, 'enable'), manageWorkspaceRuntime(provider, 'enable')]);
  expect(one).toEqual(two); expect(one.enabled).toBe(true);
  expect(provider === 'codex' ? fixture.installCodex : fixture.installClaude).toHaveBeenCalledOnce();
});

it('does not replace a broken installation or enable a failed version probe', async () => {
  fixture.exec.mockImplementation((_command, _args, _options, callback) => queueMicrotask(() => callback(new Error('Unsupported executable'))));
  await expect(manageWorkspaceRuntime('claude', 'enable')).rejects.toThrow('Unsupported executable');
  expect(fixture.installClaude).not.toHaveBeenCalled(); expect(fixture.update).not.toHaveBeenCalled();
});

it('keeps a missing runtime off on download failure and permits a retry', async () => {
  fixture.resolveClaude.mockResolvedValue(undefined); fixture.installClaude.mockRejectedValueOnce(new Error('No disk space'));
  await expect(manageWorkspaceRuntime('claude', 'enable')).rejects.toThrow('No disk space'); expect(fixture.update).not.toHaveBeenCalled();
  expect(await manageWorkspaceRuntime('claude', 'enable')).toMatchObject({ enabled: true });
});

it('does not overwrite a disable requested during setup', async () => {
  fixture.exec.mockImplementation((_command, _args, _options, callback) => { fixture.intents.set('claude-module-intent', 'disabled'); queueMicrotask(() => callback(null, '2.1.330')); });
  await expect(manageWorkspaceRuntime('claude', 'enable')).rejects.toThrow('settings changed'); expect(fixture.update).not.toHaveBeenCalled();
});

it('does not claim enabling succeeded when the setting was not saved', async () => {
  fixture.update.mockResolvedValue(undefined);
  await expect(manageWorkspaceRuntime('claude', 'enable')).rejects.toThrow('enabling the module was not confirmed');
});

it('migrates only verified existing providers and never downloads during migration', async () => {
  fixture.resolveClaude.mockResolvedValue(undefined);
  await migrateWorkspaceRuntimeModules(['codex', 'claude']);
  expect(fixture.values.get('codexModuleEnabled')).toBe(true); expect(fixture.values.has('claudeModuleEnabled')).toBe(false);
  expect(fixture.installCodex).not.toHaveBeenCalled(); expect(fixture.installClaude).not.toHaveBeenCalled();
});
