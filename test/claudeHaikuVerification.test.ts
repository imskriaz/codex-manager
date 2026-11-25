import { expect, it, vi } from 'vitest';
import { verifyClaudeHaiku } from '../src/services/claudeCliRuntime';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
const reply = (is_error: boolean) => ({type:'result',is_error}) as SDKMessage;
it('requires a successful Haiku response before exposing models', async () => {
  await expect(verifyClaudeHaiku((async function*(){yield reply(false);})())).resolves.toBeUndefined();
  await expect(verifyClaudeHaiku((async function*(){yield reply(true);})())).rejects.toThrow('Haiku verification failed');
  await expect(verifyClaudeHaiku((async function*(){})())).rejects.toThrow('without a confirmed response');
});
it('bounds an unresponsive verification', async () => {
  vi.useFakeTimers();
  try {
    const outcome=expect(verifyClaudeHaiku((async function*(){await new Promise(()=>{});yield reply(false);})())).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(15001);await outcome;
  } finally { vi.useRealTimers(); }
});
