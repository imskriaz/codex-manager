import type { ApiProxyRequestLog, ApiProxySnapshot } from '../domain/dashboard/apiProxy';
import {getSqliteStateStore} from '../storage/sqliteState';

// Keep metadata only, bounded to this host process. Never store credentials or request/response bodies.
const requests: ApiProxyRequestLog[] = [];
let generation = 0;
const generations = new WeakMap<ApiProxyRequestLog,number>();
export function startApiProxyLog(method: string, path: string, id: string): ApiProxyRequestLog {
  const entry: ApiProxyRequestLog = { id, startedAt: Date.now(), method: method === 'GET' || method === 'POST' ? method : 'OTHER', path: ['/v1/models', '/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/messages/count_tokens'].includes(path) ? path : path.startsWith('/v1/models/') ? '/v1/models/:id' : '/v1/unknown', status: 'running' };
  requests.unshift(entry);
  generations.set(entry,generation);
  requests.length = Math.min(requests.length, 100);
  return entry;
}

export function readApiProxyHistory(): ApiProxySnapshot {
  const stored = getSqliteStateStore()?.recent<ApiProxyRequestLog>('office-proxy-logs', 100) ?? [];
  const current = new Set(requests.map(entry=>entry.id));
  return { capturedAt: Date.now(), requests: [...requests,...stored.reverse().filter(entry=>!current.has(entry.id))].slice(0,100).map(entry=>({...entry})) };
}

export function saveOfficeProxyLog(entry: ApiProxyRequestLog): void {
  const store = getSqliteStateStore();
  if (!store || generations.has(entry) && generations.get(entry)!==generation) return;
  store.set('office-proxy-logs', `${String(entry.startedAt).padStart(16,'0')}:${entry.id}`, entry);
  store.deleteBefore('office-proxy-logs', String(Date.now()-30*86_400_000).padStart(16,'0'));
}

export function clearApiProxyHistory(): ApiProxySnapshot {
  const store = getSqliteStateStore();
  if (store) store.transaction(()=>{for(const key of store.keys('office-proxy-logs'))store.set('office-proxy-logs',key,undefined);});
  generation++;
  requests.length = 0;
  return readApiProxyHistory();
}
