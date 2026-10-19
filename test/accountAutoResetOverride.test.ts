import { expect, it } from 'vitest';
import { selectAccountResetOverride } from '../src/application/accounts/autoQueueOrder';
import { createAutoQueuePolicy } from '../src/domain/autoQueuePolicy';
import type { CodexManagerAccountRecord } from '../src/core/types';
const now = 2_000_000_000_000;
const policy = createAutoQueuePolicy({ autoSwitchEnabled: true, autoResetEnabled: false }, now);
const account = (id: string, count: number, patch: Partial<CodexManagerAccountRecord> = {}): CodexManagerAccountRecord => ({ id, email: `${id}@example.invalid`, createdAt: 1, updatedAt: 1, isActive: false, enabled: true, autoResetAllowed: true, lastQuotaAt: now - 1000,
  quotaSummary: { hourlyPercentage: 50, weeklyPercentage: 0, weeklyWindowPresent: true, weeklyWindowMinutes: 10080, resetCreditsAvailable: count, resetCreditsNextExpiresAt: now / 1000 + 3600 }, ...patch });

it('allows the account opt-in with global reset off, preferring the largest reserve then earliest expiry', () => {
  const a = account('a', 2), b = account('b', 5), c = account('c', 5, { quotaSummary: { ...b.quotaSummary!, resetCreditsNextExpiresAt: now / 1000 + 60 } });
  expect(selectAccountResetOverride([a,b,c], policy)?.id).toBe('c');
  expect(selectAccountResetOverride([a,b], policy)?.id).toBe('b');
});
it('requires exhausted weekly quotas for every enabled eligible account and keeps all safety guards', () => {
  const opted = account('opted', 3);
  for (const uncertain of [account('usable', 0, { quotaSummary: { ...opted.quotaSummary!, weeklyPercentage: 1 } }), account('stale', 0, { lastQuotaAt: 1 }), account('partial', 0, { quotaSummary: undefined }), account('failed', 0, { quotaError: { message: 'offline', timestamp: 1 } })]) expect(selectAccountResetOverride([opted, uncertain], policy)).toBeUndefined();
  for (const patch of [{ enabled: false }, { autoResetAllowed: false }, { resetCreditAttempt: { requestId: 'r', attemptedAt: now, availableBefore: 3 } }]) expect(selectAccountResetOverride([{ ...opted, ...patch }], policy)).toBeUndefined();
  expect(selectAccountResetOverride([opted], { ...policy, autoSwitchEnabled: false })).toBeUndefined();
  expect(selectAccountResetOverride([opted, account('disabled', 0, { enabled: false, quotaSummary: undefined })], policy)?.id).toBe('opted');
});
