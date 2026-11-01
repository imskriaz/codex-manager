import { describe, expect, it } from 'vitest';
import type { DashboardAccountViewModel, DashboardMetricViewModel } from '../src/domain/dashboard/types';
import { AccountQuota, getAccountQuotaMetrics } from '../webview-src/dashboard/accountQuota';

const metric = (key: string, percentage?: number, visible = true): DashboardMetricViewModel => ({ key, label: key, percentage, visible });

describe('compact account quota', () => {
  it('keeps two available windows, including zero, without inventing missing quota', () => {
    expect(getAccountQuotaMetrics({ metrics: [metric('5h', 0), metric('Weekly', 73.6)] }).map(item => [item.label, item.value])).toEqual([['5h', 0], ['Weekly', 74]]);
    expect(getAccountQuotaMetrics({ metrics: [metric('5h'), metric('Weekly', 25)] }).map(item => item.value)).toEqual([25]);
    expect(getAccountQuotaMetrics()).toEqual([]);
    expect(getAccountQuotaMetrics({ metrics: [] })).toEqual([]);
  });

  it('ignores hidden and invalid windows and bounds percentages', () => {
    expect(getAccountQuotaMetrics({ metrics: [metric('hidden', 20, false), metric('missing'), metric('invalid', NaN), metric('infinite', Infinity)] })).toEqual([]);
    expect(getAccountQuotaMetrics({ metrics: [metric('5h', -1), metric('Weekly', 101)] }).map(item => item.value)).toEqual([0, 100]);
  });

  it('renders a separate labelled meter per available window and marks saved data', () => {
    const account = { metrics: [metric('5h', 0), metric('Weekly', 80)] } as DashboardAccountViewModel;
    const view = AccountQuota({ account, saved: true });
    const meters = view.props.children[0].props.children;
    expect(meters).toHaveLength(2);
    expect(meters.map((item: { props: { children: Array<{ props: Record<string, unknown> }> } }) => item.props.children[1].props['aria-valuenow'])).toEqual([0, 80]);
    expect(view.props.children[1].props.children).toBe('Saved quota');
    expect(AccountQuota({ account: { ...account, metrics: [metric('Weekly', 80)] } }).props.children[0].props.children).toHaveLength(1);
    expect(AccountQuota({ account: { ...account, metrics: [] } }).props.children[0].props.children.props.children).toBe('Quota unavailable');
    expect(AccountQuota({ account: { ...account, hasQuotaError: true } }).props.children[1].props.children).toBe('Saved quota');
  });
});
