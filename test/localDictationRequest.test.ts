import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const post = vi.hoisted(() => vi.fn());
vi.mock('../webview-src/dashboard/host', () => ({ createActionRequestId: () => 'dictation-fixture', postMessageToHost: post }));
import { requestLocalDictation } from '../webview-src/dashboard/localDictationRequest';
let target: EventTarget;
beforeEach(() => { target = new EventTarget(); vi.stubGlobal('window', target); vi.useFakeTimers(); post.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function reply(status: 'completed' | 'failed', payload?: unknown, error?: string) {
  const event = new Event('message'); Object.assign(event, { data: { type: 'dashboard:action-result', action: 'localDictation', requestId: 'dictation-fixture', status, payload, error } }); target.dispatchEvent(event);
}
it('preserves host failures in the initiating dictation request', async () => {
  const pending = requestLocalDictation({ operation: 'status' });
  const check = expect(pending).rejects.toThrow('Model download failed'); reply('failed', undefined, 'Model download failed'); await check;
});
it('treats a missing host result as inconclusive instead of success', async () => {
  const pending = requestLocalDictation({ operation: 'prepare' }); const check = expect(pending).rejects.toThrow('did not return a result');
  reply('completed', {}); await check;
});
it('times out transcription visibly without replaying the audio', async () => {
  const pending = requestLocalDictation({ operation: 'transcribe', audio: 'fixture' }); const check = expect(pending).rejects.toThrow('did not respond in time');
  await vi.advanceTimersByTimeAsync(50_000); await check;
  expect(post).toHaveBeenCalledTimes(1);
});
it('cancels listener and timer when the composer changes and ignores late results', async () => {
  const controller = new AbortController(); const pending = requestLocalDictation({ operation: 'transcribe', audio: 'fixture' }, controller.signal);
  const check = expect(pending).rejects.toThrow('cancelled'); controller.abort(); reply('completed', { dictation: { ready: true, text: 'Late text' } }); await check;
  expect(vi.getTimerCount()).toBe(0);
});
