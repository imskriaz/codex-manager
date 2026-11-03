/** Notification destinations stay inside the authenticated dashboard. */
export function notificationTargetUrl(value: unknown, deviceId?: string): string {
  try {
    if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//')) value = '/';
    const url = new URL(value as string, 'https://dashboard.invalid');
    if (url.origin !== 'https://dashboard.invalid' || !/^\/(?:tasks|workspace(?:\/[a-f0-9-]{36})?)?$/i.test(url.pathname)) return deviceId ? '/?device=' + encodeURIComponent(deviceId) : '/';
    if (deviceId) url.searchParams.set('device', deviceId);
    return url.pathname + url.search + url.hash;
  } catch { return '/'; }
}

