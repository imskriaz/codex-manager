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
    get: (key: string, fallback?: unknown) => key === "cloudflaredDomain" ? domain : key === "webDashboardEnabled" ? true : fallback
  } as never);
  sync = { setOnlineDeviceIds: vi.fn(), setRealtimeSyncPublisher: vi.fn(), getRealtimeEnablementRegistry: vi.fn(() => []),
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
  it('delivers authenticated remote notices once to push and browsers, retaining the system name', async () => {
    const source = { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() }, browser = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const upstream = { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
    internal.peerSocket = upstream; internal.webSocketClients.add(browser);
    const notify = vi.spyOn(internal.browserPush, 'notify').mockImplementation(() => undefined);
    const event = { type: 'peer:notice', deviceId: 'other-pc', eventId: 'switch', sentAt: Date.now(), signature: 'signed', notice: { level: 'warning', message: 'Switch failed.', systemName: 'Other PC' } };
    await internal.handlePeerMessage(JSON.stringify(event), source);
    expect(notify).not.toHaveBeenCalled();
    internal.authenticatedPeerSockets.add(source); internal.peerSockets.set('other-pc', source);
    await internal.handlePeerMessage(JSON.stringify(event), source);
    await internal.handlePeerMessage(JSON.stringify(event), source);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ systemName: 'Other PC', message: 'Switch failed.' }));
    expect(browser.send).toHaveBeenCalledTimes(1); expect(upstream.send).toHaveBeenCalledTimes(1);
    expect(source.send).not.toHaveBeenCalled();
    sync.verifyRealtimePeerPayload.mockResolvedValueOnce(false);
    await internal.acceptPeerNotification({ ...event, eventId: 'tampered' }, upstream);
    await internal.acceptPeerNotification({ ...event, eventId: 'stale', sentAt: Date.now() - 300000 }, upstream);
    await internal.acceptPeerNotification({ ...event, deviceId: 'spoofed', eventId: 'spoof' }, source);
    expect(notify).toHaveBeenCalledTimes(1);
    internal.webSocketClients.clear(); internal.peerSockets.clear();
  });

  it('signs passive notices, bounds replay and sends it once per reconnect', async () => {
    const notice = { level: 'warning', message: 'Reloading.', systemName: 'Original PC', actions: ['Reload'], actionPrompt: { kind: 'quotaWarning' } };
    await internal.publishPeerNotification(notice);
    const socket = { readyState: 1, bufferedAmount: 0, send: vi.fn() };
    internal.replayPeerNotifications(socket); internal.replayPeerNotifications(socket);
    expect(socket.send).toHaveBeenCalledTimes(1);
    const event = JSON.parse(socket.send.mock.calls[0][0]);
    expect(event.notice).toEqual({ level: 'warning', message: 'Reloading.', systemName: 'Original PC' });
    expect(event.signature).toBe('signed');
    for (let i = 0; i < 140; i++) await internal.publishPeerNotification({ level: 'warning', message: `Warning ${i}` });
    expect(internal.peerNotifications.size).toBe(128);
    await vi.advanceTimersByTimeAsync(300001);
    expect(internal.recentPeerNotifications()).toEqual([]);
  });

  it('ignores stale and duplicate remote session completions before sending push', () => {
    const completion = vi.spyOn(internal, 'notifySessionCompletion').mockResolvedValue(undefined);
    const state = { sessionId: '12345678-1234-1234-1234-123456789abc', streamId: '22345678-1234-1234-1234-123456789abc', deviceId: 'other-pc', sequence: 1, status: 'completed', updatedAt: Date.now(), messages: [] };
    internal.publishSessionLive({ ...state, updatedAt: Date.now() - 300000 });
    expect(completion).not.toHaveBeenCalled();
    internal.publishSessionLive(state); internal.publishSessionLive(state);
    expect(completion).toHaveBeenCalledTimes(1);
  });

  it('bounds pending remote signing and leaves local delivery available when its queue is full', async () => {
    sync.signRealtimePeerPayload.mockImplementation(() => new Promise(() => undefined));
    const notify = vi.spyOn(internal.browserPush, 'notify').mockImplementation(() => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let i = 0; i < 33; i++) internal.broadcastRealtimeNotice({ level: 'warning', message: `Warning ${i}` });
    expect(notify).toHaveBeenCalledTimes(33);
    expect(internal.peerNotificationSends.size).toBe(32);
    expect(warning).toHaveBeenCalledWith('[codexManager] remote notification queue full');
    await vi.advanceTimersByTimeAsync(2001);
    await Promise.all([...internal.peerNotificationSends]);
    expect(internal.peerNotificationSends.size).toBe(0);
  });
  it('notifies native views only when data or action routes change, retaining cached rows', async () => {
    const changed=vi.fn();server.onDidChangeDashboardPeers(changed);
    const initial=peer();await internal.acceptPeerSession(initial);
    expect(changed).toHaveBeenCalledOnce();
    await internal.acceptPeerSession({...initial,sentAt:initial.sentAt+1});
    expect(changed).toHaveBeenCalledOnce();
    internal.peerSockets.set(initial.deviceId,{readyState:1});internal.notifyDashboardPeers();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(server.getDashboardPeerState().connectedPeers.find(peer=>!peer.local)?.connected).toBe(true);
    await internal.acceptPeerSession({...initial,sentAt:initial.sentAt+2,sessions:[{id:'s',title:'Work',status:'idle'}]});
    await internal.acceptPeerSession({...initial,sentAt:initial.sentAt+3,sessions:[{id:'s',title:'Work',status:'running'}]});
    expect(changed).toHaveBeenCalledTimes(4);
    internal.peerSockets.clear();internal.notifyDashboardPeers();
    expect(changed).toHaveBeenCalledTimes(5);
    expect(server.getDashboardPeerState().connectedPeers.find(peer=>!peer.local)?.connected).toBe(false);
    expect(server.getRemoteCliSessions()).toHaveLength(1);
  });
  it('keeps cached peer data but reports a missing action route as disconnected',async()=>{
    await internal.acceptPeerSession(peer());
    expect(internal.getConnectedPeers().find((item:any)=>item.id==='other-pc').connected).toBe(false);
    internal.peerSockets.set('other-pc',{readyState:1});
    expect(internal.getConnectedPeers().find((item:any)=>item.id==='other-pc').connected).toBe(true);
    internal.peerSockets.clear();internal.peerSocket={readyState:1,close:vi.fn()};
    expect(internal.getConnectedPeers().find((item:any)=>item.id==='other-pc').connected).toBe(true);
    expect(internal.peerSessions.has('other-pc')).toBe(true);
  });
  it('rejects malformed peer account tags before passing them to browser filters', async () => {
    for (const tags of ['Work', [1], ['x'.repeat(25)], Array.from({ length: 11 }, (_, index) => `Tag${index}`)])
      expect(await internal.acceptPeerSession({ ...peer(), accounts: [{ id: 'tagged', email: 'tags@example.test', tags }] })).toBe(false);
    expect(sync.verifyRealtimePeerPayload).not.toHaveBeenCalled();
    expect(await internal.acceptPeerSession({ ...peer(), accounts: [{ id: 'tagged', email: 'tags@example.test', tags: ['Work'] }] })).toBe(true);
    expect(internal.peerSessions.get('other-pc').accounts[0].tags).toEqual(['Work']);
  });
  it("authenticates browser interest, expires it, and never advertises another PC's demand as its own", async () => {
    const lifecycle = vi.spyOn(internal, "refreshCliSessionRealtimeLifecycle").mockImplementation(() => undefined);
    internal.readLocalPeerSessions.mockRestore();
    const standby = await internal.readLocalPeerSessions();
    expect(standby).toMatchObject({ sessions: [], accounts: [], dashboardTargets: [] });
    expect(internal.hasWorkspaceViewer()).toBe(false);
    for (const dashboardTargets of ["yes", [""], [1], ["x", "x"], Array(129).fill("x")])
      expect(await internal.acceptPeerSession({ ...peer(), dashboardTargets })).toBe(false);
    sync.verifyRealtimePeerPayload.mockResolvedValueOnce(false);
    expect(await internal.acceptPeerSession({ ...peer(), dashboardTargets: [internal.deviceId] })).toBe(false);
    expect(internal.hasWorkspaceViewer()).toBe(false);
    vi.spyOn(internal, "publishLocalPeerState").mockImplementation(() => undefined);
    expect(await internal.acceptPeerSession({ ...peer(), dashboardTargets: ["unrelated-pc"] })).toBe(true);
    expect(internal.hasWorkspaceViewer()).toBe(false);
    const interested = { ...peer(), sentAt: Date.now() + 1, dashboardTargets: [internal.deviceId] };
    expect(await internal.acceptPeerSession(interested)).toBe(true);
    expect(internal.hasWorkspaceViewer()).toBe(true);
    expect(JSON.parse(sync.verifyRealtimePeerPayload.mock.calls.at(-1)[0])).toMatchObject({ dashboardTargets: [internal.deviceId] });
    expect(internal.browserDashboardTargets()).toEqual([]);
    vi.spyOn(internal, "readLocalPeerState").mockResolvedValue({ sessions: [], accounts: [] });
    expect(await internal.readLocalPeerSessions()).toMatchObject({ dashboardTargets: [] });
    expect(await internal.acceptPeerSession({ ...interested, dashboardTargets: [], sentAt: interested.sentAt - 1 })).toBe(false);
    expect(internal.hasWorkspaceViewer()).toBe(true);
    await vi.advanceTimersByTimeAsync(120_001);
    expect(internal.hasWorkspaceViewer()).toBe(false);
    expect(await internal.acceptPeerSession({ ...peer(), dashboardTargets: [internal.deviceId] })).toBe(true);
    expect(internal.hasWorkspaceViewer()).toBe(true);
    internal.removePeerPresence("other-pc");
    expect(internal.hasWorkspaceViewer()).toBe(false);
    expect(lifecycle).toHaveBeenCalled();
    const remoteBrowser = { readyState: 1 };
    internal.updateWorkspaceViewer(remoteBrowser, true, "different-pc");
    expect(internal.browserDashboardTargets()).toEqual(["different-pc"]);
    expect(internal.hasWorkspaceViewer()).toBe(false);
    const browser = { readyState: 1 };
    internal.updateWorkspaceViewer(browser, true);
    expect(internal.browserDashboardTargets()).toEqual(["different-pc", internal.deviceId].sort());
    expect(internal.hasWorkspaceViewer()).toBe(true);
    internal.updateWorkspaceViewer(remoteBrowser, false);
    expect(internal.browserDashboardTargets()).toEqual([internal.deviceId]);
    await vi.advanceTimersByTimeAsync(45_001);
    expect(internal.hasWorkspaceViewer()).toBe(false);
  });
  it('pushes changed remote sessions immediately without waiting for local discovery or republishing unchanged heartbeats', async () => {
    const browser = { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
    internal.webSocketClients.add(browser);
    const initial = { ...peer(), sessions: [{ id: 'remote-session', title: 'First title', status: 'idle' }] };
    expect(await internal.acceptPeerSession(initial)).toBe(true);
    expect(JSON.parse(browser.send.mock.calls[0][0])).toMatchObject({ type: 'dashboard:action-result', action: 'listCodexCliSessions', payload: { cliSessionsDeviceId: 'other-pc', cliSessionsPartial: true, cliSessions: [{ deviceId: 'other-pc', remote: true, title: 'First title' }] } });
    expect(await internal.acceptPeerSession({ ...initial, sentAt: initial.sentAt + 1 })).toBe(true);
    expect(browser.send).toHaveBeenCalledOnce();
    expect(await internal.acceptPeerSession({ ...initial, sentAt: initial.sentAt + 2, sessions: [{ ...initial.sessions[0], title: 'Renamed', status: 'running' }] })).toBe(true);
    expect(browser.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(browser.send.mock.calls[1][0]).payload.cliSessions[0]).toMatchObject({ title: 'Renamed', status: 'running' });
  });
  it('marks remote lists with their replacement scope and keeps conversation and terminal ownership', () => {
    internal.peerSessions.set('other-pc', peer());
    const result = internal.decoratePeerActionResult({ type: 'peer:action-result', status: 'completed', requestId: 'read', payload: {
      cliSessions: [{ id: 'same', title: 'Remote', status: 'idle' }], cliComposerConfig: { projects: [{ id: 'remote', path: 'E:/remote', label: 'remote' }], models: [] },
      cliSession: { id: 'same', title: 'Remote', status: 'idle' }, terminalResults: [{ id: 'terminal' }]
    } }, 'other-pc');
    expect(result.payload).toMatchObject({ cliSessionsDeviceId: 'other-pc', cliSessions: [{ deviceId: 'other-pc', remote: true }], cliSession: { deviceId: 'other-pc' }, terminalResults: [{ deviceId: 'other-pc' }], cliComposerConfig: { projects: [{ path: 'E:/remote' }] } });
  });
  it('accepts the actual relay aggregate containing the receiver itself over HTTP and WebSocket', async () => {
    domain = 'dashboard.example';
    const aggregate = { type: 'peer:aggregate', peers: [peer(), { ...peer(), deviceId: internal.deviceId }] };
    fetchMock.mockResolvedValue({ ok: true, json: async () => aggregate });
    await internal.publishPeerHeartbeatHttp();
    expect(server.getDashboardPeerState().connectedPeers).toHaveLength(2);
    internal.connectPeerSocket();
    const socket = sockets[0]; socket.readyState = 1;
    socket.emit('message', { data: JSON.stringify(aggregate) });
    await vi.advanceTimersByTimeAsync(0);
    expect(server.getDashboardPeerState().connectedPeers).toHaveLength(2);
    expect(internal.peerSessions.has(internal.deviceId)).toBe(false);
  });
  it('keeps peer data atomic on invalid, duplicate, replayed, and replaced aggregates', async () => {
    const initial = peer();
    await internal.acceptPeerSession(initial);
    expect(await internal.replacePeerAggregate([peer(), { ...peer(), deviceId: 'bad', signature: undefined }])).toBe(false);
    expect(await internal.replacePeerAggregate([peer(), peer()])).toBe(false);
    expect([...internal.peerSessions.keys()]).toEqual(['other-pc']);
    const newer = { ...peer(), sentAt: initial.sentAt + 1, deviceName: 'Renamed PC' };
    await internal.acceptPeerSession(newer);
    expect(await internal.replacePeerAggregate([initial])).toBe(true);
    expect(internal.peerSessions.get('other-pc').deviceName).toBe('Renamed PC');
    let finish!: (valid: boolean) => void;
    sync.verifyRealtimePeerPayload.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = internal.replacePeerAggregate([newer]);
    internal.restartPeerSocket();
    finish(true);
    expect(await pending).toBe(false);
    expect(internal.peerSessions.size).toBe(0);
  });
  it("keeps a recently signed PC through an empty aggregate without letting replays renew its lease", async () => {
    vi.spyOn(internal, "broadcastPeerAggregate").mockResolvedValue(undefined);
    const initial = peer();
    await internal.acceptPeerSession(initial);
    await vi.advanceTimersByTimeAsync(500);
    expect(await internal.replacePeerAggregate([])).toBe(true);
    expect(internal.peerSessions.has("other-pc")).toBe(true);
    const seen = internal.peerLastSeenAt.get("other-pc");
    await vi.advanceTimersByTimeAsync(5000);
    expect(await internal.replacePeerAggregate([initial])).toBe(true);
    expect(internal.peerLastSeenAt.get("other-pc")).toBe(seen);
    await vi.advanceTimersByTimeAsync(10001);
    expect(internal.peerSessions.has("other-pc")).toBe(false);
  });
  it('accepts upstream progress only for known peers and fences a replaced relay socket', async () => {
    domain = 'dashboard.example'; internal.connectPeerSocket();
    const socket = sockets[0]; socket.readyState = 1;
    const browser = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() });
    internal.webSocketClients.add(browser);
    const job = { id: 'cleanup', tool: 'goals', operation: 'delete', status: 'running', total: 1, processed: 0, cleared: 0, skipped: 0, failed: 0, errors: [] };
    const message = { data: JSON.stringify({ type: 'peer:maintenance-progress', deviceId: 'other-pc', job }) };
    socket.emit('message', message); await vi.advanceTimersByTimeAsync(0);
    expect(browser.send).not.toHaveBeenCalled();
    internal.peerSessions.set('other-pc', peer());
    socket.emit('message', message); await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(browser.send.mock.calls[0][0])).toMatchObject({ type: 'dashboard:maintenance-progress', deviceId: 'other-pc', job });
    domain = 'replacement.example'; internal.restartPeerSocket();
    browser.send.mockClear(); socket.emit('message', message); await vi.advanceTimersByTimeAsync(0);
    expect(browser.send).not.toHaveBeenCalled();
  });
  it('routes bounded maintenance progress only from its authenticated device without echoing upstream', async () => {
    const browser = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() });
    const origin = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() });
    const other = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() });
    const upstream = { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
    internal.webSocketClients.add(browser); internal.peerSockets.set('other-pc', origin); internal.peerSockets.set('third-pc', other); internal.authenticatedPeerSockets.add(other);
    const job = { id: 'cleanup', tool: 'archives', operation: 'delete', status: 'running', total: 2, processed: 1, cleared: 1, failed: 0, skipped: 0, errors: [], revision: 1 };
    const message = { type: 'peer:maintenance-progress', deviceId: 'other-pc', job };
    internal.peerSocket = upstream;
    await internal.handlePeerMessage(JSON.stringify(message), origin);
    expect(browser.send).not.toHaveBeenCalled();
    internal.authenticatedPeerSockets.add(origin);
    await internal.handlePeerMessage(JSON.stringify({ ...message, deviceId: 'third-pc' }), origin);
    await internal.handlePeerMessage(JSON.stringify({ ...message, job: { ...job, total: 10001 } }), origin);
    expect(browser.send).not.toHaveBeenCalled();
    await internal.handlePeerMessage(JSON.stringify(message), origin);
    expect(JSON.parse(browser.send.mock.calls[0][0])).toMatchObject({ type: 'dashboard:maintenance-progress', deviceId: 'other-pc', job });
    expect(other.send).toHaveBeenCalledOnce(); expect(origin.send).not.toHaveBeenCalled(); expect(upstream.send).not.toHaveBeenCalled();
    internal.publishMaintenanceProgress({ type: 'dashboard:maintenance-progress', job });
    expect(upstream.send).toHaveBeenCalledOnce();
    browser.bufferedAmount = 5 * 1024 * 1024;
    internal.publishMaintenanceProgress({ type: 'dashboard:maintenance-progress', job });
    expect(browser.close).toHaveBeenCalledWith(1013, expect.any(String));
    expect(browser.send).toHaveBeenCalledTimes(2);
    internal.peerSocket = undefined;
  });
  it("publishes an aggregate once so system selection survives heartbeat refreshes", async () => {
    const changed = vi.fn();
    const listener = server.onDidChangeDashboardPeers(changed);
    domain = "dashboard.example";
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ type: "peer:aggregate", peers: [peer(), { ...peer(), deviceId: "second-pc" }] }) });
    await internal.publishPeerHeartbeatHttp();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(server.getDashboardPeerState().connectedPeers).toHaveLength(3);
    listener.dispose();
  });
  it("shares signed peer state with VS Code and retains the authenticated relay's failure outcome", async () => {
    const changed = vi.fn();
    const listener = server.onDidChangeDashboardPeers(changed);
    await internal.acceptPeerSession({ ...peer(), sessions: [{ id: "running", title: "Remote task", status: "running", interrupted: false }] });
    expect(changed).toHaveBeenCalled();
    expect(server.getDashboardPeerState().connectedPeers).toEqual(expect.arrayContaining([expect.objectContaining({ id: "other-pc", connected: false })]));
    expect(server.getRemoteCliSessions()[0]).toMatchObject({ deviceId: "other-pc", remote: true });
    await expect(server.relayWebviewAction({ type: "dashboard:action", action: "resumeCodexSessions", requestId: "desktop-remote", payload: { targetDeviceId: "other-pc" } })).resolves.toMatchObject({ status: "failed", errorMessage: "The selected PC is offline." });
    await expect(server.relayWebviewAction({ type: "dashboard:action", action: "resumeCodexSessions", requestId: "desktop-local", payload: {} })).resolves.toMatchObject({ status: "failed" });
    const relay = vi.spyOn(internal, "relayPeerAction").mockResolvedValue({ status: "completed", payload: { notice: { level: "info", message: "Opened." } } });
    const request = { type: "dashboard:action" as const, action: "resumeCodexSessions" as const, requestId: "desktop-success", payload: { targetDeviceId: "other-pc" } };
    expect(await server.relayWebviewAction(request)).toMatchObject({ status: "completed", payload: { notice: { message: "Opened." } } });
    expect(relay).toHaveBeenCalledWith(request, "other-pc");
    listener.dispose();
  });
  it("accepts bounded session settings and rejects invalid peer model metadata", async () => {
    const session = { id: "session", title: "Task", status: "running", model: "gpt-5", reasoningEffort: "high", runningSince: Date.now() - 1000 };
    for (const invalid of [{ ...session, model: {} }, { ...session, model: "x".repeat(257) }, { ...session, reasoningEffort: 1 }, { ...session, reasoningEffort: "x".repeat(65) }, { ...session, runningSince: "now" }, { ...session, runningSince: Infinity }, { ...session, runningSince: Date.now() + 600_000 }, { ...session, interrupted: "yes" }]) {
      await expect(internal.acceptPeerSession({ ...peer(), sessions: [invalid] })).resolves.toBe(false);
    }
    expect(sync.verifyRealtimePeerPayload).not.toHaveBeenCalled();
    await expect(internal.acceptPeerSession({ ...peer(), sessions: [session] })).resolves.toBe(true);
    expect(internal.peerSessions.get("other-pc").sessions[0]).toMatchObject(session);
  });
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
