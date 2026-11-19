import { randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';
import { recordPersistentEvent } from '../utils/persistentLog';

type Phase = 'running' | 'closing' | 'handoff-requested' | 'closed' | 'failed';
type HostRecord = { host: 'vscode' | 'node'; pid: number; startedAt: string; phase: Phase; updatedAt: string; handoffRequested?: boolean };
const PREFIX = 'codexManager.hostLifecycle.';
const active = new WeakMap<vscode.ExtensionContext, { key: string; record: HostRecord; pending: Promise<void> }>();

/** A durable per-run marker survives a forced exit that cannot write a final log. */
export function startHostLifecycle(context: vscode.ExtensionContext, host: HostRecord['host']): Promise<void> {
  const previous = active.get(context);
  if (previous) return previous.pending;
  const now = new Date().toISOString();
  const current = { key: PREFIX + randomUUID(), record: { host, pid: process.pid, startedAt: now, phase: 'running' as Phase, updatedAt: now }, pending: Promise.resolve() };
  active.set(context, current);
  current.pending = (async () => {
    for (const key of context.globalState.keys().filter(key => key.startsWith(PREFIX)).slice(0, 32)) {
      const saved = context.globalState.get<HostRecord>(key);
      if (!saved || !Number.isSafeInteger(saved.pid) || saved.pid <= 0) continue;
      let exited = false;
      try { process.kill(saved.pid, 0); }
      catch (error) { exited = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (!exited) continue; // Other windows, access-denied probes and reused PIDs are inconclusive.
      if (saved.phase !== 'closed') recordPersistentEvent('warning', 'host-lifecycle',
        'Previous host close was not confirmed; possible abnormal termination', saved);
      await context.globalState.update(key, undefined);
    }
    await context.globalState.update(current.key, current.record);
    recordPersistentEvent('info', 'host-lifecycle', host === 'vscode' ? 'VS Code host started' : 'Standalone host started', current.record);
  })();
  return current.pending;
}

export function recordHostLifecycle(context: vscode.ExtensionContext | undefined, phase: Exclude<Phase, 'running'>, error?: unknown): Promise<void> {
  const current = context && active.get(context);
  if (!context || !current) return Promise.resolve();
  current.pending = current.pending.catch(error => console.warn('[codexManager] previous close marker could not be saved', error)).then(async () => {
    current.record = { ...current.record, phase, updatedAt: new Date().toISOString(),
      ...(phase === 'handoff-requested' ? { handoffRequested: true } : {}) };
    await context.globalState.update(current.key, current.record);
    const label = current.record.host === 'vscode' ? 'VS Code' : 'Standalone';
    recordPersistentEvent(phase === 'failed' ? 'error' : 'info', 'host-lifecycle', `${label} ${phase === 'closing' ? 'shutdown started' : phase === 'closed' ? 'shutdown completed' : phase === 'failed' ? 'shutdown failed' : 'standalone handoff requested'}`, current.record, error);
  });
  return current.pending;
}
