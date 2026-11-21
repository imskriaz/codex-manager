import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqliteStateStore, configureSqliteStateStore } from '../src/storage/sqliteState';
import { coordinateStoredSessions, pruneSessionCoordination, removeSessionCoordination } from '../src/storage/sqliteCoordination';
import { pruneManagerCaches } from '../src/storage/storageCleanup';
import { coordinateCodexSessions } from '../src/services/sessionCoordination';
import { getCodexHomeStateKey } from '../src/codex/authFile';
import { removeDeletedSessionCache } from '../src/storage/sqliteSessions';

const mocks = vi.hoisted(() => ({ summary: vi.fn(), sessions: vi.fn(), home: '/codex' }));
vi.mock('../src/services/codexSessionResume', () => ({ readCodexCliSessionSummary: (...args: unknown[]) => mocks.summary(...args), readCodexCliSessions: () => mocks.sessions(), resolveCodexHome: () => mocks.home }));
vi.mock('../src/services/workspaceTools', () => ({ resolveWorkspaceProjectPathAsync: async (project: string) => project }));
const scope = { home: 'home', project: 'project' }, other = { home: 'other', project: 'project' };
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
let root: string, store: SqliteStateStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'coordination-')); store = await SqliteStateStore.open(path.join(root, 'state.sqlite')); configureSqliteStateStore(store);
  mocks.home = '/codex'; mocks.summary.mockReset(); mocks.sessions.mockReset();
  mocks.summary.mockImplementation(async id => ({ id, projectPath: '/project' })); mocks.sessions.mockResolvedValue([{ id: a, projectPath: '/project', title: 'A', status: 'running' }, { id: b, projectPath: '/foreign' }]);
});
afterEach(async () => { vi.useRealTimers(); configureSqliteStateStore(undefined); store.close(); await rm(root, { recursive: true, force: true }); });
const send = (id = 'message', text = 'Editing attachments', now = Date.now()) => coordinateStoredSessions(store, scope, a, { operation: 'send', toSessionId: b, messageId: id, text }, now);
const read = (session = b, current = scope) => coordinateStoredSessions(store, current, session, { operation: 'read' });

it('queues peer messages without consuming them on read and acknowledges only the recipient inbox', () => {
  expect(send().message).toMatchObject({ id: 'message', fromSessionId: a, toSessionId: b });
  expect(read().messages).toHaveLength(1); expect(read().messages).toHaveLength(1);
  expect(read(a).messages).toEqual([]); expect(read(b, other).messages).toEqual([]); expect(read(b, { ...scope, project: 'foreign' }).messages).toEqual([]);
  expect(() => coordinateStoredSessions(store, scope, a, { operation: 'acknowledge', messageIds: ['message'] })).toThrow('outside your inbox');
  expect(coordinateStoredSessions(store, scope, b, { operation: 'acknowledge', messageIds: ['message'] })).toEqual({ acknowledged: 1 });
  expect(read().messages).toEqual([]); expect(send().message?.acknowledgedAt).toBeTypeOf('number');
});

it('makes retries idempotent, rejects mismatched IDs, and keeps acknowledgements atomic', () => {
  send(); send(); expect(read().messages).toHaveLength(1);
  expect(() => send('message', 'Different')).toThrow('different content');
  expect(() => coordinateStoredSessions(store, scope, b, { operation: 'acknowledge', messageIds: ['message', 'missing'] })).toThrow('No acknowledgements');
  expect(read().messages).toHaveLength(1);
});

it('bounds inbox capacity and returns paged unread messages without dropping them', () => {
  for (let n = 0; n < 200; n++) send(`message-${n}`);
  expect(read()).toMatchObject({ more: true, messages: expect.any(Array) }); expect(read().messages).toHaveLength(50);
  expect(() => send('over-limit')).toThrow('inbox is full');
  coordinateStoredSessions(store, scope, b, { operation: 'acknowledge', messageIds: read().messages!.map(row => row.id) });
  expect(() => send('after-ack')).not.toThrow();
  expect(() => send('too-large', 'a'.repeat(4001))).toThrow('4,000');
});

it('caps global message storage across projects and preserves queued messages', () => {
  store.transaction(() => {
    for (let n = 0; n < 2000; n++) store.set('session-coordination-messages', `full-${n}`, { ...other, id: `full-${n}`, fromSessionId: a, toSessionId: b, text: 'Keep', createdAt: Date.now() });
  });
  expect(() => send()).toThrow('inbox is full'); expect(store.keys('session-coordination-messages')).toHaveLength(2000);
});

it('expires status, acknowledged messages and unread messages through scheduled cache cleanup', () => {
  const now = Date.now(), day = 24 * 60 * 60_000;
  coordinateStoredSessions(store, scope, a, { operation: 'status', activity: 'working', note: 'src/attachments.ts' }, now);
  send('old-unread', 'Old unread', now - 7 * day - 1); send('ack', 'Ack', now); send('keep', 'Keep', now);
  coordinateStoredSessions(store, scope, b, { operation: 'acknowledge', messageIds: ['ack'] }, now);
  expect(coordinateStoredSessions(store, scope, undefined, { operation: 'list' }, now + 301_000).peers?.[0]?.activity).toBe('unknown');
  pruneManagerCaches(store, now + day + 1);
  expect(store.keys('session-coordination-participants')).toEqual([]);
  expect(read().messages?.map(row => row.id)).toEqual(['keep']);
  expect(store.keys('session-coordination-messages')).toHaveLength(1);
});

it('clears deleted-session messages and status in one home while preserving another home', () => {
  send(); coordinateStoredSessions(store, scope, a, { operation: 'status', activity: 'blocked', note: 'Waiting for package' });
  coordinateStoredSessions(store, other, a, { operation: 'send', toSessionId: b, messageId: 'message', text: 'Other home' });
  removeSessionCoordination(store, scope.home, a);
  expect(read().messages).toEqual([]); expect(read(b, other).messages).toHaveLength(1);
  expect(coordinateStoredSessions(store, scope, undefined, { operation: 'list' }).peers).toEqual([]);
  store.set('deleted-codex-sessions', `${scope.home}:${a}`, Date.now()); expect(() => send()).toThrow('deleted');
});

it('prunes malformed mailbox records without touching unrelated state', () => {
  store.prepare('INSERT INTO state VALUES(?,?,?)').run('session-coordination-messages', 'bad', 'invalid');
  store.set('unknown', 'keep', true); pruneSessionCoordination(store); expect(store.keys('session-coordination-messages')).toEqual([]); expect(store.get('unknown', 'keep')).toBe(true);
});

it('verifies both native sessions belong to the requested project before queuing', async () => {
  mocks.summary.mockImplementation(async id => ({ id, projectPath: id === b ? '/foreign' : '/project' }));
  await expect(coordinateCodexSessions('/project', a, { operation: 'send', toSessionId: b, messageId: 'test', text: 'Hello' })).rejects.toThrow('another project');
  expect(store.keys('session-coordination-messages')).toEqual([]);
  mocks.summary.mockResolvedValue(undefined); await expect(coordinateCodexSessions('/project', a, { operation: 'read' })).rejects.toThrow('missing');
});

it('discovers only project peers and overlays recent registered activity', async () => {
  await coordinateCodexSessions('/project', a, { operation: 'status', activity: 'working', note: 'Editing cleanup' });
  expect((await coordinateCodexSessions('/project', undefined, { operation: 'list' })).peers).toEqual([{ sessionId: a, title: 'A', runtimeStatus: 'running', activity: 'working', note: 'Editing cleanup', updatedAt: expect.any(Number) }]);
});

it('returns registered peers and a visible warning when optional discovery is slow', async () => {
  vi.useFakeTimers(); await coordinateCodexSessions('/project', a, { operation: 'status', activity: 'working', note: 'Available' });
  mocks.sessions.mockReturnValue(new Promise(() => undefined));
  const pending = coordinateCodexSessions('/project', undefined, { operation: 'list' }); await vi.advanceTimersByTimeAsync(750);
  expect(await pending).toMatchObject({ peers: [{ sessionId: a }], warning: expect.stringContaining('still loading') });
});

it('rejects ownership timeouts and storage switches without late message writes', async () => {
  vi.useFakeTimers(); let complete!: (value: unknown) => void;
  mocks.summary.mockReturnValue(new Promise(resolve => { complete = resolve; }));
  const pending = coordinateCodexSessions('/project', a, { operation: 'status', activity: 'working', note: 'Wait' });
  const rejected = expect(pending).rejects.toThrow('could not be verified'); await vi.advanceTimersByTimeAsync(5000); await rejected;
  complete({ id: a, projectPath: '/project' }); await Promise.resolve(); expect(store.keys('session-coordination-participants')).toEqual([]);
  mocks.summary.mockImplementation(async id => { mocks.home = '/changed'; return { id, projectPath: '/project' }; });
  await expect(coordinateCodexSessions('/project', a, { operation: 'status', activity: 'idle', note: 'Done' })).rejects.toThrow('storage changed');
  expect(store.keys('session-coordination-participants')).toEqual([]);
});

it('does not resurrect mailbox state after confirmed deletion', async () => {
  store.set('deleted-codex-sessions', `${getCodexHomeStateKey(mocks.home)}:${a}`, Date.now());
  await expect(coordinateCodexSessions('/project', a, { operation: 'status', activity: 'working', note: 'Old' })).rejects.toThrow('missing');
});

it('includes coordination in confirmed deletion cleanup while retaining archived and unconfirmed state', () => {
  const nativeScope = { home: getCodexHomeStateKey(mocks.home), project: 'project' };
  coordinateStoredSessions(store, nativeScope, a, { operation: 'send', toSessionId: b, messageId: 'delete-test', text: 'Keep until deleted' });
  removeDeletedSessionCache(store, mocks.home, [a]);
  expect(coordinateStoredSessions(store, nativeScope, b, { operation: 'read' }).messages).toHaveLength(1);
  removeDeletedSessionCache(store, mocks.home, [a], undefined, Date.now(), true);
  expect(coordinateStoredSessions(store, nativeScope, b, { operation: 'read' }).messages).toEqual([]);
});
