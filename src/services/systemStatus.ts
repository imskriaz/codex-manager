import { getCodexManagerConfiguration } from '../infrastructure/config/extensionSettings';
import { waitWithin } from '../utils/concurrency';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SystemStatus } from '../domain/systemStatus';

const execute = promisify(execFile);
let cached: SystemStatus | undefined;
let pending = false;
let lastAttempt = 0;
let lastBatteryAttempt = 0;
const SYSTEM_STATUS_REFRESH_MS = 5_000;
const BATTERY_REFRESH_MS = 30_000;
const CPU_SAMPLE_MS = 125;

function cpuSnapshot(): { idle: number; total: number } | undefined {
  try { return os.cpus().reduce((sum, core) => ({
    idle: sum.idle + core.times.idle,
    total: sum.total + Object.values(core.times).reduce((a, b) => a + b, 0)
  }), { idle: 0, total: 0 }); } catch { return undefined; }
}

async function battery(): Promise<SystemStatus['battery']> {
  if (process.platform === 'win32') {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 3000, maxBuffer: 8192 });
    if (!stdout.trim()) return undefined;
    const value: unknown = JSON.parse(stdout);
    const rows: unknown[] = Array.isArray(value) ? value : [value];
    const valid = rows.filter((row): row is { EstimatedChargeRemaining: number; BatteryStatus: number } => {
      if (!row || typeof row !== 'object') return false;
      const batteryRow = row as Record<string, unknown>;
      return typeof batteryRow['EstimatedChargeRemaining'] === 'number' && batteryRow['EstimatedChargeRemaining'] >= 0 && batteryRow['EstimatedChargeRemaining'] <= 100 && typeof batteryRow['BatteryStatus'] === 'number';
    });
    if (valid.length) return { percent: Math.round(valid.reduce((sum, row) => sum + row.EstimatedChargeRemaining, 0) / valid.length), charging: valid.some(row => [6, 7, 8, 9].includes(row.BatteryStatus)) };
  } else if (process.platform === 'linux') {
    for (const name of await fs.readdir('/sys/class/power_supply')) {
      const root = path.join('/sys/class/power_supply', name);
      if ((await fs.readFile(path.join(root, 'type'), 'utf8')).trim() !== 'Battery') continue;
      const percent = Number((await fs.readFile(path.join(root, 'capacity'), 'utf8')).trim());
      if (Number.isFinite(percent) && percent >= 0 && percent <= 100) return { percent, charging: (await fs.readFile(path.join(root, 'status'), 'utf8')).trim() === 'Charging' };
    }
  } else if (process.platform === 'darwin') {
    const { stdout } = await execute('/usr/bin/pmset', ['-g', 'batt'], { timeout: 3000, maxBuffer: 8192 });
    const percent = stdout.match(/(\d+)%;/);
    if (percent) return { percent: Math.min(100, Number(percent[1])), charging: /; charging;/i.test(stdout) };
  }
  return undefined;
}

/** Optional telemetry never blocks dashboard snapshots or explicit account actions. */
export function getSystemStatus(): SystemStatus | undefined {
  if (!getCodexManagerConfiguration().get<boolean>("systemInfoEnabled", true)) return undefined;
  if (!pending && Date.now() - lastAttempt >= SYSTEM_STATUS_REFRESH_MS) {
    pending = true;
    lastAttempt = Date.now();
    void refresh().catch(() => undefined).finally(() => { pending = false; });
  }
  return cached ? { ...cached } : undefined;
}

async function refresh(): Promise<void> {
  const beforeCpu = cpuSnapshot();
  const next: SystemStatus = { observedAt: Date.now(), battery: cached?.battery };
  try { next.networkConnected = Object.values(os.networkInterfaces()).some(rows => rows?.some(row => !row.internal && row.address !== '0.0.0.0' && !row.address.startsWith('169.254.') && !row.address.startsWith('fe80:'))); } catch { /* Optional on restricted hosts. */ }
  const cpuSample = new Promise<void>(resolve => setTimeout(resolve, CPU_SAMPLE_MS)).then(() => {
    const afterCpu = cpuSnapshot();
    if (beforeCpu && afterCpu && afterCpu.total > beforeCpu.total) {
      const busyFraction = 1 - (afterCpu.idle - beforeCpu.idle) / (afterCpu.total - beforeCpu.total);
      next.cpuPercent = Math.round(Math.max(0, Math.min(100, busyFraction * 100)));
    }
  });
  // Battery discovery may spawn a platform utility; keep it off the fast sampling cadence.
  const refreshBattery = Date.now() - lastBatteryAttempt >= BATTERY_REFRESH_MS;
  if (refreshBattery) lastBatteryAttempt = Date.now();
  await Promise.allSettled([
    cpuSample,
    ...(refreshBattery ? [waitWithin(battery(), 3500, "Battery unavailable").then(value => { next.battery = value; }, () => { delete next.battery; })] : []),
    waitWithin(fs.statfs(os.homedir()), 1500, "Disk unavailable").then(value => { next.diskFree = value.bavail * value.bsize; next.diskTotal = value.blocks * value.bsize; })
  ]);
  next.memoryTotal = os.totalmem();
  next.memoryUsed = Math.max(0, next.memoryTotal - os.freemem());
  next.uptimeSeconds = os.uptime();
  next.observedAt = Date.now();
  cached = next;
}
