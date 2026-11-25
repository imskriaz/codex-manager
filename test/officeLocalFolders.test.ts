import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OfficeLocalFolderConnections } from '../src/services/officeLocalFolders';
let service: OfficeLocalFolderConnections;
const client = '11111111-1111-1111-1111-111111111111', other = '22222222-2222-2222-2222-222222222222';
beforeEach(() => { vi.useFakeTimers(); service = new OfficeLocalFolderConnections(); });
afterEach(() => { service.close(); vi.useRealTimers(); });

it('routes a command once and accepts only its owning connection response', async () => {
  service.connect('alex', '/project', client);
  const result = service.request('alex', '/project', { operation: 'read', path: 'report.txt' });
  const commands = service.poll('alex', '/project', client); expect(commands).toHaveLength(1);
  expect(service.poll('alex', '/project', client)).toEqual([]);
  expect(() => service.complete('sam', '/project', client, commands[0].id, {})).toThrow('offline');
  expect(() => service.complete('alex', '/project', other, commands[0].id, {})).toThrow('offline');
  const value = { data: Buffer.from('Report').toString('base64'), revision: 'a'.repeat(64), size: 6 };
  service.complete('alex', '/project', client, commands[0].id, value);
  await expect(result).resolves.toEqual(value);
});
it('keeps projects and users separate and refuses an active second tab', () => {
  service.connect('alex', '/project', client);
  expect(() => service.connect('alex', '/project', other)).toThrow('another browser tab');
  expect(() => service.request('alex', '/other', { operation: 'list' })).toThrow('offline');
  expect(() => service.request('sam', '/project', { operation: 'list' })).toThrow('offline');
  expect(() => service.request('alex', '/project', { operation: 'write', path: '../secret' })).toThrow('relative path');
});
it('expires undelivered writes without replay and ignores late results', async () => {
  service.connect('alex', '/project', client);
  const result = service.request('alex', '/project', { operation: 'write', path: 'report.txt', data: 'eA==' });
  const assertion = expect(result).rejects.toThrow('not replayed');
  await vi.advanceTimersByTimeAsync(12000); await assertion;
  expect(service.poll('alex', '/project', client)).toEqual([]);
  service.complete('alex', '/project', client, 'late', { revision: 'a'.repeat(64), size: 1 });
});
it('reports disconnected or expired connections without moving actions to the host', async () => {
  service.connect('alex', '/project', client);
  const result = service.request('alex', '/project', { operation: 'list' });
  const assertion = expect(result).rejects.toThrow('disconnected');
  service.disconnect('alex', '/project', client); await assertion;
  expect(() => service.request('alex', '/project', { operation: 'list' })).toThrow('offline');
  service.connect('alex', '/project', client); vi.advanceTimersByTime(30000);
  expect(() => service.request('alex', '/project', { operation: 'list' })).toThrow('offline');
  expect(() => service.connect('alex', '/project', other)).not.toThrow();
});
it('preserves errors and rejects malformed folder results', async () => {
  service.connect('alex', '/project', client);
  const failed = service.request('alex', '/project', { operation: 'list' });
  const [command] = service.poll('alex', '/project', client);
  service.complete('alex', '/project', client, command.id, undefined, 'Permission revoked');
  await expect(failed).rejects.toThrow('Permission revoked');
  const invalid = service.request('alex', '/project', { operation: 'list' });
  const [second] = service.poll('alex', '/project', client);
  service.complete('alex', '/project', client, second.id, { files: [{ path: '../secret', name: 'secret', type: 'file', depth: 0 }] });
  await expect(invalid).rejects.toThrow('invalid result');
});
