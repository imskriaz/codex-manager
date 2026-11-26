import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { requestWorkspaceRuntime } from '../webview-src/dashboard/workspaceRuntimeSettings';

let target: EventTarget;
const send = vi.fn(() => 'request');
beforeEach(() => { vi.useFakeTimers(); target = new EventTarget(); vi.stubGlobal('window', target); send.mockClear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const reply = (status: string, runtime?: unknown, error?: string, requestId = 'request') => {
  const event = new Event('message'); Object.assign(event, { data: { type: 'dashboard:action-result', action: 'manageWorkspaceRuntime', requestId, status, payload: { workspaceRuntime: runtime }, error } }); target.dispatchEvent(event);
};

it('matches request IDs and returns confirmed setup', async () => {
  const result = requestWorkspaceRuntime(send, { provider: 'claude', operation: 'enable' });
  reply('completed', { provider: 'claude', enabled: true }, undefined, 'another');
  reply('completed', { provider: 'claude', available: true, enabled: true });
  expect(await result).toMatchObject({ provider: 'claude', enabled: true });
  expect(send).toHaveBeenCalledWith('manageWorkspaceRuntime', undefined, { runtimeRequest: { provider: 'claude', operation: 'enable' } });
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['failed', 'cancelled'])('preserves a %s result from setup', async status => {
  const result = requestWorkspaceRuntime(send, { provider: 'codex', operation: 'enable' });
  const check = expect(result).rejects.toThrow('Install failed: disk full'); reply(status, undefined, 'Install failed: disk full'); await check;
  expect(vi.getTimerCount()).toBe(0);
});
it('reports an unconfirmed timeout without replaying the installation', async () => {
  const result = requestWorkspaceRuntime(send, { provider: 'codex', operation: 'enable' });
  const check = expect(result).rejects.toThrow('outcome is unconfirmed'); await vi.advanceTimersByTimeAsync(120_000); await check;
  reply('completed', { provider: 'codex', enabled: true }); expect(send).toHaveBeenCalledOnce();
});
it('cleans up a waiter when its view closes', async () => {
  const controller = new AbortController(); const result = requestWorkspaceRuntime(send, { provider: 'claude', operation: 'check' }, controller.signal);
  const check = expect(result).rejects.toThrow('Stopped waiting'); controller.abort(); await check; expect(vi.getTimerCount()).toBe(0);
});
