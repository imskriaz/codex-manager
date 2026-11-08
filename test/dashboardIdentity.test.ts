import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
vi.mock("http", async original => ({ ...await original<typeof import("http")>(), createServer: () => Object.assign(new EventEmitter(), {
  listen() { queueMicrotask(() => this.emit("listening")); }, close(callback: () => void) { callback(); }, closeIdleConnections() {}
}) }));
import { configureSqliteStateStore, createSqliteMemento, SqliteStateStore } from "../src/storage/sqliteState";
import { configureCrossWindowOperationCoordinator } from "../src/utils/crossWindowOperations";
import { WebDashboardServer } from "../src/services/webDashboardServer";
import { removeTestDirectory } from "./testFilesystem";

let root: string, store: SqliteStateStore, context: vscode.ExtensionContext;
const servers: WebDashboardServer[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "manager-device-handoff-"));
  store = await SqliteStateStore.open(join(root, "manager.sqlite"));
  configureSqliteStateStore(store);
  await configureCrossWindowOperationCoordinator(root);
  context = { extensionUri: { fsPath: root }, secrets: { get: async () => undefined, delete: async () => undefined },
    globalState: createSqliteMemento(store, "global", { keys: () => [], get: () => undefined, update: async () => undefined }), subscriptions: [] } as unknown as vscode.ExtensionContext;
});
afterEach(async () => {
  for (const server of servers.splice(0)) { await server.stop(); server.dispose(); }
  configureSqliteStateStore(undefined); store.close(); vi.restoreAllMocks(); await removeTestDirectory(root);
});
function server(nativeId?: string) {
  const sync = nativeId ? { getPresenceDeviceId: async () => nativeId, setOnlineDeviceIds: vi.fn(), isCrossPcEnabled: () => false, getRealtimeEnablementRegistry: () => [] } : undefined;
  const instance = new WebDashboardServer(context, {} as never, sync as never);
  vi.spyOn(instance as any, "isEnabled").mockReturnValue(true);
  for (const method of ["startWebSocketHeartbeat", "updateOnlineDevicePresence", "connectPeerSocket", "publishLocalPeerState"])
    vi.spyOn(instance as any, method).mockImplementation(() => undefined);
  servers.push(instance);
  return instance as any;
}

it("persists the native identity before serving, and retains it through Node and VS Code takeover", async () => {
  await context.globalState.update("codexManager.webDashboard.deviceId", "old-node-id");
  const vscodeHost = server("native-device-id");
  await vscodeHost.start();
  expect(context.globalState.get("codexManager.webDashboard.deviceId")).toBe("native-device-id");
  await vscodeHost.stop();
  const node = server(); await node.start();
  expect(node.deviceId).toBe("native-device-id");
  await node.stop();
  const takeover = server("native-device-id"); await takeover.start();
  expect(takeover.deviceId).toBe("native-device-id");
});

it("elects one shared identity when two standalone hosts initialize without an existing ID", async () => {
  const first = server(), second = server();
  await Promise.all([first.start(), second.start()]);
  expect(first.deviceId).toBe(second.deviceId);
  expect(first.deviceId).toBe(context.globalState.get("codexManager.webDashboard.deviceId"));
});

it("reports identity persistence failures before binding a dashboard", async () => {
  vi.spyOn(context.globalState, "update").mockRejectedValue(new Error("SQLITE_FULL"));
  const host = server("native-device-id");
  await expect(host.start()).rejects.toThrow("SQLITE_FULL");
  expect(host.server).toBeUndefined();
});
