import type { DashboardCliSessionMessage, DashboardHostMessage } from '../../src/domain/dashboard/types';
import { useEffect, useRef, useState } from 'preact/hooks';
import { readBrowserCache, writeBrowserCache } from './cliSessionCache';

import { unansweredSessionQuestions, sessionQuestionReply } from '../../src/domain/sessionQuestions';
export { sessionQuestionReply } from '../../src/domain/sessionQuestions';
export const pendingSessionQuestion = (messages: DashboardCliSessionMessage[]) => unansweredSessionQuestions(messages).at(-1);

export function SessionQuestionPrompt({ message, onReply, disabled, scope }: { message: DashboardCliSessionMessage; onReply?: (text: string) => string | undefined; disabled?: boolean; scope?: string }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [requestId, setRequestId] = useState<string>();
  const [outcome, setOutcome] = useState('');
  const [ready, setReady] = useState(!onReply);
  const edited = useRef(false), timer = useRef<ReturnType<typeof setTimeout>>();
  const key = `question:${scope ?? message.turnId ?? ''}:${message.id}`;
  useEffect(() => {
    if (!onReply) return;
    let disposed = false;
    void readBrowserCache<Record<string, string>>(key).then(saved => {
      if (!disposed) { if (!edited.current && saved && Object.values(saved).every(value => typeof value === 'string')) setAnswers(saved); setReady(true); }
    });
    return () => { disposed = true; };
  }, [key, !!onReply]);
  useEffect(() => {
    if (!requestId) return;
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const result = event.data;
      if (result?.type !== 'dashboard:action-result' || result.requestId !== requestId) return;
      clearTimeout(timer.current);
      if (result.status === 'completed') setOutcome('Answer sent to Codex.');
      else { setRequestId(undefined); setOutcome(result.error || 'Answer was not confirmed. Your answer is kept; review the conversation before retrying.'); }
    };
    window.addEventListener('message', receive);
    timer.current = setTimeout(() => setOutcome('Answer is awaiting confirmation. Your answer is kept; check the conversation before retrying.'), 65_000);
    return () => { clearTimeout(timer.current); window.removeEventListener('message', receive); };
  }, [requestId]);
  const update = (index: number, value: string) => {
    edited.current = true;
    const next = { ...answers, [index]: value };
    setAnswers(next);
    void writeBrowserCache(key, next).then(saved => { if (!saved) setOutcome('Browser storage could not save this answer. It is kept in this tab; copy it before closing.'); });
  };
  return <form class="codex-request-panel cli-question-prompt" aria-label="Codex question" onSubmit={event => {
    event.preventDefault();
    if (!onReply || disabled || requestId || !ready || !message.questions?.every((_, index) => answers[String(index)]?.trim())) return;
    const id = onReply(sessionQuestionReply(message, answers));
    if (id) { setRequestId(id); setOutcome('Sending answer…'); }
    else setOutcome('Your answer was not sent. Reconnect or wait for the current request.');
  }}>
    <strong>Codex has a question</strong>
    {message.questions?.map((question, index) => <fieldset key={index} disabled={!onReply || disabled || !!requestId || !ready}><legend>{question.title}</legend>
      {question.options?.map((option, optionIndex) => <label class="cli-question-option" key={optionIndex}><input type="radio" name={`question-${message.id}-${index}`} checked={answers[String(index)] === option} onChange={() => update(index, option)} /><span>{option}</span></label>)}
      {onReply ? <label class="cli-question-freeform"><span>Your answer</span><textarea aria-label={`Answer: ${question.title}`} rows={2} maxLength={8000} value={answers[String(index)] ?? ''} onInput={event => update(index, event.currentTarget.value)} placeholder="Choose an option or type an answer…" /></label> : null}
    </fieldset>)}
    {outcome ? <p role="status">{outcome}</p> : null}
    {onReply ? <button type="submit" disabled={disabled || !!requestId || !ready || !message.questions?.every((_, index) => answers[String(index)]?.trim())}>{requestId ? 'Answer submitted' : 'Send answer'}</button> : null}
  </form>;
}
