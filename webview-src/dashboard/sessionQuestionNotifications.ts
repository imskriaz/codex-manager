import { useEffect, useRef, useState } from 'preact/hooks';
import type { DashboardCodexServerRequest, DashboardHostMessage, DashboardNotice } from '../../src/domain/dashboard/types';
import { codexPromptKey, readDismissedCodexRequests, saveDismissedCodexRequests } from './codexSessionPrompts';
import { answeredSessionQuestionIds } from '../../src/domain/sessionQuestions';

type QuestionNotification = Pick<DashboardCodexServerRequest, 'id' | 'threadId' | 'deviceId' | 'sourceMessageId'> & { kind: 'question'; title: string };
const STORAGE_KEY = 'codexManager.questionNotifications.v1';
export const questionNotificationKey = (request: QuestionNotification): string => JSON.stringify(['question', request.deviceId ?? 'local', request.threadId, request.sourceMessageId ?? request.id]);

function notification(value: unknown): QuestionNotification | undefined {
  if (!value || typeof value !== 'object') return;
  const request = value as Partial<DashboardCodexServerRequest>;
  if (request.kind !== 'question' || typeof request.id !== 'string' || !request.id || request.id.length > 256 || typeof request.threadId !== 'string' || !request.threadId || request.threadId.length > 256 ||
    request.deviceId !== undefined && (typeof request.deviceId !== 'string' || !request.deviceId || request.deviceId.length > 128) ||
    request.sourceMessageId !== undefined && (typeof request.sourceMessageId !== 'string' || !request.sourceMessageId || request.sourceMessageId.length > 256)) return;
  return { id: request.id, threadId: request.threadId, deviceId: request.deviceId, sourceMessageId: request.sourceMessageId, kind: 'question', title: 'Codex has a question' };
}

function readNotifications(): QuestionNotification[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value.slice(-128).flatMap(value => notification(value) ?? []) : [];
  } catch { return []; }
}

/** Persist only routing metadata; question text and secret answers stay in the conversation. */
export function useSessionQuestionNotifications(onNotice: (notice: DashboardNotice) => void) {
  const [notices, setNotices] = useState(readNotifications);
  const current = useRef(notices), dismissed = useRef(new Set(readDismissedCodexRequests()));
  for (const key of readDismissedCodexRequests()) dismissed.current.add(key);
  const hidden = (request: QuestionNotification): boolean => dismissed.current.has(questionNotificationKey(request)) || dismissed.current.has(codexPromptKey(request));
  const feedback = useRef(onNotice); feedback.current = onNotice;
  const save = (next: QuestionNotification[]): boolean => {
    current.current = next; setNotices(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); return true; } catch { return false; }
  };
  const clearAnswered = (answered: QuestionNotification[]): void => {
    if (!answered.length) return;
    const keys = new Set(answered.map(questionNotificationKey));
    for (const request of answered) dismissed.current.add(questionNotificationKey(request));
    const saved = save(current.current.filter(request => !keys.has(questionNotificationKey(request))));
    if (!saveDismissedCodexRequests([...readDismissedCodexRequests(), ...dismissed.current]) || !saved)
      feedback.current({ level: 'warning', message: 'Answered question cleared in this tab. Browser storage is unavailable.' });
  };
  useEffect(() => {
    const receive = (event: MessageEvent<DashboardHostMessage>): void => {
      const message = event.data;
      if (message?.type === 'dashboard:codex-request-resolved' && message.answered === true) {
        clearAnswered(current.current.filter(request => request.id === message.requestId && request.deviceId === message.deviceId));
        return;
      }
      const session = message?.type === 'dashboard:codex-session-live' ? { id: message.state.sessionId, deviceId: message.state.deviceId } :
        message?.type === 'dashboard:action-result' && message.status === 'completed' && message.action === 'getCodexCliSessionMessages' ? message.payload?.cliSession : undefined;
      const history = message?.type === 'dashboard:codex-session-live' ? message.state.messages :
        message?.type === 'dashboard:action-result' && message.action === 'getCodexCliSessionMessages' ? message.payload?.cliSessionMessages : undefined;
      if (session && history) {
        const answered = answeredSessionQuestionIds(history);
        clearAnswered(current.current.filter(request => request.threadId === session.id && request.deviceId === session.deviceId &&
          history.some(item => item.id === request.sourceMessageId && item.questions?.length && item.questions.every((_, index) => answered.has(JSON.stringify(['request_user_input_async', item.id, index]))))));
      }
      const requests = message?.type === 'dashboard:codex-request' ? [message.request] : message?.type === 'dashboard:codex-requests' && Array.isArray(message.requests) ? message.requests : [];
      if (!requests.length) return;
      const next = new Map(current.current.map(request => [questionNotificationKey(request), request]));
      for (const raw of requests) {
        const request = notification(raw);
        if (request && !hidden(request)) next.set(questionNotificationKey(request), request);
      }
      const values = [...next.values()].slice(-128);
      if (JSON.stringify(values) !== JSON.stringify(current.current)) save(values);
    };
    const changed = (event: StorageEvent): void => {
      if (event.key !== STORAGE_KEY && event.key !== 'codexManager.dismissedRequests.v1') return;
      for (const key of readDismissedCodexRequests()) dismissed.current.add(key);
      current.current = readNotifications(); setNotices(current.current);
    };
    window.addEventListener('message', receive);
    window.addEventListener('storage', changed);
    return () => { window.removeEventListener('message', receive); window.removeEventListener('storage', changed); };
  }, []);
  return {
    active: notices.find(request => !hidden(request)),
    dismiss(request: QuestionNotification): void {
      const key = questionNotificationKey(request);
      dismissed.current.add(key);
      const saved = save(current.current.filter(request => questionNotificationKey(request) !== key));
      if (!saveDismissedCodexRequests([...readDismissedCodexRequests(), ...dismissed.current]) || !saved)
        feedback.current({ level: 'warning', message: 'Question notification dismissed in this tab. Browser storage is unavailable.' });
    }
  };
}
