import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vm from "node:vm";
import { describe, expect, it } from "vitest";
import { isCodexSessionLiveState, isNewerCodexSessionLiveState } from "../src/domain/codexSessionLive";

type Json = Record<string, any>;
const source = readFileSync("tools/always-online-server.js", "utf8");
const sessionId = "12345678-1234-1234-1234-123456789abc";
const streamId = "22345678-1234-1234-1234-123456789abc";

function harness(contractAvailable = true) {
  let now = 1700000000000;
  const hostKey = Buffer.from("isolated-relay-test-key").toString("base64url");
  const timers = new Map<object, () => void>();
  let requestHandler: (request: EventEmitter & Json, response: Json) => void;
  class Socket extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    sent: Json[] = [];
    throws = false;
    send(raw: string) { if (this.throws) throw new Error("send failed"); this.sent.push(JSON.parse(raw)); }
    terminate() { if (!this.readyState) return; this.readyState = 0; this.emit("close"); }
    close() { this.terminate(); }
    receive(message: Json) { this.emit("message", JSON.stringify(message)); }
  }
  class Server extends EventEmitter { clients = new Set<Socket>(); close(callback: () => void) { callback(); } }
  const server = new EventEmitter() as EventEmitter & Json;
  server.listen = () => undefined;
  server.close = (callback: () => void) => callback();
  const processStub = { argv: ["node", "relay.js", "config.json"], once() {}, exit() {}, exitCode: 0, pid: 1234 };
  const mockRequire = Object.assign((id: string) => {
    if (id === "node:http") return { createServer(handler: typeof requestHandler) { requestHandler = handler; return server; } };
    if (id === "node:fs") return { readFileSync() { return JSON.stringify({ hostKey, modulePaths: ["fixture"] }); }, writeFileSync() {} };
    if (id === "node:crypto") return crypto;
    if (id === "node:path") return path;
    if (id === "mock-ws") return { WebSocketServer: Server };
    if (id.endsWith("codexSessionLive.js") && contractAvailable) return { isCodexSessionLiveState, isNewerCodexSessionLiveState };
    throw new Error("dependency unavailable");
  }, { resolve: () => "mock-ws" });
  class Clock extends Date { static override now() { return now; } }
  const context = vm.createContext({ require: mockRequire, Buffer, URL, console, process: processStub,
    __dirname: "fixture/tools", Date: Clock,
    setTimeout(callback: () => void) { const timer = { unref() {} }; timers.set(timer, callback); return timer; },
    clearTimeout(timer: object) { timers.delete(timer); }, setInterval() { return { unref() {} }; }, setImmediate() {} });
  const relay = vm.runInContext(`(function(){${source}\nreturn { wsServer, peers, replayEvents, eventRevisions, pendingActions, pruneEvents };})()`, context);
  const signed = (deviceId: string, sentAt = now) => {
    const message: Json = { type: "peer:sessions", deviceId, deviceName: deviceId, sessions: [], accounts: [], enablementRegistry: [], sentAt };
    message.signature = createHmac("sha256", Buffer.from(hostKey, "base64url")).update(JSON.stringify(message)).digest("base64url");
    return message;
  };
  const connect = (deviceId?: string) => {
    const socket = new Socket(); relay.wsServer.clients.add(socket);
    relay.wsServer.emit("connection", socket, { url: "/ws?peer=1" });
    if (deviceId) socket.receive(signed(deviceId));
    socket.sent = [];
    return socket;
  };
  const live = (deviceId: string, sequence = 1, overrides: Json = {}) => ({ type: "peer:codex-session-live", deviceId,
    state: { sessionId, streamId, sequence, status: "running", updatedAt: now, messages: [], ...overrides } });
  const output = (deviceId: string, sequence = 1, id = "command") => ({ type: "peer:terminal-output", deviceId,
    output: { id, terminalId: "terminal", command: "echo ok", cwd: "fixture", chunk: "ok", stream: "stdout", sequence } });
  const heartbeat = (message: Json) => {
    const request = Object.assign(new EventEmitter(), { method: "POST", url: "/api/peer-heartbeat" });
    const response = { statusCode: 200, setHeader() {}, end() {} };
    requestHandler!(request, response); request.emit("data", JSON.stringify(message)); request.emit("end");
    return response.statusCode;
  };
  return { relay, connect, signed, live, output, heartbeat, advance(ms: number) { now += ms; },
    expire() { relay.pruneEvents(); }, runTimers() { for (const callback of [...timers.values()]) callback(); }, now: () => now };
}

describe("detached relay authenticated realtime and recovery", () => {
  it("relays device-bound state without origin loops, rejects spoofed/unknown sources and malformed states", () => {
    const h = harness(), source = h.connect("source"), target = h.connect("target"), stranger = h.connect();
    source.sent = []; target.sent = [];
    stranger.receive(h.live("source"));
    source.receive(h.live("forged"));
    source.receive(h.live("source", 1, { sequence: -1 }));
    expect(target.sent).toEqual([]);
    source.receive(h.live("source"));
    expect(target.sent.map(event => event.type)).toEqual(["peer:codex-session-live"]);
    expect(source.sent).toEqual([]);
    target.receive(h.live("source"));
    expect(source.sent).toEqual([]);
  });

  it("uses shared revisions for duplicate, stale and replacement streams, then expires replay", () => {
    const h = harness(), source = h.connect("source"), target = h.connect("target"); target.sent = [];
    source.receive(h.live("source", 2)); source.receive(h.live("source", 1)); source.receive(h.live("source", 2));
    source.receive(h.live("source", 0, { streamId: "32345678-1234-1234-1234-123456789abc", updatedAt: h.now() - 1 }));
    expect(target.sent.length).toBe(1);
    h.advance(1); source.receive(h.live("source", 0, { streamId: "32345678-1234-1234-1234-123456789abc" }));
    expect(target.sent.length).toBe(2);
    const reconnect = h.connect("reconnect");
    expect(reconnect.sent).toEqual([]); // connect helper resets observation after signed authentication.
    expect(h.relay.replayEvents.size).toBe(1);
    h.advance(5 * 60000); h.expire();
    expect(h.relay.replayEvents.size).toBe(0);
    expect(h.relay.eventRevisions.size).toBe(0);
  });

  it("replays latest live, output/completion and unresolved prompts while respecting source availability", () => {
    const h = harness(), source = h.connect("source");
    source.receive(h.live("source")); source.receive(h.output("source", 1)); source.receive(h.output("source", 2));
    source.receive({ type: "peer:codex-request", deviceId: "source", request: { id: "prompt", threadId: sessionId, kind: "command", title: "Approve" } });
    const reconnect = h.connect(); reconnect.receive(h.signed("target"));
    expect(reconnect.sent.filter(event => event.type !== "peer:aggregate").map(event => event.type)).toEqual([
      "peer:codex-session-live", "peer:terminal-output", "peer:terminal-output", "peer:codex-request"]);
    source.receive({ type: "peer:terminal-complete", deviceId: "source", result: { id: "command", terminalId: "terminal", command: "echo ok", cwd: "fixture", output: "okok", durationMs: 1, status: "completed", finishedAt: new Date(h.now()).toISOString() } });
    source.receive({ type: "peer:codex-request-resolved", deviceId: "source", requestId: "prompt" });
    source.receive(h.output("source", 3));
    source.receive({ type: "peer:codex-request", deviceId: "source", request: { id: "prompt", threadId: sessionId, kind: "command", title: "Approve" } });
    const late = h.connect(); late.receive(h.signed("late"));
    expect(late.sent.filter(event => event.type !== "peer:aggregate").map(event => event.type)).toEqual([
      "peer:codex-session-live", "peer:terminal-complete", "peer:codex-request-resolved"]);
    source.close(); const offline = h.connect(); offline.receive(h.signed("offline"));
    expect(offline.sent.filter(event => event.type !== "peer:aggregate").map(event => event.type)).toEqual(["peer:terminal-complete"]);
  });

  it("keeps signed socket identity during HTTP heartbeat and closes superseded or rebound peers", () => {
    const h = harness(), source = h.connect("source");
    expect(h.heartbeat(h.signed("source"))).toBe(200);
    expect(h.relay.peers.get("source").socket).toBe(source);
    const replayedIdentity = h.connect(); replayedIdentity.receive(h.signed("source"));
    expect(replayedIdentity.readyState).toBe(0);
    expect(source.readyState).toBe(1);
    h.advance(1);
    const replacement = h.connect("source");
    expect(source.readyState).toBe(0);
    expect(h.relay.peers.get("source").socket).toBe(replacement);
    replacement.receive(h.signed("other"));
    expect(replacement.readyState).toBe(0);
    expect(h.relay.peers.has("other")).toBe(false);
  });

  it("bounds streams, replay bytes/events, slow sockets, failed sends and missing live dependencies", () => {
    const h = harness(), source = h.connect("source"), slow = h.connect("slow"), failed = h.connect("failed");
    slow.bufferedAmount = 4 * 1024 * 1024 + 1; failed.throws = true;
    source.receive(h.output("source", 1));
    expect(slow.readyState).toBe(0); expect(failed.readyState).toBe(0);
    for (let sequence = 2; sequence <= 300; sequence++) source.receive(h.output("source", sequence));
    expect(h.relay.replayEvents.size).toBeLessThanOrEqual(256);
    for (let sequence = 301; sequence <= 400; sequence++) {
      const value = h.output("source", sequence); value.output.chunk = "x".repeat(127 * 1024); source.receive(value);
    }
    expect([...h.relay.replayEvents.values()].reduce((sum: number, entry: Json) => sum + entry.bytes, 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
    for (let id = 0; id < 100; id++) source.receive(h.output("source", 1, `command-${id}`));
    expect(h.relay.eventRevisions.size).toBeLessThanOrEqual(64);
    const boundedFrames = h.connect(); boundedFrames.receive(h.signed("bounded-frames"));
    expect(boundedFrames.sent.every(event => Buffer.byteLength(JSON.stringify(event)) <= 2 * 1024 * 1024)).toBe(true);
    const noContract = harness(false), producer = noContract.connect("source"), consumer = noContract.connect("target");
    producer.receive(noContract.live("source")); producer.receive(noContract.output("source"));
    expect(consumer.sent.map(event => event.type)).toEqual(["peer:terminal-output"]);
  });

  it("rejects expired/future live revisions, malformed terminal/prompt payloads and expires unauthenticated sockets", () => {
    const h = harness(), source = h.connect("source"), target = h.connect("target"), unauthenticated = h.connect(); target.sent = [];
    source.receive(h.live("source", 1, { updatedAt: h.now() - 5 * 60000 }));
    source.receive(h.live("source", 1, { updatedAt: h.now() + 10001 }));
    source.receive({ ...h.output("source"), output: { ...h.output("source").output, deviceId: "forged" } });
    source.receive({ type: "peer:codex-request", deviceId: "source", request: { id: "prompt", threadId: sessionId, kind: "question", title: "Approve", questions: [{ id: "question", header: "Prompt", question: "Continue?", isSecret: "false" }] } });
    expect(target.sent).toEqual([]);
    h.runTimers();
    expect(unauthenticated.readyState).toBe(0);
    expect(source.readyState).toBe(1);
  });

  it("bounds pending actions and fails destination disconnects without replaying mutations", () => {
    const h = harness(), origin = h.connect("origin"), destination = h.connect("target"); origin.sent = []; destination.sent = [];
    for (let id = 0; id <= 128; id++) origin.receive({ type: "peer:action", requestId: `request-${id}`, action: "sendCodexCliSessionMessage", payload: { targetDeviceId: "target" } });
    expect(h.relay.pendingActions.size).toBe(128);
    expect(origin.sent.at(-1).error).toContain("queue is full");
    destination.close();
    expect(h.relay.pendingActions.size).toBe(0);
    expect(origin.sent.filter(event => event.type === "peer:action-result").length).toBe(129);
    expect(origin.sent.at(-1).error).toContain("outcome is unknown");
    expect(h.relay.replayEvents.size).toBe(0);
  });

  it("times out actions visibly and accepts results only from the selected destination", () => {
    const h = harness(), origin = h.connect("origin"), destination = h.connect("target"), other = h.connect("other");
    origin.sent = []; destination.sent = [];
    origin.receive({ type: "peer:action", requestId: "request", action: "steerCodexCliSessionTurn", payload: { targetDeviceId: "target" } });
    other.receive({ type: "peer:action-result", requestId: "request", status: "completed" });
    expect(h.relay.pendingActions.size).toBe(1);
    expect(origin.sent).toEqual([]);
    h.runTimers();
    expect(h.relay.pendingActions.size).toBe(0);
    expect(origin.sent.at(-1).status).toBe("failed");
    expect(origin.sent.at(-1).error).toContain("outcome is unknown");
    destination.receive({ type: "peer:action-result", requestId: "request", status: "completed" });
    expect(origin.sent.length).toBe(1);
  });

  it("preserves signed encrypted-vault forwarding without accepting bad signatures or origins", () => {
    const h = harness(), source = h.connect("source"), target = h.connect("target"); source.sent = []; target.sent = [];
    const value = { type: "peer:vault", deviceId: "source", sentAt: h.now(), vault: "encrypted-ciphertext" };
    const hostKey = Buffer.from("isolated-relay-test-key").toString("base64url");
    const signature = createHmac("sha256", Buffer.from(hostKey, "base64url")).update(JSON.stringify(value)).digest("base64url");
    source.receive({ ...value, signature: "bad" });
    source.receive({ ...value, signature }); source.receive({ ...value, signature });
    expect(target.sent.map(event => event.type)).toEqual(["peer:vault"]);
    expect(source.sent).toEqual([]);
    h.advance(120001); h.expire();
    expect(h.relay.replayEvents.size).toBe(0);
  });
});
