import type { DashboardCliSessionSummary, DashboardCodexSessionLiveState } from '../../src/domain/dashboard/types';

export function ClaudeQuota({ session, live }: { session: DashboardCliSessionSummary; live?: DashboardCodexSessionLiveState }) {
  const native = session.nativeQuota?.limits ?? [];
  const limits = native.length ? native : [
    ...(live?.rateLimits?.primary ? [{kind:'five_hour',status:'allowed',...live.rateLimits.primary}] : []),
    ...(live?.rateLimits?.secondary ? [{kind:'seven_day',status:'allowed',...live.rateLimits.secondary}] : [])
  ];
  return <span class="cli-turn-account-group" role="status" aria-label="Claude quota"><strong>Claude</strong>{limits.length ? limits.map(limit => {
    const stale = limit.resetsAt !== undefined && limit.resetsAt * 1000 <= Date.now();
    const label = limit.kind === 'five_hour' ? '5h' : limit.kind === 'seven_day' ? 'Weekly' : limit.kind.replace(/_/g, ' ');
    return <span key={limit.kind} title={limit.resetsAt ? `Reset ${new Date(limit.resetsAt * 1000).toLocaleString()}` : 'Reset time not reported'}>{label}: {stale ? 'refresh needed' : limit.usedPercent !== undefined ? `${Math.max(0, Math.round(100-limit.usedPercent))}% remaining` : limit.status === 'rejected' ? 'limit reached' : limit.status === 'allowed_warning' ? 'near limit' : 'available'}</span>;
  }) : <span>Quota not reported by Claude</span>}</span>;
}
