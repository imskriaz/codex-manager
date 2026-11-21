import { execFile } from 'node:child_process';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'win32')('does not mistake an open shared handle for a Windows byte-range writer lock', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-real-writer-'));
  const file = path.join(directory, '01a04882-d037-7a42-ad24-9afb61901188.lock');
  await writeFile(file, '');
  const handle = await open(file, 'r');
  try {
    const { stdout } = await promisify(execFile)(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('tools/inspect-session-writers.ps1'), '-Directory', directory],
      { timeout: 15_000, windowsHide: true });
    expect(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())).toEqual([]);
  } finally { await handle.close(); await rm(directory, { recursive: true, force: true }); }
});
