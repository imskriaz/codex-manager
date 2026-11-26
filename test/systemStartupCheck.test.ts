import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { resolveNodeExecutable } from '../src/utils/relayStartup';
import { checkSystemStartup } from '../src/services/systemStartupCheck';

const { settings } = vi.hoisted(() => ({ settings: { dashboard: true } }));
vi.mock('../src/infrastructure/config/extensionSettings', () => ({ getCodexManagerConfiguration: () => ({ get: () => settings.dashboard }) }));
vi.mock('../src/utils/relayStartup', () => ({ resolveNodeExecutable: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  vi.clearAllMocks();
  settings.dashboard = true;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  vi.mocked(resolveNodeExecutable).mockResolvedValue('C:/node/node.exe');
  vi.mocked(execFile).mockImplementation(((_exe: unknown, _args: unknown, _options: unknown, callback: (error: Error | null, stdout: string) => void) => callback(null, 'True')) as typeof execFile);
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks(); if (getuid) Object.defineProperty(process, 'getuid', getuid); else Reflect.deleteProperty(process, 'getuid'); });
it('returns detected prerequisites without registering or enabling startup', async () => {
  const result = await checkSystemStartup();
  expect(result.ready).toBe(true);
  expect(result.checks.every(check => check.status === 'passed')).toBe(true);
  expect(result.checks.some(check => check.instruction)).toBe(false);
  expect(execFile).toHaveBeenCalledWith('powershell.exe', expect.any(Array), expect.objectContaining({ timeout: 3000 }), expect.any(Function));
});
it('shows elevation instructions only when the Windows host is not elevated', async () => {
  vi.mocked(execFile).mockImplementation(((_exe: unknown, _args: unknown, _options: unknown, callback: (error: Error | null, stdout: string) => void) => callback(null, 'False')) as typeof execFile);
  const result = await checkSystemStartup();
  expect(result.ready).toBe(true);
  expect(result.checks.at(-1)).toMatchObject({ status: 'warning', instruction: expect.stringContaining('administrator') });
});
it('preserves runtime errors and blocks enabling when prerequisites fail', async () => {
  settings.dashboard = false;
  vi.mocked(resolveNodeExecutable).mockRejectedValue(new Error('Runtime probe timed out'));
  const result = await checkSystemStartup();
  expect(result.ready).toBe(false);
  expect(result.checks).toContainEqual(expect.objectContaining({ label: 'Node.js runtime', status: 'blocked', detail: 'Runtime probe timed out' }));
});
it('does not invent elevation results when the account check fails', async () => {
  vi.mocked(execFile).mockImplementation(((_exe: unknown, _args: unknown, _options: unknown, callback: (error: Error | null, stdout: string) => void) => callback(new Error('Permission probe timed out'), '')) as typeof execFile);
  expect((await checkSystemStartup()).checks.at(-1)).toMatchObject({ status: 'warning', detail: expect.stringContaining('Permission probe timed out') });
});
it('shows macOS account instructions only for root', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  Object.defineProperty(process, 'getuid', { configurable: true, value: () => 0 });
  const result = await checkSystemStartup();
  expect(result.ready).toBe(false);
  expect(result.checks.at(-1)).toMatchObject({ status: 'blocked', instruction: expect.stringContaining('without sudo') });
  expect(execFile).not.toHaveBeenCalled();
});
it('blocks unsupported systems with relevant instructions', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  expect(await checkSystemStartup()).toMatchObject({ ready: false, checks: expect.arrayContaining([expect.objectContaining({ label: 'Operating system', status: 'blocked' })]) });
});
