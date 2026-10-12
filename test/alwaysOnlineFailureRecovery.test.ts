import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), get: vi.fn(), request: vi.fn(), readFile: vi.fn() }));
vi.mock("child_process", () => ({ spawn: mocks.spawn }));
vi.mock("http", () => ({ get: mocks.get, request: mocks.request }));
vi.mock("fs/promises", async () => ({ ...await vi.importActual<typeof import("fs/promises")>("fs/promises"), readFile: mocks.readFile }));
vi.mock("../src/utils/storageRoot", () => ({ getCodexManagerStorageRoot: () => "relay-test-storage" }));
import { AlwaysOnlineServer } from "../src/services/alwaysOnlineServer";

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function unhealthyPort() {
  mocks.get.mockImplementation((_options, callback) => {
    const response = Object.assign(new EventEmitter(), { statusCode: 200, setEncoding: vi.fn(), resume: vi.fn() });
    queueMicrotask(() => { callback(response); response.emit("data", "unrelated dashboard"); response.emit("end"); });
    return Object.assign(new EventEmitter(), { destroy: vi.fn() });
  });
}
function server() {
  const instance = new AlwaysOnlineServer({} as never);
  vi.spyOn(instance as unknown as { prepareRelay(): Promise<unknown> }, "prepareRelay").mockResolvedValue({
    port: 39875, pidPath: "missing-relay.pid", configPath: "relay-config.json", scriptTarget: "relay.js", hostKey: "key", adminToken: "token"
  });
  return instance;
}

describe("detached relay terminal outcomes", () => {
  it("does not report a stale live PID as a healthy running relay", async () => {
    vi.useFakeTimers(); unhealthyPort();
    mocks.readFile.mockResolvedValue(String(process.pid));
    mocks.request.mockImplementation(() => Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() }));
    const instance = server();
    vi.spyOn(instance as unknown as { prepareRelay(): Promise<unknown> }, "prepareRelay").mockResolvedValue({
      port: 39875, pidPath: "relay.pid", configPath: "relay-config.json", scriptTarget: "relay.js",
      hostKey: "key", previousKey: "key", adminToken: "token", previousAdminToken: "token"
    });
    const start = instance.start("key");
    const checked = expect(start).rejects.toThrow("did not confirm shutdown");
    await vi.advanceTimersByTimeAsync(6000);
    await checked;
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("reports an occupied port instead of claiming the relay started", async () => {
    vi.useFakeTimers(); unhealthyPort();
    mocks.readFile.mockRejectedValue(new Error("missing"));
    mocks.spawn.mockReturnValue(Object.assign(new EventEmitter(), { unref: vi.fn() }));
    const start = server().start("key");
    const checked = expect(start).rejects.toThrow("port is occupied");
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(9000);
    await checked;
  });

  it("handles a failed process launch and returns the concrete failure", async () => {
    vi.useFakeTimers(); unhealthyPort();
    mocks.readFile.mockRejectedValue(new Error("missing"));
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    mocks.spawn.mockReturnValue(child);
    const start = server().start("key");
    const checked = expect(start).rejects.toThrow("node executable missing");
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    expect(() => child.emit("error", new Error("node executable missing"))).not.toThrow();
    await vi.advanceTimersByTimeAsync(9000);
    await checked;
  });

  it("reports an unconfirmed shutdown instead of announcing that the relay stopped", async () => {
    vi.useFakeTimers(); unhealthyPort();
    mocks.readFile.mockImplementation(async (file: string) => file.endsWith(".pid") ? String(process.pid) : JSON.stringify({ adminToken: "token" }));
    mocks.request.mockImplementation((_options, callback) => Object.assign(new EventEmitter(), {
      destroy: vi.fn(), end: () => queueMicrotask(() => {
        const response = Object.assign(new EventEmitter(), { resume: vi.fn() });
        callback(response); response.emit("end");
      })
    }));
    const stop = server().stop();
    const checked = expect(stop).rejects.toThrow("did not confirm shutdown");
    await vi.advanceTimersByTimeAsync(4500);
    await checked;
  });
});
