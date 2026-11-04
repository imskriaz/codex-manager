import { expect, it } from 'vitest';
import { toFailureMessage } from '../src/presentation/dashboard/actionUtils';
import { isCredentialRejection } from '../src/utils/quotaIssue';

it('preserves Windows sandbox logon failures with an actionable diagnosis without treating them as account reauthentication', () => {
  const message = 'windows sandbox failed: CreateProcessWithLogonW failed: 1385';
  expect(toFailureMessage(new Error(message))).toContain(message);
  expect(toFailureMessage(message)).toContain("sandbox user's logon rights");
  expect(toFailureMessage(message)).toContain('have not been changed');
  expect(isCredentialRejection(message)).toBe(false);
});
it('preserves unrelated errors and does not classify a path containing the same number', () => {
  expect(toFailureMessage(new Error('File 1385.txt is missing'))).toBe('File 1385.txt is missing');
  expect(toFailureMessage('Connection lost')).toBe('Connection lost');
});
