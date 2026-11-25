import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';

const fixture = vi.hoisted(() => ({ exec: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), unlink: vi.fn() }));
vi.mock('child_process', () => ({ execFile: fixture.exec }));
vi.mock('fs/promises', () => ({ mkdir: fixture.mkdir, writeFile: fixture.writeFile, rename: fixture.rename, unlink: fixture.unlink }));
vi.mock('os', () => ({ homedir: () => '/Users/test home' }));
import { installMacRelayStartup, removeMacRelayStartup } from '../src/utils/macRelayStartup';

const uid = Object.getOwnPropertyDescriptor(process, 'getuid');
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, 'getuid', { configurable: true, value: () => 501 });
  fixture.exec.mockImplementation((_executable, _args, options, callback) => { expect(options.timeout).toBe(3000); callback(null); });
  for (const method of ['mkdir', 'writeFile', 'rename', 'unlink'] as const) fixture[method].mockResolvedValue(undefined);
});
afterEach(() => { if (uid) Object.defineProperty(process, 'getuid', uid); else Reflect.deleteProperty(process, 'getuid'); });

describe('macOS user login startup', () => {
  const config = path.resolve('user home', 'a&b', 'config.json');
  const script = path.resolve('clone with spaces', 'start-node.cjs');
  const executable = path.resolve('node path', 'node');
  it('validates the LaunchAgent before atomically installing it without starting or stopping a host', async () => {
    await installMacRelayStartup(config, script, executable);
    const [temporary, content, options] = fixture.writeFile.mock.calls[0]!;
    expect(temporary).toMatch(/com\.codex-manager\.always-online\.plist\.pending$/);
    expect(options.mode).toBe(0o600);
    expect(content).toContain('a&amp;b');
    expect(content).toContain(`<string>${script}</string>`);
    expect(content).toContain('<key>RunAtLoad</key><true/>');
    expect(content).toContain('<key>ELECTRON_RUN_AS_NODE</key><string>1</string>');
    expect(content).not.toContain('<key>KeepAlive</key>');
    expect(fixture.exec.mock.calls.map(call => [call[0], call[1]])).toEqual([
      ['/usr/bin/plutil', ['-lint', temporary]],
      ['/bin/launchctl', ['enable', 'gui/501/com.codex-manager.always-online']]
    ]);
    expect(fixture.rename).toHaveBeenCalledWith(temporary, temporary.replace(/\.pending$/, ''));
    expect(fixture.rename.mock.invocationCallOrder[0]).toBeGreaterThan(fixture.exec.mock.invocationCallOrder[1]!);
    expect(fixture.unlink).not.toHaveBeenCalled();
  });
  it.each([0, 1])('preserves existing registration and the original failure when command %s fails', async failureIndex => {
    const failure = new Error('Registration denied');
    fixture.exec.mockImplementationOnce((_executable, _args, _options, callback) => callback(failureIndex === 0 ? failure : null));
    if (failureIndex === 1) fixture.exec.mockImplementationOnce((_executable, _args, _options, callback) => callback(failure));
    fixture.unlink.mockRejectedValue(new Error('Cleanup failed'));
    await expect(installMacRelayStartup(config, script, executable)).rejects.toBe(failure);
    expect(fixture.rename).not.toHaveBeenCalled();
    expect(fixture.unlink).toHaveBeenCalledWith(expect.stringMatching(/\.pending$/));
  });
  it('rejects root and relative runtime paths before writing anything', async () => {
    await expect(installMacRelayStartup(config, script, 'node')).rejects.toThrow('absolute');
    Object.defineProperty(process, 'getuid', { configurable: true, value: () => 0 });
    await expect(installMacRelayStartup(config, script, executable)).rejects.toThrow('without sudo');
    expect(fixture.writeFile).not.toHaveBeenCalled();
  });
  it('removes the next login trigger without stopping active sessions, and reports removal errors', async () => {
    await removeMacRelayStartup();
    expect(fixture.unlink).toHaveBeenCalledWith(expect.stringMatching(/com\.codex-manager\.always-online\.plist$/));
    fixture.unlink.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    await expect(removeMacRelayStartup()).resolves.toBeUndefined();
    fixture.unlink.mockRejectedValueOnce(new Error('Permission denied'));
    await expect(removeMacRelayStartup()).rejects.toThrow('Permission denied');
    expect(fixture.exec).not.toHaveBeenCalled();
  });
});
