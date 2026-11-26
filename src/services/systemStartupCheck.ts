import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { getCodexManagerConfiguration } from '../infrastructure/config/extensionSettings';
import { resolveNodeExecutable } from '../utils/relayStartup';
import type { SystemStartupCheck } from '../domain/systemStartup';

/** Inspect prerequisites only; never register startup during a check. */
export async function checkSystemStartup(): Promise<SystemStartupCheck> {
  const platform = process.platform;
  const host = vscode.env.appHost === 'node' ? 'node' : 'vscode';
  const checks: SystemStartupCheck['checks'] = [];
  const supported = platform === 'win32' || platform === 'darwin';
  checks.push({ label: 'Operating system', status: supported ? 'passed' : 'blocked', detail: platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform,
    ...(!supported ? { instruction: 'System startup supports Windows and macOS. Choose a supported system.' } : {}) });
  checks.push({ label: 'Manager host', status: 'passed', detail: host === 'node' ? 'Standalone Node.js' : 'VS Code extension' });
  const dashboard = getCodexManagerConfiguration().get<boolean>('webDashboardEnabled', false);
  checks.push({ label: 'Web Dashboard', status: dashboard ? 'passed' : 'blocked', detail: dashboard ? 'Enabled' : 'Disabled',
    ...(!dashboard ? { instruction: 'Enable Web Dashboard in Connections, then check again.' } : {}) });
  try {
    const executable = await resolveNodeExecutable();
    checks.push({ label: 'Node.js runtime', status: 'passed', detail: `Compatible runtime: ${executable}` });
  } catch (error) {
    checks.push({ label: 'Node.js runtime', status: 'blocked', detail: error instanceof Error ? error.message : String(error),
      instruction: 'Install Node.js 22.13 or newer on this system, restart the Manager host, then check again.' });
  }
  if (platform === 'win32') {
    try {
      const elevated = await new Promise<boolean>((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],
        { windowsHide: true, timeout: 3000 }, (error, stdout) => {
          if (error) { reject(error instanceof Error ? error : new Error('Windows administrator check failed.')); return; }
          const value = stdout.trim().toLowerCase();
          if (value !== 'true' && value !== 'false') { reject(new Error('Windows returned an unknown administrator status.')); return; }
          resolve(value === 'true');
        }));
      checks.push({ label: 'Windows account', status: elevated ? 'passed' : 'warning', detail: elevated ? 'Administrator: startup before sign-in is available.' : 'Not elevated: startup may be limited to sign-in.',
        ...(!elevated ? { instruction: host === 'vscode' ? 'For startup before sign-in, close VS Code on this system and reopen it using Run as administrator. Return here and check again.' : 'For startup before sign-in, restart the standalone Manager host from an administrator PowerShell terminal. Return here and check again.' } : {}) });
    } catch (error) {
      checks.push({ label: 'Windows account', status: 'warning', detail: `Could not check administrator access: ${error instanceof Error ? error.message : String(error)}`,
        instruction: 'Retry the check, or continue with verification. Windows will determine whether boot or sign-in startup is permitted.' });
    }
  } else if (platform === 'darwin') {
    const uid = process.getuid?.();
    const signedIn = uid !== undefined && uid !== 0;
    checks.push({ label: 'macOS account', status: signedIn ? 'passed' : 'blocked', detail: signedIn ? 'User account: startup at sign-in.' : 'A normal user account could not be verified.',
      ...(!signedIn ? { instruction: 'Restart Manager from your signed-in user account without sudo, then check again.' } : {}) });
  }
  return { ready: checks.every(check => check.status !== 'blocked'), platform, host, checks };
}
