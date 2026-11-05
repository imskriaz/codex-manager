import type { DashboardCliSessionMessage } from './dashboard/types';

export function formatActivityCode(text: string): string {
  const content = text.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
  if (!/^\s*[\[{]/.test(content) || content.length > 64_000) return content;
  try { JSON.parse(content); } catch { return content; }
  // Preserve numeric precision and escaped strings; copying still uses the original.
  const tokens = content.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:"]+/g) ?? [];
  let formatted = '', depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '{' || token === '[') {
      formatted += token;
      if (tokens[index + 1] === (token === '{' ? '}' : ']')) formatted += tokens[++index];
      else { if (++depth > 32) return content; formatted += '\n' + '  '.repeat(depth); }
    } else if (token === '}' || token === ']') formatted += '\n' + '  '.repeat(--depth) + token;
    else if (token === ',') formatted += ',\n' + '  '.repeat(depth);
    else formatted += token === ':' ? ': ' : token;
    if (formatted.length > 64_000) return content;
  }
  return formatted;
}

/** Only protocol recipient fields become links; arbitrary IDs in prose stay text. */
export function messageAgentIds(message: DashboardCliSessionMessage): string[] {
  if (message.kind !== 'collaboration' && !(message.kind === 'tool-call' && /(?:spawn_agent|send_message|send_input|wait_agent|close_agent|resume_agent|followup_task|interrupt_agent|list_agents)/i.test([message.title, message.subtitle, message.debug].join(' ')))) return [];
  const ids = new Set<string>();
  const add = (value: unknown) => { if (typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) && ids.size < 32) ids.add(value); };
  const read = (value: unknown, depth = 0): void => {
    if (depth > 6 || !value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      if (['agent_id', 'agentId', 'receiverThreadId', 'receiver_thread_id', 'target'].includes(key)) add(item);
      if (['receiverThreadIds', 'receiver_thread_ids', 'ids'].includes(key) && Array.isArray(item)) item.slice(0, 32).forEach(add);
      if (key === 'agentsStates' || key === 'status') { if (item && typeof item === 'object') Object.keys(item).slice(0, 32).forEach(add); }
      if (typeof item === 'string' && ['text', 'output', 'result', 'input', 'arguments'].includes(key) && item.length <= 64_000) { try { read(JSON.parse(item), depth + 1); } catch { /* Prose is not a protocol payload. */ } }
      else read(item, depth + 1);
    }
  };
  for (const raw of [message.debug, message.arguments, message.result]) if (raw && raw.length <= 64_000) {
    try {
      const value: unknown = JSON.parse(raw); read(value);
      if (raw === message.arguments && /(?:send_input|close_agent|resume_agent)/i.test([message.title, message.subtitle].join(' ')) && value && typeof value === 'object' && 'id' in value) add(value.id);
    } catch { /* Partial output remains readable. */ }
  }
  return [...ids];
}

export function agentActivityLabel(message: DashboardCliSessionMessage, names: Record<string, string>): string | undefined {
  const ids = messageAgentIds(message);
  if (ids.length !== 1) return;
  let name = names[ids[0]!];
  if (!name && message.debug && message.debug.length <= 64_000) {
    try {
      const detail = JSON.parse(message.debug) as Record<string, unknown>;
      const raw = detail['agentName'] ?? detail['agentNickname'] ?? detail['name'];
      if (typeof raw === 'string' && raw.trim()) name = raw;
    } catch { /* Partial payloads keep their activity label. */ }
  }
  name ||= 'agent';
  if (/send[_-]?(?:input|message)/i.test([message.subtitle, message.title].join(' '))) {
    if (message.status === 'failed') return `Message to ${name} failed`;
    if (message.status === 'inProgress') return `Sending message to ${name}`;
    if (message.status === 'completed') return `Sent message to ${name}`;
    return;
  }
  if (/\b(?:finished|completed)\b/i.test(message.title ?? '') && message.status === 'completed') return `Completed ${name}`;
  if (/wait[_-]?agent/i.test([message.subtitle, message.title].join(' ')) && message.status === 'completed' && message.result && message.result.length <= 64_000) {
    try {
      const result = JSON.parse(message.result) as { status?: Record<string, unknown>; agentsStates?: Record<string, unknown> };
      const state = (result.status ?? result.agentsStates)?.[ids[0]!];
      if (state === 'completed' || state && typeof state === 'object' && ('completed' in state || 'status' in state && state.status === 'completed')) return `Completed ${name}`;
    } catch { /* A completed wait is not proof that the agent finished. */ }
  }
  return undefined;
}
