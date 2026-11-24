import type { LocalDictationRequest, LocalDictationResult } from '../../src/services/localDictation';
import type { DashboardHostMessage } from '../../src/domain/dashboard/types';
import { createActionRequestId, postMessageToHost } from './host';

export function requestLocalDictation(request: LocalDictationRequest, signal?: AbortSignal): Promise<LocalDictationResult> {
  const requestId = createActionRequestId(true);
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); window.removeEventListener('message', receive); signal?.removeEventListener('abort', cancel); };
    const cancel = () => { finish(); reject(new Error('Dictation cancelled. Your draft is kept.')); };
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type !== 'dashboard:action-result' || message.requestId !== requestId || message.action !== 'localDictation') return;
      finish();
      if (message.status !== 'completed' || !message.payload?.dictation) reject(new Error(message.error || 'Local Whisper did not return a result. Update the host and retry.'));
      else resolve(message.payload.dictation);
    };
    const timer = setTimeout(() => { finish(); reject(new Error('Local Whisper did not respond in time. Your draft is kept.')); }, request.operation === 'transcribe' ? 50_000 : 10_000);
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    window.addEventListener('message', receive);
    try { postMessageToHost({ type: 'dashboard:action', requestId, action: 'localDictation', payload: { dictationRequest: request, automatic: true } }); }
    catch (error) { finish(); reject(error instanceof Error ? error : new Error(String(error))); }
  });
}
