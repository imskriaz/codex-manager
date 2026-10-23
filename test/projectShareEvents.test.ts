import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectShareEvents } from '../src/services/projectShareEvents';
import { createProjectShare, getProjectShare, readProjectTasks, revokeProjectShares, saveProjectTask, syncProjectSessions } from '../src/services/projectTasks';
import { publishDashboardRealtime } from '../src/services/dashboardRealtime';
import { configureSqliteStateStore, SqliteStateStore } from '../src/storage/sqliteState';
import { removeTestDirectory } from './testFilesystem';

const state = vi.hoisted(() => ({ home: '' }));
vi.mock('../src/services/codexSessionResume', () => ({ resolveCodexHome: () => state.home }));
let root: string, store: SqliteStateStore, streams: ProjectShareEvents;
class Response extends EventEmitter {
  writableLength = 0; writableEnded = false; destroyed = false;
  headers = new Map<string, string>();
  setHeader(key: string, value: string) { this.headers.set(key, value); }
  write = vi.fn((_chunk: string) => true);
  end = vi.fn(() => { this.writableEnded = true; });
  destroy() { this.destroyed = true; this.emit('close'); }
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
  root = await mkdtemp(join(tmpdir(), 'manager-share-events-')); state.home = root;
  store = await SqliteStateStore.open(join(root, 'manager.sqlite')); configureSqliteStateStore(store);
  readProjectTasks(root); streams = new ProjectShareEvents();
});
afterEach(async () => { streams.close(); vi.restoreAllMocks(); vi.useRealTimers(); configureSqliteStateStore(undefined); store.close(); await removeTestDirectory(root); });
function open(response = new Response(), days = 7, address = '127.0.0.1', token = createProjectShare(root, [], days).token) {
  const result = streams.open(response as unknown as ServerResponse, token, getProjectShare(token)!, address);
  return { response, token, result };
}
const changed = (projectPath = root) => publishDashboardRealtime({ type: 'dashboard:project-changed', projectPath });

it('sends no project content, ignores other project events, and bounds bursts without idle polling', async () => {
  const { response } = open();
  expect(response.headers.get('Content-Type')).toContain('text/event-stream');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  changed(join(root, 'other')); await vi.advanceTimersByTimeAsync(0);
  expect(response.write).toHaveBeenCalledTimes(1);
  changed(); await vi.advanceTimersByTimeAsync(0);
  expect(response.write).toHaveBeenLastCalledWith('event: change\ndata: {}\n\n');
  for (let index = 0; index < 100; index++) changed();
  await vi.advanceTimersByTimeAsync(1499); expect(response.write).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); expect(response.write).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(10000); expect(response.write).toHaveBeenCalledTimes(3);
  expect(response.write.mock.calls.flat().join('')).not.toContain(root);
});

it('invalidates known local sessions without exposing transcripts or reacting to another session/device', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  syncProjectSessions(root, root, [{ id, title: 'Private title', status: 'running' }]);
  await vi.advanceTimersByTimeAsync(0);
  const { response } = open();
  const live = { sessionId: id, streamId: id, sequence: 1, status: 'running' as const, updatedAt: Date.now(), messages: [{ id: 'secret', role: 'assistant' as const, text: 'Secret output' }] };
  publishDashboardRealtime({ type: 'dashboard:codex-session-live', state: { ...live, deviceId: 'other' } });
  publishDashboardRealtime({ type: 'dashboard:codex-session-live', state: { ...live, sessionId: 'outside' } });
  await vi.advanceTimersByTimeAsync(0); expect(response.write).toHaveBeenCalledTimes(1);
  publishDashboardRealtime({ type: 'dashboard:codex-session-live', state: live });
  await vi.advanceTimersByTimeAsync(0); expect(response.write).toHaveBeenCalledTimes(2);
  expect(response.write.mock.calls.flat().join('')).not.toContain('Secret');
});

it('detects committed edits and revocations written from another SQLite connection', async () => {
  saveProjectTask(root, { id: 'task', title: 'Task', prompt: '', stage: 'planned', expectedRevision: 0 });
  await vi.advanceTimersByTimeAsync(0);
  const { response, token } = open();
  const other = await SqliteStateStore.open(store.file);
  try {
    other.prepare("UPDATE project_tasks SET data=json_set(data,'$.revision',2) WHERE id='task'").run();
    await vi.advanceTimersByTimeAsync(251); expect(response.write).toHaveBeenCalledTimes(2);
    other.prepare("DELETE FROM state WHERE namespace='project-shares'").run();
    await vi.advanceTimersByTimeAsync(250);
    expect(getProjectShare(token)).toBeUndefined();
    expect(response.write).toHaveBeenLastCalledWith('event: revoked\ndata: {}\n\n');
    expect(response.end).toHaveBeenCalledOnce();
  } finally { other.close(); }
});

it('expires open links at their deadline and handles 30-day timer overflow correctly', () => {
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const start = Date.now(), day = 24 * 60 * 60 * 1000;
  const { response } = open(new Response(), 1);
  const expireShort = timers.mock.calls.at(-1)![0] as () => void;
  const long = open(new Response(), 30).response;
  const expireLong = timers.mock.calls.at(-1)![0] as () => void;
  expect(timers.mock.calls.at(-1)![1]).toBe(2_147_483_647);
  vi.setSystemTime(start + day); expireShort();
  expect(response.end).toHaveBeenCalledOnce(); expect(long.end).not.toHaveBeenCalled();
  vi.setSystemTime(start + 2_147_483_647); expireLong();
  expect(long.end).not.toHaveBeenCalled();
  expect(timers.mock.calls.at(-1)![1]).toBe(30 * day - 2_147_483_647);
  vi.setSystemTime(start + 30 * day); expireLong();
  expect(long.end).toHaveBeenCalledOnce();
});

it('releases subscriptions and pending sends after disconnect or host shutdown', async () => {
  const first = open(), second = open();
  changed(); first.response.emit('close'); streams.close();
  await vi.advanceTimersByTimeAsync(2000); changed();
  expect(first.response.write).toHaveBeenCalledTimes(1); expect(second.response.write).toHaveBeenCalledTimes(1);
  expect(first.response.listenerCount('close')).toBe(0);
  expect(first.response.end).toHaveBeenCalledOnce(); expect(second.response.end).toHaveBeenCalledOnce();
});

it('caps total connections and duplicate viewers, and frees their slots on close', () => {
  const first = open(), duplicate = open(new Response(), 7, '127.0.0.1', first.token);
  expect(duplicate.result).toBe(true);
  expect(open(new Response(), 7, '127.0.0.1', first.token).result).toBe(false);
  first.response.emit('close'); expect(open(new Response(), 7, '127.0.0.1', first.token).result).toBe(true);
  for (let index = 0; index < 30; index++) expect(open().result).toBe(true);
  expect(open().result).toBe(false);
});

it('disconnects slow or failed responses instead of accumulating output', async () => {
  const slow = open().response, broken = open().response;
  slow.writableLength = 16 * 1024 + 1;
  broken.write.mockImplementationOnce(() => { throw new Error('Disconnected'); });
  changed(); await vi.advanceTimersByTimeAsync(0);
  expect(slow.destroyed).toBe(true); expect(broken.destroyed).toBe(true);
});

it('fails closed on storage errors and revocation during a pending invalidation', async () => {
  const { response } = open();
  changed(); revokeProjectShares(root); await vi.advanceTimersByTimeAsync(0);
  expect(response.write).toHaveBeenLastCalledWith('event: revoked\ndata: {}\n\n');
  const broken = open().response;
  vi.spyOn(store, 'get').mockImplementationOnce(() => { throw new Error('Busy'); });
  changed();
  expect(broken.write).toHaveBeenLastCalledWith('event: unavailable\ndata: {}\n\n');
  expect(broken.end).toHaveBeenCalledOnce();
});

it('keeps idle transports alive without requesting content and revalidates their grants', () => {
  const { response } = open();
  streams.heartbeat(); expect(response.write).toHaveBeenLastCalledWith('event: keepalive\ndata: {}\n\n');
  revokeProjectShares(root); streams.heartbeat();
  expect(response.write).toHaveBeenLastCalledWith('event: revoked\ndata: {}\n\n');
  expect(response.end).toHaveBeenCalledOnce();
});

it('bounds legacy conversation streams, coalesces native hints and validates without loading content', async () => {
  const token = 'c'.repeat(64), response = new Response(), valid = vi.fn(async () => ({}));
  expect(streams.openConversation(response as unknown as ServerResponse, token, Date.now() + 86400000, 'legacy', 'local', valid)).toBe(true);
  expect(streams.openConversation(new Response() as unknown as ServerResponse, token, Date.now() + 86400000, undefined, 'local', valid)).toBe(true);
  expect(streams.openConversation(new Response() as unknown as ServerResponse, token, Date.now() + 86400000, undefined, 'local', valid)).toBe(false);
  const live = { sessionId: 'legacy', streamId: 's', sequence: 1, status: 'running' as const, updatedAt: Date.now(), messages: [{ id: 'secret', role: 'assistant' as const, text: 'Private output' }] };
  publishDashboardRealtime({ type: 'dashboard:codex-session-live', state: { ...live, deviceId: 'remote' } });
  publishDashboardRealtime({ type: 'dashboard:codex-session-live', state: { ...live, sessionId: 'different' } });
  await vi.advanceTimersByTimeAsync(0); expect(valid).not.toHaveBeenCalled();
  for (let n = 0; n < 30; n++) publishDashboardRealtime({ type: 'dashboard:codex-session-live', state: live });
  await vi.advanceTimersByTimeAsync(0); expect(valid).toHaveBeenCalledOnce();
  expect(response.write).toHaveBeenLastCalledWith('event: change\ndata: {}\n\n');
  expect(response.write.mock.calls.flat().join('')).not.toContain('Private');
  await vi.advanceTimersByTimeAsync(10000); expect(valid).toHaveBeenCalledOnce();
  valid.mockResolvedValue(undefined as never); streams.heartbeat(); await Promise.resolve();
  expect(response.write).toHaveBeenLastCalledWith('event: revoked\ndata: {}\n\n'); expect(response.end).toHaveBeenCalledOnce();
});

it('releases legacy subscriptions on expiry, failure, slow clients and late validation', async () => {
  let complete!: (value: unknown) => void;
  const response = new Response(), valid = vi.fn(() => new Promise(resolve => { complete = resolve; }));
  streams.openConversation(response as unknown as ServerResponse, 'd'.repeat(64), Date.now() + 1000, 'legacy', 'local', valid);
  streams.heartbeat(); streams.heartbeat(); expect(valid).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000); expect(response.end).toHaveBeenCalledOnce();
  complete({}); await Promise.resolve(); expect(response.write).toHaveBeenCalledTimes(2);
  const broken = new Response(); streams.openConversation(broken as unknown as ServerResponse, 'e'.repeat(64), Date.now() + 1000, undefined, 'local', async () => { throw new Error('Storage unavailable'); });
  streams.heartbeat(); await Promise.resolve(); expect(broken.end).toHaveBeenCalledOnce();
  expect(broken.write).toHaveBeenLastCalledWith('event: unavailable\ndata: {}\n\n');
  const slow = new Response(); slow.writableLength = 17 * 1024;
  streams.openConversation(slow as unknown as ServerResponse, 'f'.repeat(64), Date.now() + 1000, undefined, 'local', async () => ({}));
  expect(slow.destroyed).toBe(true);
});

it('does not spin expiry timers for permanent links and still closes on revocation', async () => {
  const {response} = open(new Response(), 0);
  await vi.advanceTimersByTimeAsync(60000);
  expect(response.end).not.toHaveBeenCalled(); expect(response.write).toHaveBeenCalledTimes(1);
  revokeProjectShares(root); streams.heartbeat();
  expect(response.end).toHaveBeenCalledOnce();
  expect(response.write).toHaveBeenLastCalledWith('event: revoked\ndata: {}\n\n');
});
