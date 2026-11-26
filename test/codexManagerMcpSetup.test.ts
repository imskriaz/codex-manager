import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
const mocks = vi.hoisted(() => ({ cli: vi.fn(), discover: vi.fn(), node: vi.fn(), access: vi.fn(), mkdir: vi.fn(), config: { get: vi.fn(), update: vi.fn() } }));
vi.mock('child_process', () => ({ execFile: (...args: any[]) => mocks.cli(...args) }));
vi.mock('fs/promises', () => ({ access: (...args: any[]) => mocks.access(...args), mkdir: (...args: any[]) => mocks.mkdir(...args) }));
vi.mock('../src/codex/authFile', () => ({ getCodexHome: () => 'D:/fixture', getCodexHomeStateKey: () => 'fixture' }));
vi.mock('../src/services/codexCliRuntime', () => ({ discoverBundledCodexCli: () => mocks.discover() }));
vi.mock('../src/utils/relayStartup', () => ({ resolveNodeExecutable: () => mocks.node() }));
vi.mock('../src/utils/crossWindowOperations', () => ({ runCrossWindowExclusive: (_key: string, _name: string, run: () => unknown) => run() }));
vi.mock('../src/infrastructure/config/extensionSettings', () => ({ getCodexManagerConfiguration: () => mocks.config }));
import { registerCodexManagerMcpSetup, setupCodexManagerMcp } from '../src/services/codexManagerMcpSetup';

const key = 'codexManager.mcp.fixture';
let context: vscode.ExtensionContext, entries: unknown[], state: Map<string, any>;
beforeEach(() => {
  vi.clearAllMocks(); entries = []; state = new Map();
  Object.assign(vscode.commands, { registerCommand: vi.fn(() => ({ dispose: vi.fn() })) });
  context = { extensionPath: 'D:/extension', subscriptions: [], globalState: { get: (key: string) => state.get(key), update: vi.fn(async (key: string, value: unknown) => { state.set(key, value); }) }, secrets: { get: vi.fn(async () => 'old-token'), store: vi.fn(), delete: vi.fn() } } as unknown as vscode.ExtensionContext;
  mocks.discover.mockResolvedValue(['codex.exe']); mocks.access.mockResolvedValue(undefined); mocks.mkdir.mockResolvedValue(undefined); mocks.node.mockResolvedValue('node.exe');
  mocks.config.get.mockImplementation((_key, fallback) => fallback); mocks.config.update.mockResolvedValue(undefined);
  mocks.cli.mockImplementation((_cmd, args, _options, callback) => callback(null, args[1] === 'list' ? JSON.stringify(entries) : '', ''));
});
function owned(local = false) {
  const registration = { command: 'node.exe', args: ['D:/old-extension/tools/codex-manager-mcp.mjs'], ...(local ? { transport: 'local' } : { tokenId: 'token-id' }) };
  state.set(key, registration);
  entries = [{ name: 'codex-manager', transport: { ...registration, env: local ? {} : { CODEX_MANAGER_TOKEN: 'old-token' } } }];
}
describe('local Codex Manager MCP setup', () => {
  it('does not discover or modify MCP configuration before automatic setup is enabled', async () => {
    expect(await setupCodexManagerMcp(context, true)).toBe('Automatic MCP setup is disabled.');
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.cli).not.toHaveBeenCalled();
  });
  it('registers without a token, without enabling external API access, using bounded subprocesses', async () => {
    expect(await setupCodexManagerMcp(context)).toContain('No API token');
    const args = mocks.cli.mock.calls[1][1];
    expect(args).toContain('CODEX_MANAGER_TRANSPORT=local');
    expect(args.join(' ')).not.toMatch(/CODEX_MANAGER_TOKEN|CODEX_MANAGER_URL/);
    expect(mocks.cli.mock.calls[1][2]).toMatchObject({ cwd: 'D:/fixture', timeout: 10000, windowsHide: true });
    expect(context.secrets.store).not.toHaveBeenCalled(); expect(mocks.config.update).not.toHaveBeenCalled();
    expect(state.get(key)).toMatchObject({ transport: 'local' });
  });
  it.each([false, true])('migrates owned registrations, local=%s, while external API is disabled', async local => {
    owned(local); mocks.config.get.mockImplementation((key, fallback) => key === 'apiAccessEnabled' ? false : key === 'mcpAutoSetupEnabled' ? true : fallback);
    await setupCodexManagerMcp(context, true);
    expect(mocks.cli.mock.calls[1][1]).toContain('CODEX_MANAGER_TRANSPORT=local');
    expect(mocks.config.update).not.toHaveBeenCalled();
  });
  it('preserves ownership for a repair after the config writer fails and creates no credential', async () => {
    owned(); const before = state.get(key);
    mocks.cli.mockImplementation((_cmd, args, _options, callback) => args[1] === 'list' ? callback(null, JSON.stringify(entries)) : callback(new Error('private output')));
    await expect(setupCodexManagerMcp(context)).rejects.toThrow('configuration command failed');
    expect(state.get(key)).toEqual(before); expect(context.secrets.store).not.toHaveBeenCalled();
  });
  it.each([false, true])('preserves independently managed and disabled entries, disabled=%s', async disabled => {
    entries = [{ name: 'codex-manager', enabled: !disabled, transport: { command: 'custom-node', args: ['custom-server'] } }];
    expect(await setupCodexManagerMcp(context)).toMatch(/preserved|disabled/);
    expect(mocks.cli).toHaveBeenCalledOnce(); expect(state.size).toBe(0);
  });
  it('respects auto setup being disabled', async () => {
    mocks.config.get.mockReturnValue(false); expect(await setupCodexManagerMcp(context, true)).toContain('disabled'); expect(mocks.cli).not.toHaveBeenCalled();
  });
  it('surfaces explicit command completion and failure through VS Code notifications', async () => {
    registerCodexManagerMcpSetup(context);
    const command = vi.mocked(vscode.commands.registerCommand).mock.calls.find(call => call[0] === 'codexManager.setupMcp')![1];
    await command(); expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('configured'));
    mocks.discover.mockResolvedValue([]); await command(); expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('MCP setup failed'));
  });
});
