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
  outputTokens?: number;
  error?: string;
}

export interface ApiProxySnapshot {
  capturedAt: number;
  requests: ApiProxyRequestLog[];
}
