import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ exec: vi.fn(), stat: vi.fn(), unlink: vi.fn(), writeFile: vi.fn() }));
vi.mock("child_process", () => ({ execFile: fixture.exec }));
vi.mock("fs/promises", () => ({ stat: fixture.stat, unlink: fixture.unlink, writeFile: fixture.writeFile }));
import { installRelayStartup, migrateRelayStartup, removeRelayStartup, resolveNodeExecutable } from "../src/utils/relayStartup";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  Object.defineProperty(process,"platform", { ...platform, value: "win32" });
  vi.stubEnv("APPDATA", "test-appdata");
  fixture.exec.mockImplementation((_command, _args, _options, callback) => { callback(null); });
  fixture.stat.mockResolvedValue({ isFile: () => true });
  fixture.unlink.mockResolvedValue(undefined);
  fixture.writeFile.mockResolvedValue(undefined);
});
afterEach(() => { Object.defineProperty(process,"platform",platform); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("relay startup without generated files", () => {
  it("registers the packaged script and removes the legacy launcher only after success", async () => {
    await installRelayStartup("C:\\test home\\.codex\\always-online-relay.json", "C:\\extension\\tools\\always-online-server.js");
    expect(fixture.exec).toHaveBeenCalledWith("schtasks.exe", expect.arrayContaining(["/Create", "/SC", "ONSTART", "/RU", "SYSTEM"]), { windowsHide: true, timeout: 5000 }, expect.any(Function));
    const args = fixture.exec.mock.calls[0]![1] as string[];
    expect(args[args.indexOf('/TR') + 1]).toBe('cmd.exe /d /s /c ""C:\\test home\\.codex\\always-online-relay-start.cmd""');
    expect(fixture.writeFile).toHaveBeenCalledWith(expect.stringContaining("always-online-relay-start.cmd"), expect.stringContaining("Windows boot task triggered"), expect.any(Object));
    expect(fixture.unlink).toHaveBeenCalledTimes(2);
    fixture.exec.mockImplementationOnce((_command, _args, _options, callback) => callback(new Error("Access is denied")));
    fixture.exec.mockImplementationOnce((_command, _args, _options, callback) => callback(new Error("Task creation disabled")));
    fixture.unlink.mockClear();
    fixture.writeFile.mockClear();
    await installRelayStartup("config", "script");
    expect(fixture.writeFile).toHaveBeenCalledTimes(2);
    expect(fixture.writeFile.mock.calls[1]![0]).toContain('Startup');
    expect(fixture.writeFile.mock.calls[1]![0]).toMatch(/\.vbs$/);
    expect(fixture.writeFile.mock.calls[1]![1]).toContain(', 0, False');
    expect(fixture.unlink).toHaveBeenCalledWith(expect.stringContaining('CodexManagerAlwaysOnline.cmd'));
    expect(fixture.writeFile.mock.calls[0]![0]).not.toContain('Startup');
  });
  it("handles missing entries and reports inconclusive removal", async () => {
    fixture.exec.mockImplementationOnce((_command, _args, _options, callback) => callback(Object.assign(new Error("missing"), { code: 1 })));
    await removeRelayStartup();
    expect(fixture.exec).toHaveBeenCalledWith("schtasks.exe", ["/Query", "/TN", "CodexManagerAlwaysOnline"], expect.any(Object), expect.any(Function));
    expect(fixture.unlink).toHaveBeenCalledWith(expect.stringContaining('always-online-relay-start.cmd'));
    expect(fixture.unlink).toHaveBeenCalledWith(expect.stringContaining('CodexManagerAlwaysOnline.vbs'));
    fixture.exec.mockImplementationOnce((_command, _args, _options, callback) => callback(new Error("timeout")));
    await expect(removeRelayStartup()).rejects.toThrow("timeout");
  });
  it("removes login startup when system startup is disabled", async () => {
    fixture.exec.mockImplementationOnce((_command, _args, _options, callback) => callback(Object.assign(new Error("missing"), { code: 1 })));
    await installRelayStartup("config", "script", "node", false);
    expect(fixture.exec).toHaveBeenCalledWith("schtasks.exe", ["/Query", "/TN", "CodexManagerAlwaysOnline"], { windowsHide: true, timeout: 3000 }, expect.any(Function));
    expect(fixture.exec).toHaveBeenCalledWith("schtasks.exe", ["/Query", "/TN", "CodexManagerAlwaysOnline"], expect.any(Object), expect.any(Function));
  });
  it("migrates an existing startup launcher and does not arm a previously disabled host", async () => {
    await migrateRelayStartup("new-storage", "extension");
    expect(fixture.exec).toHaveBeenCalledWith("schtasks.exe", expect.arrayContaining(["/Create", "/SC", "ONSTART"]), expect.any(Object), expect.any(Function));
    fixture.exec.mockClear();
    fixture.stat.mockRejectedValueOnce(Object.assign(new Error("missing"),{code:"ENOENT"}));
    fixture.stat.mockRejectedValueOnce(Object.assign(new Error("missing"),{code:"ENOENT"}));
    await migrateRelayStartup("new-storage", "extension");
    expect(fixture.exec).not.toHaveBeenCalled();
  });
  it("leaves non-Windows hosts alone", async () => {
    Object.defineProperty(process,"platform", { ...platform, value: "linux" });
    await installRelayStartup("config", "script"); await removeRelayStartup();
    expect(fixture.exec).not.toHaveBeenCalled(); expect(fixture.unlink).not.toHaveBeenCalled();
  });
  it("prefers an installed compatible Node and falls back past missing or old runtimes", async () => {
    vi.stubEnv("NODE", "missing-node"); vi.stubEnv("NODE_EXE", "old-node");
    fixture.exec.mockImplementation((executable, _args, options, callback) => {
      expect(options.windowsHide).toBe(true);
      if (executable === 'where.exe') callback(new Error('ENOENT'));
      else if (executable === 'missing-node') callback(new Error('ENOENT'));
      else callback(null, JSON.stringify({ version: executable === 'old-node' ? '20.19.0' : '22.13.0', executable: process.execPath }));
    });
    await expect(resolveNodeExecutable()).resolves.toBe(process.execPath);
    expect(fixture.exec.mock.calls.map(call => call[0])).toEqual(['where.exe', 'missing-node', 'old-node', 'node']);
    fixture.exec.mockImplementation((_executable, _args, _options, callback) => callback(new Error('missing or unsupported')));
    await expect(resolveNodeExecutable()).rejects.toThrow('22.13');
  });
  it("uses a custom Node location discovered through the system PATH with a bounded startup probe", async () => {
    vi.stubEnv('NODE', undefined); vi.stubEnv('NODE_EXE', undefined);
    const custom = 'D:\\Custom Tools\\nodejs\\node.exe';
    fixture.exec.mockImplementation((executable, _args, options, callback) => {
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(executable === 'where.exe' ? 1000 : 2000);
      if (executable === 'where.exe') callback(null, `${custom}\r\n`);
      else {
        expect(executable).toBe(custom);
        callback(null, JSON.stringify({ version: '24.18.0', executable: custom }));
      }
    });
    await expect(resolveNodeExecutable()).resolves.toBe(custom);
  });
  it("bounds total discovery even when PATH contains many stalled Node executables", async () => {
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    fixture.exec.mockImplementation((executable, _args, options, callback) => {
      now += options.timeout;
      if (executable === 'where.exe') callback(null, Array.from({ length: 20 }, (_, index) => `D:\\Node ${index}\\node.exe`).join('\r\n'));
      else callback(Object.assign(new Error('stalled'), { killed: true }));
    });
    try {
      await expect(resolveNodeExecutable()).rejects.toThrow('5 second deadline');
      expect(now).toBeLessThanOrEqual(5000);
      expect(fixture.exec).toHaveBeenCalledTimes(3);
      expect(fixture.exec.mock.calls.at(-1)?.[0]).toBe(process.execPath);
    } finally { clock.mockRestore(); }
  });
  it("reserves a verified VS Code fallback when installed runtime probes use their full timeout", async () => {
    vi.stubEnv('NODE', 'stalled-node'); vi.stubEnv('NODE_EXE', undefined);
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    fixture.exec.mockImplementation((executable, _args, options, callback) => {
      if (executable === process.execPath) {
        now += 1500;
        expect(options.timeout).toBeGreaterThanOrEqual(1500);
        callback(null, JSON.stringify({version:'24.22.1',executable:process.execPath}));
      } else {
        now += options.timeout;
        callback(executable === 'where.exe' ? null : Object.assign(new Error('stalled'), {killed:true}), executable === 'where.exe' ? 'D:\\Slow Node\\node.exe' : undefined);
      }
    });
    try {
      await expect(resolveNodeExecutable()).resolves.toBe(process.execPath);
      expect(now).toBeLessThanOrEqual(5000);
    } finally { clock.mockRestore(); }
  });
  it("quotes spaces and preserves the startup log in the boot launcher", async () => {
    await installRelayStartup("C:\\user's home\\config.json", "C:\\extension\\start-node.cjs", "C:\\node path\\node.exe");
    const launcher = fixture.writeFile.mock.calls[0]![1];
    expect(launcher).toContain('"C:\\node path\\node.exe"');
    expect(launcher).toContain('"C:\\user\'s home\\config.json"');
    expect(launcher).toContain("always-online-relay-startup.log");
  });
});
