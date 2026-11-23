import { AsyncLocalStorage } from 'node:async_hooks';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getCodexHome } from '../codex/authFile';
import { getSqliteStateStore } from '../storage/sqliteState';
import type { DashboardCliSessionMessage, DashboardCliSessionSummary, DashboardCodexSessionLiveState, DashboardCodexServerRequest } from '../domain/dashboard/types';

export type ProviderConversation = {
  id: string;
  activeId: string;
  nativeIds: string[];
  title: string;
  model?: string;
  reasoningEffort?: string;
  firstPrompt?: string;
  history: DashboardCliSessionMessage[];
  bootstrap: string;
  input: Pick<DashboardCliSessionMessage, 'text' | 'textAttachments' | 'imageCount'>;
  deleted?: boolean;
  starting?: boolean;
  contextPath?: string;
};

const scope = () => 'session-providers:' + createHash('sha256').update(getCodexHome()).update('\0').update(path.resolve(process.env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude'))).digest('hex');
export function providerConversation(id: string): ProviderConversation | undefined {
  const store = getSqliteStateStore();
  const owner = store?.get<string>(scope() + ':owners', id.toLowerCase());
  return store?.get<ProviderConversation>(scope(), owner ?? id.toLowerCase());
}
export function nativeSessionId(id: string): string {
  const conversation = providerConversation(id);
  if (conversation?.deleted) throw new Error('This conversation was deleted. Refresh before retrying.');
  return conversation?.activeId ?? id;
}
export function saveProviderConversation(conversation: ProviderConversation): void {
  const store = getSqliteStateStore();
  if (!store) throw new Error('Conversation storage is unavailable. The provider was not changed.');
  store.transaction(() => {
    store.set(scope(), conversation.id, conversation);
    for (const id of conversation.nativeIds) store.set(scope() + ':owners', id, conversation.id);
  });
}
export function presentProviderMessages(id: string, messages: DashboardCliSessionMessage[]): DashboardCliSessionMessage[] {
  const conversation = providerConversation(id);
  if (!conversation) return messages;
  return messages.map(message => message.role === 'user' && message.text.startsWith(conversation.bootstrap)
    ? { ...message, ...conversation.input } : message);
}
export function presentProviderSummary(summary: DashboardCliSessionSummary): DashboardCliSessionSummary {
  const conversation = providerConversation(summary.id);
  return conversation ? { ...summary, id: conversation.id, title: conversation.title, model: conversation.model ?? summary.model, reasoningEffort: conversation.reasoningEffort ?? summary.reasoningEffort } : summary;
}
export function presentProviderSessions(sessions: DashboardCliSessionSummary[]): DashboardCliSessionSummary[] {
  return sessions.filter(session => {
    const conversation = providerConversation(session.id);
    return !conversation || !conversation.deleted && conversation.activeId === session.id;
  }).map(presentProviderSummary);
}
export function presentProviderLive(state: DashboardCodexSessionLiveState): DashboardCodexSessionLiveState | undefined {
  if (state.deviceId) return state;
  const conversation = providerConversation(state.sessionId);
  if (!conversation) return state;
  if (conversation.deleted || conversation.activeId !== state.sessionId) return undefined;
  return { ...state, sessionId: conversation.id, messages: presentProviderMessages(state.sessionId, state.messages) };
}
export function presentProviderRequest(request: DashboardCodexServerRequest): DashboardCodexServerRequest {
  if (request.deviceId || !request.threadId) return request;
  return { ...request, threadId: providerConversation(request.threadId)?.id ?? request.threadId };
}

/** Native cursors remain opaque; only the saved prefix uses a Manager cursor. */
export async function providerHistoryPage(id: string, before: string | undefined, read: (nativeId: string, before?: string) => Promise<{ messages: DashboardCliSessionMessage[]; olderThan?: string; warnings: string[] }>) {
  const conversation = providerConversation(id);
  if (!conversation || conversation.deleted) throw new Error('This conversation is unavailable. Refresh history.');
  if (before?.startsWith('provider:')) {
    if (!/^provider:\d{1,8}$/.test(before)) throw new Error('The conversation history cursor is invalid.');
    const end = Number(before.slice(9));
    if (end > conversation.history.length) throw new Error('The conversation history changed. Refresh before loading older messages.');
    const start = Math.max(0, end - 200);
    return { messages: conversation.history.slice(start, end), olderThan: start ? `provider:${start}` : undefined, warnings: [] as string[] };
  }
  const page = await read(conversation.activeId, before);
  const messages = presentProviderMessages(id, page.messages);
  if (page.olderThan) return { ...page, messages };
  const end = Math.max(0, conversation.history.length - Math.max(0, 200 - messages.length));
  return { ...page, messages: [...conversation.history.slice(end), ...messages], olderThan: end ? `provider:${end}` : undefined };
}

const nativeOperations = new AsyncLocalStorage<boolean>();
export const providerRoutingSuppressed = () => nativeOperations.getStore() === true;
export const withNativeSession = <T>(work: () => T): T => nativeOperations.run(true, work);
export const routedSessionId = (id: string): string => providerRoutingSuppressed() ? id : nativeSessionId(id);
