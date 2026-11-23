import type { DashboardCliSessionMessage } from './dashboard/types';

type QuestionPreview=NonNullable<NonNullable<DashboardCliSessionMessage['questions']>[number]['previews']>[number];
export function validQuestionPreview(value:unknown):value is QuestionPreview {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const preview=value as Record<string,unknown>;
  if(Object.keys(preview).some(key=>!['option','image','description'].includes(key))||typeof preview['option']!=='string'||!preview['option'].trim()||preview['option'].length>8000||typeof preview['image']!=='string'||preview['image'].length>8192||!preview['image'].startsWith('/api/workspace/image?')||preview['description']!==undefined&&(typeof preview['description']!=='string'||preview['description'].length>1000))return false;
  try{const url=new URL(preview['image'],'https://workspace.invalid');return url.pathname==='/api/workspace/image'&&!!url.searchParams.get('filePath')&&['image/png','image/jpeg','image/webp'].includes(url.searchParams.get('mimeType')??'');}catch{return false;}
}
export function readSessionQuestions(value: unknown): NonNullable<DashboardCliSessionMessage['questions']> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const question = value as { title?: unknown; question?: unknown; options?: unknown;previews?:unknown;view?:unknown };
    const title = question.title ?? question.question;
    if(typeof title!=='string'||!title.trim())return [];
    const options=Array.isArray(question.options)?question.options.flatMap((option:unknown)=>typeof option==='string'?[option.slice(0,8000)]:option&&typeof option==='object'&&'label' in option&&typeof option.label==='string'?[option.label.slice(0,8000)]:[]).slice(0,20):undefined;
    const seen=new Set<string>();
    const previews=Array.isArray(question.previews)?question.previews.filter(validQuestionPreview).filter(item=>{if(!options?.includes(item.option)||seen.has(item.option))return false;seen.add(item.option);return true;}).slice(0,10):[];
    const view=question.view==='grid'?(previews.length>=2?'grid':'list'):question.view==='list'?'list':undefined;
    return [{title:title.slice(0,8000),...(options?{options}:{}),...(previews.length?{previews}: {}),...(view?{view}:{})}];
  });
}

export function answeredSessionQuestionIds(messages: DashboardCliSessionMessage[]) {
  const answered = new Set<string>();
  for (const reply of messages) {
    if (reply.role !== 'user') continue;
    for (const match of reply.text.matchAll(/<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/g)) try {
      const value: unknown = JSON.parse(match[1]!);
      const rows: unknown[] = Array.isArray(value) ? value : [value];
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const reply = row as { questionItemId?: unknown; answer?: unknown };
        if (typeof reply.questionItemId === 'string' && typeof reply.answer === 'string' && reply.answer.trim()) {
          let id = reply.questionItemId;
          try { id = JSON.stringify(JSON.parse(id)); } catch { /* Keep legacy non-JSON IDs unchanged. */ }
          answered.add(id);
        }
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

/** Protocol mirrors may be separated by tool activity; question IDs identify the same answer. */
export function coalesceSessionQuestionMessages(messages: DashboardCliSessionMessage[]): DashboardCliSessionMessage[] {
  const answers = new Set<string>();
  const questions = new Set<string>();
  const result = messages.flatMap(message => {
    if (message.role === 'assistant' && !message.questions?.length && message.turnId && message.text.includes('?')) {
      const key = JSON.stringify([message.turnId, message.text.trim()]);
      if (questions.has(key)) return [];
      questions.add(key);
    }
    if (message.questions?.length) {
      const key = JSON.stringify([message.turnId ?? message.timestamp ?? message.id, message.questions]);
      if (questions.has(key)) return [];
      questions.add(key);
    }
    if (message.role !== 'user') return [message];
    const match = message.text.match(/^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/);
    if (!match) return [message];
    try {
      const value: unknown = JSON.parse(match[1]!);
      const rows: unknown[] = Array.isArray(value) ? value : [value];
      if (!rows.length || rows.some(row => !row || typeof row !== 'object' || !('questionItemId' in row) || typeof row.questionItemId !== 'string' || !('answer' in row) || typeof row.answer !== 'string')) return [message];
      const unique = rows.filter(row => {
        const reply = row as { questionItemId: string; answer: string };
        let id = reply.questionItemId;
        try { id = JSON.stringify(JSON.parse(id)); } catch { /* Legacy IDs remain valid. */ }
        const key = JSON.stringify([id, reply.answer.trim()]);
        if (answers.has(key)) return false;
        answers.add(key); return true;
      });
      return !unique.length ? [] : unique.length === rows.length ? [message] : [{ ...message, text: `<send_user_message_question_reply>\n${JSON.stringify(unique)}\n</send_user_message_question_reply>` }];
    } catch { return [message]; }
  });
  return result.length === messages.length && result.every((message, index) => message === messages[index]) ? messages : result;
}

export function sessionQuestionText(message: DashboardCliSessionMessage): string {
  if (!message.questions?.length) return message.text;
  const normalize = (text: string) => text.replace(/[*_`#>•]/g, '').replace(/^\s*[-+]\s+/gm, '').replace(/\s+/g, ' ').trim();
  const questionText = message.questions.flatMap(question => [question.title, ...(question.options ?? [])]).join('\n');
  return normalize(message.text) === normalize(questionText) ? '' : message.text;
}

