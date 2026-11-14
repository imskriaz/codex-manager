import type { DashboardActionName, DashboardActionPayload } from '../../src/domain/dashboard/types';
export const OFFLINE_CACHE_READS = new Set<DashboardActionName>(['getWorkspaceEnvironment','listWorkspaceFiles','readWorkspaceFile','getUsageGraph','getDailyUsage','viewLogs','listApiTokens','previewMaintenance','getMaintenancePage','getMaintenanceStatus','inspectMaintenanceStorage']);
export function offlineReadCacheKey(action: DashboardActionName, accountId: string | undefined, payload: DashboardActionPayload | undefined, localSystemId?: string): string {
  return `read:${JSON.stringify([action, accountId ?? '', payload?.targetDeviceId && payload.targetDeviceId !== 'local' ? payload.targetDeviceId : localSystemId ?? 'local', payload?.projectPath ? '' : payload?.sessionId ?? '', payload?.projectPath ?? '', payload?.filePath ?? '', payload?.includeBranchDiff ?? false, payload?.usageGraph ?? null, payload?.gitHistory ?? null, payload?.gitRequest ?? null, payload?.githubRequest ?? null, ...(action === 'getDailyUsage' ? [payload?.days ?? 30] : ['previewMaintenance','getMaintenancePage','getMaintenanceStatus','inspectMaintenanceStorage'].includes(action) ? [payload?.maintenanceTool ?? null, payload?.maintenanceInspection ?? null, payload?.maintenanceToken ?? null, payload?.maintenanceQuery ?? null, payload?.maintenanceOffset ?? null, payload?.maintenanceJobId ?? null] : [])])}`;
}
export function canQueueOfflineAction(action: DashboardActionName): boolean {
  return action === 'saveProjectTask' || action === 'addProjectComment';
}

/** Disconnected peers cannot provide authoritative account health updates. */
export function retainOfflineAccounts(next: import('../../src/domain/dashboard/types').DashboardState, previous?: import('../../src/domain/dashboard/types').DashboardState) {
  if (!previous) return next;
  const peerAccounts = { ...next.peerAccounts };
  for (const peer of next.connectedPeers ?? []) {
    if (!peer.local && !peer.connected && previous.peerAccounts?.[peer.id]) peerAccounts[peer.id] = previous.peerAccounts[peer.id]!;
  }
  return { ...next, peerAccounts };
}
