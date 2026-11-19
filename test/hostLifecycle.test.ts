import { afterEach, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { startHostLifecycle, recordHostLifecycle } from '../src/services/hostLifecycle';
import { recordPersistentEvent } from '../src/utils/persistentLog';

vi.mock('../src/utils/persistentLog', () => ({ recordPersistentEvent: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

function context(saved: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(saved));
  return {
    values,
    ctx: { globalState: {
      keys: () => [...values.keys()],
      get: (key: string) => values.get(key),
      update: async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, value); }
    } } as unknown as vscode.ExtensionContext
  };
}
const prefix = 'codexManager.hostLifecycle.';

it('serializes close and handoff markers and records a completed shutdown', async () => {
  const { ctx, values } = context();
  const started = startHostLifecycle(ctx, 'vscode');
  const closing = recordHostLifecycle(ctx, 'closing');
  const handoff = recordHostLifecycle(ctx, 'handoff-requested');
  const closed = recordHostLifecycle(ctx, 'closed');
  await Promise.all([started, closing, handoff, closed]);
  expect([...values.values()]).toEqual([expect.objectContaining({ phase: 'closed', handoffRequested: true, pid: process.pid })]);
  expect(vi.mocked(recordPersistentEvent).mock.calls.map(call => call[2])).toEqual([
    'VS Code host started', 'VS Code shutdown started', 'VS Code standalone handoff requested', 'VS Code shutdown completed'
  ]);
});

it('reports a dead unfinished host while preserving live and inconclusive windows', async () => {
  const { ctx, values } = context({
    [prefix + 'dead']: { pid: 101, phase: 'closing', host: 'node' },
    [prefix + 'closed']: { pid: 102, phase: 'closed', host: 'vscode' },
    [prefix + 'live']: { pid: 103, phase: 'running', host: 'vscode' },
    [prefix + 'denied']: { pid: 104, phase: 'running', host: 'node' }
  });
  vi.spyOn(process, 'kill').mockImplementation(pid => {
    if (pid === 103) return true;
    throw Object.assign(new Error('probe'), { code: pid === 104 ? 'EPERM' : 'ESRCH' });
  });
  await startHostLifecycle(ctx, 'node');
  expect(recordPersistentEvent).toHaveBeenCalledWith('warning', 'host-lifecycle', expect.stringContaining('possible abnormal termination'), expect.objectContaining({ pid: 101 }));
  expect(vi.mocked(recordPersistentEvent).mock.calls.filter(call => call[0] === 'warning')).toHaveLength(1);
  expect(values.has(prefix + 'dead')).toBe(false);
  expect(values.has(prefix + 'closed')).toBe(false);
  expect(values.has(prefix + 'live')).toBe(true);
  expect(values.has(prefix + 'denied')).toBe(true);
});

it('preserves shutdown failure details instead of reporting completion', async () => {
  const { ctx, values } = context();
  await startHostLifecycle(ctx, 'node');
  const error = new Error('Dashboard close failed');
  await recordHostLifecycle(ctx, 'failed', error);
  expect([...values.values()]).toEqual([expect.objectContaining({ phase: 'failed' })]);
  expect(recordPersistentEvent).toHaveBeenLastCalledWith('error', 'host-lifecycle', 'Standalone shutdown failed', expect.any(Object), error);
});
