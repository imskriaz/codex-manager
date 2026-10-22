import { describe, expect, it } from 'vitest';
import { isAccountTagResult, isAccountTagUpdate, normalizeAccountTags } from '../src/domain/accountTags';
import { filterAccounts } from '../webview-src/dashboard/accountSorting';
import { createInitialState, reducer } from '../webview-src/dashboard/state';

describe('account tags', () => {
  it('trims and deduplicates case-insensitively and supports clearing', () => {
    expect(normalizeAccountTags([' Work ', 'work', '', 'Personal'])).toEqual(['work', 'Personal']);
    expect(normalizeAccountTags([])).toEqual([]);
  });
  it('rejects malformed, duplicate, and oversized acknowledgements', () => {
    const update = { accountId: 'one', tags: ['Work'], updatedAt: 10 };
    expect(isAccountTagUpdate(update)).toBe(true);
    expect(isAccountTagUpdate({ ...update, tags: 'Work' })).toBe(false);
    expect(isAccountTagUpdate({ ...update, enabled: 1 })).toBe(false);
    expect(isAccountTagResult({ accounts: [update], successCount: 1, failedCount: 0, errors: [] })).toBe(true);
    expect(isAccountTagResult({ accounts: [update, update], successCount: 2, failedCount: 0, errors: [] })).toBe(false);
    expect(isAccountTagResult({ accounts: [update], successCount: 1, failedCount: -1, errors: [] })).toBe(false);
    expect(isAccountTagResult({ accounts: [update], successCount: 1, failedCount: 0, errors: ['x'.repeat(301)] })).toBe(false);
  });
  it.each([undefined, null, 'Work', [3], Array.from({ length: 11 }, (_, index) => `Tag ${index}`), ['x'.repeat(25)], ['line\nbreak'], ['control\u0000']])('rejects malformed or oversized input %j', value => {
    expect(() => normalizeAccountTags(value)).toThrow();
  });
  it('combines tag filtering with status and text search without requiring legacy tags', () => {
    const accounts = [
      { id: 'work', email: 'work@example.test', tags: ['Work'], enabled: true, healthKind: 'healthy', metrics: [] },
      { id: 'personal', email: 'personal@example.test', tags: ['Personal'], enabled: false, healthKind: 'healthy', metrics: [] },
      { id: 'legacy', email: 'legacy@example.test', enabled: true, healthKind: 'healthy', metrics: [] }
    ] as never;
    expect(filterAccounts(accounts, '', 'all', 10, 'WORK').map(account => account.id)).toEqual(['work']);
    expect(filterAccounts(accounts, 'personal', 'all', 10).map(account => account.id)).toEqual(['personal']);
    expect(filterAccounts(accounts, '', 'enabled', 10, 'Personal')).toEqual([]);
    expect(filterAccounts(accounts, '', 'all', 10)).toHaveLength(3);
  });
  it('applies acknowledgements only to their system and keeps tags across stale snapshots without reviving removed accounts', () => {
    const snapshot = { accounts: [{ id: 'same', updatedAt: 1, tags: ['Local'] }], peerAccounts: { remote: [{ id: 'same', updatedAt: 1, tags: ['Old'] }] }, settings: { autoRefreshMinutes: 0, autoRefreshCurrentMinutes: 0 } } as never;
    let state = reducer(createInitialState(), { type: 'snapshot', snapshot });
    state = reducer(state, { type: 'account-tags', deviceId: 'remote', updates: [{ accountId: 'same', tags: ['Remote'], updatedAt: 3, enabled: false }] });
    expect(state.snapshot?.accounts[0]?.tags).toEqual(['Local']);
    expect(state.snapshot?.peerAccounts?.remote?.[0]?.tags).toEqual(['Remote']);
    expect(state.snapshot?.peerAccounts?.remote?.[0]?.enabled).toBe(false);
    state = reducer(state, { type: 'snapshot', snapshot });
    expect(state.snapshot?.peerAccounts?.remote?.[0]?.tags).toEqual(['Remote']);
    state = reducer(state, { type: 'account-tags', deviceId: 'remote', updates: [{ accountId: 'same', tags: ['Late'], updatedAt: 2 }] });
    expect(state.snapshot?.peerAccounts?.remote?.[0]?.tags).toEqual(['Remote']);
    state = reducer(state, { type: 'snapshot', snapshot: { ...state.snapshot!, peerAccounts: { remote: [] } } });
    expect(state.snapshot?.peerAccounts?.remote).toEqual([]);
  });
});
