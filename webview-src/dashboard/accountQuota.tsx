import type { DashboardAccountViewModel } from '../../src/domain/dashboard/types';

export function getAccountQuotaMetrics(account?: Pick<DashboardAccountViewModel, 'metrics'>) {
  return (account?.metrics ?? [])
    .filter(metric => metric.visible && typeof metric.percentage === 'number' && Number.isFinite(metric.percentage))
    .slice(0, 2)
    .map(metric => ({ ...metric, value: Math.max(0, Math.min(100, Math.round(metric.percentage!))) }));
}

export function AccountQuota({ account, saved = false }: { account?: DashboardAccountViewModel; saved?: boolean }) {
  const metrics = getAccountQuotaMetrics(account);
  return <span class="cli-quota-summary" role="group" aria-label="Current account quota">
    <span class="cli-quota-meters">
      {metrics.length ? metrics.map(metric => <span class="cli-quota-meter" key={metric.key}>
        <span class="cli-quota-label"><span>{metric.label}</span><strong>{metric.value}%</strong></span>
        <span class="cli-account-quota-track" data-level={metric.value < 20 ? 'low' : 'normal'} role="meter" aria-label={`${metric.label} quota remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={metric.value}><i style={{ width: `${metric.value}%` }} /></span>
      </span>) : <small class="cli-quota-unavailable">Quota unavailable</small>}
    </span>
    {metrics.length && (saved || account?.hasQuotaError) ? <small class="cli-quota-note">Saved quota</small> : null}
  </span>;
}
