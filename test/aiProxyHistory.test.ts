import { afterEach, expect, it } from 'vitest';
import { clearApiProxyHistory, readApiProxyHistory, startApiProxyLog } from '../src/services/aiProxyHistory';

it('bounds host metadata, normalizes untrusted paths, and returns isolated snapshots', () => {
  for (let index = 0; index < 105; index++) startApiProxyLog('GET', '/v1/models', String(index));
  const snapshot = readApiProxyHistory();
  expect(snapshot.requests).toHaveLength(100);
  expect(snapshot.requests[0].id).toBe('104');
  snapshot.requests[0].status = 'failed';
  expect(readApiProxyHistory().requests[0].status).toBe('running');
  startApiProxyLog('untrusted method', '/v1/private-secret?key=secret', 'safe');
  expect(readApiProxyHistory().requests[0]).toMatchObject({ method: 'OTHER', path: '/v1/unknown' });
  startApiProxyLog('GET', '/v1/models/private-secret', 'model');
  expect(readApiProxyHistory().requests[0].path).toBe('/v1/models/:id');
  startApiProxyLog('POST', '/v1/messages/count_tokens', 'count');
  expect(readApiProxyHistory().requests[0].path).toBe('/v1/messages/count_tokens');
  expect(JSON.stringify(readApiProxyHistory())).not.toContain('private-secret');
});


it('summarizes each key separately and keeps missing usage distinct from zero', async () => {
  const { apiKeyUsage } = await import('../src/domain/dashboard/apiProxy');
  const base = { startedAt: 10, method: 'POST', path: '/v1/responses' };
  const snapshot = { capturedAt: 20, requests: [
    { ...base, id: 'a', apiKeyId: 'key', status: 'completed' as const, inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
    { ...base, id: 'b', apiKeyId: 'key', status: 'failed' as const, startedAt: 15 },
    { ...base, id: 'c', apiKeyId: 'other', status: 'completed' as const, inputTokens: 999 },
    { ...base, id: 'd', apiKeyId: 'missing', status: 'cancelled' as const }
  ] };
  expect(apiKeyUsage(snapshot, 'key')).toEqual({ requests: 2, input: 100, output: 20, cached: 80, errors: 1, lastUsed: 15 });
  expect(apiKeyUsage(snapshot, 'unused')).toMatchObject({ requests: 0, input: 0, output: 0, cached: 0 });
  expect(apiKeyUsage(snapshot, 'missing')).toMatchObject({ requests: 1, input: undefined, output: undefined, cached: undefined });
  expect(apiKeyUsage(undefined, 'key')).toBeUndefined();
  expect(apiKeyUsage({ capturedAt: 20, requests: [{ ...base, id: 'count', apiKeyId: 'key', path: '/v1/messages/count_tokens', status: 'completed', estimatedInputTokens: 999 }] }, 'key')).toMatchObject({ requests: 1, input: undefined, output: undefined });
});

afterEach(() => clearApiProxyHistory());

it('deletes recorded entries and does not restore them when an in-flight request finishes', () => {
  const running = startApiProxyLog('POST', '/v1/messages', 'in-flight');
  startApiProxyLog('GET', '/v1/models', 'discovery').status = 'completed';
  expect(clearApiProxyHistory().requests).toEqual([]);
  expect(running.status).toBe('running');
  running.status = 'completed';
  expect(readApiProxyHistory().requests).toEqual([]);
  startApiProxyLog('POST', '/v1/messages', 'new-request');
  expect(readApiProxyHistory().requests.map(row => row.id)).toEqual(['new-request']);
  expect(clearApiProxyHistory().requests).toEqual([]);
  expect(clearApiProxyHistory().requests).toEqual([]);
});
