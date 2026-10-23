import { expect, it } from 'vitest';
import { isPeerNotification, peerNotificationPayload } from '../src/domain/peerNotification';

const event = { type: 'peer:notice' as const, deviceId: 'remote', eventId: 'event', sentAt: 1000000, signature: 'signed', notice: { level: 'warning' as const, message: 'Switch failed.', systemName: 'Remote PC' } };
it('signs the same canonical fields regardless of incoming property order', () => {
  expect(isPeerNotification(event, event.sentAt)).toBe(true);
  expect(peerNotificationPayload({ ...event, notice: { systemName: 'Remote PC', message: 'Switch failed.', level: 'warning' } })).toBe(peerNotificationPayload(event));
});
it.each([
  { ...event, sentAt: 700000 }, { ...event, sentAt: 1010001 }, { ...event, signature: '' },
  { ...event, deviceId: '' }, { ...event, eventId: 'x'.repeat(129) },
  { ...event, notice: { ...event.notice, message: 'x'.repeat(4097) } },
  { ...event, notice: { ...event.notice, actions: ['Switch'] } },
  { ...event, actionPrompt: { kind: 'quotaWarning' } }
])('rejects stale, malformed, oversized or interactive remote data %#', invalid => {
  expect(isPeerNotification(invalid, event.sentAt)).toBe(false);
});
