import { describe, expect, it } from 'vitest';
import type { CodexManagerAccountRecord } from '../src/core/types';
import { parseAccountsIndexValue } from '../src/storage/accountsIndex';
import { accountQuotaAvailability } from '../src/utils/quotaWindows';

const account: CodexManagerAccountRecord = { id: 'chosen', email: 'chosen@example.test', createdAt: 1, updatedAt: 1 };
describe('manual account quota selection', () => {
  it.each([
    [0, 70, 'exhausted'], [70, 0, 'exhausted'], [70, 80, 'available'],
    [NaN, 80, 'unknown'], [101, 80, 'unknown'], [-1, 80, 'unknown']
  ] as const)('classifies %s/%s without treating a partial or invalid quota as available', (hourly, weekly, expected) => {
    expect(accountQuotaAvailability({ ...account, quotaSummary: { hourlyWindowPresent: true, hourlyWindowMinutes: 300, hourlyPercentage: hourly, weeklyWindowPresent: true, weeklyWindowMinutes: 10080, weeklyPercentage: weekly } })).toBe(expected);
  });
  it('drops retired manual pause metadata while preserving accounts', () => {
    const result = parseAccountsIndexValue({ accounts: [account], manualSelectionByCodexHome: { home: { accountId: account.id } } }, 'fixture');
    expect(result.accounts[0]!.id).toBe(account.id);
    expect(result).not.toHaveProperty('manualSelectionByCodexHome');
  });
});
