import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { requestCodexModels } from '../webview-src/dashboard/codexModelsSetting';
let target: EventTarget;
const send = vi.fn(() => 'model-request');
beforeEach(() => { vi.useFakeTimers(); target = new EventTarget(); vi.stubGlobal('window', target); send.mockClear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function reply(status: string, payload?: unknown, error?: string, requestId = 'model-request') {
  const event = new Event('message'); Object.assign(event, { data: { type: 'dashboard:action-result', action: 'manageCodexModels', requestId, status, payload, error } }); target.dispatchEvent(event);
}
it('routes to the selected host and accepts only the matching confirmed result', async () => {
  const pending = requestCodexModels(send, { operation: 'test', model: 'custom' }, 'remote');
  reply('completed', { codexModels: { message: 'wrong' } }, undefined, 'other');
  reply('completed', { codexModels: { message: 'OK' } });
  await expect(pending).resolves.toEqual({ message: 'OK' });
  expect(send).toHaveBeenCalledWith('manageCodexModels', undefined, { targetDeviceId: 'remote', codexModelRequest: { operation: 'test', model: 'custom' } });
});
it.each(['failed', 'missing'])('preserves host errors and rejects inconclusive results: %s', async status => {
  const pending = requestCodexModels(send, { operation: 'save', ids: '', expected: '' });
  const check = expect(pending).rejects.toThrow(status === 'failed' ? 'Access denied' : 'did not confirm');
  reply(status === 'failed' ? 'failed' : 'completed', undefined, status === 'failed' ? 'Access denied' : undefined);
  await check;
});
it('reports timeouts without replaying a test or accepting late results', async () => {
  const pending = requestCodexModels(send, { operation: 'test', model: 'custom' });
  const check = expect(pending).rejects.toThrow('outcome is unconfirmed');
  await vi.advanceTimersByTimeAsync(35_000); await check;
  reply('completed', { codexModels: { message: 'late' } });
  expect(send).toHaveBeenCalledOnce();
});
it('removes its waiter on cancellation', async () => {
  const controller = new AbortController();
  const pending = requestCodexModels(send, { operation: 'test', model: 'custom' }, undefined, controller.signal);
  const check = expect(pending).rejects.toThrow('cancelled'); controller.abort(); await check;
  expect(vi.getTimerCount()).toBe(0);
});
