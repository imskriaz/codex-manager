export type DashboardHostReload = {
  type: "dashboard:host-reload";
  deviceId?: string;
  startedAt: number;
  phase: "reloading" | "failed" | "cancelled";
  fromAccountId?: string;
  toAccountId?: string;
};

export const HOST_RELOAD_WAIT_MS = 90_000;

export function isDashboardHostReload(value: unknown, now = Date.now()): value is DashboardHostReload {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return raw['type'] === 'dashboard:host-reload' && Number.isSafeInteger(raw['startedAt']) &&
    Number(raw['startedAt']) > now - 10 * 60_000 && Number(raw['startedAt']) <= now + 30_000 &&
    ['reloading', 'failed', 'cancelled'].includes(String(raw['phase'])) &&
    ['deviceId', 'fromAccountId', 'toAccountId'].every(key => raw[key] === undefined ||
      typeof raw[key] === 'string' && raw[key].length > 0 && raw[key].length <= 256);
}
