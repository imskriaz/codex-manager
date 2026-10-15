import { EventEmitter } from "node:events";
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sockets, fetchMock } = vi.hoisted(() => ({ sockets: [] as any[], fetchMock: vi.fn() }));
vi.mock("undici", async (original) => ({
  ...(await original<typeof import("undici")>()),
  fetch: fetchMock,
  WebSocket: class extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    bufferedAmount = 0;
    send = vi.fn();
    close = vi.fn(() => { this.readyState = 3; this.emit("close"); });
    constructor(public url: URL) { super(); sockets.push(this); }
    addEventListener(type: string, listener: (...args: any[]) => void) { this.on(type, listener); }
  }
}));
import { WebDashboardServer } from "../src/services/webDashboardServer";

let domain: string;
let server: WebDashboardServer;
let internal: any;
let sync: any;
const peer = () => ({ type: "peer:sessions", deviceId: "other-pc", deviceName: "Other PC", sessions: [], accounts: [], enablementRegistry: [], sentAt: Date.now(), signature: "signed" });

beforeEach(() => {
  vi.useFakeTimers();
  domain = "";
  sockets.length = 0;
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({ type: "peer:aggregate", peers: [] }) });
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: (key: string, fallback?: unknown) => key === "cloudflaredDomain" ? domain : key === "webDashboardAlwaysOnlineEnabled" ? true : fallback
  } as never);
  sync = { setOnlineDeviceIds: vi.fn(), setRealtimeSyncPublisher: vi.fn(),
    verifyRealtimePeerPayload: vi.fn(async () => true), signRealtimePeerPayload: vi.fn(async () => "signed"),
    getRealtimeEncryptedVault: vi.fn(async () => "encrypted-vault"), applyRealtimeEncryptedVault: vi.fn(async () => true) };
  server = new WebDashboardServer({ extensionUri: { fsPath: process.cwd() }, secrets: {} } as never, {} as never, sync);
  internal = server;
  internal.peerStopped = false;
  vi.spyOn(internal, "readLocalPeerSessions").mockResolvedValue({ type: "peer:sessions" });
  vi.spyOn(internal, "publishRealtimeState").mockImplementation(() => undefined);
});

afterEach(async () => {
  await server.stop();
  server.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("canonical cross-PC WebSocket domain", () => {
  it.each(["", "   ", "http://dashboard.example", "https://user:password@dashboard.example", "https://dashboard.example/path", "https://dashboard.example/?q=1", "https://dashboard.example/#fragment", "not a host"])("avoids outgoing peer connections and loopback fallback with %j", async value => {
    domain = value;
    internal.connectPeerSocket();
    await internal.publishPeerHeartbeatHttp();
    expect(sockets).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([" Dashboard.Example ", "https://Dashboard.Example/", "https://dashboard.example:8443/"])("normalizes the peer endpoint and recovery origin for %j", async value => {
    domain = value;
    internal.connectPeerSocket();
    internal.connectPeerSocket();
    await internal.peerHttpHeartbeatInFlight;
    const origin = value.includes("8443") ? "https://dashboard.example:8443" : "https://dashboard.example";
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url.origin).toBe(origin.replace("https:", "wss:"));
    expect(sockets[0].url.pathname).toBe("/ws");
    expect(sockets[0].url.searchParams.get("peer")).toBe("1");
    expect(fetchMock.mock.calls[0][0].origin).toBe(origin);
  });

  it.each(["", "http://dashboard.example"])("rejects peer upgrades but retains local browser upgrades with %j", async value => {
    domain = value;
    const upgrade = vi.spyOn(internal.webSocketServer, "handleUpgrade").mockImplementation(() => undefined);
    const socket = { destroy: vi.fn() };
    const headers = { host: "127.0.0.1:39875", origin: "http://127.0.0.1:39875" };
    await internal.handleWebSocketUpgrade({ url: "/ws?peer=1", headers }, socket, Buffer.alloc(0));
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(upgrade).not.toHaveBeenCalled();
    await internal.handleWebSocketUpgrade({ url: "/ws", headers }, socket, Buffer.alloc(0));
    expect(upgrade).toHaveBeenCalledOnce();
  });

  it("allows peer upgrades for a valid configured domain", async () => {
    domain = "dashboard.example";
    const upgrade = vi.spyOn(internal.webSocketServer, "handleUpgrade").mockImplementation(() => undefined);
    const socket = { destroy: vi.fn() };
    await internal.handleWebSocketUpgrade({ url: "/ws?peer=1", headers: { host: "dashboard.example", origin: "https://dashboard.example" } }, socket, Buffer.alloc(0));
    expect(upgrade).toHaveBeenCalledOnce();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("closes all incoming peers and settles requests when the domain is cleared, keeping local browsers open", async () => {
    domain = "dashboard.example";
    internal.connectPeerSocket();
    const previous = sockets[0];
    previous.readyState = 1;
    const incoming = { close: vi.fn() }, unauthenticated = { close: vi.fn() }, browser = { close: vi.fn() };
    internal.webSocketServer.clients.add(incoming).add(unauthenticated).add(browser);
    internal.peerSockets.set("other-pc", incoming);
    internal.webSocketClients.add(browser);
    internal.remoteSessionLive.set("stale", {});
    internal.remoteCodexPrompts.set("stale", {});
    const action = internal.relayPeerAction({ type: "dashboard:action", action: "refreshView", requestId: "pending" }, "remote-pc");
    const vault = internal.publishPeerVault(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(internal.peerVaultWaiters.size).toBe(1);
    domain = "";
    internal.restartPeerSocket();
    expect(previous.close).toHaveBeenCalledOnce();
    expect(incoming.close).toHaveBeenCalledOnce();
    expect(unauthenticated.close).toHaveBeenCalledOnce();
    expect(browser.close).not.toHaveBeenCalled();
    expect(internal.peerSockets.size).toBe(0);
    expect(await action).toMatchObject({ status: "failed", error: expect.stringContaining("outcome is unknown") });
    expect(await vault).toBe(false);
    expect(internal.peerActionWaiters.size).toBe(0);
    expect(internal.peerVaultWaiters.size).toBe(0);
    expect(internal.remoteSessionLive.size).toBe(0);
    expect(internal.remoteCodexPrompts.size).toBe(0);
    previous.emit("open");
    previous.emit("message", { data: JSON.stringify({ type: "peer:aggregate", peers: [peer()] }) });
    previous.emit("close");
    expect(internal.peerSocket).toBeUndefined();
    expect(internal.peerReconnectTimer).toBeUndefined();
    expect(internal.peerPublishTimer).toBeUndefined();
    expect(internal.peerHttpHeartbeatTimer).toBeUndefined();
  });

  it("reconnects to the new domain and ignores a delayed close from the old socket", async () => {
    domain = "old.example";
    internal.connectPeerSocket();
    const previous = sockets[0];
    domain = "new.example";
    internal.restartPeerSocket();
    expect(sockets[1].url.origin).toBe("wss://new.example");
    previous.emit("close");
    expect(internal.peerSocket).toBe(sockets[1]);
    expect(internal.peerReconnectTimer).toBeUndefined();
    sockets[1].emit("close");
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets[2].url.origin).toBe("wss://new.example");
  });

  it("settles direct peer actions without waiting for the closing handshake and refuses duplicate requests", async () => {
    const incoming = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn(), close: vi.fn() });
    internal.peerSockets.set("remote-pc", incoming);
    internal.webSocketServer.clients.add(incoming);
    const action = { type: "dashboard:action", action: "refreshView", requestId: "direct" };
    const pending = internal.relayPeerAction(action, "remote-pc");
    expect(await internal.relayPeerAction(action, "remote-pc")).toMatchObject({ status: "failed", error: expect.stringContaining("already pending") });
    expect(incoming.send).toHaveBeenCalledOnce();
    internal.restartPeerSocket();
    expect(await pending).toMatchObject({ status: "failed", error: expect.stringContaining("outcome is unknown") });
    expect(incoming.listenerCount("message")).toBe(0);
    expect(incoming.listenerCount("close")).toBe(0);
    expect(internal.peerActionWaiters.size).toBe(0);
  });

  it("resends the same vault when a relay reconnects after reboot", async () => {
    domain = "dashboard.example";
    internal.connectPeerSocket();
    internal.lastPublishedPeerVault = "encrypted-vault";
    sockets[0].readyState = 1;
    sockets[0].emit("open");
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0].send.mock.calls.map(([raw]: [string]) => JSON.parse(raw).type)).toContain("peer:vault");
  });

  it("rejects a session signature that finishes after peer configuration changes", async () => {
    let finish!: (valid: boolean) => void;
    sync.verifyRealtimePeerPayload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = internal.acceptPeerSession(peer());
    internal.restartPeerSocket();
    finish(true);
    expect(await pending).toBe(false);
    expect(internal.peerSessions.size).toBe(0);
    expect(internal.peerPresenceAuthoritative).toBe(false);
  });

  it("does not apply a vault whose verification finishes after disconnection", async () => {
    let finish!: (valid: boolean) => void;
    sync.verifyRealtimePeerPayload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = internal.acceptPeerVault({ type: "peer:vault", deviceId: "other-pc", vault: "encrypted", sentAt: Date.now(), signature: "signed" });
    internal.restartPeerSocket();
    finish(true);
    expect(await pending).toBe(false);
    expect(sync.applyRealtimeEncryptedVault).not.toHaveBeenCalled();
  });

  it("does not send a vault prepared before the configured connection was replaced", async () => {
    domain = "dashboard.example";
    internal.connectPeerSocket();
    sockets[0].readyState = 1;
    let finish!: (signature: string) => void;
    sync.signRealtimePeerPayload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = internal.publishPeerVault(true);
    await vi.advanceTimersByTimeAsync(0);
    domain = "";
    internal.restartPeerSocket();
    finish("signed");
    expect(await pending).toBe(false);
    expect(sockets[0].send).not.toHaveBeenCalled();
    expect(internal.peerVaultWaiters.size).toBe(0);
  });

  it("does not send session metadata prepared before a socket was replaced", async () => {
    domain = "dashboard.example";
    internal.connectPeerSocket();
    const previous = sockets[0];
    previous.readyState = 1;
    let finish!: (value: unknown) => void;
    internal.readLocalPeerSessions.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = internal.publishPeerSessionsCore();
    domain = "";
    internal.restartPeerSocket();
    finish({ type: "peer:sessions" });
    await pending;
    expect(previous.send).not.toHaveBeenCalled();
  });

  it("ignores a recovery response after the same domain is disconnected and configured again", async () => {
    domain = "dashboard.example";
    let finish!: (value: unknown) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = internal.publishPeerHeartbeatHttp();
    await vi.advanceTimersByTimeAsync(0);
    internal.restartPeerSocket();
    finish({ ok: true, json: async () => ({ type: "peer:aggregate", peers: [peer()] }) });
    await pending;
    expect(internal.peerPresenceAuthoritative).toBe(false);
    expect(internal.peerSessions.size).toBe(0);
  });
});
