import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ store: { file: '/storage/manager.sqlite' } as object | undefined, database: vi.fn(), attachments: vi.fn(), retry: vi.fn(), lock: vi.fn() }));
vi.mock('../src/storage/sqliteState', () => ({ getSqliteStateStore: () => fixture.store }));
vi.mock('../src/storage/storageCleanup', () => ({ maintainManagerDatabases: fixture.database }));
vi.mock('../src/services/projectTaskAttachments', () => ({ maintainAttachmentStorage: fixture.attachments }));
vi.mock('../src/services/codexSessionStorageDelete', () => ({ retryDeletedSessionFileCleanup: fixture.retry }));
vi.mock('../src/services/codexSessionResume', () => ({ resolveCodexHome: () => '/home' }));
vi.mock('../src/utils/crossWindowOperations', () => ({ runCrossWindowExclusive: fixture.lock, CrossWindowOperationBusyError: class extends Error {} }));
import { registerStorageMaintenance } from '../src/services/storageMaintenance';
let context: { subscriptions: Array<{ dispose(): void }> };
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  fixture.store = { file: '/storage/manager.sqlite' };
  fixture.lock.mockImplementation((_key: string, _label: string, work: (signal: AbortSignal) => Promise<void>) => work(new AbortController().signal));
  context = { subscriptions: [] };
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { context.subscriptions.forEach(item => item.dispose()); vi.useRealTimers(); vi.restoreAllMocks(); });

it('starts after 30 seconds and repeats every 30 minutes without overlapping a slow pass', async () => {
  let finish!: () => void;
  fixture.attachments.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  registerStorageMaintenance(context as never);
  expect(fixture.lock).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fixture.retry).toHaveBeenCalledWith('/home', expect.any(AbortSignal));
  expect(fixture.attachments).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(fixture.lock).toHaveBeenCalledOnce();
  finish(); await vi.advanceTimersByTimeAsync(0);
  expect(fixture.database).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(fixture.lock).toHaveBeenCalledTimes(2);
  expect(fixture.lock).toHaveBeenLastCalledWith('background:storage-cleanup', 'Storage cleanup', expect.any(Function), { background: true });
});

it('continues database maintenance after an attachment failure and retries the next scheduled pass', async () => {
  fixture.attachments.mockRejectedValueOnce(new Error('Busy files'));
  registerStorageMaintenance(context as never);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fixture.database).toHaveBeenCalledOnce();
  expect(console.warn).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(fixture.attachments).toHaveBeenCalledTimes(2);
  expect(fixture.database).toHaveBeenCalledTimes(2);
});

it('cancels file cleanup on shutdown and stops future timers', async () => {
  let signal!: AbortSignal, finish!: () => void;
  fixture.attachments.mockImplementationOnce((_store: object, incoming: AbortSignal) => { signal = incoming; return new Promise<void>(resolve => { finish = resolve; }); });
  registerStorageMaintenance(context as never);
  await vi.advanceTimersByTimeAsync(30_000);
  context.subscriptions[0]!.dispose();
  expect(signal.aborted).toBe(true);
  finish(); await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(fixture.database).not.toHaveBeenCalled();
  expect(fixture.lock).toHaveBeenCalledOnce();
});

it('skips remaining phases when the active storage changes', async () => {
  fixture.retry.mockImplementationOnce(() => { fixture.store = { file: '/other/manager.sqlite' }; });
  registerStorageMaintenance(context as never);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fixture.attachments).not.toHaveBeenCalled();
  expect(fixture.database).not.toHaveBeenCalled();
});
