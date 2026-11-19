// Public gateway aliases; the upstream model is always the selected Codex target.
export const CLAUDE_PROXY_MODELS = {
  opus: 'claude-opus',
  sonnet: 'claude-sonnet',
  haiku: 'claude-haiku',
  fable: 'claude-fable'
} as const;
export const CLAUDE_PROXY_MODEL_OVERRIDES = {
  'claude-opus-4-6': CLAUDE_PROXY_MODELS.opus,
  'claude-sonnet-4-6': CLAUDE_PROXY_MODELS.sonnet,
  'claude-haiku-4-5': CLAUDE_PROXY_MODELS.haiku,
  'claude-fable-5': CLAUDE_PROXY_MODELS.fable
};
export type ClaudeProxyMapping = Record<keyof typeof CLAUDE_PROXY_MODELS, string>;

export function claudeProxyModelName(role: keyof ClaudeProxyMapping, target: { id: string; name: string }): string {
  const name = target.name === target.id && /^gpt[-_]/i.test(target.id)
    ? target.id.replace(/^gpt[-_]/i, 'GPT ').replace(/[-_]/g, ' ') : target.name;
  return `${CLAUDE_PROXY_MODELS[role]} (${name})`;
}

export interface ApiProxyRequestLog {
  id: string;
  startedAt: number;
  method: string;
  path: string;
  model?: string;
  apiKeyId?: string;
  apiKeyName?: string;
  accountId?: string;
  accountEmail?: string;
  status: 'running' | 'completed' | 'incomplete' | 'failed' | 'cancelled';
  httpStatus?: number;
  durationMs?: number;
  inputTokens?: number;
  estimatedInputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  error?: string;
}

export interface ApiProxySnapshot {
  capturedAt: number;
  requests: ApiProxyRequestLog[];
  models?: Array<{ id: string; name: string }>;
  modelDiscoveryWarning?: string;
  claudeMapping?: ClaudeProxyMapping;
}

export function apiKeyUsage(snapshot: ApiProxySnapshot | undefined, id: string) {
  if (!snapshot) return undefined;
  const requests = snapshot.requests.filter(request => request.apiKeyId === id);
  const total = (field: 'inputTokens' | 'outputTokens' | 'cachedInputTokens') => {
    const values = requests.flatMap(request => request[field] === undefined ? [] : [request[field]!]);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : requests.length ? undefined : 0;
  };
  return { requests: requests.length, input: total('inputTokens'), output: total('outputTokens'), cached: total('cachedInputTokens'), errors: requests.filter(request => request.status === 'failed' || request.status === 'incomplete').length, lastUsed: requests.length ? Math.max(...requests.map(request => request.startedAt)) : undefined };
}
