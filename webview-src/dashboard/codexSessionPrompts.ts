import type { DashboardCodexServerRequest } from "../../src/domain/dashboard/types";

export type CodexPromptEntry = {
  request: DashboardCodexServerRequest;
  answers: Record<string, string>;
  responseId?: string;
  uncertain?: boolean;
  error?: string;
};
export type CodexPromptState = { entries: CodexPromptEntry[]; responses: Record<string, string>; closed: string[] };
export const emptyCodexPrompts: CodexPromptState = { entries: [], responses: {}, closed: [] };
export const codexPromptKey = (request: Pick<DashboardCodexServerRequest, "id" | "deviceId">): string => JSON.stringify([request.deviceId ?? "local", request.id]);
export function canAnswerCodexPrompt(entry: CodexPromptEntry): boolean {
  return !entry.responseId && !entry.uncertain && (entry.request.kind !== "question" ||
    Boolean(entry.request.questions?.length && entry.request.questions.every(question => {
      const raw = entry.answers[question.id];
      const answer = typeof raw === "string" ? question.isSecret ? raw : raw.trim() : undefined;
      return answer && answer.length <= 8_000;
    })));
}
export type CodexPromptUpdate =
  | { type: "list"; requests: DashboardCodexServerRequest[] }
  | { type: "request"; request: DashboardCodexServerRequest }
  | { type: "resolved"; key: string }
  | { type: "answer"; key: string; questionId: string; answer: string }
  | { type: "submit"; key: string; responseId: string }
  | { type: "error"; key: string; error?: string }
  | { type: "result"; responseId: string; success: boolean; error?: string }
  | { type: "timeout"; responseId: string };
export function updateCodexPrompts(state: CodexPromptState, update: CodexPromptUpdate): CodexPromptState {
  if (update.type === "list" || update.type === "request") {
    const incoming = update.type === "list" ? update.requests : state.entries.some(entry => codexPromptKey(entry.request) === codexPromptKey(update.request))
      ? state.entries.map(entry => codexPromptKey(entry.request) === codexPromptKey(update.request) ? update.request : entry.request)
      : [...state.entries.map(entry => entry.request), update.request];
    const seen = new Set<string>();
    const entries = incoming.filter(request => { const key = codexPromptKey(request); if (seen.has(key) || state.closed.includes(key)) return false; seen.add(key); return true; }).map(request => {
      const previous = state.entries.find(entry => codexPromptKey(entry.request) === codexPromptKey(request));
      if (!previous) return { request, answers: {} };
      if (JSON.stringify(previous.request) !== JSON.stringify(request)) return { request, answers: {}, responseId: previous.responseId, uncertain: true, error: "Request details changed. Check the request before responding." };
      return update.type === "list" && previous.uncertain ? { ...previous, uncertain: false, error: undefined } : previous;
    });
    return { ...state, entries };
  }
  if (update.type === "error") return { ...state, entries: state.entries.map(entry => codexPromptKey(entry.request) === update.key ? { ...entry, error: update.error } : entry) };
  if (update.type === "resolved") return { ...state, entries: state.entries.filter(entry => codexPromptKey(entry.request) !== update.key), closed: [...state.closed.filter(key => key !== update.key), update.key].slice(-128) };
  if (update.type === "answer") return { ...state, entries: state.entries.map(entry => codexPromptKey(entry.request) === update.key && !entry.responseId &&
    entry.request.questions?.some(question => question.id === update.questionId)
    ? { ...entry, answers: { ...entry.answers, [update.questionId]: update.answer.slice(0, 8_000) } } : entry) };
  if (update.type === "submit") {
    const entry = state.entries.find(item => codexPromptKey(item.request) === update.key);
    if (!entry || entry.responseId || entry.uncertain) return state;
    const activeIds = new Set(state.entries.flatMap(item => item.responseId ? [item.responseId] : []));
    const active = Object.entries(state.responses).filter(([id]) => activeIds.has(id));
    const retired = Object.entries(state.responses).filter(([id]) => !activeIds.has(id)).slice(-127);
    return { ...state, entries: state.entries.map(item => item === entry ? { ...item, responseId: update.responseId, error: undefined } : item), responses: Object.fromEntries([...retired, ...active, [update.responseId, update.key]]) };
  }
  const key = Object.hasOwn(state.responses, update.responseId) ? state.responses[update.responseId] : undefined;
  if (!key) return state;
  if (update.type === "timeout") return { ...state, entries: state.entries.map(entry => codexPromptKey(entry.request) === key && entry.responseId === update.responseId
    ? { ...entry, responseId: undefined, uncertain: true, error: "The response was not confirmed. Check the request before retrying; your answer is kept." } : entry) };
  const responses = { ...state.responses };
  delete responses[update.responseId];
  return { ...state, responses, closed: update.success ? [...state.closed.filter(item => item !== key), key].slice(-128) : state.closed, entries: update.success
    ? state.entries.filter(entry => codexPromptKey(entry.request) !== key)
    : state.entries.map(entry => codexPromptKey(entry.request) === key && (entry.responseId === update.responseId || !entry.responseId)
      ? { ...entry, responseId: undefined, uncertain: false, error: update.error || "Codex could not receive this response. Your answer is kept." } : entry) };
}
