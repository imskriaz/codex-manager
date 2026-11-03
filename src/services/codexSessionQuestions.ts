import type { DashboardCliSessionMessage } from '../domain/dashboard/types';
import { unansweredSessionQuestions, answeredSessionQuestionIds } from '../domain/sessionQuestions';
import { waitWithin } from '../utils/concurrency';
import { syncNativeCodexPrompts, clearNativeCodexPrompts, CodexPromptNotSentError } from './codexAppServerPrompts';
import type { AppServerRequest } from './codexAppServerRpc';
import { readCodexCliSessionMessages, readCodexCliSessionSummary, resolveCodexHome, sendCodexCliSessionMessage, steerCodexCliSessionTurn } from './codexSessionResume';
import { publishDashboardRealtime } from './dashboardRealtime';

const sources = new Map<string, { source: object; requests: Map<string, AppServerRequest>; accepted: Set<string> }>();

/** Async assistant questions use the same reviewed response path as blocking Codex prompts. */
export function syncAsyncCodexQuestions(home: string, sessionId: string, messages: DashboardCliSessionMessage[]): void {
  const key = JSON.stringify([home, sessionId]);
  let entry = sources.get(key);
  if (!entry) {
    while (sources.size >= 128) { const oldest = sources.keys().next().value!; clearNativeCodexPrompts(sources.get(oldest)!.source); sources.delete(oldest); }
    entry = { source: {}, requests: new Map(), accepted: new Set() }; sources.set(key, entry);
  }
  const answered = answeredSessionQuestionIds(messages);
  for (const id of answered) { entry.requests.delete(id); entry.accepted.delete(id); }
  for (const message of unansweredSessionQuestions(messages)) message.questions?.forEach((question, index) => {
    const id = JSON.stringify(['request_user_input_async', message.id, index]);
    if (answered.has(id) || entry!.accepted.has(id) || entry!.requests.size >= 30) return;
    entry!.requests.set(id, { id, method: 'item/tool/requestUserInput', params: { threadId: sessionId, sourceMessageId: message.id, questions: [{ id, header: 'Question', question: question.title, options: question.options?.map(label => ({ label, description: '' })) }] } });
  });
  const current = entry;
  syncNativeCodexPrompts(current.source, sessionId, [...current.requests.values()], async (request, result) => {
    const answers = (result as { answers?: Record<string, { answers: string[] }> }).answers;
    const answer = answers?.[String(request.id)]?.answers[0];
    if (!answer) { current.requests.delete(String(request.id)); current.accepted.add(String(request.id)); return; }
    if (home !== resolveCodexHome()) throw new CodexPromptNotSentError('The Codex account home changed. Open the session before answering.');
    const messages = await readCodexCliSessionMessages(sessionId, home).catch(error => { throw new CodexPromptNotSentError((error as Error).message); });
    const sourceId = (request.params as { sourceMessageId: string }).sourceMessageId;
    const question = unansweredSessionQuestions(messages).find(message => message.id === sourceId);
    const definition = (request.params as { questions: Array<{ question: string }> }).questions[0]!;
    if (!question || answeredSessionQuestionIds(messages).has(String(request.id))) throw new CodexPromptNotSentError('This question was already answered or is no longer active. Refresh the conversation.');
    const identity: unknown = JSON.parse(String(request.id));
    const index = Array.isArray(identity) && typeof identity[2] === "number" ? identity[2] : -1;
    if (question.questions?.[index]?.title !== definition.question) throw new CodexPromptNotSentError('The question changed. Refresh before answering.');
    const summary = await readCodexCliSessionSummary(sessionId, home).catch(error => { throw new CodexPromptNotSentError((error as Error).message); });
    if (!summary || summary.archived || summary.status === 'unknown') throw new CodexPromptNotSentError('This session cannot accept an answer yet. Open it and refresh before retrying.');
    if (home !== resolveCodexHome()) throw new CodexPromptNotSentError('The Codex account home changed. Refresh before answering.');
    const text = '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: request.id, question: definition.question, answer }]) + '\n</send_user_message_question_reply>';
    if (summary.status === 'running') {
      if (!summary.steerTurnId) throw new CodexPromptNotSentError('The running Codex owner is unavailable. Open the session before answering.');
      await steerCodexCliSessionTurn({ sessionId, text, expectedTurnId: summary.steerTurnId, projectPath: summary.projectPath });
    } else {
      await waitWithin(new Promise<void>((resolve, reject) => {
        let started = false;
        void sendCodexCliSessionMessage({ sessionId, text, projectPath: summary.projectPath, onStarted: () => { started = true; resolve(); } }).then(resolve, error => {
          if (!started) reject(error instanceof Error ? error : new Error(String(error)));
          else publishDashboardRealtime({ type: 'dashboard:notice', level: 'error', message: error instanceof Error ? error.message : 'The question reply turn failed. Open the related session to review it.' });
        });
      }), 12_000, 'The question reply was not confirmed. Open the related session before retrying.');
    }
    current.requests.delete(String(request.id)); current.accepted.add(String(request.id));
    while (current.accepted.size > 200) current.accepted.delete(current.accepted.values().next().value!);
  });
}

