// Stable, recognized Claude IDs are public gateway aliases, not upstream model claims.
export const CLAUDE_PROXY_MODELS = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
  fable: 'claude-fable-5'
} as const;
export type ClaudeProxyMapping = Record<keyof typeof CLAUDE_PROXY_MODELS, string>;

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
