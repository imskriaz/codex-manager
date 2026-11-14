import { expect, it } from "vitest";
import { offlineReadCacheKey, canQueueOfflineAction, retainOfflineAccounts, OFFLINE_CACHE_READS } from "../webview-src/dashboard/offlinePolicy";

it("keeps local cached reads with their actual system across a host change", () => {
  const payload = { projectPath: "D:/project", filePath: "index.ts" };
  expect(offlineReadCacheKey("readWorkspaceFile", undefined, payload, "host-a")).not.toBe(
    offlineReadCacheKey("readWorkspaceFile", undefined, payload, "host-b")
  );
  expect(offlineReadCacheKey("readWorkspaceFile", undefined, { ...payload, targetDeviceId: "remote" }, "host-a")).toBe(
    offlineReadCacheKey("readWorkspaceFile", undefined, { ...payload, targetDeviceId: "remote" }, "host-b")
  );
  expect(offlineReadCacheKey("readWorkspaceFile", undefined, { ...payload, targetDeviceId: "local" }, "host-a")).toBe(
    offlineReadCacheKey("readWorkspaceFile", undefined, payload, "host-a")
  );
});

it("never queues execution or destructive actions offline", () => {
  for (const action of [
    "startCodexCliSession",
    "deleteCodexCliSession",
    "refreshToken",
    "pushWorkspaceBranch"
  ] as const)
    expect(canQueueOfflineAction(action)).toBe(false);
  expect(canQueueOfflineAction("saveProjectTask")).toBe(true);
  expect(canQueueOfflineAction("addProjectComment")).toBe(true);
});

it('shares project file caches across sessions while separating files, projects and history pages', () => {
  const key = (payload: Parameters<typeof offlineReadCacheKey>[2]) => offlineReadCacheKey('readWorkspaceFile', undefined, payload, 'pc');
  expect(key({ projectPath: 'D:/project', sessionId: 'one', filePath: 'a.ts' })).toBe(key({ projectPath: 'D:/project', sessionId: 'two', filePath: 'a.ts' }));
  expect(key({ sessionId: 'one' })).not.toBe(key({ sessionId: 'two' }));
  expect(key({ projectPath: 'D:/project', filePath: 'a.ts' })).not.toBe(key({ projectPath: 'D:/project', filePath: 'b.ts' }));
  expect(key({ projectPath: 'D:/one' })).not.toBe(key({ projectPath: 'D:/two' }));
  expect(key({ gitHistory: { offset: 0 } })).not.toBe(key({ gitHistory: { offset: 50 } }));
});

it('retains account status for offline peers but accepts confirmed online changes', () => {
  const prior = { peerAccounts: { remote: [{ id: 'a', healthKind: 'healthy' }] } } as unknown as import('../src/domain/dashboard/types').DashboardState;
  const next = { connectedPeers: [{ id: 'remote', connected: false }], peerAccounts: { remote: [{ id: 'a', healthKind: 'reauthorize' }] } } as unknown as import('../src/domain/dashboard/types').DashboardState;
  expect(retainOfflineAccounts(next, prior).peerAccounts?.remote?.[0]?.healthKind).toBe('healthy');
  next.connectedPeers![0]!.connected = true;
  expect(retainOfflineAccounts(next, prior).peerAccounts?.remote?.[0]?.healthKind).toBe('reauthorize');
  expect(retainOfflineAccounts(next)).toBe(next);
});

it('caches inspection snapshots without allowing server execution', () => {
  for (const action of ['getDailyUsage','viewLogs','listApiTokens','previewMaintenance','getMaintenancePage','getMaintenanceStatus','inspectMaintenanceStorage'] as const) expect(OFFLINE_CACHE_READS.has(action)).toBe(true);
  for (const action of ['runMaintenance','clearLogs','generateApiToken','revokeApiToken','workspaceTerminal'] as const) expect(OFFLINE_CACHE_READS.has(action)).toBe(false);
  expect(offlineReadCacheKey('getDailyUsage','a',{days:7},'pc')).not.toBe(offlineReadCacheKey('getDailyUsage','a',{days:30},'pc'));
  expect(offlineReadCacheKey('getMaintenancePage',undefined,{maintenanceToken:'one',maintenanceOffset:0},'pc')).not.toBe(offlineReadCacheKey('getMaintenancePage',undefined,{maintenanceToken:'two',maintenanceOffset:0},'pc'));
  expect(offlineReadCacheKey('readWorkspaceFile',undefined,{projectPath:'p',filePath:'f'},'pc')).toBe('read:'+JSON.stringify(['readWorkspaceFile','','pc','','p','f',false,null,null,null,null]));
});
