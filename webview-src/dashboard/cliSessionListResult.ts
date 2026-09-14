export function classifyCliSessionListResult(
  requestId: string,
  realtimeRevision: number | undefined,
  lastRealtimeRevision: number,
  explicitRefreshRequestId?: string
): { apply: boolean; explicitRefresh: boolean; nextRealtimeRevision: number } {
  const explicitRefresh = requestId === explicitRefreshRequestId;
  const staleRealtime = typeof realtimeRevision === "number" && realtimeRevision <= lastRealtimeRevision;
  return {
    apply: !staleRealtime,
    explicitRefresh,
    nextRealtimeRevision: typeof realtimeRevision === "number"
      ? Math.max(lastRealtimeRevision, realtimeRevision)
      : lastRealtimeRevision
  };
}
