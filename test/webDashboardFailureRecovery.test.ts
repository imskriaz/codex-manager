import { EventEmitter } from "node:events";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as vscode from "vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardClientMessage, DashboardHostMessage } from "../src/domain/dashboard/types";

const { buildState, executeAction } = vi.hoisted(() => ({ buildState: vi.fn(), executeAction: vi.fn() }));
vi.mock("../src/application/dashboard/buildDashboardState", () => ({ buildDashboardState: buildState }));
vi.mock("../src/presentation/dashboard/actionHandlers", () => ({ executeDashboardActionMessage: executeAction }));
import { WebDashboardServer } from "../src/services/webDashboardServer";
import * as sessionEditor from "../src/services/codexSessionResume";
import * as dashboardSettings from "../src/presentation/dashboard/settings";
import * as usageHistory from "../src/services/dashboardUsageHistory";
import { recordDashboardActionPrompt, shouldSuppressDashboardNotifications } from "../src/utils/notificationPolicy";

afterEach(() => { vi.restoreAllMocks(); });

function createServer() {
  const server = new WebDashboardServer({ extension: { packageJSON: { version: "test" } }, extensionUri: { fsPath: process.cwd() }, globalState: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) } } as never, {} as never);
  const internal = server as unknown as {
    processClientMessage(message: DashboardClientMessage): Promise<{ messages: DashboardHostMessage[]; reloadAfterResponse: boolean }>;
    webSocketServer: EventEmitter & { options: { maxPayload: number } };
  };
  return { server, internal };
}

it("keeps standby peer heartbeats free of session scans and account builds, then follows browser visibility", async () => {
  const { server } = createServer();
  const internal = server as any;
  vi.spyOn(internal, "refreshCliSessionRealtimeLifecycle").mockImplementation(() => undefined);
  const sessions = vi.spyOn(internal, "readLocalCliSessions").mockResolvedValue([{ id: "local", title: "Local", status: "idle" }]);
  buildState.mockClear().mockResolvedValue({ accounts: [{ id: "account" }] });
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback?: unknown) => key === "cliIntegrationEnabled" ? true : fallback } as never);
  const browser = { readyState: 1 };
  try {
    expect(await internal.readLocalPeerSessions()).toMatchObject({ sessions: [], accounts: [], dashboardTargets: [] });
    expect(sessions).not.toHaveBeenCalled();
    expect(buildState).not.toHaveBeenCalled();
    internal.updateWorkspaceViewer(browser, true);
    expect(await internal.readLocalPeerSessions()).toMatchObject({ sessions: [{ id: "local" }], accounts: [{ id: "account" }], dashboardTargets: [internal.deviceId] });
    await internal.readLocalPeerSessions();
    expect(sessions).toHaveBeenCalledOnce();
    expect(buildState).toHaveBeenCalledOnce();
    internal.updateWorkspaceViewer(browser, false);
    internal.invalidateLocalPeerState();
    expect(await internal.readLocalPeerSessions()).toMatchObject({ sessions: [], accounts: [], dashboardTargets: [] });
    expect(sessions).toHaveBeenCalledOnce();
    expect(buildState).toHaveBeenCalledOnce();
    internal.updateWorkspaceViewer(browser, true);
    expect(await internal.readLocalPeerSessions()).toMatchObject({ sessions: [{ id: "local" }] });
    expect(sessions).toHaveBeenCalledTimes(2);
    internal.updateWorkspaceViewer(browser, true, "other-pc");
    expect(await internal.readLocalPeerSessions()).toMatchObject({ sessions: [], accounts: [], dashboardTargets: ["other-pc"] });
    expect(sessions).toHaveBeenCalledTimes(2);
  } finally { await server.stop(); server.dispose(); }
});

it('publishes successful peer tag changes without waiting for a storage watcher', async () => {
  const { server } = createServer(), internal = server as any;
  const publish = vi.spyOn(internal, 'publishLocalPeerState').mockImplementation(() => undefined);
  executeAction.mockResolvedValueOnce({ status: 'completed', payload: { accountTags: { accountId: 'tagged', tags: ['Work'], updatedAt: 1 } } });
  const send = vi.fn();
  try {
    await internal.executePeerAction({ type: 'peer:action', action: 'setAccountTags', requestId: 'tags', accountId: 'tagged' }, send);
    expect(publish).toHaveBeenCalledOnce();
    expect(JSON.parse(send.mock.calls[0]![0])).toMatchObject({ status: 'completed', payload: { accountTags: { tags: ['Work'] } } });
  } finally { await server.stop(); server.dispose(); }
});

it("coalesces file changes during an active read, delivers the last change, and stays idle afterwards", async () => {
  vi.useFakeTimers();
  const { server } = createServer(), internal = server as any;
  let viewing = true, finish!: () => void;
  vi.spyOn(internal, "hasWorkspaceViewer").mockImplementation(() => viewing);
  vi.spyOn(internal, "publishLocalStateChange").mockImplementation(() => undefined);
  const refresh = vi.spyOn(internal, "publishCliSessionsRealtimeCore")
    .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
    .mockResolvedValue(undefined);
  try {
    const first = internal.publishCliSessionsRealtime();
    internal.scheduleCliSessionRefresh(); internal.scheduleCliSessionRefresh();
    await vi.advanceTimersByTimeAsync(250);
    expect(refresh).toHaveBeenCalledOnce();
    finish(); await first;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    internal.scheduleCliSessionRefresh();
    viewing = false; internal.stopCliSessionRealtime();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  } finally { await server.stop(); server.dispose(); vi.useRealTimers(); }
});

describe("browser action completion during state failure", () => {
  it("returns peer account prompts to the browser with their originating system", async () => {
    const { server } = createServer(), send = vi.fn(), enableRescue = vi.fn().mockResolvedValue(true);
    Reflect.set(server, 'encryptedSync', { setRegistryOverrideEnabled: enableRescue });
    executeAction.mockImplementationOnce(async context => {
      expect(context.hostKind).toBe('browser');
      expect(shouldSuppressDashboardNotifications()).toBe(true);
      expect(await context.setEncryptedSyncRegistryOverride(true, 'fixture-only-password')).toBe(true);
      expect(recordDashboardActionPrompt({ kind: 'quotaWarning', accountId: 'remote-account', message: 'Quota low', selectLabel: 'Select Account', laterLabel: 'Later' })).toBe(true);
      return { status: 'completed' };
    });
    try {
      await Reflect.get(server, 'executePeerAction').call(server, { requestId: 'peer-quota', action: 'refresh', accountId: 'remote-account' }, send);
      expect(JSON.parse(send.mock.calls[0]![0])).toMatchObject({ type: 'peer:action-result', status: 'completed', payload: { actionPrompts: [{ accountId: 'remote-account', targetDeviceId: Reflect.get(server, 'deviceId') }] } });
      expect(shouldSuppressDashboardNotifications()).toBe(false);
      expect(enableRescue).toHaveBeenCalledWith(true, { passphrase: 'fixture-only-password' });
    } finally { Reflect.set(server, 'encryptedSync', undefined); server.dispose(); }
  });

  it("serves HTTP pages, assets and account state while local session discovery never responds", async () => {
    const { server } = createServer();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback?: unknown) => key === "cliIntegrationEnabled" ? true : fallback } as never);
    Reflect.set(server, "hasWorkspaceViewer", () => true);
    Reflect.set(server, "isAuthorized", async () => true);
    vi.spyOn(sessionEditor, "readCodexCliSessions").mockReturnValue(new Promise(() => undefined));
    vi.spyOn(usageHistory, "appendDashboardUsageSnapshot").mockResolvedValue([]);
    vi.spyOn(usageHistory, "readDashboardUsageSummary").mockReturnValue({ revision: 0, count: 0 });
    buildState.mockResolvedValue({ accounts: [{ id: "saved-account" }], settings: {} });
    const host = createHttpServer((request, response) => {
      void Reflect.get(server, "handle").call(server, request, response).catch(() => { response.statusCode = 500; response.end(); });
    });
    await new Promise<void>(resolve => host.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
    try {
      const start = Date.now();
      const stateRequest = fetch(`${origin}/api/state`);
      const html = await fetch(origin);
      expect(html.status).toBe(200);
      expect(await html.text()).toContain('id="app"');
      const asset = await fetch(`${origin}/assets/browserHost.js`);
      expect(asset.status).toBe(200);
      expect(await asset.text()).toContain("acquireVsCodeApi");
      const state = await stateRequest;
      expect(state.status).toBe(200);
      expect(await state.json()).toMatchObject({ accounts: [{ id: "saved-account" }] });
      expect(Date.now() - start).toBeLessThan(5_000);
    } finally {
      await new Promise<void>(resolve => { host.close(() => resolve()); host.closeAllConnections(); });
      server.dispose();
    }
  });

  it("does not block a dashboard state build on local session discovery", async () => {
    vi.useFakeTimers();
    const { server } = createServer();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) => key === "cliIntegrationEnabled" ? true : fallback
    } as never);
    Reflect.set(server, "hasWorkspaceViewer", () => true);
    vi.spyOn(sessionEditor, "readCodexCliSessions").mockReturnValue(new Promise(() => undefined));
    try {
      const work = Reflect.get(server, "getConnectedPeers").call(server) as Promise<unknown[]>;
      await vi.advanceTimersByTimeAsync(750);
      await expect(work).resolves.toEqual([expect.objectContaining({ local: true, sessionCount: 0 })]);
    } finally {
      server.dispose();
      vi.useRealTimers();
    }
  });

  it("uses cached session counts while discovery is slow and updates them after completion", async () => {
    vi.useFakeTimers();
    const { server } = createServer();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback?: unknown) => key === "cliIntegrationEnabled" ? true : fallback } as never);
    Reflect.set(server, "hasWorkspaceViewer", () => true);
    Reflect.set(server, "localCliSessions", [{ id: "saved", status: "idle" }]);
    let finish!: (sessions: never[]) => void;
    const read = vi.spyOn(sessionEditor, "readCodexCliSessions").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    try {
      const first = Reflect.get(server, "getConnectedPeers").call(server);
      const duplicate = Reflect.get(server, "getConnectedPeers").call(server);
      await vi.advanceTimersByTimeAsync(750);
      expect((await first)[0].sessionCount).toBe(1);
      expect((await duplicate)[0].sessionCount).toBe(1);
      expect(read).toHaveBeenCalledOnce();
      finish([]);
      await vi.advanceTimersByTimeAsync(0);
      expect((await Reflect.get(server, "getConnectedPeers").call(server))[0].sessionCount).toBe(0);
    } finally { server.dispose(); vi.useRealTimers(); }
  });

  it("returns a retryable HTTP failure within 5 seconds and recovers without a reload", async () => {
    vi.useFakeTimers();
    const { server } = createServer();
    let finish!: (state: unknown) => void;
    buildState.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ accounts: [], settings: {} });
    const end = vi.fn(), response = { statusCode: 200, setHeader: vi.fn(), end };
    try {
      const work = Reflect.get(server, "sendState").call(server, response);
      await vi.advanceTimersByTimeAsync(5_000);
      await work;
      expect(response.statusCode).toBe(503);
      expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "2");
      expect(JSON.parse(end.mock.calls[0]![0])).toMatchObject({ error: expect.stringContaining("still loading") });
      vi.spyOn(usageHistory, "appendDashboardUsageSnapshot").mockResolvedValue([]);
      vi.spyOn(usageHistory, "readDashboardUsageSummary").mockReturnValue({ revision: 0, count: 0 });
      finish({ accounts: [], settings: {} });
      await vi.advanceTimersByTimeAsync(0);
      response.statusCode = 200;
      await Reflect.get(server, "sendState").call(server, response);
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(end.mock.calls.at(-1)![0])).toHaveProperty("accounts");
    } finally { server.dispose(); vi.useRealTimers(); }
  });

  it("records quota history without blocking account rendering", async () => {
    vi.useFakeTimers();
    const { server } = createServer();
    buildState.mockResolvedValue({ accounts: [], settings: {} });
    const write = vi.spyOn(usageHistory, "appendDashboardUsageSnapshot").mockReturnValue(new Promise(() => undefined));
    vi.spyOn(usageHistory, "readDashboardUsageSummary").mockReturnValue({ revision: 4, count: 2 });
    try {
      const work = Reflect.get(server, "buildState").call(server);
      await vi.advanceTimersByTimeAsync(250);
      await expect(work).resolves.toMatchObject({ accounts: [], usageSummary: { revision: 4, count: 2 } });
      expect(write).toHaveBeenCalledOnce();
    } finally { server.dispose(); vi.useRealTimers(); }
  });

  it("does not serve a revoked snapshot when revocation finishes during live message discovery",async()=>{
    const {server}=createServer();
    Reflect.set(server,"settingsStore",{getDashboardSettings:()=>({})});
    const share={sessionKey:JSON.stringify(["local","aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"]),title:"Private",expiresAt:Date.now()+1000,messages:[{role:"user",text:"private content"}]};
    const refresh=vi.fn(async()=>undefined);
    Reflect.set(server,"conversationShares",{get:vi.fn().mockResolvedValue(share),refresh});
    vi.spyOn(sessionEditor,"readCodexCliSessionMessages").mockResolvedValue([{role:"assistant",text:"new content"}] as never);
    const end=vi.fn(),response={setHeader:vi.fn(),end,statusCode:200};
    try {
      await Reflect.get(server,"handle").call(server,{method:"GET",url:"/api/share/"+"a".repeat(64),headers:{host:"127.0.0.1:39875"}},response);
      expect(response.statusCode).toBe(404);expect(end.mock.calls[0]?.[0]).not.toContain("private content");
    } finally {server.dispose();}
  });
  it("bounds shutdown when an HTTP connection never finishes closing",async()=>{
    vi.useFakeTimers();const {server}=createServer();
    const closeAllConnections=vi.fn(),closeIdleConnections=vi.fn();
    Reflect.set(server,"server",{close:vi.fn(),closeAllConnections,closeIdleConnections});
    try {
      const stopping=server.stop();await vi.advanceTimersByTimeAsync(1500);await stopping;
      expect(closeAllConnections).toHaveBeenCalledOnce();expect(closeIdleConnections).toHaveBeenCalledOnce();
    } finally {server.dispose();vi.useRealTimers();}
  });

  it("discards a completed snapshot from a stopped dashboard generation",async()=>{
    const {server}=createServer();let release!:(state:unknown)=>void;
    Reflect.set(server,"buildState",()=>new Promise(resolve=>{release=resolve;}));
    const broadcast=vi.fn();Reflect.set(server,"broadcastRealtimeState",broadcast);
    Reflect.get(server,"webSocketClients").add({readyState:1,close:vi.fn()});
    const work=Reflect.get(server,"broadcastRealtimeSnapshot").call(server) as Promise<void>;
    await server.stop();release({accounts:[]});await work;
    expect(broadcast).not.toHaveBeenCalled();server.dispose();
  });

  it("returns a completed action within 250ms when its optional snapshot stalls", async () => {
    vi.useFakeTimers();
    buildState.mockReturnValue(new Promise(() => undefined));
    executeAction.mockResolvedValue({ status: "completed", payload: { reloadScheduled: true } });
    const { server, internal } = createServer();
    try {
      const work = internal.processClientMessage({ type: "dashboard:action", action: "switch", requestId: "slow-snapshot" });
      await vi.advanceTimersByTimeAsync(250);
      const result = await work;
      expect(result.reloadAfterResponse).toBe(true);
      expect(result.messages).toContainEqual(expect.objectContaining({ requestId: "slow-snapshot", status: "completed" }));
      expect(result.messages).not.toContainEqual(expect.objectContaining({ type: "dashboard:notice", message: expect.stringContaining("still loading") }));
    } finally { server.dispose(); vi.useRealTimers(); }
  });

  it("bounds a stalled explicit snapshot refresh and reports failure", async () => {
    vi.useFakeTimers();
    buildState.mockReturnValue(new Promise(() => undefined));
    executeAction.mockResolvedValue({ status: "completed" });
    const { server, internal } = createServer();
    try {
      const work = internal.processClientMessage({ type: "dashboard:action", action: "refreshView", requestId: "slow-refresh" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await work).messages).toContainEqual(expect.objectContaining({ requestId: "slow-refresh", status: "failed", error: "Dashboard state is still loading" }));
    } finally { server.dispose(); vi.useRealTimers(); }
  });
  it("preserves a successful mutation and scheduled reload when snapshot building fails", async () => {
    buildState.mockRejectedValue(new Error("storage temporarily unavailable"));
    executeAction.mockResolvedValue({ status: "completed", payload: { reloadScheduled: true } });
    const { server, internal } = createServer();
    try {
      const result = await internal.processClientMessage({ type: "dashboard:action", action: "switch", requestId: "switch-1" });
      expect(result.reloadAfterResponse).toBe(true);
      expect(result.messages).toContainEqual(expect.objectContaining({ type: "dashboard:action-result", requestId: "switch-1", status: "completed" }));
      expect(result.messages).toContainEqual(expect.objectContaining({ type: "dashboard:notice", level: "warning", message: expect.stringContaining("storage temporarily unavailable") }));
    } finally { server.dispose(); }
  });

  it("fails an explicit refresh when no snapshot can be produced", async () => {
    buildState.mockRejectedValue(new Error("cannot refresh"));
    executeAction.mockResolvedValue({ status: "completed" });
    const { server, internal } = createServer();
    try {
      const result = await internal.processClientMessage({ type: "dashboard:action", action: "refreshView", requestId: "refresh-1" });
      expect(result.messages).toContainEqual(expect.objectContaining({ type: "dashboard:action-result", requestId: "refresh-1", status: "failed", error: "cannot refresh" }));
    } finally { server.dispose(); }
  });

  it("bounds inbound messages and handles peer socket errors without crashing the host", () => {
    const { server, internal } = createServer();
    const socket = new EventEmitter();
    try {
      expect(internal.webSocketServer.options.maxPayload).toBe(2 * 1024 * 1024);
      internal.webSocketServer.emit("connection", socket, { url: "/ws?peer=1&deviceId=test" });
      expect(() => socket.emit("error", new Error("oversized message"))).not.toThrow();
    } finally { server.dispose(); }
  });
});

it('acknowledges saved settings in the browser and never reports a failed write as success', async () => {
  const { server, internal } = createServer();
  const update = vi.spyOn(dashboardSettings, 'handleDashboardSettingUpdate').mockResolvedValue(true);
  vi.spyOn(server as never, 'appendClientSnapshot' as never).mockResolvedValue(undefined as never);
  try {
    const result = await internal.processClientMessage({ type: 'dashboard:setting', key: 'autoRefreshMinutes', value: 10 });
    expect(result.messages).toContainEqual({ type: 'dashboard:notice', level: 'info', message: 'Setting saved.' });
    update.mockRejectedValueOnce(new Error('Settings are read-only.'));
    await expect(internal.processClientMessage({ type: 'dashboard:setting', key: 'autoRefreshMinutes', value: 5 })).rejects.toThrow(/read-only/);
  } finally { server.dispose(); }
});
