export function classifyCliSessionListResult(
  requestId: string,
  realtimeRevision: number | undefined,
  lastRealtimeRevision: number,
  explicitRefreshRequestId?: string,
  requestRealtimeRevision?: number
): { apply: boolean; explicitRefresh: boolean; nextRealtimeRevision: number } {
  const explicitRefresh = requestId === explicitRefreshRequestId;
  const realtime = requestId.startsWith("realtime-");
  const staleRealtime = typeof realtimeRevision === "number"
    ? realtimeRevision < lastRealtimeRevision || (realtime || explicitRefresh) && realtimeRevision === lastRealtimeRevision
    : !realtime && requestRealtimeRevision !== undefined && requestRealtimeRevision < lastRealtimeRevision;
  return {
    apply: !staleRealtime,
    explicitRefresh,
    nextRealtimeRevision: typeof realtimeRevision === "number"
      ? Math.max(lastRealtimeRevision, realtimeRevision)
      : lastRealtimeRevision
  };
}
