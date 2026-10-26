import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ connect: vi.fn(), lstat: vi.fn() }));
vi.unmock("../src/services/codexNativeSessionStatus");
vi.mock("node:net", () => ({ createConnection: mocks.connect }));
vi.mock("node:fs/promises", () => ({ lstat: mocks.lstat, realpath: async (file: string) => file }));
import { cancelNativeCodexSessionTurn, disposeNativeCodexSessionStatus, getNativeCodexSessionRunning, readNativeCodexSessionRunning, startNativeCodexSessionTurn, waitForNativeCodexSessionReady } from "../src/services/codexNativeSessionStatus";

class FakeSocket extends EventEmitter {
  writable = true;
  sent: any[] = [];
  unref() { return this; }
  write(frame: Buffer) { this.sent.push(JSON.parse(frame.subarray(4).toString())); return true; }
  destroy() { if (this.writable) { this.writable = false; this.emit("close"); } return this; }
}

it("uses the verified native owner to accept Continue once in its recorded project", async () => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("idle")); await reading;
  const params = { threadId: id, cwd: home, input: [{ type: "text", text: "Continue", text_elements: [] }], model: "gpt-5", effort: "high" };
  const started = vi.fn();
  const action = startNativeCodexSessionTurn(home, id, params, undefined, started);
  for (let i = 0; i < 50; i++) await Promise.resolve();
  const sent = socket.sent.find(value => value.method === "thread-follower-start-turn");
  expect(sent).toMatchObject({ version: 2, targetClientId: "owner", params: { conversationId: id, turnStart: { request: params, context: { inheritThreadSettings: true } } } });
  message({ type: "response", requestId: sent.requestId, resultType: "success", result: { result: { turn: { id: "native-turn" } } } });
  expect(await action).toBe(true);
  expect(started).toHaveBeenCalledWith("native-turn");
  expect(socket.sent.filter(value => value.method === "thread-follower-start-turn")).toHaveLength(1);
  expect(socket.sent.find(value => value.method === "initialize")).toMatchObject({ version: 0 });
});
it.each([undefined, null, "", " ", 42, "x".repeat(257)])("does not acknowledge a native start without a valid turn ID %j", async turnId => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("idle")); await reading;
  const started = vi.fn();
  const result = expect(startNativeCodexSessionTurn(home, id, { threadId: id, input: [] }, undefined, started)).rejects.toThrow("did not confirm a started turn");
  for (let i = 0; i < 50; i++) await Promise.resolve();
  const sent = socket.sent.find(value => value.method === "thread-follower-start-turn");
  message({ type: "response", requestId: sent.requestId, resultType: "success", result: { result: { turn: { id: turnId } } } });
  await result;
  expect(started).not.toHaveBeenCalled();
  expect(socket.sent.filter(value => value.method === "thread-follower-start-turn")).toHaveLength(1);
});

it.each(["confirmed", "changed", "goal-pause", "timeout", "disconnect"])("stops only the accepted native turn and preserves an unconfirmed outcome (%s)", async outcome => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("active")); await reading;
  const pending = cancelNativeCodexSessionTurn(home, id, "native-turn");
  const result = outcome === "confirmed" ? expect(pending).resolves.toBe(true) : expect(pending).rejects.toThrow();
  for (let i = 0; i < 50; i++) await Promise.resolve();
  const sent = socket.sent.find(value => value.method === "thread-follower-interrupt-turn");
  expect(sent).toMatchObject({ version: 4, targetClientId: "owner", params: { conversationId: id, mode: "user-stop", expectedTurnId: "native-turn" } });
  if (outcome === "timeout") await vi.advanceTimersByTimeAsync(10_001);
  else if (outcome === "disconnect") socket.destroy();
  else message({ type: "response", requestId: sent.requestId, resultType: "success", result: { ok: true, interruptedTurnId: outcome === "changed" ? "new-turn" : "native-turn", ...(outcome === "goal-pause" ? { goalPauseError: "Storage unavailable" } : {}) } });
  await result;
  expect(socket.sent.filter(value => value.method === "thread-follower-interrupt-turn")).toHaveLength(1);
});
it("waits for a loaded conversation instead of treating a published notLoaded tab as ready", async () => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("notLoaded")); await reading;
  let ready = false;
  const waiting = waitForNativeCodexSessionReady(home, id).then(value => { ready = value === true; return value; });
  await vi.advanceTimersByTimeAsync(800); expect(ready).toBe(false);
  message(snapshot("idle", 2)); await vi.advanceTimersByTimeAsync(200);
  expect(await waiting).toBe(true);
});
it("rediscovers a cached notLoaded owner whose resumed snapshot restarts its revision", async () => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("notLoaded", 20)); await reading;
  const write = socket.write.bind(socket);
  const spy = vi.spyOn(socket, "write").mockImplementation(frame => {
    const value = JSON.parse(frame.subarray(4).toString());
    const result = write(frame);
    if (value.method === "thread-owner-discovery") message(snapshot("idle", 1));
    return result;
  });
  try {
    const ready = waitForNativeCodexSessionReady(home, id);
    await vi.advanceTimersByTimeAsync(200);
    expect(await ready).toBe(true);
    expect(socket.sent.some(value => value.method === "thread-follower-start-turn")).toBe(false);
  } finally { spy.mockRestore(); }
});
it("does not dispatch a turn to a known owner that is still loading", async () => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("notLoaded")); await reading;
  await expect(startNativeCodexSessionTurn(home, id, { threadId: id, input: [] })).rejects.toThrow("still loading");
  expect(socket.sent.some(value => value.method === "thread-follower-start-turn")).toBe(false);
});
it("keeps an opening observation through status-cache eviction pressure", async () => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("notLoaded", 20)); await reading;
  const waiting = waitForNativeCodexSessionReady(home, id);
  await vi.advanceTimersByTimeAsync(0);
  for (let n = 0; n < 256; n++) {
    const otherId = `01a04882-d037-7a42-ad24-${String(n).padStart(12, "0")}`;
    const pending = readNativeCodexSessionRunning(home, otherId);
    for (let turn = 0; turn < 15; turn++) await Promise.resolve();
    const value = snapshot("idle"); value.params.conversationId = otherId; value.params.change.conversationState.id = otherId;
    message(value); await pending;
  }
  message(snapshot("idle", 1)); await vi.advanceTimersByTimeAsync(200);
  expect(await waiting).toBe(true);
});
it("waits for a cold native owner beyond the earlier twenty-second cutoff", async () => {
  const waiting = waitForNativeCodexSessionReady(home, id); await initialize();
  let settled = false; void waiting.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(28_000); expect(settled).toBe(false);
  message(snapshot("idle")); await vi.advanceTimersByTimeAsync(200);
  expect(await waiting).toBe(true);
});
it("waits through startup IPC loss and reconnects before confirming readiness without sending a turn", async () => {
  const waiting = waitForNativeCodexSessionReady(home, id, undefined, 120_000);
  await initialize();
  let settled = false; void waiting.then(() => { settled = true; });
  socket.emit("error", new Error("IPC temporarily unavailable"));
  socket = new FakeSocket(); mocks.connect.mockReturnValue(socket);
  await vi.advanceTimersByTimeAsync(200);
  await initialize();
  expect(settled).toBe(false);
  message(snapshot("idle", 0, "reconnected-owner"));
  await vi.advanceTimersByTimeAsync(200);
  expect(await waiting).toBe(true);
  expect(mocks.connect).toHaveBeenCalledTimes(2);
  expect(socket.sent.some(value => value.method === "thread-follower-start-turn")).toBe(false);
});
it("bounds and cancels readiness while native IPC remains unavailable", async () => {
  mocks.connect.mockImplementation(() => { const failed = new FakeSocket(); queueMicrotask(() => failed.emit("error", new Error("offline"))); return failed; });
  const waiting = waitForNativeCodexSessionReady(home, id, undefined, 1000);
  let settled = false; void waiting.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(600); expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(600); expect(await waiting).toBeUndefined();
  const controller = new AbortController();
  const cancelled = expect(waitForNativeCodexSessionReady(home, id, controller.signal, 120_000)).rejects.toThrow("manual action");
  await vi.advanceTimersByTimeAsync(200); controller.abort(new Error("manual action")); await cancelled;
});
it("keeps background native observations connected without dashboard reads", async () => {
  const reading = readNativeCodexSessionRunning(home,id); await initialize(); message(snapshot("active")); await reading;
  await vi.advanceTimersByTimeAsync(90_000);
  expect(socket.writable).toBe(true);
  expect(getNativeCodexSessionRunning(home,id)).toBe(true);
  message(snapshot("idle",2));
  expect(getNativeCodexSessionRunning(home,id)).toBe(false);
  expect(mocks.connect).toHaveBeenCalledOnce();
  disposeNativeCodexSessionStatus();
  expect(socket.writable).toBe(false);
  expect(getNativeCodexSessionRunning(home,id)).toBeUndefined();
});
it("evicts idle history before active observations while retaining its fixed cache limit", async () => {
  const reading=readNativeCodexSessionRunning(home,id);await initialize();message(snapshot("active"));await reading;
  for(let n=0;n<260;n++){
    const otherId=`01a04882-d037-7a42-ad24-${String(n).padStart(12,"0")}`;
    const pending=readNativeCodexSessionRunning(home,otherId);
    for(let turn=0;turn<20;turn++)await Promise.resolve();
    const value=snapshot("idle");value.params.conversationId=otherId;value.params.change.conversationState.id=otherId;
    message(value);await pending;
  }
  expect(getNativeCodexSessionRunning(home,id)).toBe(true);
  expect(socket.sent.some(value=>value.params?.conversationId===id && value.params.following===false)).toBe(false);
  expect(socket.sent.filter(value=>value.params?.following===false).length).toBe(5);
});
it("allows automatic recovery to wait for a hundred-second renderer and still bounds and cancels it", async () => {
  const waiting = waitForNativeCodexSessionReady(home,id,undefined,120_000); await initialize();
  await vi.advanceTimersByTimeAsync(100_000);
  message(snapshot("idle")); await vi.advanceTimersByTimeAsync(200);
  expect(await waiting).toBe(true);
  message(snapshot("notLoaded",2));
  const stalled = waitForNativeCodexSessionReady(home,id,undefined,120_000);
  await vi.advanceTimersByTimeAsync(123_000);
  expect(await stalled).toBe(false);
  const controller = new AbortController();
  const cancelled = expect(waitForNativeCodexSessionReady(home,id,controller.signal,120_000)).rejects.toThrow("manual action");
  await vi.advanceTimersByTimeAsync(0); controller.abort(new Error("manual action")); await cancelled;
  expect(socket.sent.some(value => value.method === "thread-follower-start-turn")).toBe(false);
});
it("bounds a blank tab readiness wait and cancels it without dispatching a turn", async () => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("notLoaded")); await reading;
  const waiting = waitForNativeCodexSessionReady(home, id);
  await vi.advanceTimersByTimeAsync(40_000); expect(await waiting).toBe(false);
  const controller = new AbortController();
  const cancelled = expect(waitForNativeCodexSessionReady(home, id, controller.signal)).rejects.toThrow("cancel opening");
  await vi.advanceTimersByTimeAsync(0); controller.abort(new Error("cancel opening")); await cancelled;
  expect(socket.sent.some(value => value.method === "thread-follower-start-turn")).toBe(false);
});
it("waits for a late native owner instead of racing it with a second writer", async () => {
  const waiting = waitForNativeCodexSessionReady(home, id); await initialize();
  await vi.advanceTimersByTimeAsync(8_000);
  message(snapshot("idle")); await vi.advanceTimersByTimeAsync(200);
  expect(await waiting).toBe(true);
  expect(socket.sent.filter(value => value.method === "thread-owner-discovery").length).toBeGreaterThan(1);
  expect(socket.sent.some(value => value.method === "thread-follower-start-turn")).toBe(false);
});
it("does not send to a running native owner", async () => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("active")); await reading;
  await expect(startNativeCodexSessionTurn(home, id, { threadId: id, input: [] })).rejects.toThrow("already working");
  expect(socket.sent.some(value => value.method === "thread-follower-start-turn")).toBe(false);
});
it.each(["timeout", "cancel", "disconnect", "rejected"])("never resends an uncertain native request after %s", async failure => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("idle")); await reading;
  const controller = new AbortController();
  const action = expect(startNativeCodexSessionTurn(home, id, { threadId: id, input: [] }, controller.signal)).rejects.toThrow();
  for (let i = 0; i < 50; i++) await Promise.resolve();
  const sent = socket.sent.find(value => value.method === "thread-follower-start-turn");
  if (failure === "timeout") await vi.advanceTimersByTimeAsync(10_001);
  if (failure === "cancel") controller.abort();
  if (failure === "disconnect") socket.destroy();
  if (failure === "rejected") message({ type: "response", requestId: sent.requestId, resultType: "error", error: "Owner changed" });
  await action;
  expect(socket.sent.filter(value => value.method === "thread-follower-start-turn")).toHaveLength(1);
});
it("declines discovery requests without delaying other clients", async () => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("idle")); await reading;
  message({ type: "client-discovery-request", requestId: "other-request" });
  expect(socket.sent.at(-1)).toEqual({ type: "client-discovery-response", requestId: "other-request", response: { canHandle: false } });
});
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
  for (let i = 0; i < 50; i++) await Promise.resolve();
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
  for (let i = 0; i < 50; i++) await Promise.resolve();
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
  for (let i = 0; i < 50; i++) await Promise.resolve();
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
    for (let tick = 0; tick < 50; tick++) await Promise.resolve();
    const value = snapshot("active"); value.params.conversationId = conversationId; value.params.change.conversationState.id = conversationId;
    message(value); expect(await pending).toBe(true);
  }
  expect(socket.sent.some(value => value.params?.conversationId === id && value.params.following === false)).toBe(true);
});
