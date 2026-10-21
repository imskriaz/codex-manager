import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as vscode from 'vscode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ home: '', sessions: vi.fn(), resume: vi.fn(), notice: vi.fn() }));
vi.mock('../src/infrastructure/config/extensionSettings', () => ({ getCodexManagerConfiguration: () => ({ get: () => true }) }));
vi.mock('../src/services/codexSessionResume', () => ({ resolveCodexHome: () => mocks.home, readCodexCliSessions: mocks.sessions }));
vi.mock('../src/services/codexSessionRecovery', () => ({ resumeCodexSessionWork: mocks.resume }));
vi.mock('../src/services/dashboardRealtime', () => ({ publishDashboardRealtime: mocks.notice }));
vi.mock('../src/utils/crossWindowOperations', () => ({
  CrossWindowOperationBusyError: class extends Error {},
  runCrossWindowExclusive: async (_key: string, _label: string, work: (signal: AbortSignal) => unknown) => work(new AbortController().signal)
}));

import { registerCodexSessionQueue } from '../src/services/codexSessionQueue';
import { readCodexSessionPreferences, writeCodexSessionPreference } from '../src/services/codexSessionPreferences';
import { configureSqliteStateStore, SqliteStateStore } from '../src/storage/sqliteState';

const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
let store: SqliteStateStore;
let subscriptions: vscode.Disposable[];
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.home = await mkdtemp(path.join(tmpdir(), 'codex-queue-runtime-'));
  store = await SqliteStateStore.open(path.join(mocks.home, 'manager.sqlite')); configureSqliteStateStore(store);
  subscriptions = [];
  mocks.sessions.mockResolvedValue([{ id, title: 'Finished work', status: 'idle', interrupted: true }]);
  mocks.resume.mockResolvedValue('continued');
});
afterEach(async () => {
  subscriptions.forEach(item => item.dispose());
  await new Promise(resolve => setImmediate(resolve));
  configureSqliteStateStore(undefined); store.close();
  await rm(mocks.home, { recursive: true, force: true });
});
const start = () => registerCodexSessionQueue({ subscriptions } as vscode.ExtensionContext);
const queue = (revision: string) => writeCodexSessionPreference(mocks.home, id, { queue: true, priority: 1, queueRevision: revision, queueError: undefined, queueClaimId: undefined, queueClaimedAt: undefined });
const drain = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

it('consumes a queue request once across completion updates and scheduler restart; allows explicit requeue', async () => {
  queue('first'); start();
  await vi.waitFor(() => expect(readCodexSessionPreferences(mocks.home, [id]).get(id)?.queue).not.toBe(true));
  expect(mocks.resume).toHaveBeenCalledTimes(1);
  for (const status of ['running', 'idle', 'idle']) {
    store.set('session-status', id, { status, updated: Math.random() });
    await drain();
  }
  subscriptions.forEach(item => item.dispose()); subscriptions = []; start(); await drain();
  expect(mocks.resume).toHaveBeenCalledTimes(1);
  queue('second');
  await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalledTimes(2));
  await drain();
  expect(readCodexSessionPreferences(mocks.home, [id]).get(id)?.queue).not.toBe(true);
});

it('keeps an uncertain start blocked across status updates and restart until explicitly requeued', async () => {
  mocks.resume.mockRejectedValueOnce(new Error('Start confirmation timed out'));
  queue('uncertain'); start();
  await vi.waitFor(() => expect(readCodexSessionPreferences(mocks.home, [id]).get(id)?.queueError).toContain('timed out'));
  expect(mocks.notice).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', message: expect.stringContaining('not confirmed') }));
  store.set('session-status', id, { status: 'idle' }); await drain();
  subscriptions.forEach(item => item.dispose()); subscriptions = []; start(); await drain();
  expect(mocks.resume).toHaveBeenCalledTimes(1);
  queue('retry');
  await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalledTimes(2)); await drain();
});

it('does not erase an explicit requeue made while an earlier start is pending', async () => {
  let finish!: (outcome: string) => void;
  mocks.resume.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
  queue('first'); start(); await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce());
  queue('second'); finish('continued');
  await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalledTimes(2)); await drain();
  expect(readCodexSessionPreferences(mocks.home, [id]).get(id)?.queue).not.toBe(true);
});

it('does not start queued work when disposed during discovery', async () => {
  let finish!: (rows: unknown[]) => void;
  mocks.sessions.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  queue('first'); start(); await vi.waitFor(() => expect(mocks.sessions).toHaveBeenCalledOnce());
  subscriptions.forEach(item => item.dispose());
  finish([{ id, title: 'Pending', status: 'idle', interrupted: true }]); await drain();
  expect(mocks.resume).not.toHaveBeenCalled();
  expect(readCodexSessionPreferences(mocks.home, [id]).get(id)?.queue).toBe(true);
});

it('reports result-storage failure and retains its durable claim without replaying the accepted start', async () => {
  mocks.resume.mockImplementationOnce(async () => { configureSqliteStateStore(undefined); return 'continued'; });
  queue('first'); start();
  await vi.waitFor(() => expect(mocks.notice).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', message: expect.stringContaining('Result storage failed') })));
  configureSqliteStateStore(store);
  const preference = readCodexSessionPreferences(mocks.home, [id]).get(id);
  expect(preference?.queueClaimId).toBeTruthy();
  store.set('session-status', id, { status: 'idle' }); await drain();
  expect(mocks.resume).toHaveBeenCalledOnce();
});
