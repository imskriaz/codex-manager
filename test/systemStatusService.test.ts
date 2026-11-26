import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const readings = vi.hoisted(() => ({
  enabled: true,
  cpuTick: 0,
  cpus: vi.fn(),
  freemem: vi.fn(),
  uptime: vi.fn(),
  networkInterfaces: vi.fn(),
  statfs: vi.fn(),
  execute: vi.fn()
}));
vi.mock('../src/infrastructure/config/extensionSettings', () => ({ isRuntimeModuleEnabled: () => true, assertRuntimeModuleEnabled: () => undefined,
  getCodexManagerConfiguration: () => ({ get: () => readings.enabled })
}));
vi.mock('node:os', () => ({
  cpus: readings.cpus, freemem: readings.freemem, uptime: readings.uptime,
  networkInterfaces: readings.networkInterfaces, totalmem: () => 8192, homedir: () => '/home/test'
}));
vi.mock('node:fs/promises', () => ({ statfs: readings.statfs, readdir: async () => [] }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => undefined, { [Symbol.for('nodejs.util.promisify.custom')]: readings.execute })
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
  vi.clearAllMocks();
  readings.enabled = true;
  readings.cpuTick = 0;
  readings.cpus.mockImplementation(() => [{ times: { idle: 100 + ++readings.cpuTick * 100, user: 900 + readings.cpuTick * 100, nice: 0, sys: 0, irq: 0 } }]);
  readings.freemem.mockReturnValue(4096);
  readings.uptime.mockReturnValue(100);
  readings.networkInterfaces.mockReturnValue({ ethernet: [{ internal: false, address: '192.0.2.1' }] });
  readings.statfs.mockResolvedValue({ bavail: 50, bsize: 1024, blocks: 100 });
  readings.execute.mockResolvedValue({ stdout: '' });
});
afterEach(() => vi.useRealTimers());

it('returns immediately and includes sampled CPU in its first complete reading', async () => {
  const { getSystemStatus } = await import('../src/services/systemStatus');
  expect(getSystemStatus()).toBeUndefined();
  expect(getSystemStatus()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(125);
  expect(getSystemStatus()).toMatchObject({ cpuPercent: 50, memoryUsed: 4096, memoryTotal: 8192, diskFree: 51200, diskTotal: 102400, uptimeSeconds: 100, networkConnected: true });
  expect(readings.statfs).toHaveBeenCalledOnce();
});

it('refreshes CPU, RAM, disk, network and uptime after five seconds without reusing old samples', async () => {
  const { getSystemStatus } = await import('../src/services/systemStatus');
  getSystemStatus();
  await vi.advanceTimersByTimeAsync(125);
  const first = getSystemStatus()!;
  readings.freemem.mockReturnValue(2048);
  readings.uptime.mockReturnValue(105);
  readings.networkInterfaces.mockReturnValue({});
  readings.statfs.mockResolvedValue({ bavail: 40, bsize: 1024, blocks: 100 });
  readings.cpus.mockReturnValueOnce([{ times: { idle: 100, user: 900 } }]).mockReturnValueOnce([{ times: { idle: 120, user: 1080 } }]);
  await vi.advanceTimersByTimeAsync(4875);
  expect(getSystemStatus()).toEqual(first);
  await vi.advanceTimersByTimeAsync(125);
  expect(getSystemStatus()).toMatchObject({ cpuPercent: 90, memoryUsed: 6144, diskFree: 40960, uptimeSeconds: 105, networkConnected: false });
  expect(getSystemStatus()!.observedAt).toBeGreaterThan(first.observedAt);
  expect(readings.statfs).toHaveBeenCalledTimes(2);
  expect(readings.execute.mock.calls.length).toBeLessThanOrEqual(1);
});

it('bounds an unavailable disk probe and retains the other current readings', async () => {
  readings.statfs.mockReturnValue(new Promise(() => undefined));
  const { getSystemStatus } = await import('../src/services/systemStatus');
  getSystemStatus();
  await vi.advanceTimersByTimeAsync(1500);
  expect(getSystemStatus()).toMatchObject({ cpuPercent: 50, memoryUsed: 4096, networkConnected: true });
  expect(getSystemStatus()!.diskFree).toBeUndefined();
});

it('keeps memory and uptime available when the platform cannot provide CPU or network data', async () => {
  readings.cpus.mockImplementation(() => { throw new Error('CPU unavailable'); });
  readings.networkInterfaces.mockImplementation(() => { throw new Error('Network unavailable'); });
  const { getSystemStatus } = await import('../src/services/systemStatus');
  getSystemStatus();
  await vi.advanceTimersByTimeAsync(125);
  expect(getSystemStatus()).toMatchObject({ memoryUsed: 4096, uptimeSeconds: 100 });
  expect(getSystemStatus()!.cpuPercent).toBeUndefined();
  expect(getSystemStatus()!.networkConnected).toBeUndefined();
});

it('does not collect or return telemetry when system information is disabled', async () => {
  readings.enabled = false;
  const { getSystemStatus } = await import('../src/services/systemStatus');
  expect(getSystemStatus()).toBeUndefined();
  expect(readings.cpus).not.toHaveBeenCalled();
  expect(readings.statfs).not.toHaveBeenCalled();
});
