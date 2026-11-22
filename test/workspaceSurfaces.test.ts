import { afterEach, expect, it, vi } from 'vitest';
import type { WorkspaceSurfaceState } from '../src/domain/workspaceSurface';
import { acknowledgeWorkspaceSurface, removeWorkspaceSurface, updateWorkspaceSurface, workspaceSurface } from '../src/services/workspaceSurfaces';

const phone = {}, desktop = {};
const state = (surfaceId = 'phone'): WorkspaceSurfaceState => ({ surfaceId, host: 'browser', viewport: { width: 390, height: 844 }, projectPath: 'D:/demo', sessionId: 'session', targetDeviceId: 'worker', visible: true, panelOpen: false, activeTab: 'env', tabs: [{ id: 'env', kind: 'env', title: 'Env' }], browserPages: [], terminals: [] });
afterEach(() => { removeWorkspaceSurface(phone); removeWorkspaceSurface(desktop); vi.useRealTimers(); });

it('discovers project surfaces without changing their UI and keeps scoped tokens local', async () => {
  const send = vi.fn();
  updateWorkspaceSurface(phone, state(), send);
  updateWorkspaceSurface(desktop, { ...state('desktop'), targetDeviceId: undefined }, send);
  expect((await workspaceSurface('D:/demo', { operation: 'list' })).surfaces).toHaveLength(2);
  expect((await workspaceSurface('D:/other', { operation: 'list' })).surfaces).toEqual([]);
  expect((await workspaceSurface('D:/demo', { operation: 'list' }, true)).surfaces.map(surface => surface.surfaceId)).toEqual(['desktop']);
  expect(send).not.toHaveBeenCalled();
});

it('sends a command only to the requested phone and completes after its own acknowledgement', async () => {
  const send = vi.fn(), other = vi.fn();
  updateWorkspaceSurface(phone, state(), send);
  updateWorkspaceSurface(desktop, state('desktop'), other);
  let completed = false;
  const command = workspaceSurface('D:/demo', { operation: 'open', surfaceId: 'phone', sessionId: 'session', tab: 'terminal' }).then(result => { completed = true; return result; });
  const message = send.mock.calls[0]![0];
  expect(message).toMatchObject({ type: 'dashboard:workspace-command', sessionId: 'session', request: { tab: 'terminal' } });
  acknowledgeWorkspaceSurface(desktop, message.requestId, { ...state(), panelOpen: true });
  await Promise.resolve(); expect(completed).toBe(false); expect(other).not.toHaveBeenCalled();
  acknowledgeWorkspaceSurface(phone, message.requestId, { ...state(), panelOpen: true, activeTab: 'terminal', tabs: [...state().tabs, { id: 'terminal', kind: 'terminal', title: 'Terminal' }] });
  expect((await command).surfaces[0]?.activeTab).toBe('terminal');
});

it('rejects ambiguous, hidden, stale and changed-context commands without choosing another dashboard', async () => {
  const send = vi.fn();
  updateWorkspaceSurface(phone, state(), send);
  await expect(workspaceSurface('D:/demo', { operation: 'open', tab: 'browser' })).rejects.toThrow('surfaceId');
  await expect(workspaceSurface('D:/demo', { operation: 'read', surfaceId: 'phone', sessionId: 'other' })).rejects.toThrow('surfaceId');
  updateWorkspaceSurface(phone, { ...state(), visible: false }, send);
  await expect(workspaceSurface('D:/demo', { operation: 'open', surfaceId: 'phone', sessionId: 'session', tab: 'browser' })).rejects.toThrow('background');
  expect(send).not.toHaveBeenCalled();
  updateWorkspaceSurface(phone, state(), send);
  const command = workspaceSurface('D:/demo', { operation: 'read', surfaceId: 'phone', sessionId: 'session' });
  const rejected = expect(command).rejects.toThrow('changed');
  acknowledgeWorkspaceSurface(phone, send.mock.calls[0]![0].requestId, { ...state(), sessionId: 'other' });
  await rejected;
  vi.useFakeTimers(); vi.advanceTimersByTime(45001);
  expect((await workspaceSurface('D:/demo', { operation: 'list' })).surfaces).toEqual([]);
});

it('reports timeout/disconnect as unknown and never replays panel commands', async () => {
  vi.useFakeTimers(); const send = vi.fn();
  updateWorkspaceSurface(phone, state(), send);
  const timed = expect(workspaceSurface('D:/demo', { operation: 'open', surfaceId: 'phone', sessionId: 'session', tab: 'browser' })).rejects.toThrow('outcome is unknown');
  await vi.advanceTimersByTimeAsync(25001); await timed; expect(send).toHaveBeenCalledOnce();
  const disconnected = expect(workspaceSurface('D:/demo', { operation: 'read', surfaceId: 'phone', sessionId: 'session' })).rejects.toThrow('disconnected');
  removeWorkspaceSurface(phone); await disconnected; expect(send).toHaveBeenCalledTimes(2);
});

it('validates surface envelopes and does not allow another connection to reuse an active surface ID', () => {
  expect(() => updateWorkspaceSurface(phone, { ...state(), tabs: 'invalid' }, vi.fn())).toThrow('Invalid');
  updateWorkspaceSurface(phone, state(), vi.fn());
  expect(() => updateWorkspaceSurface(desktop, state(), vi.fn())).toThrow('already connected');
});

it.each([{ sessionId: 'other' }, { targetDeviceId: 'other' }, { visible: false }])('fails a pending command immediately when its live context changes: %o', async change => {
  vi.useFakeTimers(); const send = vi.fn();
  updateWorkspaceSurface(phone, state(), send);
  const command = workspaceSurface('D:/demo', { operation: 'open', surfaceId: 'phone', sessionId: 'session', tab: 'browser' });
  const rejected = expect(command).rejects.toThrow('outcome is unknown');
  updateWorkspaceSurface(phone, { ...state(), ...change }, send);
  await rejected;
  expect(send).toHaveBeenCalledOnce();
  acknowledgeWorkspaceSurface(phone, send.mock.calls[0]![0].requestId, { ...state(), panelOpen: true });
  expect((await workspaceSurface('D:/demo', { operation: 'list' })).surfaces[0]).toMatchObject(change);
});

it('rejects an acknowledgement with a different surface identity on the same socket', async () => {
  const send = vi.fn(); updateWorkspaceSurface(phone, state(), send);
  const rejected = expect(workspaceSurface('D:/demo', { operation: 'read', surfaceId: 'phone', sessionId: 'session' })).rejects.toThrow('changed');
  acknowledgeWorkspaceSurface(phone, send.mock.calls[0]![0].requestId, state('replacement'));
  await rejected;
});

it('bounds an optional subscriber preview acknowledgement without replaying it',async()=>{
 vi.useFakeTimers();const send=vi.fn();updateWorkspaceSurface(phone,{...state(),targetDeviceId:undefined},send);
 const timed=expect(workspaceSurface('D:/demo',{operation:'open',surfaceId:'phone',sessionId:'session',tab:'browser',previewPath:'index.html'},true,()=>true,5000)).rejects.toThrow('outcome is unknown');
 await vi.advanceTimersByTimeAsync(5001);await timed;expect(send).toHaveBeenCalledOnce();
});
