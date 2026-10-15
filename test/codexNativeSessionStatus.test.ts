import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ connect: vi.fn(), lstat: vi.fn() }));
vi.unmock("../src/services/codexNativeSessionStatus");
vi.mock("node:net", () => ({ createConnection: mocks.connect }));
vi.mock("node:fs/promises", () => ({ lstat: mocks.lstat }));
import { disposeNativeCodexSessionStatus, readNativeCodexSessionRunning } from "../src/services/codexNativeSessionStatus";

class FakeSocket extends EventEmitter {
  writable = true;
  sent: any[] = [];
  unref() { return this; }
  write(frame: Buffer) { this.sent.push(JSON.parse(frame.subarray(4).toString())); return true; }
  destroy() { if (this.writable) { this.writable = false; this.emit("close"); } return this; }
}
let socket: FakeSocket;
const home = path.join(os.tmpdir(), "native-status-home");
const id = "01a04882-d037-7a42-ad24-9afb61901188";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
function frame(value: unknown) {
  const body = Buffer.from(JSON.stringify(value)); const result = Buffer.alloc(body.length + 4);
  result.writeUInt32LE(body.length); body.copy(result, 4); return result;
}
function message(value: unknown) { socket.emit("data", frame(value)); }
function snapshot(type: string, revision = 1, source = "owner", rolloutPath = path.join(home, "sessions", "turn.jsonl")) {
  return { type: "broadcast", version: 11, sourceClientId: source, method: "thread-stream-state-changed", params: {
    hostId: "local", conversationId: id, change: { type: "snapshot", revision, conversationState: { id, rolloutPath, threadRuntimeStatus: { type } } }
  } };
}
async function initialize() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  socket.emit("connect");
  message({ type: "response", method: "initialize", result: { clientId: "observer" } });
}
beforeEach(() => {
  vi.useFakeTimers();
  socket = new FakeSocket(); mocks.connect.mockReset().mockReturnValue(socket);
  mocks.lstat.mockReset().mockImplementation(async (file: string) => ({ uid: 1000, mode: 0o700, isSocket: () => file.endsWith(".sock"), isDirectory: () => !file.endsWith(".sock") }));
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 1000 });
});
afterEach(() => {
  disposeNativeCodexSessionStatus(); vi.useRealTimers();
  Object.defineProperty(process, "platform", platform);
  if (getuid) Object.defineProperty(process, "getuid", getuid); else delete (process as any).getuid;
});

it.each(["win32", "darwin", "linux"])("reads active and idle native sessions over %s IPC", async platformName => {
  Object.defineProperty(process, "platform", { value: platformName });
  const pending = readNativeCodexSessionRunning(home, id); await initialize();
  message(snapshot("idle")); expect(await pending).toBe(false);
  message(snapshot("active", 2)); expect(await readNativeCodexSessionRunning(home, id)).toBe(true);
  expect(mocks.connect).toHaveBeenCalledWith(platformName === "win32" ? "\\\\.\\pipe\\codex-ipc" : path.join(home, "ipc", "ipc.sock"));
  expect(socket.sent.some(value => value.method === "thread-stream-following-changed" && value.params.following)).toBe(true);
  expect(socket.sent.some(value => value.method?.includes("start-turn"))).toBe(false);
});
it("decodes split headers and UTF-8 frames, and coalesces reads", async () => {
  const first = readNativeCodexSessionRunning(home, id), second = readNativeCodexSessionRunning(home, id); await initialize();
  const data = frame(snapshot("idle")); for (let offset = 0; offset < data.length; offset += 3) socket.emit("data", data.subarray(offset, offset + 3));
  expect(await Promise.all([first, second])).toEqual([false, false]); expect(mocks.connect).toHaveBeenCalledOnce();
});
it("cancels one waiter without unfollowing the remaining consumer, then retries after last cancellation", async () => {
  const first = new AbortController(), second = new AbortController();
  const one = readNativeCodexSessionRunning(home, id, first.signal);
  const two = readNativeCodexSessionRunning(home, id, second.signal);
  await initialize();
  first.abort();
  expect(await one).toBeUndefined();
  expect(socket.sent.some(value => value.params?.following === false)).toBe(false);
  second.abort();
  expect(await two).toBeUndefined();
  expect(socket.sent.some(value => value.params?.following === false)).toBe(true);
  const retry = readNativeCodexSessionRunning(home, id);
  message(snapshot("idle"));
  expect(await retry).toBe(false);
});
it("applies ordered runtime patches and ignores duplicate or stale snapshots", async () => {
  const pending = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("active", 4)); expect(await pending).toBe(true);
  message({ ...snapshot("active"), params: { hostId: "local", conversationId: id, change: { type: "patches", baseRevision: 4, revision: 5, patches: [{ op: "replace", path: ["threadRuntimeStatus"], value: { type: "idle" } }] } } });
  message(snapshot("active", 4)); message(snapshot("active", 5)); expect(await readNativeCodexSessionRunning(home, id)).toBe(false);
});
it("rechecks after a missing patch or owner disconnect instead of retaining idle state", async () => {
  const pending = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("idle")); expect(await pending).toBe(false);
  message({ ...snapshot("active"), params: { hostId: "local", conversationId: id, change: { type: "patches", baseRevision: 3, revision: 4, patches: [] } } });
  const refresh = readNativeCodexSessionRunning(home, id); message(snapshot("active", 5)); expect(await refresh).toBe(true);
  message({ type: "broadcast", method: "client-status-changed", params: { status: "disconnected", clientId: "owner" } });
  const newOwner = readNativeCodexSessionRunning(home, id); message(snapshot("idle", 0, "new-owner")); expect(await newOwner).toBe(false);
});
it.each(["wrong-home", "unknown-status", "wrong-host", "wrong-version"])("rejects %s snapshots and bounds inconclusive reads", async failure => {
  const pending = readNativeCodexSessionRunning(home, id); await initialize(); const value = snapshot("idle");
  if (failure === "wrong-home") value.params.change.conversationState.rolloutPath = path.resolve(home, "..", "foreign", "turn.jsonl");
  if (failure === "unknown-status") value.params.change.conversationState.threadRuntimeStatus.type = "future-state";
  if (failure === "wrong-host") value.params.hostId = "remote";
  if (failure === "wrong-version") value.version = 12;
  message(value); await vi.advanceTimersByTimeAsync(3000); expect(await pending).toBeUndefined();
});
it("settles pending reads on connection failure or oversized frames", async () => {
  const pending = readNativeCodexSessionRunning(home, id); await initialize(); const huge = Buffer.alloc(4); huge.writeUInt32LE(64 * 1024 * 1024 + 1);
  socket.emit("data", huge); expect(await pending).toBeUndefined(); expect(socket.writable).toBe(false);
});
it("does not connect to a Unix socket writable by another user", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" }); mocks.lstat.mockResolvedValue({ uid: 1000, mode: 0o777, isSocket: () => true, isDirectory: () => true });
  expect(await readNativeCodexSessionRunning(home, id)).toBeUndefined(); expect(mocks.connect).not.toHaveBeenCalled();
});

it("settles lost connections and accepts a fresh owner after reconnecting", async () => {
  const pending = readNativeCodexSessionRunning(home, id); await initialize();
  socket.emit("error", new Error("IPC disconnected")); expect(await pending).toBeUndefined();
  socket = new FakeSocket(); mocks.connect.mockReturnValue(socket);
  const retry = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("active", 0, "new-owner"));
  expect(await retry).toBe(true); expect(mocks.connect).toHaveBeenCalledTimes(2);
});

it("bounds a missing handshake and does not retain a stale root replacement", async () => {
  const handshake = readNativeCodexSessionRunning(home, id);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(3000); expect(await handshake).toBeUndefined();
  socket = new FakeSocket(); mocks.connect.mockReturnValue(socket);
  const retry = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("active")); expect(await retry).toBe(true);
  message({ ...snapshot("active"), params: { hostId: "local", conversationId: id, change: { type: "patches", baseRevision: 1, revision: 2, patches: [{ op: "replace", path: [], value: {} }] } } });
  const refresh = readNativeCodexSessionRunning(home, id); message(snapshot("idle", 3)); expect(await refresh).toBe(false);
});

it("releases the oldest settled observation when the native subscription cache fills", async () => {
  const initial = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("idle")); expect(await initial).toBe(false);
  for (let index = 0; index < 256; index++) {
    const conversationId = `01a04882-d037-7a42-ad24-${String(index).padStart(12, "0")}`;
    const pending = readNativeCodexSessionRunning(home, conversationId);
    const value = snapshot("active"); value.params.conversationId = conversationId; value.params.change.conversationState.id = conversationId;
    message(value); expect(await pending).toBe(true);
  }
  expect(socket.sent.some(value => value.params?.conversationId === id && value.params.following === false)).toBe(true);
});
