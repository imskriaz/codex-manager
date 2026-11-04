import type { DashboardCliSessionMessage } from './dashboard/types';

export function readSessionQuestions(value: unknown): NonNullable<DashboardCliSessionMessage['questions']> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const question = value as { title?: unknown; question?: unknown; options?: unknown };
    const title = question.title ?? question.question;
    return typeof title === 'string' && title.trim() ? [{ title: title.slice(0, 8000), ...(Array.isArray(question.options) ? { options: (question.options as unknown[]).flatMap(option => typeof option === 'string' ? [option.slice(0, 8000)] : option && typeof option === 'object' && 'label' in option && typeof option.label === 'string' ? [option.label.slice(0, 8000)] : []).slice(0, 20) } : {}) }] : [];
  });
}

export function answeredSessionQuestionIds(messages: DashboardCliSessionMessage[]) {
  const answered = new Set<string>();
  for (const reply of messages) {
    const match = reply.role === 'user' && reply.text.match(/^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/);
    if (!match) continue;
    try {
      const value: unknown = JSON.parse(match[1]!);
      const rows: unknown[] = Array.isArray(value) ? value : [value];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const reply = row as { questionItemId?: unknown; answer?: unknown };
        if (typeof reply.questionItemId === 'string' && typeof reply.answer === 'string' && reply.answer.trim()) answered.add(reply.questionItemId);
      }
    } catch { /* Incomplete replies remain visible as normal messages. */ }
  }
  return answered;
}

export function unansweredSessionQuestions(messages: DashboardCliSessionMessage[]) {
  const answered = answeredSessionQuestionIds(messages);
  return messages.filter(message => message.questions?.some((_, index) => !answered.has(JSON.stringify(['request_user_input_async', message.id, index]))));
}

export const SESSION_QUESTION_PROMPT_MS = 120_000;

/** History stays answerable; only a recent question with no later activity interrupts. */
export function activeSessionQuestion(messages: DashboardCliSessionMessage[], now = Date.now()) {
  const question = unansweredSessionQuestions(messages).at(-1);
  const timestamp = Date.parse(question?.timestamp ?? '');
  return question && messages.at(-1)?.id === question.id && Number.isFinite(timestamp) && timestamp <= now && now - timestamp < SESSION_QUESTION_PROMPT_MS ? question : undefined;
}

export function sessionQuestionReply(message: DashboardCliSessionMessage, answers: Record<string, string>): string {
  return `<send_user_message_question_reply>\n${JSON.stringify(message.questions?.flatMap((question, index) => answers[String(index)]?.trim() ? [{ questionItemId: JSON.stringify(['request_user_input_async', message.id, index]), question: question.title, answer: answers[String(index)]!.trim() }] : []))}\n</send_user_message_question_reply>`;
}

