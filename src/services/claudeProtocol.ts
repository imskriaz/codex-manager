import type { DashboardCliSessionMessage, DashboardCliSessionSummary, DashboardCodexSessionLiveState } from '../domain/dashboard/types';
import { prepareChatInput, readChatTextAttachments, withoutChatTextAttachments, type ChatAttachment } from '../domain/chatAttachments';
import type { SDKUserMessage, PermissionMode } from '@anthropic-ai/claude-agent-sdk';

export const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value.slice(0, 12_000) : '';
export function claudePermissionMode(mode: string | undefined, autoApprove: boolean): PermissionMode {
  return mode === 'read-only' ? 'plan' : mode === 'danger-full-access' && autoApprove ? 'bypassPermissions' : mode === 'workspace-write' && autoApprove ? 'acceptEdits' : 'default';
}

export function claudeUserMessage(id: string, prompt: string, attachments?: ChatAttachment[], materializedText?: string): SDKUserMessage {
  const prepared = prepareChatInput(prompt, attachments);
  if (!prepared.text?.trim()) throw new Error('Write a message before sending it to Claude.');
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } }> = [{ type: 'text', text: materializedText ?? prepared.text }];
  for (const image of prepared.attachments?.filter(file => file.kind === 'image') ?? []) {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(image.data);
    if (!match) throw new Error('Claude requires PNG, JPEG, GIF or WebP image attachments.');
    content.push({ type: 'image', source: { type: 'base64', media_type: match[1] as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: match[2]! } });
  }
  return { type: 'user', session_id: id, parent_tool_use_id: null, message: { role: 'user', content } };
}

export function claudeMessage(raw: unknown): DashboardCliSessionMessage[] {
  const wire = object(raw), message = object(wire['message']);
  const role = wire['type'] === 'user' ? 'user' : 'assistant';
  const id = text(message['id'] ?? wire['uuid']);
  const parts = typeof message['content'] === 'string' ? [{ type: 'text', text: message['content'] }] : message['content'];
  if (!id || !Array.isArray(parts)) return [];
  const messages = parts.flatMap((part, index): DashboardCliSessionMessage[] => {
    const block = object(part), type = block['type'];
    if (type === 'text') return [{ id: `${id}-${index}`, role, kind: 'message', text: typeof block['text'] === 'string' ? block['text'].slice(0, role === 'user' ? 64_000 : 12_000) : '' }];
    if (type === 'thinking') return [{ id: `${id}-${index}`, kind: 'reasoning', text: text(block['thinking']) }];
    if (type === 'tool_use') return [{ id: `tool-${text(block['id'])}`, kind: 'tool-call', text: '', title: text(block['name']), arguments: JSON.stringify(block['input'] ?? {}).slice(0, 12_000), status: 'inProgress' }];
    if (type === 'tool_result') return [{ id: `tool-${text(block['tool_use_id'])}`, kind: 'tool-call', text: '', result: (typeof block['content'] === 'string' ? block['content'] : JSON.stringify(block['content'] ?? '')).slice(0, 12_000), status: block['is_error'] ? 'failed' : 'completed' }];
    if (type === 'image' && role === 'user') {
      const source = object(block['source']);
      if (source['type'] === 'base64' && typeof source['media_type'] === 'string' && typeof source['data'] === 'string') return [{ id: `${id}-${index}`, role, text: '', images: [{ src: `data:${source['media_type']};base64,${source['data']}` }] }];
    }
    return [];
  });
  if (role !== 'user') return messages;
  const content = messages.filter(item => item.role === 'user');
  if (!content.length) return messages;
  const fullText = content.map(item => item.text).filter(Boolean).join('\n\n');
  const textAttachments = readChatTextAttachments(fullText), images = content.flatMap(item => item.images ?? []);
  return [{ id: `${id}-0`, role, kind: 'message', text: withoutChatTextAttachments(fullText),
    ...(textAttachments.length ? { textAttachments } : {}), ...(images.length ? { images, imageCount: images.length } : {}) },
    ...messages.filter(item => item.role !== 'user')];
}

export function claudeQuota(previous: DashboardCliSessionSummary['nativeQuota'], raw: unknown): DashboardCliSessionSummary['nativeQuota'] {
  const info = object(raw);
  if (!['allowed','allowed_warning','rejected'].includes(String(info['status']))) return previous;
  const kind = typeof info['rateLimitType'] === 'string' ? info['rateLimitType'].slice(0, 64) : 'usage';
  const utilization = info['utilization'], resetsAt = info['resetsAt'];
  const limit = { kind, status: String(info['status']),
    ...(typeof utilization === 'number' && Number.isFinite(utilization) && utilization >= 0 && utilization <= 1 ? { usedPercent: utilization * 100 } : {}),
    ...(typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}) };
  return { checkedAt: Date.now(), limits: [...(previous?.limits ?? []).filter(item => item.kind !== kind), limit].slice(-10) };
}

export function claudeUsage(raw: unknown, modelUsage: unknown, contextTokens?: number): DashboardCodexSessionLiveState['tokenUsage'] {
  const usage = object(raw), models = Object.values(object(modelUsage)).map(object);
  const n = (source: Record<string, unknown>, key: string) => typeof source[key] === 'number' && Number.isSafeInteger(source[key]) && (source[key] as number) >= 0 ? source[key] as number : 0;
  const cumulative = models.some(model => typeof model['inputTokens'] === 'number' || typeof model['outputTokens'] === 'number');
  const cachedInput = cumulative ? models.reduce((sum, model) => sum + n(model, 'cacheReadInputTokens'), 0) : n(usage, 'cache_read_input_tokens');
  const input = cumulative ? models.reduce((sum, model) => sum + n(model, 'inputTokens') + n(model, 'cacheReadInputTokens') + n(model, 'cacheCreationInputTokens'), 0) : n(usage, 'input_tokens') + n(usage, 'cache_read_input_tokens') + n(usage, 'cache_creation_input_tokens');
  const output = cumulative ? models.reduce((sum, model) => sum + n(model, 'outputTokens'), 0) : n(usage, 'output_tokens');
  const contextWindow = models.map(model => model['contextWindow']).find(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0) as number | undefined;
  return { input, output, cachedInput, total: input + output, contextWindow, contextTokens };
}
