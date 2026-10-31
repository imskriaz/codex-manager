import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as vscode from 'vscode';
import { publishDashboardRealtime } from './dashboardRealtime';

// A pipe ties the request to this host's lifetime; no machine power settings change.
const windowsScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class CodexPower { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }'
try {
  while ([Console]::ReadLine() -eq 'awake') {
    if ([CodexPower]::SetThreadExecutionState([uint32]2147483649) -eq 0) { throw 'Windows refused the sleep prevention request.' }
  }
} finally { [void][CodexPower]::SetThreadExecutionState([uint32]2147483648) }
`;

export function createAutoResumeKeepAwake() {
  let child: ChildProcessWithoutNullStreams | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let retryAfter = 0;
  let disposed = false;
  let warned = false;
  const release = () => {
    if (expiry) clearTimeout(expiry);
    expiry = undefined;
    const previous = child;
    child = undefined;
    previous?.stdin.end();
    previous?.kill();
  };
  const failure = (error: unknown) => {
    release();
    retryAfter = Date.now() + 60_000;
    console.warn('[codexManager] Auto Resume sleep prevention unavailable', error);
    if (warned || disposed) return;
    warned = true;
    const message = 'Auto Resume could not keep this system awake. Check your sleep settings while work continues.';
    publishDashboardRealtime({ type: 'dashboard:notice', level: 'warning', message });
    void vscode.window.showWarningMessage(message);
  };
  return {
    setActive(active: boolean) {
      if (disposed) return;
      if (!active) { release(); return; }
      // Failed or stale session discovery must not leave a permanent sleep blocker.
      if (expiry) clearTimeout(expiry);
      expiry = setTimeout(release, 90_000);
      expiry.unref?.();
      if (child || Date.now() < retryAfter) return;
      try {
        const command = process.platform === 'win32' ? 'powershell.exe' : process.platform === 'darwin' ? '/usr/bin/caffeinate' : 'systemd-inhibit';
        const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', windowsScript]
          : process.platform === 'darwin' ? ['-i', '-w', String(process.pid)]
            : ['--what=idle:sleep', '--mode=block', '--why=Codex Auto Resume is finishing work', 'cat'];
        const request = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child = request;
        request.stdout.resume();
        request.stderr.resume();
        request.stdin.on('error', error => { if (child === request) failure(error); });
        request.once('error', error => { if (child === request) failure(error); });
        request.once('exit', code => { if (child === request) failure(new Error(`Sleep prevention exited (${code}).`)); });
        if (process.platform === 'win32') request.stdin.write('awake\n');
      } catch (error) { failure(error); }
    },
    dispose() { disposed = true; release(); }
  };
}
