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
