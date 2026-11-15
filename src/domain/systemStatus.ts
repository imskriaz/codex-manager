export type SystemStatus = {
  observedAt: number;
  battery?: { percent: number; charging: boolean };
  networkConnected?: boolean;
  cpuPercent?: number;
  memoryUsed?: number;
  memoryTotal?: number;
  diskFree?: number;
  diskTotal?: number;
  uptimeSeconds?: number;
};

export function normalizeSystemStatus(value: unknown): SystemStatus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as SystemStatus;
  if (!Number.isFinite(row.observedAt) || row.observedAt <= 0 || row.observedAt > Date.now() + 60_000) return undefined;
  const result: SystemStatus = { observedAt: row.observedAt };
  if (typeof row.networkConnected === 'boolean') result.networkConnected = row.networkConnected;
  if (row.battery && Number.isFinite(row.battery.percent) && row.battery.percent >= 0 && row.battery.percent <= 100 && typeof row.battery.charging === 'boolean') result.battery = { percent: Math.round(row.battery.percent), charging: row.battery.charging };
  for (const key of ['cpuPercent', 'memoryUsed', 'memoryTotal', 'diskFree', 'diskTotal', 'uptimeSeconds'] as const) {
    const number = row[key];
    if (typeof number === 'number' && Number.isFinite(number) && number >= 0 && (key !== 'cpuPercent' || number <= 100)) result[key] = number;
  }
  if (result.memoryUsed !== undefined && result.memoryTotal !== undefined && result.memoryUsed > result.memoryTotal) delete result.memoryUsed;
  if (result.diskFree !== undefined && result.diskTotal !== undefined && result.diskFree > result.diskTotal) delete result.diskFree;
  return result;
}
