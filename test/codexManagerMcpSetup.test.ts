import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
const mocks = vi.hoisted(() => ({ cli: vi.fn(), discover: vi.fn(), node: vi.fn(), create: vi.fn(), read: vi.fn(), revoke: vi.fn(), access: vi.fn(), mkdir: vi.fn(), config: { get: vi.fn(), update: vi.fn() } }));
vi.mock('child_process', () => ({ execFile: (...args: any[]) => mocks.cli(...args) }));
vi.mock('fs/promises', () => ({ access: (...args: any[]) => mocks.access(...args), mkdir: (...args: any[]) => mocks.mkdir(...args) }));
vi.mock('../src/codex/authFile', () => ({ getCodexHome: () => 'D:/fixture', getCodexHomeStateKey: () => 'fixture' }));
vi.mock('../src/services/codexCliRuntime', () => ({ discoverBundledCodexCli: () => mocks.discover() }));
vi.mock('../src/utils/relayStartup', () => ({ resolveNodeExecutable: () => mocks.node() }));
vi.mock('../src/utils/crossWindowOperations', () => ({ runCrossWindowExclusive: (_key: string, _name: string, run: () => unknown) => run() }));
vi.mock('../src/infrastructure/config/extensionSettings', () => ({ getCodexManagerConfiguration: () => mocks.config }));
vi.mock('../src/services/dashboardApiToken', () => ({ createDashboardApiToken: (...args: any[]) => mocks.create(...args), readDashboardApiToken: (...args: any[]) => mocks.read(...args), revokeDashboardApiToken: (...args: any[]) => mocks.revoke(...args) }));
import { registerCodexManagerMcpSetup, setupCodexManagerMcp } from '../src/services/codexManagerMcpSetup';

const key = 'codexManager.mcp.fixture';
let context: vscode.ExtensionContext;
let entries: unknown[];
let state: Map<string, unknown>;
let secrets: Map<string, string>;
beforeEach(() => {
  vi.clearAllMocks(); entries = []; state = new Map(); secrets = new Map();
  Object.assign(vscode.commands, { registerCommand: vi.fn(() => ({ dispose: vi.fn() })) });
  context = { extensionPath: 'D:/extension', subscriptions: [], globalState: { get: (key: string) => state.get(key), update: vi.fn(async (key: string, value: unknown) => { state.set(key, value); }) }, secrets: { get: vi.fn(async (key: string) => secrets.get(key)), store: vi.fn(async (key: string, value: string) => { secrets.set(key, value); }) } } as unknown as vscode.ExtensionContext;
  mocks.discover.mockResolvedValue(['codex.exe']); mocks.access.mockResolvedValue(undefined); mocks.mkdir.mockResolvedValue(undefined); mocks.node.mockResolvedValue('node.exe');
  mocks.config.get.mockImplementation((key, fallback) => key === 'apiAccessEnabled' ? true : fallback); mocks.config.update.mockResolvedValue(undefined);
  mocks.create.mockResolvedValue({ token: 'secret-token', record: { id: 'token-id' } }); mocks.read.mockResolvedValue({ id: 'token-id' }); mocks.revoke.mockResolvedValue([]);
  mocks.cli.mockImplementation((_cmd, args, _options, callback) => callback(null, args[1] === 'list' ? JSON.stringify(entries) : '', ''));
});
function owned() {
  const registration = { command: 'node.exe', args: ['D:/old-extension/tools/codex-manager-mcp.mjs'], tokenId: 'token-id' };
  state.set(key, registration); secrets.set(key, 'secret-token');
  entries = [{ name: 'codex-manager', transport: { ...registration, env: { CODEX_MANAGER_TOKEN: 'secret-token' } } }];
}
describe('automatic Codex Manager MCP setup', () => {
  it('registers globally using the official writer with workspace permissions and bounded subprocesses', async () => {
    expect(await setupCodexManagerMcp(context, true)).toContain('new Codex sessions');
    expect(mocks.cli.mock.calls[1][1]).toEqual(expect.arrayContaining(['add', 'codex-manager', '--env', 'CODEX_MANAGER_TOKEN=secret-token']));
    expect(mocks.cli.mock.calls[1][2]).toMatchObject({ cwd: 'D:/fixture', timeout: 10000, windowsHide: true, env: { CODEX_HOME: 'D:/fixture' } });
    const permissions = mocks.create.mock.calls[0][1].permissions;
    expect(permissions).toContain('workspaceBrowser'); expect(permissions).toContain('saveWorkspaceFile');
    expect(permissions).not.toContain('*'); expect(permissions).not.toContain('settings'); expect(permissions).not.toContain('switch');
    expect(secrets.get(key)).toBe('secret-token'); expect(state.get(key)).toMatchObject({ command: 'node.exe', tokenId: 'token-id' });
    expect(mocks.config.update).toHaveBeenCalledWith('apiAccessEnabled', true, vscode.ConfigurationTarget.Global);
  });
  it('respects automatic setup being disabled without accessing files or credentials', async () => {
    mocks.config.get.mockReturnValue(false);
    expect(await setupCodexManagerMcp(context, true)).toContain('disabled');
    expect(mocks.cli).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([false, true])('preserves user-managed and disabled entries: disabled=%s', async disabled => {
    entries = [{ name: 'codex-manager', enabled: !disabled, transport: { command: 'custom-node', args: ['custom-server'] } }];
    expect(await setupCodexManagerMcp(context)).toMatch(/preserved|disabled/);
    expect(mocks.cli).toHaveBeenCalledOnce(); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.config.update).not.toHaveBeenCalled();
  });
  it('updates an owned registration after extension upgrades while reusing the token', async () => {
    owned(); await setupCodexManagerMcp(context, true);
    expect(mocks.cli.mock.calls[1][1]).toEqual(expect.arrayContaining([expect.stringMatching(/extension[\\/]tools[\\/]codex-manager-mcp.mjs$/)]));
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('does not silently re-enable explicitly disabled API access after setup', async () => {
    owned(); mocks.config.get.mockImplementation((key, fallback) => key === 'apiAccessEnabled' ? false : fallback);
    await expect(setupCodexManagerMcp(context, true)).rejects.toThrow('Enable them');
    expect(mocks.config.update).not.toHaveBeenCalled();
  });
  it('does not automatically replace a revoked token, but allows explicit repair', async () => {
    owned(); mocks.read.mockResolvedValue(undefined);
    await expect(setupCodexManagerMcp(context, true)).rejects.toThrow('revoked'); expect(mocks.create).not.toHaveBeenCalled();
    await setupCodexManagerMcp(context); expect(mocks.create).toHaveBeenCalledOnce();
  });
  it('reports unavailable CLI and invalid config without writing registration or tokens', async () => {
    mocks.discover.mockResolvedValue([]);
    await expect(setupCodexManagerMcp(context)).rejects.toThrow('official Codex extension');
    mocks.discover.mockResolvedValue(['codex.exe']); mocks.cli.mockImplementation((_cmd, _args, _opts, callback) => callback(new Error('secret must not appear')));
    await expect(setupCodexManagerMcp(context)).rejects.toThrow('config.toml'); expect(mocks.create).not.toHaveBeenCalled();
  });
  it('retains ownership and one credential for repair when the config writer fails without leaking the token', async () => {
    mocks.cli.mockImplementation((_cmd, args, _options, callback) => args[1] === 'list' ? callback(null, '[]') : callback(new Error('CODEX_MANAGER_TOKEN=secret-token')));
    await expect(setupCodexManagerMcp(context)).rejects.toThrow('configuration command failed');
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(state.get(key)).toMatchObject({ tokenId: 'token-id' });
    await expect(setupCodexManagerMcp(context)).rejects.toThrow('configuration command failed');
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it('surfaces explicit command completion and failure through VS Code notifications', async () => {
    registerCodexManagerMcpSetup(context);
    const command = vi.mocked(vscode.commands.registerCommand).mock.calls.find(call => call[0] === 'codexManager.setupMcp')![1];
    await command(); expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('configured'));
    mocks.discover.mockResolvedValue([]); await command();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('MCP setup failed'));
  });
});
