import {ModalShell} from './primitives';
import type { DashboardCliSessionMessage } from '../../src/domain/dashboard/types';
import { useEffect, useRef, useState } from 'preact/hooks';
import { readBrowserCache, writeBrowserCache } from './cliSessionCache';
import { readDismissedCodexRequests, saveDismissedCodexRequests } from './codexSessionPrompts';
import { activeSessionQuestion, sessionQuestionReply, SESSION_QUESTION_PROMPT_MS } from '../../src/domain/sessionQuestions';
export { sessionQuestionReply } from '../../src/domain/sessionQuestions';
export const pendingSessionQuestion = activeSessionQuestion;

export function SessionQuestionPrompt({ message, onReply, disabled, scope, autoOpen = false, answered, pending = false, assistantName = 'Codex' }: { message: DashboardCliSessionMessage; onReply?: (text: string) => string | undefined; disabled?: boolean; scope?: string; autoOpen?: boolean; answered: Set<string>; pending?: boolean; assistantName?: string }) {
  const key = `question:${scope ?? message.turnId ?? ''}:${message.id}`;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false), [expired, setExpired] = useState(() => readDismissedCodexRequests().includes(key));
  const [outcome, setOutcome] = useState(''), [ready, setReady] = useState(!onReply), [queued, setQueued] = useState(false);
  const [enlarged,setEnlarged]=useState<{image:string;option:string}>(),[failed,setFailed]=useState<string[]>([]);
  const edited = useRef(false), submitting = useRef(false);
  const questions = message.questions?.map((question, index) => ({ ...question, index })).filter(question => !answered.has(JSON.stringify(['request_user_input_async', message.id, question.index]))) ?? [];
  const visible = !!onReply && !queued && (open || autoOpen && !expired);
  useEffect(() => { if (!pending) { submitting.current = false; setQueued(false); } }, [pending, questions.length]);
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
  const close = () => { setOpen(false); setExpired(true); if (!saveDismissedCodexRequests([...readDismissedCodexRequests(), key])) setOutcome('Question closed in this tab. Browser storage is unavailable.'); };
  if (!questions.length || queued) return null;
  return <section class="cli-question-message" aria-label={`${assistantName} question`}>
    {!visible ? <>{!onReply?questions.map(question => <p key={question.index}>{question.title}</p>):null}{onReply ? <button type="button" disabled={queued} onClick={() => setOpen(true)} aria-expanded={false}>{queued ? 'Answer queued' : 'Answer'}</button> : null}</> :
      <ModalShell open={visible} title={`${assistantName} has a question`} closeLabel="Close question" className="session-question-modal" onClose={close}><form class="codex-request-panel cli-question-prompt" aria-label={`Answer ${assistantName} question`} onSubmit={event => {
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
        <div class="cli-question-scroll">{questions.map(question => <fieldset key={question.index} disabled={disabled || !ready}><legend>{question.title}</legend>
          <div class={question.view==='grid'||question.previews?.length&&question.view!=='list'?'cli-visual-options':undefined}>{question.options?.map((option,optionIndex)=>{
            const preview=question.previews?.find(item=>item.option===option);
            return <div class={preview||question.view==='grid'?'cli-visual-option':undefined} key={optionIndex}>{preview?<><button type="button" class="cli-visual-preview" aria-label={`Enlarge ${option}`} disabled={failed.includes(preview.image)} onClick={()=>setEnlarged(preview)}>{failed.includes(preview.image)?<span>Preview unavailable</span>:<img src={preview.image} alt={option} loading="lazy" onError={()=>{setFailed(current=>[...current,preview.image]);setOutcome('A preview could not be loaded. You can review its description or choose another option.');}}/>}</button>{preview.description?<p>{preview.description}</p>:null}</>:null}<label class="cli-question-option"><input type="radio" name={`question-${message.id}-${question.index}`} checked={answers[String(question.index)]===option} onChange={()=>update(question.index,option)}/><span>{option}</span></label></div>;
          })}</div>
          <label class="cli-question-freeform"><span>Your answer</span><textarea aria-label={`Answer: ${question.title}`} rows={2} maxLength={8000} value={answers[String(question.index)] ?? ''} onInput={event => update(question.index, event.currentTarget.value)} placeholder="Choose an option or type an answer…" /></label>
        </fieldset>)}</div>
        {outcome ? <p role="status">{outcome}</p> : null}
        <div class="dialog-actions"><button type="button" onClick={close}>Cancel</button><button type="submit" disabled={disabled || !ready || !questions.every(question => answers[String(question.index)]?.trim())}>Send answer</button></div>
      </form></ModalShell>}
    <ModalShell open={!!enlarged} title={enlarged?.option??'Preview'} closeLabel="Close visual preview" className="visual-review-modal" onClose={()=>setEnlarged(undefined)}>{enlarged?<img class="visual-review-image" src={enlarged.image} alt={enlarged.option}/>:null}</ModalShell>
    {!visible && outcome ? <p role="status">{outcome}</p> : null}
  </section>;
}
