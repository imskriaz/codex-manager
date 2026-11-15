import { expect, it } from 'vitest';
import { normalizeSystemStatus } from '../src/domain/systemStatus';

it('accepts partial system readings without inventing missing battery or CPU data', () => {
  const observedAt = Date.now();
  expect(normalizeSystemStatus({ observedAt, networkConnected: false, memoryUsed: 2, memoryTotal: 8 })).toEqual({ observedAt, networkConnected: false, memoryUsed: 2, memoryTotal: 8 });
  expect(normalizeSystemStatus({ observedAt, battery: { percent: 58.6, charging: true }, cpuPercent: 20 })).toEqual({ observedAt, battery: { percent: 59, charging: true }, cpuPercent: 20 });
});

it('rejects malformed, future and impossible remote telemetry', () => {
  for (const value of [null, {}, { observedAt: Infinity }, { observedAt: Date.now() + 120000 }]) expect(normalizeSystemStatus(value)).toBeUndefined();
  const observedAt = Date.now();
  expect(normalizeSystemStatus({ observedAt, battery: { percent: 101, charging: true }, cpuPercent: NaN, diskFree: 20, diskTotal: 10, memoryUsed: -1 })).toEqual({ observedAt, diskTotal: 10 });
});
