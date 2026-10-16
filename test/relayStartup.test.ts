import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ exec: vi.fn(), stat: vi.fn(), unlink: vi.fn() }));
vi.mock("child_process", () => ({ execFile: fixture.exec }));
vi.mock("fs/promises", () => ({ stat: fixture.stat, unlink: fixture.unlink }));
import { installRelayStartup, migrateRelayStartup, removeRelayStartup } from "../src/utils/relayStartup";
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
    expect(fixture.exec.mock.calls[0]![1].join(" ")).toContain('"C:\\extension\\tools\\always-online-server.js"');
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
});
