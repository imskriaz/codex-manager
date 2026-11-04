import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { DashboardHostMessage, DashboardNotice } from "../../src/domain/dashboard/types";
import type { SendAction } from "./hookTypes";
import { postMessageToHost } from "./host";
import { sameCliSessionTarget, type CliSessionTarget } from "./cliSessionRoute";
import { canAnswerCodexPrompt, readDismissedCodexRequests, saveDismissedCodexRequests, codexPromptKey, emptyCodexPrompts, updateCodexPrompts, type CodexPromptEntry, type CodexPromptUpdate } from "./codexSessionPrompts";

export function useCodexSessionPrompts(props: {
  target?: CliSessionTarget;
  browser: boolean;
  connected: boolean;
  peers?: Array<{ id: string; connected: boolean; local?: boolean }>;
  sendAction: SendAction;
  onNotice: (notice: DashboardNotice) => void;
}) {
  const initialDismissed = useRef(readDismissedCodexRequests());
  const [dismissed, setDismissed] = useState(initialDismissed.current);
  const dismissedRef = useRef(dismissed); dismissedRef.current = dismissed;
  const dismiss = (key: string): void => {
    const next = [...dismissedRef.current.filter(value => value !== key), key].slice(-128);
    dismissedRef.current = next; setDismissed(next);
    if (!saveDismissedCodexRequests(next)) options.current.onNotice({level: "warning", message: "Request notification dismissed in this tab. Browser storage is unavailable."});
  };
  const [state, setState] = useState(emptyCodexPrompts);
  const current = useRef(state);
  const options = useRef(props); options.current = props;
  const [checking, setChecking] = useState(false);
  const checkTimer = useRef<number>();
  const checkTarget = useRef<string>();
  const update = useCallback((action: CodexPromptUpdate) => {
    current.current = updateCodexPrompts(current.current, action);
    setState(current.current);
  }, []);
  const matches = (entry: CodexPromptEntry): boolean => {
    const local = props.peers?.find(peer => peer.local)?.id;
    const device = (id?: string) => !id || id === "local" || id === local ? undefined : id;
    return sameCliSessionTarget({ id: entry.request.threadId, deviceId: device(entry.request.deviceId) }, props.target && { ...props.target, deviceId: device(props.target.deviceId) });
  };
  const connectedTo = (entry: CodexPromptEntry): boolean => {
    const { connected, peers } = options.current;
    const id = entry.request.deviceId;
    return connected && (!id || id === "local" || peers?.some(peer => peer.id === id && (peer.local || peer.connected)) === true);
  };
  useEffect(() => {
    const stopCheck = () => { window.clearTimeout(checkTimer.current); checkTimer.current = undefined; checkTarget.current = undefined; setChecking(false); };
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type === "dashboard:codex-requests") {
        const wasChecking = checkTimer.current !== undefined;
        stopCheck();
        const keys = new Set(message.requests.map(codexPromptKey));
        const closed = current.current.entries.some(entry => !keys.has(codexPromptKey(entry.request)) && !Object.values(current.current.responses).includes(codexPromptKey(entry.request)));
        update({ type: "list", requests: message.requests });
        if (closed && !wasChecking) options.current.onNotice({ level: "warning", message: "A pending Codex request closed while reconnecting. It may have expired or been answered elsewhere." });
        if (wasChecking) options.current.onNotice({ level: "info", message: current.current.entries.length ? "Pending Codex requests refreshed. Review before responding." : "No pending Codex requests remain." });
      } else if (message?.type === "dashboard:codex-request") {
        update({ type: "request", request: message.request });
      } else if (message?.type === "dashboard:codex-request-resolved") {
        const key = codexPromptKey({ id: message.requestId, deviceId: message.deviceId });
        const entry = current.current.entries.find(item => codexPromptKey(item.request) === key);
        if (entry && !Object.values(current.current.responses).includes(key)) options.current.onNotice({ level: "warning", message: "The Codex request closed. It may have expired, been cancelled, or been answered elsewhere." });
        if (checkTarget.current === key) stopCheck();
        update({ type: "resolved", key });
      } else if (message?.type === "dashboard:action-result" && message.action === "respondCodexServerRequest" && Object.hasOwn(current.current.responses, message.requestId)) {
        if (message.status === "completed" && checkTarget.current === current.current.responses[message.requestId]) stopCheck();
        if (message.status === 'completed') dismiss(current.current.responses[message.requestId]!);
        update({ type: "result", responseId: message.requestId, success: message.status === "completed", error: message.error });
        options.current.onNotice(message.status === "completed" ? { level: "info", message: "Response sent to Codex." } : { level: "error", message: message.error || "Codex could not receive this response. Your answer is kept." });
      }
    };
    window.addEventListener("message", receive);
    return () => { window.removeEventListener("message", receive); window.clearTimeout(checkTimer.current); };
  }, [update]);
  const check = (key: string): void => {
    if (!options.current.connected || checkTimer.current !== undefined) return;
    setChecking(true); checkTarget.current = key; update({ type: "error", key });
    checkTimer.current = window.setTimeout(() => {
      checkTimer.current = undefined; checkTarget.current = undefined; setChecking(false);
      const message = "Pending requests could not be verified. Your answer is kept; reconnect and check again.";
      update({ type: "error", key, error: message }); options.current.onNotice({ level: "warning", message });
    }, 15_000);
    try { postMessageToHost({ type: "dashboard:ready" }); }
    catch {
      window.clearTimeout(checkTimer.current); checkTimer.current = undefined; setChecking(false);
      const message = "The request check could not be sent. Your answer is kept.";
      update({ type: "error", key, error: message }); options.current.onNotice({ level: "error", message });
    }
  };
  const respond = (key: string, decision: "approve" | "decline"): void => {
    const entry = current.current.entries.find(item => codexPromptKey(item.request) === key);
    if (!entry || entry.responseId || entry.uncertain) return;
    if (!connectedTo(entry)) { options.current.onNotice({ level: "warning", message: "The owning system is offline. Your answer is kept; reconnect before responding." }); return; }
    if (decision === "approve" && !canAnswerCodexPrompt(entry)) return;
    const responseId = options.current.sendAction("respondCodexServerRequest", undefined, {
      codexRequestId: entry.request.id, codexDecision: decision,
      codexAnswers: decision === "approve" && entry.request.kind === "question" ? entry.answers : undefined,
      targetDeviceId: entry.request.deviceId
    });
    update({ type: "submit", key, responseId });
  };
  const active = state.entries.find(matches) ?? (!props.browser ? state.entries[0] : undefined);
  return {
    active, background: state.entries.find(entry => entry !== active && !dismissed.includes(codexPromptKey(entry.request))), dismiss, entries: state.entries,
    connectedTo, checking, check, respond,
    answer: (key: string, questionId: string, answer: string) => update({ type: "answer", key, questionId, answer }),
    timeout: (responseId: string) => update({ type: "timeout", responseId })
  };
}
