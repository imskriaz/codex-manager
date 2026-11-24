import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), get: vi.fn(), request: vi.fn(), readFile: vi.fn(), unlink: vi.fn() }));
vi.mock("child_process", async () => ({ ...await vi.importActual<typeof import("child_process")>("child_process"), spawn: mocks.spawn }));
vi.mock("http", () => ({ get: mocks.get, request: mocks.request }));
vi.mock("fs/promises", async () => ({ ...await vi.importActual<typeof import("fs/promises")>("fs/promises"), readFile: mocks.readFile, unlink: mocks.unlink }));
vi.mock("../src/utils/storageRoot", () => ({ getCodexManagerStorageRoot: () => "relay-test-storage" }));
import { AlwaysOnlineServer } from "../src/services/alwaysOnlineServer";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); });

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
    executable: process.execPath, port: 39875, pidPath: "missing-relay.pid", configPath: "relay-config.json", scriptTarget: "relay.js", hostKey: "key", adminToken: "token"
  });
  return instance;
}

describe("detached relay terminal outcomes", () => {
  it("accepts a valid Node snapshot and confirms its authenticated shutdown", async () => {
    vi.useFakeTimers();
    let live = true;
    mocks.readFile.mockImplementation(async (file: string) => {
      if (!file.endsWith('.pid')) return JSON.stringify({ adminToken: 'token', mode: 'node' });
      if (live) return String(process.pid);
      throw Object.assign(new Error('Missing'), { code: 'ENOENT' });
    });
    mocks.get.mockImplementation((_options, callback) => {
      const request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      queueMicrotask(() => {
        if (!live) { request.emit('error', Object.assign(new Error('Closed'), { code: 'ECONNREFUSED' })); return; }
        const response = Object.assign(new EventEmitter(), { statusCode: 200, setEncoding: vi.fn() });
        callback(response); response.emit('data', JSON.stringify({ accounts: [], settings: {}, panelTitle: 'Codex Manager' })); response.emit('end');
      });
      return request;
    });
    mocks.request.mockImplementation((_options, callback) => Object.assign(new EventEmitter(), {
      destroy: vi.fn(), end: () => {
        live = false;
        const response = Object.assign(new EventEmitter(), { resume: vi.fn() });
        callback(response); response.emit('end');
      }
    }));
    const checked = server().prepareForVscodeSession();
    await vi.advanceTimersByTimeAsync(200);
    await checked;
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.request.mock.calls[0]![0].headers['X-Codex-Admin']).toBe('token');
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("rejects unrelated HTTP 200 pages as Node hosts and bounds a stalled occupancy check", async () => {
    vi.useFakeTimers();
    mocks.readFile.mockImplementation(async (file: string) => file.endsWith(".pid") ? String(process.pid) : JSON.stringify({ adminToken: "token", mode: "node" }));
    let probes = 0;
    mocks.get.mockImplementation((_options, callback) => {
      const request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      if (++probes % 2) {
        queueMicrotask(() => {
          const response = Object.assign(new EventEmitter(), { statusCode: 200, setEncoding: vi.fn(), resume: vi.fn() });
          callback(response); response.emit("data", "<html>Unrelated server</html>"); response.emit("end");
        });
      }
      return request;
    });
    mocks.request.mockImplementation(() => Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() }));
    const checked = expect(server().prepareForVscodeSession()).rejects.toThrow("did not confirm shutdown");
    await vi.advanceTimersByTimeAsync(6000);
    await checked;
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it.each([false, true])("ignores an orphaned or reused PID when the dashboard port is free (dead: %s)", async dead => {
    mocks.readFile.mockImplementation(async (file: string) => file.endsWith(".pid") ? String(process.pid) : JSON.stringify({ adminToken: "token", mode: "node" }));
    mocks.unlink.mockResolvedValue(undefined);
    vi.spyOn(process, "kill").mockImplementation(() => {
      if (dead) throw Object.assign(new Error("No such process"), { code: "ESRCH" });
      return true;
    });
    mocks.get.mockImplementation(() => {
      const request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      queueMicrotask(() => request.emit("error", Object.assign(new Error("Port free"), { code: "ECONNREFUSED" })));
      return request;
    });
    await expect(server().prepareForVscodeSession()).resolves.toBeUndefined();
    expect(mocks.unlink).toHaveBeenCalledWith(expect.stringContaining("always-online-relay.pid"));
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("retains a replacement PID written while stale cleanup was checking the port", async () => {
    let reads = 0;
    mocks.readFile.mockImplementation(async (file: string) => file.endsWith(".pid") ? String(++reads === 1 ? process.pid : process.pid + 1) : JSON.stringify({ adminToken: "token", mode: "node" }));
    vi.spyOn(process, "kill").mockReturnValue(true);
    mocks.get.mockImplementation(() => {
      const request = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      queueMicrotask(() => request.emit("error", Object.assign(new Error("Port free"), { code: "ECONNREFUSED" })));
      return request;
    });
    await expect(server().prepareForVscodeSession()).resolves.toBeUndefined();
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

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
