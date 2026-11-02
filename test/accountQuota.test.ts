import { describe, expect, it } from 'vitest';
import type { DashboardAccountViewModel, DashboardMetricViewModel } from '../src/domain/dashboard/types';
import { AccountQuota, getAccountQuotaMetrics } from '../webview-src/dashboard/accountQuota';

const metric = (key: string, percentage?: number, visible = true): DashboardMetricViewModel => ({ key, label: key, percentage, visible });

describe('compact account quota', () => {
  it.each([
    { name: "two windows", metrics: [metric("5h", 95), metric("Weekly", 20)], expected: "95%/20%" },
    { name: "one available window", metrics: [metric("5h"), metric("Weekly", 20)], expected: "20%" },
    { name: "zero quota", metrics: [metric("5h", 0)], expected: "0%" },
    { name: "missing quota", metrics: [], expected: "—" },
    { name: "invalid quota", metrics: [metric("hidden", 30, false), metric("5h", NaN), metric("Weekly", Infinity)], expected: "—" },
    { name: "bounded and rounded quota", metrics: [metric("5h", 101), metric("Weekly", 19.6)], expected: "100%/20%" }
  ])("renders $name as inline percentages without meter rows", ({ metrics, expected }) => {
    const view = AccountQuota({ account: { metrics } as DashboardAccountViewModel, inline: true });
    expect(view.props.children).toBe(expected);
    expect(view.props.class).toBe("cli-quota-inline");
    expect(view.props.role).toBe("group");
    expect(view.props.title).toEqual(metrics.some(item => item.visible && Number.isFinite(item.percentage)) ? expect.stringContaining("quota: ") : "Quota unavailable");
  });

  it("labels offline and stale inline values without adding visible saved-quota text", () => {
    const account = { metrics: [metric("5h", 95), metric("Weekly", 20)] } as DashboardAccountViewModel;
    for (const view of [AccountQuota({ account, saved: true, inline: true }), AccountQuota({ account: { ...account, hasQuotaError: true }, inline: true })]) {
      expect(view.props.children).toBe("95%/20%");
      expect(view.props["aria-label"]).toBe("Saved quota: 5h 95%, Weekly 20%");
      expect(view.props.title).toBe(view.props["aria-label"]);
    }
    expect(AccountQuota({ inline: true, saved: true }).props["aria-label"]).toBe("Quota unavailable");
  });

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
