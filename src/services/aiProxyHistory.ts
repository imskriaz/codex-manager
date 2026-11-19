import type { ApiProxyRequestLog, ApiProxySnapshot } from '../domain/dashboard/apiProxy';

// Keep metadata only, bounded to this host process. Never store credentials or request/response bodies.
const requests: ApiProxyRequestLog[] = [];
export function startApiProxyLog(method: string, path: string, id: string): ApiProxyRequestLog {
  const entry: ApiProxyRequestLog = { id, startedAt: Date.now(), method: method === 'GET' || method === 'POST' ? method : 'OTHER', path: ['/v1/models', '/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/messages/count_tokens'].includes(path) ? path : path.startsWith('/v1/models/') ? '/v1/models/:id' : '/v1/unknown', status: 'running' };
  requests.unshift(entry);
  requests.length = Math.min(requests.length, 100);
  return entry;
}

export function readApiProxyHistory(): ApiProxySnapshot {
  return { capturedAt: Date.now(), requests: requests.map(entry => ({ ...entry })) };
}

export function clearApiProxyHistory(): ApiProxySnapshot {
  requests.length = 0;
  return readApiProxyHistory();
}
