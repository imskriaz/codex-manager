import { describe, expect, it } from 'vitest';
import { nextDashboardSnapshot, retainConfirmedValue } from '../src/domain/confirmedSnapshot';

describe('progressive dashboard snapshots', () => {
  it('emits one ordered change event and skips unchanged state', () => {
    const first = nextDashboardSnapshot(undefined, { accounts: [{ id: 'a', quota: 20 }], settings: { theme: 'dark' } });
    expect(first?.message.type).toBe('dashboard:snapshot');
    const second = nextDashboardSnapshot(first?.baseline, { accounts: [{ id: 'a', quota: 18 }], settings: { theme: 'dark' } });
    expect(second?.message).toMatchObject({ type: 'dashboard:update', baseRevision: 1, revision: 2, changes: { accounts: [{ id: 'a', quota: 18 }] } });
    expect(nextDashboardSnapshot(second!.baseline, { accounts: [{ id: 'a', quota: 18 }], settings: { theme: 'dark' } })).toBeUndefined();
  });

  it('reuses confirmed object branches when a progressive update changes another branch', () => {
    const previous = { accounts: [{ id: 'a' }], settings: { theme: 'dark' } };
    const next = retainConfirmedValue(previous, { accounts: [{ id: 'a' }], settings: { theme: 'light' } });
    expect(next.accounts).toBe(previous.accounts);
    expect(next.settings).not.toBe(previous.settings);
  });
});
