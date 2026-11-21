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
  const isMcpForm = request.kind === "mcp" && request.mcp?.mode === "form";
  const blocked = Boolean(responseId || uncertain || !props.connected);
  const content = <section ref={props.inline ? undefined : accessibility.modalRef} onKeyDown={props.inline ? undefined : accessibility.onKeyDown} tabIndex={-1}
    class={"codex-request-dialog" + (props.inline ? " codex-session-request" : "")} role={props.inline ? "region" : "dialog"} aria-modal={props.inline ? undefined : true}
    aria-labelledby={prefix + "-title"} aria-describedby={prefix + "-description"} aria-busy={Boolean(responseId)}>
    <div class="codex-request-eyebrow" role="status"><span class="codex-request-pulse" aria-hidden="true" /> {isQuestion ? "Answer needed" : "Permission needed"}{props.queuedCount > 0 ? " · " + props.queuedCount + " more waiting" : ""}</div>
    <h2 id={prefix + "-title"}>{request.title}</h2>
    <p id={prefix + "-description"}>{isQuestion || isMcpForm && request.questions?.length ? "Answer to let Codex continue this turn." : request.mcp?.mode === "url" ? "Open the link to complete the external step, then confirm that you have finished." : "Review before continuing. Approval applies only to this request or the requested permissions for this turn."}</p>
    {request.cwd ? <div class="codex-request-cwd" title={request.cwd}>Project · {request.cwd}</div> : null}
    {request.detail ? <pre class="codex-request-detail">{request.detail}</pre> : !isQuestion ? <p class="codex-request-connection" role="status">No additional details were supplied. Review this action in its owning Codex window if needed.</p> : null}
    {request.mcp?.warning ? <p class="codex-request-connection" role="alert">{request.mcp.warning}</p> : null}
    {request.approvalWarning ? <p class="codex-request-connection" role="alert">{request.approvalWarning}</p> : null}
    {request.mcp?.url && /^https?:\/\//i.test(request.mcp.url) ? <a href={request.mcp.url} target="_blank" rel="noopener noreferrer">Open request link</a> : null}
    {request.questions?.map((question, index) => {
      const id = prefix + "-answer-" + index;
      const answer = typeof answers[question.id] === "string" ? answers[question.id]! : "";
      const selected = question.options?.some(option => option.label === answer);
      const field = question.field;
      let selections: string[] = [];
      if (field?.type === "array") { try { const value: unknown = JSON.parse(answer); if (Array.isArray(value)) selections = value.filter((item): item is string => typeof item === "string"); } catch { /* No selection yet. */ } }
      return <div class="codex-request-question" key={question.id}>
        <label for={id}><span>{question.header || "Question"}{field && !field.required ? " (optional)" : ""}</span><strong>{question.question}</strong></label>
        {question.options?.length ? <select id={id} name={"choice-" + index} multiple={field?.type === "array"} value={field?.type === "array" ? undefined : selected ? answer : ""} disabled={Boolean(responseId)} onChange={event => props.onAnswer(key, question.id, field?.type === "array" ? JSON.stringify(Array.from(event.currentTarget.selectedOptions, option => option.value)) : event.currentTarget.value)}>
          {field?.type !== "array" ? <option value="">Choose an answer…</option> : null}
          {question.options.map(option => <option key={option.label} value={option.label} selected={field?.type === "array" ? selections.includes(option.label) : undefined}>{option.label}{option.description ? " — " + option.description : ""}</option>)}
        </select> : null}
        {field && question.options?.length ? null : field && (field.type === "number" || field.type === "integer") ? <input id={id} name={"answer-" + index} type="number" step={field.type === "integer" ? 1 : "any"} min={field.minimum} max={field.maximum} value={answer} disabled={Boolean(responseId)} onInput={event => props.onAnswer(key, question.id, event.currentTarget.value)} /> : question.isSecret
          ? <input id={question.options?.length ? id + "-custom" : id} name={"answer-" + index} type="password" autoComplete="off" aria-label={question.options?.length ? "Or type an answer for " + (question.header || question.question) : undefined} placeholder={question.options?.length ? "Or type your own answer…" : undefined} value={selected ? "" : answer} disabled={Boolean(responseId)} maxLength={8_000} onInput={event => props.onAnswer(key, question.id, event.currentTarget.value)} />
          : <textarea id={question.options?.length ? id + "-custom" : id} name={"answer-" + index} autoComplete="off" aria-label={question.options?.length ? "Or type an answer for " + (question.header || question.question) : undefined} placeholder={question.options?.length ? "Or type your own answer…" : undefined} rows={2} value={selected ? "" : answer} disabled={Boolean(responseId)} maxLength={8_000} onInput={event => props.onAnswer(key, question.id, event.currentTarget.value)} />}
      </div>;
    })}
    {!props.connected ? <p class="codex-request-connection" role="status">The owning system is offline. Your answer is kept; reconnect before sending.</p> : null}
    {error ? <p class="codex-request-error" role="alert">{error}</p> : null}
    <div class="codex-request-actions">
      <button type="button" class="is-secondary" disabled={blocked} onClick={() => props.onRespond(key, "decline")}>{isQuestion ? "Dismiss question" : "Decline"}</button>
      {uncertain ? <button type="button" disabled={!props.connected || props.checking} onClick={props.onCheck}>{props.checking ? "Checking…" : "Check request"}</button> : null}
      {request.mcp?.mode !== "external" ? <button type="button" class="is-primary" disabled={blocked || !canAnswerCodexPrompt(props.entry)} onClick={() => props.onRespond(key, "approve")}>{responseId ? "Sending…" : request.mcp?.mode === "url" ? "I’ve completed this step" : isQuestion || isMcpForm && request.questions?.length ? "Send answer" : "Approve once"}</button> : null}
    </div>
  </section>;
  return props.inline ? content : <div class="codex-request-backdrop" role="presentation" onPointerDown={accessibility.onBackdropPointerDown} onMouseDown={accessibility.onBackdropMouseDown} onClick={accessibility.onBackdropClick}>{content}</div>;
}
