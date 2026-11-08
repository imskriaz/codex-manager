import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ exec: vi.fn(), stat: vi.fn(), unlink: vi.fn() }));
vi.mock("child_process", () => ({ execFile: fixture.exec }));
vi.mock("fs/promises", () => ({ stat: fixture.stat, unlink: fixture.unlink }));
import { installRelayStartup, migrateRelayStartup, removeRelayStartup, resolveNodeExecutable } from "../src/utils/relayStartup";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  Object.defineProperty(process,"platform", { ...platform, value: "win32" });
  vi.stubEnv("APPDATA", "test-appdata");
  fixture.exec.mockImplementation((_command, _args, _options, callback) => { callback(null); });
  fixture.stat.mockResolvedValue({ isFile: () => true });
  fixture.unlink.mockResolvedValue(undefined);
});
afterEach(() => { Object.defineProperty(process,"platform",platform); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("relay startup without generated files", () => {
  it("registers the packaged script and removes the legacy launcher only after success", async () => {
    await installRelayStartup("C:\\test home\\.codex\\always-online-relay.json", "C:\\extension\\tools\\always-online-server.js");
    expect(fixture.exec).toHaveBeenCalledWith("reg.exe", expect.arrayContaining(["add", "CodexManagerAlwaysOnline"]), { windowsHide: true, timeout: 2000 }, expect.any(Function));
    const command = fixture.exec.mock.calls[0]![1].at(-2);
    expect(command).toContain('-WindowStyle Hidden -EncodedCommand');
    const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
    expect(script).toContain('Start-Process -WindowStyle Hidden');
    expect(script).toContain('"C:\\extension\\tools\\always-online-server.js"');
    expect(fixture.unlink).toHaveBeenCalledOnce();
    fixture.exec.mockImplementationOnce((_command, _args, _options, callback) => callback(new Error("registry unavailable")));
    fixture.unlink.mockClear();
    await expect(installRelayStartup("config", "script")).rejects.toThrow("registry unavailable");
    expect(fixture.unlink).not.toHaveBeenCalled();
  });
  it("handles missing entries and reports inconclusive removal", async () => {
    fixture.exec.mockImplementationOnce((_command, _args, _options, callback) => callback(Object.assign(new Error("missing"), { code: 1 })));
    await removeRelayStartup();
    expect(fixture.exec).toHaveBeenCalledOnce();
    fixture.exec.mockImplementationOnce((_command, _args, _options, callback) => callback(new Error("timeout")));
    await expect(removeRelayStartup()).rejects.toThrow("timeout");
  });
  it("migrates an existing startup launcher and does not arm a previously disabled host", async () => {
    await migrateRelayStartup("new-storage", "extension");
    expect(fixture.exec).toHaveBeenCalledOnce();
    fixture.exec.mockClear();
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
      if (executable === 'missing-node') callback(new Error('ENOENT'));
      else callback(null, JSON.stringify({ version: executable === 'old-node' ? '20.19.0' : '22.13.0', executable: process.execPath }));
    });
    await expect(resolveNodeExecutable()).resolves.toBe(process.execPath);
    expect(fixture.exec.mock.calls.map(call => call[0])).toEqual(['missing-node', 'old-node', 'node']);
    fixture.exec.mockImplementation((_executable, _args, _options, callback) => callback(new Error('missing or unsupported')));
    await expect(resolveNodeExecutable()).rejects.toThrow('22.13');
  });
  it("quotes apostrophes and spaces in hidden startup arguments", async () => {
    await installRelayStartup("C:\\user's home\\config.json", "C:\\extension\\start-node.cjs", "C:\\node path\\node.exe");
    const command = fixture.exec.mock.calls[0]![1].at(-2);
    const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
    expect(script).toContain("user''s home");
    expect(script).toContain("-FilePath 'C:\\node path\\node.exe'");
  });
});
