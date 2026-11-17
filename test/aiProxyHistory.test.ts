import { expect, it } from 'vitest';
import { readApiProxyHistory, startApiProxyLog } from '../src/services/aiProxyHistory';

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
  expect(JSON.stringify(readApiProxyHistory())).not.toContain('private-secret');
});
