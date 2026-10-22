import { describe, expect, it, vi } from "vitest";
import { WebDashboardServer } from "../src/services/webDashboardServer";
import { subscribeDashboardRealtime } from "../src/services/dashboardRealtime";

const state = (sequence = 1) => ({ sessionId: "01a04882-d037-7a42-ad24-9afb61901188",
  streamId: "01a04882-d037-7a42-ad24-9afb61901189", sequence, status: "running", updatedAt: Date.now(), messages: [] });
const socket = (bufferedAmount = 0) => ({ readyState: 1, bufferedAmount, send: vi.fn(), close: vi.fn() });
function host() {
  return Object.assign(Object.create(WebDashboardServer.prototype), {
    deviceId: "local-pc", remoteSessionLive: new Map(), webSocketClients: new Set(), peerSockets: new Map(),
    peerSessions: new Map([["remote-pc", {}]]), authenticatedPeerSockets: new WeakSet()
  });
}

describe("shared dashboard live session delivery", () => {
  it('relays terminal streams to authenticated peer viewers without origin loops or slow-client buffers', () => {
    const server=host(), owner=socket(), target=socket(), stranger=socket(), slow=socket(2*1024*1024);
    server.peerSockets.set('remote-pc',owner).set('target',target).set('stranger',stranger).set('slow',slow);
    server.authenticatedPeerSockets.add(owner).add(target).add(slow);
    server.relayTerminalEvent({type:'dashboard:terminal-output',output:{raw:true,id:'stream',terminalId:'pty:one',deviceId:'remote-pc',command:'',cwd:'project',chunk:'screen',stream:'terminal',sequence:1,cols:80,rows:24}});
    expect(owner.send).not.toHaveBeenCalled(); expect(stranger.send).not.toHaveBeenCalled(); expect(slow.send).not.toHaveBeenCalled();
    expect(JSON.parse(target.send.mock.calls[0][0])).toMatchObject({type:'peer:terminal-output',deviceId:'remote-pc',output:{raw:true}});
  });
  it('rejects terminal events from authenticated sockets claiming another device', async () => {
    const server=host(), owner=socket(), impostor=socket();
    server.authenticatedPeerSockets.add(owner).add(impostor);server.peerSockets.set('remote-pc',owner);
    const observed=vi.fn(), off=subscribeDashboardRealtime(observed);
    const wire=JSON.stringify({type:'peer:terminal-output',deviceId:'remote-pc',output:{raw:true,id:'stream',terminalId:'pty:one',command:'',cwd:'project',chunk:'screen',stream:'terminal',sequence:1,cols:80,rows:24}});
    try { await server.handlePeerMessage(wire,impostor);expect(observed).not.toHaveBeenCalled();await server.handlePeerMessage(wire,owner);expect(observed).toHaveBeenCalledOnce(); } finally {off();}
  });
  it("broadcasts bounded snapshots, fences stale revisions, and disconnects slow browsers", () => {
    const server = host();
    const browser = socket();
    const slow = socket(5 * 1024 * 1024);
    const producer = socket();
    const other = socket();
    server.webSocketClients.add(browser).add(slow);
    server.peerSockets.set("remote-pc", producer).set("other-pc", other);
    server.publishSessionLive({ ...state(), deviceId: "remote-pc" });
    expect(JSON.parse(browser.send.mock.calls[0]![0])).toMatchObject({ type: "dashboard:codex-session-live", state: { deviceId: "remote-pc" } });
    expect(slow.close).toHaveBeenCalledWith(1013, expect.any(String));
    expect(slow.send).not.toHaveBeenCalled();
    expect(producer.send).not.toHaveBeenCalled();
    expect(other.send).toHaveBeenCalledOnce();
    server.publishSessionLive({ ...state(), deviceId: "remote-pc" });
    expect(browser.send).toHaveBeenCalledOnce();
    server.publishSessionLive({ ...state(2), deviceId: "remote-pc", messages: [{ id: "bad", text: "unsafe", injected: true }] });
    expect(browser.send).toHaveBeenCalledOnce();
  });

  it("accepts live events only from the authenticated socket owning the claimed device", async () => {
    const server = host();
    const owner = socket();
    const impostor = socket();
    server.authenticatedPeerSockets.add(owner).add(impostor);
    server.peerSockets.set("remote-pc", owner);
    const observed = vi.fn();
    const off = subscribeDashboardRealtime(observed);
    try {
      const wire = JSON.stringify({ type: "peer:codex-session-live", deviceId: "remote-pc", state: state() });
      await server.handlePeerMessage(wire, impostor);
      expect(observed).not.toHaveBeenCalled();
      await server.handlePeerMessage(wire, owner);
      expect(observed).toHaveBeenCalledWith(expect.objectContaining({ state: expect.objectContaining({ deviceId: "remote-pc" }) }));
    } finally { off(); }
  });

  it("does not replay expired, future-dated or disconnected running state", () => {
    const server = host();
    server.remoteSessionLive.set("old", { ...state(), deviceId: "remote-pc", updatedAt: Date.now() - 300_001 });
    server.remoteSessionLive.set("future", { ...state(), deviceId: "remote-pc", updatedAt: Date.now() + 60_000 });
    server.remoteSessionLive.set("offline", { ...state(), deviceId: "offline-pc" });
    server.remoteSessionLive.set("finished", { ...state(), deviceId: "offline-pc", status: "completed" });
    expect(server.currentRemoteSessionLive()).toEqual([expect.objectContaining({ status: "completed" })]);
  });
});
