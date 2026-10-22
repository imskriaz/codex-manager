import { describe, expect, it } from 'vitest';
import type { CodexManagerAccountRecord, CodexManagerIndex } from '../src/core/types';
import { cloneIndex, mergeAccountsIndexChanges, parseAccountsIndexValue, setManualAccountSelection } from '../src/storage/accountsIndex';
import { accountQuotaAvailability } from '../src/utils/quotaWindows';

const account: CodexManagerAccountRecord = { id: 'chosen', email: 'chosen@example.test', createdAt: 1, updatedAt: 1 };
describe('manual account quota selection', () => {
  it.each([
    [0, 70, 'exhausted'], [70, 0, 'exhausted'], [70, 80, 'available'],
    [NaN, 80, 'unknown'], [101, 80, 'unknown'], [-1, 80, 'unknown']
  ] as const)('classifies %s/%s without treating a partial or invalid quota as available', (hourly, weekly, expected) => {
    expect(accountQuotaAvailability({ ...account, quotaSummary: { hourlyWindowPresent: true, hourlyWindowMinutes: 300, hourlyPercentage: hourly, weeklyWindowPresent: true, weeklyWindowMinutes: 10080, weeklyPercentage: weekly } })).toBe(expected);
  });
  it('preserves the other Codex home and merges a manual selection without losing concurrent quota', () => {
    const base: CodexManagerIndex = { accounts: [account], manualSelectionByCodexHome: { other: { accountId: 'other' } } };
    const local = cloneIndex(base);
    setManualAccountSelection(local, 'home', account);
    const remote = cloneIndex(base);
    remote.accounts[0]!.lastQuotaAt = 99;
    const merged = mergeAccountsIndexChanges(base, local, remote, 'home');
    expect(merged.manualSelectionByCodexHome).toEqual({ home: { accountId: 'chosen', awaitingQuota: true }, other: { accountId: 'other' } });
    expect(merged.accounts[0]!.lastQuotaAt).toBe(99);
    merged.manualSelectionByCodexHome!.home!.accountId = 'changed';
    expect(local.manualSelectionByCodexHome!.home!.accountId).toBe('chosen');
    expect(() => parseAccountsIndexValue({ accounts: [], manualSelectionByCodexHome: { home: { accountId: 5 } } }, 'fixture')).toThrow();
  });
});
