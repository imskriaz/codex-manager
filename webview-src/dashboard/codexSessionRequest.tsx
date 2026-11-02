import { useId } from "preact/hooks";
import { useModalAccessibility } from "./primitives";
import { canAnswerCodexPrompt, codexPromptKey, type CodexPromptEntry } from "./codexSessionPrompts";

export function CodexSessionRequest(props: {
  entry: CodexPromptEntry;
  inline?: boolean;
  queuedCount: number;
  connected: boolean;
  checking: boolean;
  onCheck: () => void;
  onAnswer: (key: string, questionId: string, answer: string) => void;
  onRespond: (key: string, decision: "approve" | "decline") => void;
}) {
  const prefix = useId();
  const accessibility = useModalAccessibility(!props.inline, () => undefined);
  const { request, answers, responseId, uncertain, error } = props.entry;
  const key = codexPromptKey(request);
  const isQuestion = request.kind === "question";
  const blocked = Boolean(responseId || uncertain || !props.connected);
  const content = <section ref={props.inline ? undefined : accessibility.modalRef} onKeyDown={props.inline ? undefined : accessibility.onKeyDown} tabIndex={-1}
    class={"codex-request-dialog" + (props.inline ? " codex-session-request" : "")} role={props.inline ? "region" : "dialog"} aria-modal={props.inline ? undefined : true}
    aria-labelledby={prefix + "-title"} aria-describedby={prefix + "-description"} aria-busy={Boolean(responseId)}>
    <div class="codex-request-eyebrow" role="status"><span class="codex-request-pulse" aria-hidden="true" /> {isQuestion ? "Answer needed" : "Permission needed"}{props.queuedCount > 0 ? " · " + props.queuedCount + " more waiting" : ""}</div>
    <h2 id={prefix + "-title"}>{request.title}</h2>
    <p id={prefix + "-description"}>{isQuestion ? "Answer to let Codex continue this turn." : "Review before continuing. Approval applies only to this request or the requested permissions for this turn."}</p>
    {request.cwd ? <div class="codex-request-cwd" title={request.cwd}>Project · {request.cwd}</div> : null}
    {request.detail ? <pre class="codex-request-detail">{request.detail}</pre> : !isQuestion ? <p class="codex-request-connection" role="status">No additional details were supplied. Review this action in its owning Codex window if needed.</p> : null}
    {request.questions?.map((question, index) => {
      const id = prefix + "-answer-" + index;
      const answer = typeof answers[question.id] === "string" ? answers[question.id]! : "";
      const selected = question.options?.some(option => option.label === answer);
      return <div class="codex-request-question" key={question.id}>
        <label for={id}><span>{question.header || "Question"}</span><strong>{question.question}</strong></label>
        {question.options?.length ? <select id={id} name={"choice-" + index} value={selected ? answer : ""} disabled={Boolean(responseId)} onChange={event => props.onAnswer(key, question.id, event.currentTarget.value)}>
          <option value="">Choose an answer…</option>
          {question.options.map(option => <option key={option.label} value={option.label}>{option.label}{option.description ? " — " + option.description : ""}</option>)}
        </select> : null}
        {question.isSecret
          ? <input id={question.options?.length ? id + "-custom" : id} name={"answer-" + index} type="password" autoComplete="off" aria-label={question.options?.length ? "Or type an answer for " + (question.header || question.question) : undefined} placeholder={question.options?.length ? "Or type your own answer…" : undefined} value={selected ? "" : answer} disabled={Boolean(responseId)} maxLength={8_000} onInput={event => props.onAnswer(key, question.id, event.currentTarget.value)} />
          : <textarea id={question.options?.length ? id + "-custom" : id} name={"answer-" + index} autoComplete="off" aria-label={question.options?.length ? "Or type an answer for " + (question.header || question.question) : undefined} placeholder={question.options?.length ? "Or type your own answer…" : undefined} rows={2} value={selected ? "" : answer} disabled={Boolean(responseId)} maxLength={8_000} onInput={event => props.onAnswer(key, question.id, event.currentTarget.value)} />}
      </div>;
    })}
    {!props.connected ? <p class="codex-request-connection" role="status">The owning system is offline. You can edit your answer; reconnect before sending.</p> : null}
    {error ? <p class="codex-request-error" role="alert">{error}</p> : null}
    <div class="codex-request-actions">
      <button type="button" class="is-secondary" disabled={blocked} onClick={() => props.onRespond(key, "decline")}>{isQuestion ? "Dismiss question" : "Decline"}</button>
      {uncertain ? <button type="button" disabled={!props.connected || props.checking} onClick={props.onCheck}>{props.checking ? "Checking…" : "Check request"}</button> : null}
      <button type="button" class="is-primary" disabled={blocked || !canAnswerCodexPrompt(props.entry)} onClick={() => props.onRespond(key, "approve")}>{responseId ? "Sending…" : isQuestion ? "Send answer" : "Approve once"}</button>
    </div>
  </section>;
  return props.inline ? content : <div class="codex-request-backdrop" role="presentation" onPointerDown={accessibility.onBackdropPointerDown} onMouseDown={accessibility.onBackdropMouseDown} onClick={accessibility.onBackdropClick}>{content}</div>;
}
