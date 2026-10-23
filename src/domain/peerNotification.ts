export type PeerNotification = {
  type: 'peer:notice'; deviceId: string; eventId: string; sentAt: number;
  notice: { level: 'info' | 'warning' | 'error'; message: string; title?: string; systemName?: string };
  signature: string;
};

export function peerNotificationPayload(event: Omit<PeerNotification, 'signature'>): string {
  return JSON.stringify({ type: event.type, deviceId: event.deviceId, eventId: event.eventId, sentAt: event.sentAt,
    notice: { level: event.notice.level, message: event.notice.message, title: event.notice.title, systemName: event.notice.systemName } });
}

export function isPeerNotification(value: unknown, now = Date.now()): value is PeerNotification {
  if (!value || typeof value !== 'object') return false;
  const event = value as PeerNotification, text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max;
  return Object.keys(event).every(key => ['type', 'deviceId', 'eventId', 'sentAt', 'notice', 'signature'].includes(key)) &&
    event.type === 'peer:notice' && text(event.deviceId, 256) && text(event.eventId, 128) && text(event.signature, 128) &&
    Number.isFinite(event.sentAt) && event.sentAt > now - 300000 && event.sentAt <= now + 10000 &&
    !!event.notice && typeof event.notice === 'object' && Object.keys(event.notice).every(key => ['level', 'message', 'title', 'systemName'].includes(key)) &&
    ['info', 'warning', 'error'].includes(event.notice.level) && text(event.notice.message, 4096) &&
    (event.notice.title === undefined || text(event.notice.title, 160)) && (event.notice.systemName === undefined || text(event.notice.systemName, 256));
}
