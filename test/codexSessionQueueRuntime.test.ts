import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as vscode from 'vscode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ home: '', enabled: true, slots: 30, sessions: vi.fn(), resume: vi.fn(), notice: vi.fn(), released: undefined as (() => void) | undefined, configuration: undefined as ((event: { affectsConfiguration: (key: string) => boolean }) => void) | undefined, lease: undefined as AbortController | undefined }));
vi.mock('../src/infrastructure/config/extensionSettings', () => ({ getCodexManagerConfiguration: () => ({ get: () => mocks.enabled }) }));
vi.mock('../src/services/codexSessionResume', () => ({ resolveCodexHome: () => mocks.home, readCodexCliSessions: mocks.sessions }));
vi.mock('../src/services/codexSessionLive', () => ({ availableCodexSessionLiveSlots: () => mocks.slots, onDidReleaseCodexSessionLiveSlot: (listener: () => void) => { mocks.released = listener; return () => { mocks.released = undefined; }; } }));
vi.mock('../src/storage/configurationEvents', () => ({ onDidChangeConfiguration: (listener: typeof mocks.configuration) => { mocks.configuration = listener; return { dispose: () => { mocks.configuration = undefined; } }; } }));
vi.mock('../src/services/codexSessionRecovery', () => ({ resumeCodexSessionWork: mocks.resume }));
vi.mock('../src/services/dashboardRealtime', () => ({ publishDashboardRealtime: mocks.notice }));
vi.mock('../src/utils/crossWindowOperations', () => ({
  CrossWindowOperationBusyError: class extends Error {},
  runCrossWindowExclusive: async (_key: string, _label: string, work: (signal: AbortSignal) => unknown) => { const lease = new AbortController(); mocks.lease = lease; return work(lease.signal); }
}));

import { removeTestDirectory } from './testFilesystem';
import { registerCodexSessionQueue } from '../src/services/codexSessionQueue';
import { readCodexSessionPreferences, writeCodexSessionPreference } from '../src/services/codexSessionPreferences';
import { saveSessionStatus } from '../src/storage/sqliteSessions';
import { configureSqliteStateStore, SqliteStateStore } from '../src/storage/sqliteState';

const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
let store: SqliteStateStore;
let subscriptions: vscode.Disposable[];
beforeEach(async () => {
  vi.resetAllMocks(); mocks.enabled = true; mocks.slots = 30; mocks.lease = undefined;
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
  await removeTestDirectory(mocks.home);
});
const start = () => registerCodexSessionQueue({ subscriptions } as vscode.ExtensionContext);
const queue = (revision: string) => writeCodexSessionPreference(mocks.home, id, { queue: true, priority: 1, queueRevision: revision, queueError: undefined, queueClaimId: undefined, queueClaimedAt: undefined });
const drain = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

it('consumes a queue request once across completion updates and scheduler restart; allows explicit requeue', async () => {
  queue('first'); start();
  await vi.waitFor(() => expect(readCodexSessionPreferences(mocks.home, [id]).get(id)?.queue).not.toBe(true));
  expect(mocks.resume).toHaveBeenCalledTimes(1);
  for (const status of ['running', 'idle', 'idle']) {
    saveSessionStatus(store, mocks.home, id, status as 'idle' | 'running');
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
  saveSessionStatus(store, mocks.home, id, 'idle'); await drain();
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
  saveSessionStatus(store, mocks.home, id, 'idle'); await drain();
  expect(mocks.resume).toHaveBeenCalledOnce();
});

const queuedRows = (count: number) => Array.from({length:count},(_,i)=>({id:`bbbbbbbb-bbbb-bbbb-bbbb-${String(i).padStart(12,'0')}`,title:`Task ${i}`,status:'idle' as 'idle' | 'running' | 'unknown',interrupted:true}));
const queueRows = (rows: ReturnType<typeof queuedRows>, priority=1) => { for(const row of rows) writeCodexSessionPreference(mocks.home,row.id,{queue:true,priority,queueRevision:'batch'}); };

it('dispatches every equal-priority item beyond eight while preserving the startup limit and waiting before a lower priority', async () => {
  const rows=queuedRows(13), accepted=new Map<string,()=>void>();
  queueRows(rows.slice(0,12));queueRows(rows.slice(12),2);
  mocks.sessions.mockImplementation(async()=>rows.map(row=>({...row})));
  mocks.resume.mockImplementation((id:string)=>new Promise(resolve=>{accepted.set(id,()=>{rows.find(row=>row.id===id)!.status='running';resolve('continued');});}));
  start();await vi.waitFor(()=>expect(mocks.resume).toHaveBeenCalledTimes(8));
  for(const accept of [...accepted.values()]) accept();
  await vi.waitFor(()=>expect(mocks.resume).toHaveBeenCalledTimes(12));
  for(const [id,accept] of accepted) if(rows.find(row=>row.id===id)?.status!=='running') accept();
  await vi.waitFor(()=>expect([...readCodexSessionPreferences(mocks.home,rows.slice(0,12).map(row=>row.id)).values()].every(value=>value.queue!==true)).toBe(true));
  await drain();expect(mocks.resume).toHaveBeenCalledTimes(12);
  rows.slice(0,12).forEach(row=>{row.status='idle';saveSessionStatus(store,mocks.home,row.id,'idle');});
  await vi.waitFor(()=>expect(mocks.resume).toHaveBeenCalledTimes(13));
  accepted.get(rows[12]!.id)!();await drain();
});

it('keeps capacity overflow queued and wakes immediately on release without another preference change', async () => {
  const rows=queuedRows(4);queueRows(rows.slice(0,3));queueRows(rows.slice(3),2);
  mocks.slots=0;mocks.sessions.mockImplementation(async()=>rows.map(row=>({...row})));
  mocks.resume.mockImplementation(async(id:string)=>{mocks.slots--;rows.find(row=>row.id===id)!.status='running';return 'continued';});
  start();await drain();expect(mocks.resume).not.toHaveBeenCalled();
  expect(readCodexSessionPreferences(mocks.home,rows.map(row=>row.id)).get(rows[0]!.id)?.queueClaimId).toBeUndefined();
  mocks.slots=2;mocks.released!();await vi.waitFor(()=>expect(mocks.resume).toHaveBeenCalledTimes(2));await drain();
  expect(readCodexSessionPreferences(mocks.home,[rows[2]!.id]).get(rows[2]!.id)).toMatchObject({queue:true,priority:1});
  expect(mocks.notice).not.toHaveBeenCalled();
  rows.slice(0,2).forEach(row=>{row.status='idle';});mocks.slots=2;mocks.released!();
  await vi.waitFor(()=>expect(mocks.resume).toHaveBeenCalledTimes(3));await drain();
  expect(mocks.resume.mock.lastCall?.[0]).toBe(rows[2]!.id);
  rows[2]!.status='idle';mocks.slots=2;mocks.released!();
  await vi.waitFor(()=>expect(mocks.resume).toHaveBeenCalledTimes(4));await drain();
});

it('leaves later entries unclaimed when another turn takes the remaining slot during dispatch', async () => {
  const rows=queuedRows(3);queueRows(rows);mocks.slots=3;mocks.sessions.mockResolvedValue(rows);
  mocks.resume.mockImplementation(async()=>{mocks.slots=0;return 'continued';});
  start();await vi.waitFor(()=>expect(mocks.resume).toHaveBeenCalledOnce());await drain();
  for(const row of rows.slice(1)) expect(readCodexSessionPreferences(mocks.home,[row.id]).get(row.id)).toMatchObject({queue:true,priority:1});
  expect(mocks.notice).not.toHaveBeenCalled();
});

it.each(['lease','configuration'] as const)('cancels a pending launch on %s loss and keeps its uncertain result reviewable', async reason => {
  let launchSignal:AbortSignal|undefined;
  mocks.resume.mockImplementation((_id:string,signal:AbortSignal)=>new Promise((_resolve,reject)=>{launchSignal=signal;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}));
  queue('cancel');start();await vi.waitFor(()=>expect(mocks.resume).toHaveBeenCalledOnce());
  if(reason==='lease') mocks.lease!.abort(new Error('Queue lease lost.'));else {mocks.enabled=false;mocks.configuration!({affectsConfiguration:key=>key==='codexManager.cliIntegrationEnabled'});}
  await vi.waitFor(()=>expect(readCodexSessionPreferences(mocks.home,[id]).get(id)?.queueError).toBeTruthy());
  expect(launchSignal?.aborted).toBe(true);expect(mocks.notice).toHaveBeenCalledWith(expect.objectContaining({level:'warning'}));
  saveSessionStatus(store,mocks.home,id,'idle');await drain();expect(mocks.resume).toHaveBeenCalledOnce();
});

it('cancels discovery when integration is disabled, preserves unclaimed work, and rechecks on enable', async () => {
  let finish!:(rows:unknown[])=>void;
  mocks.sessions.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));queue('disabled');start();
  await vi.waitFor(()=>expect(mocks.sessions).toHaveBeenCalledOnce());
  mocks.enabled=false;mocks.configuration!({affectsConfiguration:key=>key==='codexManager.cliIntegrationEnabled'});
  await drain();finish([{id,title:'Pending',status:'idle',interrupted:true}]);await drain();
  expect(mocks.resume).not.toHaveBeenCalled();expect(readCodexSessionPreferences(mocks.home,[id]).get(id)?.queueClaimId).toBeUndefined();
  mocks.enabled=true;mocks.configuration!({affectsConfiguration:key=>key==='codexManager.cliIntegrationEnabled'});
  await vi.waitFor(()=>expect(mocks.resume).toHaveBeenCalledOnce());await drain();
});

it('preserves the original home queue when the active home changes during discovery', async () => {
  const original=mocks.home;let finish!:(rows:unknown[])=>void;
  mocks.sessions.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));queue('home-change');start();
  await vi.waitFor(()=>expect(mocks.sessions).toHaveBeenCalledOnce());
  try {
    mocks.home=path.join(original,'other-home');mocks.configuration!({affectsConfiguration:key=>key==='codexManager.codexHome'});
    await drain();finish([{id,title:'Old home task',status:'idle',interrupted:true}]);await drain();
    expect(mocks.resume).not.toHaveBeenCalled();expect(readCodexSessionPreferences(original,[id]).get(id)?.queue).toBe(true);
  } finally {mocks.home=original;}
});
