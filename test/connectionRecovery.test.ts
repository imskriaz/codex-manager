import { describe, expect, it } from 'vitest';
import { HOST_RELOAD_WAIT_MS, isDashboardHostReload, type DashboardHostReload } from '../src/domain/dashboard/hostReload';
import { connectionCopy, receiveReload, reconcileReloads, reloadStage, type Reloads } from '../webview-src/dashboard/connectionRecovery';

const now = 1_000_000;
const event: DashboardHostReload = { type: 'dashboard:host-reload', startedAt: now, phase: 'reloading', deviceId: 'pc', fromAccountId: 'old', toAccountId: 'new' };
const peer = (connected: boolean) => ({ id: 'pc', name: 'PC', sessionCount: 0, connected });

describe('connection recovery', () => {
  it('rejects malformed, future and expired reloads at the peer boundary', () => {
    expect(isDashboardHostReload(event, now)).toBe(true);
    for (const invalid of [null, {}, { ...event, startedAt: NaN }, { ...event, startedAt: now + 30_001 },
      { ...event, startedAt: now - 600_000 }, { ...event, phase: 'done' }, { ...event, deviceId: 4 },
      { ...event, fromAccountId: '' }, { ...event, toAccountId: 'x'.repeat(257) }]) {
      expect(isDashboardHostReload(invalid, now)).toBe(false);
    }
  });
  it('ignores stale and duplicate messages without extending the reload deadline', () => {
    const state = receiveReload({}, event, now);
    expect(receiveReload(state, event, now + 100)).toBe(state);
    expect(receiveReload(state, { ...event, startedAt: now - 1 }, now)).toBe(state);
    const failed = receiveReload(state, { ...event, phase: 'failed' }, now + 1_000);
    expect(failed['pc']?.receivedAt).toBe(now);
    expect(receiveReload(failed, event, now + 2_000)).toBe(failed);
    expect(receiveReload(failed, { ...event, phase: 'cancelled' }, now + 2_000)).toBe(failed);
    expect(reloadStage(failed['pc']!, now)).toBe('reload-failed');
  });
  it('retains the transition through incidental live snapshots and clears it after reconnection', () => {
    const state = receiveReload({}, event, now);
    expect(reconcileReloads(state, [peer(true)])).toBe(state);
    const lost = reconcileReloads(state, [peer(false)]);
    expect(lost['pc']?.disconnected).toBe(true);
    expect(reconcileReloads(lost, [])).toBe(lost);
    expect(reconcileReloads(lost, [peer(true)])).toEqual({});
    expect(reconcileReloads(reconcileReloads(state, [], true), [peer(true)])).toEqual({});
    const local = receiveReload({}, { ...event, deviceId: undefined }, now);
    expect(reconcileReloads(reconcileReloads(local, [], true), [{ ...peer(true), local: true }])).toEqual({});
  });
  it('bounds waiting and retained devices and keeps unrelated systems separate', () => {
    let state: Reloads = {};
    for (let id = 0; id < 40; id++) state = receiveReload(state, { ...event, deviceId: String(id) }, now + id);
    expect(Object.keys(state)).toHaveLength(32);
    expect(state['0']).toBeUndefined();
    expect(reloadStage(state['39']!, now + 39 + HOST_RELOAD_WAIT_MS)).toBe('reload-slow');
    expect(reloadStage({ ...state['39']!, phase: 'cancelled' }, now)).toBe('reload-cancelled');
    expect(reconcileReloads(state, [{ ...peer(true), id: '38' }])['39']).toBe(state['39']);
  });
  it('explains confirmed causes and states uncertainty without inventing a switch', () => {
    expect(connectionCopy('reloading').title).toBe('Reloading VS Code');
    expect(connectionCopy('reloading', 'PC', 'Switching from A to B.').detail).toContain('Switching from A to B.');
    expect(connectionCopy('offline').detail).toContain('browser reports');
    expect(connectionCopy('system-offline').detail).toContain('not confirmed');
    expect(connectionCopy('unreachable').detail).toContain('cause is not confirmed');
    expect(connectionCopy('reload-slow').detail).toContain('will not be repeated');
  });
});
