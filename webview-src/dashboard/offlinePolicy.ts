import type { DashboardActionName, DashboardActionPayload } from '../../src/domain/dashboard/types';
export const OFFLINE_CACHE_READS = new Set<DashboardActionName>(['getWorkspaceEnvironment','listWorkspaceFiles','readWorkspaceFile','getUsageGraph']);
export function offlineReadCacheKey(action: DashboardActionName, accountId: string | undefined, payload: DashboardActionPayload | undefined): string {
  return `read:${JSON.stringify([action, accountId ?? '', payload?.targetDeviceId ?? 'local', payload?.sessionId ?? '', payload?.projectPath ?? '', payload?.filePath ?? '', payload?.includeBranchDiff ?? false, payload?.usageGraph ?? null])}`;
}
export function canQueueOfflineAction(action: DashboardActionName): boolean {
  return action === 'saveProjectTask' || action === 'addProjectComment';
}
