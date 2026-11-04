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
  for (const raw of [message.debug, message.arguments, message.result]) if (raw && raw.length <= 64_000) { try { read(JSON.parse(raw)); } catch { /* Partial output remains readable. */ } }
  return [...ids];
}
