import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ connect: vi.fn(), lstat: vi.fn(), realpath: vi.fn() }));
vi.unmock("../src/services/codexNativeSessionStatus");
vi.mock("node:net", () => ({ createConnection: mocks.connect }));
vi.mock("node:fs/promises", () => ({ lstat: mocks.lstat, realpath: mocks.realpath }));
import { cancelNativeCodexSessionTurn, disposeNativeCodexSessionStatus, getNativeCodexSessionTurnId, getNativeCodexSessionRunning, readNativeCodexSessionRunning, startNativeCodexSessionTurn, steerNativeCodexSessionTurn, waitForNativeCodexSessionReady } from "../src/services/codexNativeSessionStatus";

import { listPendingCodexAppServerPrompts, respondCodexAppServerPrompt } from "../src/services/codexAppServerPrompts";

class FakeSocket extends EventEmitter {
  writable = true;
  sent: any[] = [];
  unref() { return this; }
  write(frame: Buffer) { this.sent.push(JSON.parse(frame.subarray(4).toString())); return true; }
  destroy() { if (this.writable) { this.writable = false; this.emit("close"); } return this; }
}

it.each(['confirmed','changed','timeout','disconnect'])('steers a running native turn once and reports %s outcomes',async outcome=>{
  const reading=readNativeCodexSessionRunning(home,id);await initialize();message(snapshot('active'));await reading;
  const pending=steerNativeCodexSessionTurn(home,id,'native-turn',[{type:'text',text:'Follow up'}],home);
  const result=outcome==='confirmed'||outcome==='changed'?expect(pending).resolves.toBe(true):expect(pending).rejects.toThrow();
  for(let i=0;i<50;i++)await Promise.resolve();
  const sent=socket.sent.find(value=>value.method==='thread-follower-steer-turn');
  expect(sent).toMatchObject({version:1,targetClientId:'owner',params:{conversationId:id,input:[{type:'text',text:'Follow up'}],restoreMessage:{cwd:home,context:{workspaceRoots:[home]}}}});
  if(outcome==='timeout')await vi.advanceTimersByTimeAsync(10_001);
  else if(outcome==='disconnect')socket.destroy();
  else message({type:'response',requestId:sent.requestId,resultType:'success',result:{result:{turnId:outcome==='changed'?'another-turn':'native-turn'}}});
  await result;
  expect(socket.sent.filter(value=>value.method==='thread-follower-steer-turn')).toHaveLength(1);
});

it('refuses native steering after a turn finishes without sending another message',async()=>{
  const reading=readNativeCodexSessionRunning(home,id);await initialize();message(snapshot('idle'));await reading;
  await expect(steerNativeCodexSessionTurn(home,id,'native-turn',[],home)).rejects.toThrow('finished');
  expect(socket.sent.some(value=>value.method==='thread-follower-steer-turn')).toBe(false);
});

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
  const stopped = vi.fn();
  const pending = cancelNativeCodexSessionTurn(home, id, "native-turn", stopped);
  const result = outcome === "confirmed" ? expect(pending).resolves.toBe(true) : expect(pending).rejects.toThrow();
  for (let i = 0; i < 50; i++) await Promise.resolve();
  const sent = socket.sent.find(value => value.method === "thread-follower-interrupt-turn");
  expect(sent).toMatchObject({ version: 4, targetClientId: "owner", params: { conversationId: id, mode: "user-stop", expectedTurnId: "native-turn" } });
  if (outcome === "timeout") await vi.advanceTimersByTimeAsync(10_001);
  else if (outcome === "disconnect") socket.destroy();
  else message({ type: "response", requestId: sent.requestId, resultType: "success", result: { ok: true, interruptedTurnId: outcome === "changed" ? "new-turn" : "native-turn", ...(outcome === "goal-pause" ? { goalPauseError: "Storage unavailable" } : {}) } });
  await result;
  expect(stopped).toHaveBeenCalledTimes(outcome === "confirmed" || outcome === "goal-pause" ? 1 : 0);
  if (outcome === "confirmed" || outcome === "goal-pause") expect(getNativeCodexSessionRunning(home, id)).toBe(false);
  if (outcome === "changed" || outcome === "timeout") expect(getNativeCodexSessionRunning(home, id)).toBe(true);
  expect(socket.sent.filter(value => value.method === "thread-follower-interrupt-turn")).toHaveLength(1);
});
it.each(["same-owner", "new-owner"])("does not overwrite newer runtime activity when an older Stop replies (%s)", async scenario => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("active")); await reading;
  const pending = cancelNativeCodexSessionTurn(home, id, "old-turn");
  for (let i = 0; i < 50; i++) await Promise.resolve();
  const sent = socket.sent.find(value => value.method === "thread-follower-interrupt-turn");
  const newer = snapshot("active", 2);
  if (scenario === "new-owner") newer.sourceClientId = "another-owner";
  message(newer);
  message({ type: "response", requestId: sent.requestId, resultType: "success", result: { ok: true, interruptedTurnId: "old-turn" } });
  expect(await pending).toBe(true);
  expect(getNativeCodexSessionRunning(home, id)).toBe(true);
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
    hostId: "local", conversationId: id, change: { type: "snapshot", revision, conversationState: { id, rolloutPath, threadRuntimeStatus: { type }, turns: type === "active" ? [{ turnId: "native-turn", status: "inProgress" }] : [] } }
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
  mocks.realpath.mockReset().mockImplementation(async (file: string) => file);
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
  const pending = readNativeCodexSessionRunning(home, id); await initialize(); const huge = Buffer.alloc(4); huge.writeUInt32LE(128 * 1024 * 1024 + 1);
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

it.each([
  ["item/commandExecution/requestApproval", "thread-follower-command-approval-decision", { command: "npm test" }],
  ["item/fileChange/requestApproval", "thread-follower-file-approval-decision", { fileChanges: { "a.ts": {} } }],
  ["item/permissions/requestApproval", "thread-follower-permissions-request-approval-response", { permissions: { network: { enabled: true } } }],
  ["item/tool/requestUserInput", "thread-follower-submit-user-input", { questions: [{ id: "choice", question: "Which?" }] }]
])("mirrors and answers official native %s requests once", async (method, replyMethod, params) => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize();
  const value = snapshot("active");
  Object.assign(value.params.change.conversationState, { requests: [{ id: "native-request", method, params: { threadId: id, ...params } }] });
  message(value); await reading;
  const prompt = listPendingCodexAppServerPrompts()[0]!;
  expect(prompt).toMatchObject({ threadId: id });
  const responding = respondCodexAppServerPrompt(prompt.id, "approve", { choice: "First" });
  const duplicate = respondCodexAppServerPrompt(prompt.id, "approve", { choice: "First" });
  for (let i = 0; i < 50; i++) await Promise.resolve();
  const sent = socket.sent.find(item => item.method === replyMethod);
  expect(sent).toMatchObject({ targetClientId: "owner", version: 1, params: { conversationId: id, requestId: "native-request" } });
  message({ type: "response", requestId: sent.requestId, resultType: "success", result: { ok: true } });
  await Promise.all([responding, duplicate]);
  expect(socket.sent.filter(item => item.method === replyMethod)).toHaveLength(1);
  expect(listPendingCodexAppServerPrompts()).toEqual([]);
});
it.each(["disconnect", "owner-change", "revision-gap", "request-change"])("invalidates native prompts after %s without answering the old owner", async failure => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize();
  const value = snapshot("active");
  const requests = [{ id: "native-request", method: "item/commandExecution/requestApproval", params: { threadId: id, command: "npm test" } }];
  Object.assign(value.params.change.conversationState, { requests }); message(value); await reading;
  const prompt = listPendingCodexAppServerPrompts()[0]!;
  if (failure === "disconnect") socket.destroy();
  if (failure === "owner-change") message(snapshot("active", 0, "new-owner"));
  if (failure === "revision-gap") message({ ...snapshot("active"), params: { hostId: "local", conversationId: id, change: { type: "patches", baseRevision: 8, revision: 9, patches: [] } } });
  if (failure === "request-change") { const updated = snapshot("active", 2); Object.assign(updated.params.change.conversationState, { requests: [{ ...requests[0], params: { threadId: id, command: "other" } }] }); message(updated); }
  expect(() => respondCodexAppServerPrompt(prompt.id, "approve")).toThrow("no longer active");
  expect(socket.sent.some(item => item.method === "thread-follower-command-approval-decision")).toBe(false);
});
it("keeps an uncertain native prompt response from being sent again", async () => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize();
  const value = snapshot("active");
  Object.assign(value.params.change.conversationState, { requests: [{ id: 2, method: "item/commandExecution/requestApproval", params: { threadId: id, command: "npm test" } }] });
  message(value); await reading;
  const prompt = listPendingCodexAppServerPrompts()[0]!;
  const pending = expect(respondCodexAppServerPrompt(prompt.id, "decline")).rejects.toThrow("did not confirm");
  await vi.advanceTimersByTimeAsync(10_001); await pending;
  await expect(respondCodexAppServerPrompt(prompt.id, "decline")).rejects.toThrow("did not confirm");
  expect(socket.sent.filter(item => item.method === "thread-follower-command-approval-decision")).toHaveLength(1);
});

it.each(["legacy", "canonical", "canonical-orphan", "canonical-partial", "canonical-terminal", "canonical-missing-newest-id", "missing", "completed-newest", "missing-newest-id", "null-newest", "invalid"])("derives native steering proof from the current owner snapshot (%s)", async scenario => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize();
  const current: any = snapshot("active");
  if (scenario.startsWith("canonical")) {
    current.params.change.conversationState.turns = [];
    current.params.change.conversationState.turnHistory = { kind: "canonical", history: { islands: [{ newerBoundary: { status: "exhausted" }, entries: [{ value: "old" }, { value: "active" }] }], entitiesByKey: { old: { turnId: "old", status: "completed" }, active: { turnId: "native-turn", status: "inProgress" }, orphan: { turnId: "orphan-turn", status: "inProgress" } } } };
  }
  if (scenario === "canonical-orphan") current.params.change.conversationState.turnHistory.history.islands[0].entries = [{ value: "old" }];
  if (scenario === "canonical-partial") current.params.change.conversationState.turnHistory.history.islands[0].newerBoundary.status = "unknown";
  if (scenario === "canonical-terminal") current.params.change.conversationState.turnHistory.history.entitiesByKey.active.status = "completed";
  if (scenario === "canonical-missing-newest-id") {
    current.params.change.conversationState.turnHistory.history.islands[0].entries.push({ value: "latest" });
    current.params.change.conversationState.turnHistory.history.entitiesByKey.latest = { status: "completed" };
  }
  if (scenario === "missing-newest-id") current.params.change.conversationState.turns.push({status:"completed"});
  if (scenario === "null-newest") current.params.change.conversationState.turns.push(null);
  if (scenario === "missing") current.params.change.conversationState.turns = [];
  if (scenario === "completed-newest") current.params.change.conversationState.turns.push({ turnId: "newer-completed", status: "completed" });
  if (scenario === "invalid") current.params.change.conversationState.turns[0].turnId = " ";
  message(current); expect(await reading).toBe(true);
  expect(getNativeCodexSessionTurnId(home, id)).toBe(scenario === "legacy" || scenario === "canonical" ? "native-turn" : undefined);
  expect(getNativeCodexSessionTurnId(path.join(home, "other"), id)).toBeUndefined();
  if (scenario !== "legacy" && scenario !== "canonical") {
    await expect(steerNativeCodexSessionTurn(home, id, "native-turn", [], home)).rejects.toThrow(/could not be verified/);
    expect(socket.sent.some(value => value.method === "thread-follower-steer-turn")).toBe(false);
  }
});

it.each(["turn", "canonical", "owner", "gap", "runtime", "home", "disconnect", "reset"])("revokes old native steering proof when %s changes", async scenario => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("active")); await reading;
  expect(getNativeCodexSessionTurnId(home, id)).toBe("native-turn");
  if (scenario === "owner") {
    const other: any = snapshot("active", 2, "another-owner"); other.params.change.conversationState.turns = []; message(other);
  } else if (scenario === "disconnect") socket.destroy();
  else if (scenario === "reset") message({ type: "broadcast", method: "ipc-connection-reset", version: 1 });
  else message({ type: "broadcast", version: 11, sourceClientId: "owner", method: "thread-stream-state-changed", params: { hostId: "local", conversationId: id, change: {
    type: "patches", baseRevision: scenario === "gap" ? 0 : 1, revision: 2,
    patches: [{ op: "replace", path: scenario === "turn" ? ["turns", 0, "turnId"] : scenario === "canonical" ? ["turnHistory", "history", "entitiesByKey", "active", "status"] : scenario === "home" ? ["rolloutPath"] : ["threadRuntimeStatus"], value: scenario === "runtime" ? { type: "idle" } : "changed" }]
  } } });
  expect(getNativeCodexSessionTurnId(home, id)).toBeUndefined();
  if (scenario === "turn" || scenario === "canonical") {
    const newer = snapshot("active", 2); newer.params.change.conversationState.turns[0]!.turnId = "new-turn";
    message(newer); expect(getNativeCodexSessionTurnId(home, id)).toBe("new-turn");
    await expect(steerNativeCodexSessionTurn(home, id, "native-turn", [], home)).rejects.toThrow(/changed/);
    expect(socket.sent.some(value => value.method === "thread-follower-steer-turn")).toBe(false);
  }
});

it.each(["owner", "turn", "home", "disconnect"])("does not send native guidance if %s changes during final canonical preflight", async scenario => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("active")); await reading;
  mocks.realpath.mockImplementationOnce(async (file: string) => {
    if (scenario === "home") return path.join(home, "changed-home");
    if (scenario === "disconnect") socket.destroy();
    else {
      const newer = snapshot("active", 2, scenario === "owner" ? "another-owner" : "owner");
      if (scenario === "turn") newer.params.change.conversationState.turns[0]!.turnId = "new-turn";
      message(newer);
    }
    return file;
  });
  const pending = steerNativeCodexSessionTurn(home, id, "native-turn", [], home);
  if (scenario === "home" || scenario === "disconnect") await expect(pending).resolves.toBe(false);
  else await expect(pending).rejects.toThrow(/changed/);
  expect(socket.sent.some(value => value.method === "thread-follower-steer-turn")).toBe(false);
});

it.each([undefined, null, "", " ", 42, "x".repeat(257)])("keeps an invalid native guidance acknowledgment inconclusive without replay (%j)", async turnId => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("active")); await reading;
  const result = expect(steerNativeCodexSessionTurn(home, id, "native-turn", [], home)).rejects.toThrow(/unconfirmed/);
  for (let i = 0; i < 50; i++) await Promise.resolve();
  const sent = socket.sent.find(value => value.method === "thread-follower-steer-turn");
  message({ type: "response", requestId: sent.requestId, resultType: "success", result: { result: { turnId } } });
  await result;
  expect(socket.sent.filter(value => value.method === "thread-follower-steer-turn")).toHaveLength(1);
});

it("retains native turn proof for ordinary activity patches and refuses a full request queue", async () => {
  const reading = readNativeCodexSessionRunning(home, id); await initialize(); message(snapshot("active")); await reading;
  message({ type: "broadcast", version: 11, sourceClientId: "owner", method: "thread-stream-state-changed", params: { hostId: "local", conversationId: id, change: {
    type: "patches", baseRevision: 1, revision: 2, patches: [{ op: "add", path: ["turns", 0, "items", 0], value: { type: "agentMessage" } }]
  } } });
  expect(getNativeCodexSessionTurnId(home, id)).toBe("native-turn");
  Object.assign(socket, { writableLength: 4 * 1024 * 1024 + 1 });
  await expect(steerNativeCodexSessionTurn(home, id, "native-turn", [], home)).rejects.toThrow(/queue is full/);
  expect(socket.sent.some(value => value.method === "thread-follower-steer-turn")).toBe(false);
});
