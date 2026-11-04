import type { DashboardCliSessionMessage } from '../domain/dashboard/types';
import { answeredSessionQuestionIds } from '../domain/sessionQuestions';
import { getSqliteStateStore } from '../storage/sqliteState';
import { runCrossWindowExclusive, sharedResourceKey } from '../utils/crossWindowOperations';
import * as path from 'path';

const attempts = new Map<string, string[]>();

/** Fence question IDs across push, queued replies, windows and uncertain delivery. */
export async function sendCodexQuestionReply(home: string, sessionId: string, text: string, readMessages: () => Promise<DashboardCliSessionMessage[]>, send: (onAttempt: (attempted: boolean) => void) => Promise<void>): Promise<void> {
  const ids = [...answeredSessionQuestionIds([{ id: 'reply', role: 'user', text }])];
  if (!ids.length) return send(() => undefined);
  const resolvedHome = path.resolve(home);
  const key = sharedResourceKey('question-reply', [process.platform === 'win32' ? resolvedHome.toLowerCase() : resolvedHome, sessionId.toLowerCase()]);
  return runCrossWindowExclusive(key, 'Answer Codex question', async () => {
    const store = getSqliteStateStore();
    const answered = answeredSessionQuestionIds(await readMessages());
    const recorded = store?.get<string[]>('question-replies', key) ?? attempts.get(key) ?? [];
    if (ids.some(id => recorded.includes(id) || answered.has(id))) throw new Error('An answer to this question was already sent or is awaiting confirmation. Review the conversation before sending another answer.');
    const next = [...recorded, ...ids].slice(-200);
    // Save before delivery: after a crash or timeout, an answer must never replay itself.
    if (store) store.set('question-replies', key, next);
    else { attempts.set(key, next); while (attempts.size > 128) attempts.delete(attempts.keys().next().value!); }
    let attempted = false;
    try { await send(value => { attempted = value; }); }
    catch (error) {
      if (!attempted) {
        const remaining = next.filter(id => !ids.includes(id));
        if (store) store.set('question-replies', key, remaining);
        else attempts.set(key, remaining);
        throw error;
      }
      throw new Error(`${error instanceof Error ? error.message : String(error)} The answer was not confirmed; check the conversation before retrying.`);
    }
  });
}
