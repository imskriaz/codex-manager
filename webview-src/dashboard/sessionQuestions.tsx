import type { DashboardCliSessionMessage } from '../../src/domain/dashboard/types';
import { useEffect, useRef, useState } from 'preact/hooks';
import { readBrowserCache, writeBrowserCache } from './cliSessionCache';
import { readDismissedCodexRequests, saveDismissedCodexRequests } from './codexSessionPrompts';
import { activeSessionQuestion, sessionQuestionReply, SESSION_QUESTION_PROMPT_MS } from '../../src/domain/sessionQuestions';
export { sessionQuestionReply } from '../../src/domain/sessionQuestions';
export const pendingSessionQuestion = activeSessionQuestion;

export function SessionQuestionPrompt({ message, onReply, disabled, scope, autoOpen = false, answered, pending = false }: { message: DashboardCliSessionMessage; onReply?: (text: string) => string | undefined; disabled?: boolean; scope?: string; autoOpen?: boolean; answered: Set<string>; pending?: boolean }) {
  const key = `question:${scope ?? message.turnId ?? ''}:${message.id}`;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false), [expired, setExpired] = useState(() => readDismissedCodexRequests().includes(key));
  const [outcome, setOutcome] = useState(''), [ready, setReady] = useState(!onReply), [queued, setQueued] = useState(false);
  const edited = useRef(false), submitting = useRef(false);
  const questions = message.questions?.map((question, index) => ({ ...question, index })).filter(question => !answered.has(JSON.stringify(['request_user_input_async', message.id, question.index]))) ?? [];
  const visible = !!onReply && !queued && (open || autoOpen && !expired);
  useEffect(() => { if (!questions.length) { submitting.current = false; setQueued(false); } }, [questions.length]);
  useEffect(() => {
    if (!onReply) return;
    let disposed = false;
    void readBrowserCache<Record<string, string>>(key).then(saved => {
      if (!disposed) { if (!edited.current && saved && Object.values(saved).every(value => typeof value === 'string')) setAnswers(saved); setReady(true); }
    }).catch(() => { if (!disposed) { setReady(true); setOutcome('Saved answer could not be loaded. You can still answer here.'); } });
    return () => { disposed = true; };
  }, [key, !!onReply]);
  useEffect(() => {
    if (!autoOpen) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, Date.parse(message.timestamp ?? '') + SESSION_QUESTION_PROMPT_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [autoOpen, message.timestamp]);
  const update = (index: number, value: string) => {
    edited.current = true;
    const next = { ...answers, [index]: value };
    setAnswers(next);
    void writeBrowserCache(key, next).then(saved => { if (!saved) setOutcome('Browser storage could not save this answer. It is kept in this tab; copy it before closing.'); });
  };
  if (!questions.length) return <section class="cli-question-message" aria-label={pending ? 'Queued Codex answer' : 'Answered Codex question'}>{message.questions?.map((question, index) => <p key={index}>{question.title}</p>)}<small>{pending ? 'Answer queued' : 'Answered'}</small></section>;
  return <section class="cli-question-message" aria-label="Codex question">
    {!visible ? <>{questions.map(question => <p key={question.index}>{question.title}</p>)}{onReply ? <button type="button" disabled={queued} onClick={() => setOpen(true)} aria-expanded={false}>{queued ? 'Answer queued' : 'Answer'}</button> : null}</> :
      <form class="codex-request-panel cli-question-prompt" aria-label="Answer Codex question" onSubmit={event => {
        event.preventDefault();
        if (!onReply || disabled || submitting.current || !ready || !questions.every(question => answers[String(question.index)]?.trim())) return;
        submitting.current = true;
        const remaining = Object.fromEntries(questions.map(question => [String(question.index), answers[String(question.index)]!]));
        let id: string | undefined;
        try { id = onReply(sessionQuestionReply(message, remaining)); }
        catch (error) { submitting.current = false; setOutcome(error instanceof Error ? error.message : 'Your answer could not be queued. It is kept here.'); return; }
        if (id) { setQueued(true); setOpen(false); setExpired(true); setOutcome('Answer queued. Follow its status in the conversation.'); }
        else { submitting.current = false; setOutcome('Your answer could not be queued. It is kept here; review the conversation before retrying.'); }
      }}>
        <strong>Codex has a question</strong>
        {questions.map(question => <fieldset key={question.index} disabled={disabled || !ready}><legend>{question.title}</legend>
          {question.options?.map((option, optionIndex) => <label class="cli-question-option" key={optionIndex}><input type="radio" name={`question-${message.id}-${question.index}`} checked={answers[String(question.index)] === option} onChange={() => update(question.index, option)} /><span>{option}</span></label>)}
          <label class="cli-question-freeform"><span>Your answer</span><textarea aria-label={`Answer: ${question.title}`} rows={2} maxLength={8000} value={answers[String(question.index)] ?? ''} onInput={event => update(question.index, event.currentTarget.value)} placeholder="Choose an option or type an answer…" /></label>
        </fieldset>)}
        <button type="button" onClick={() => { setOpen(false); setExpired(true); if (!saveDismissedCodexRequests([...readDismissedCodexRequests(), key])) setOutcome('Question closed in this tab. Browser storage is unavailable.'); }}>Close</button>
        <button type="submit" disabled={disabled || !ready || !questions.every(question => answers[String(question.index)]?.trim())}>Send answer</button>
      </form>}
    {outcome ? <p role="status">{outcome}</p> : null}
  </section>;
}
