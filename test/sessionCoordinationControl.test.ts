import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqliteStateStore, configureSqliteStateStore } from '../src/storage/sqliteState';
import { coordinateCodexSessions } from '../src/services/sessionCoordination';
import { readCodexSessionPreferences } from '../src/services/codexSessionPreferences';
import { CodexCliTurnCancelledError } from '../src/services/codexSessionResume';

const mocks = vi.hoisted(() => ({ summary: vi.fn(), cancel: vi.fn(), send: vi.fn(), notice: vi.fn(), home: '/codex' }));
vi.mock('../src/services/dashboardRealtime', () => ({ publishDashboardRealtime: mocks.notice }));
vi.mock('../src/services/codexSessionResume', () => ({ readCodexCliSessionSummary: (...args: unknown[]) => mocks.summary(...args),
  readCodexCliSessions: async () => [], resolveCodexHome: () => mocks.home,
  CodexCliTurnCancelledError: class extends Error {},
  cancelCodexCliSessionTurn: (...args: unknown[]) => mocks.cancel(...args), sendCodexCliSessionMessage: (...args: unknown[]) => mocks.send(...args) }));
vi.mock('../src/services/workspaceTools', () => ({ resolveWorkspaceProjectPathAsync: async (project: string) => project }));
vi.mock('../src/utils/crossWindowOperations', () => ({ runCrossWindowExclusive: (_key: string, _name: string, run: () => unknown) => run() }));
const self = '11111111-1111-4111-8111-111111111111', source = '22222222-2222-4222-8222-222222222222', destination = '33333333-3333-4333-8333-333333333333';
let root: string, store: SqliteStateStore, running: boolean;
const control = (operation: 'stop' | 'pause' | 'resume' | 'handover', extra = {}) => coordinateCodexSessions('/project', self,
  { operation, operationId: 'attempt', toSessionId: source, ...extra });
beforeEach(async () => {
  vi.clearAllMocks(); running = false; mocks.home = '/codex';
  root = await mkdtemp(path.join(os.tmpdir(), 'coordination-control-')); store = await SqliteStateStore.open(path.join(root, 'state.sqlite')); configureSqliteStateStore(store);
  mocks.summary.mockImplementation(async id => ({ id, projectPath: '/project', status: id === source && running ? 'running' : 'idle', locked: false, canStop: false }));
  mocks.cancel.mockResolvedValue(true);
  mocks.send.mockImplementation(async options => { options.onStarted(); });
});
afterEach(async () => { vi.useRealTimers(); configureSqliteStateStore(undefined); store.close(); await rm(root, { recursive: true, force: true }); });

it.each(['stop', 'pause'] as const)('holds automatic recovery for an idle session on %s', async operation => {
  expect(await control(operation)).toMatchObject({ control: { status: 'completed' } });
  expect(readCodexSessionPreferences(mocks.home, [source]).get(source)?.manualStop).toBe(true);
  expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.cancel).not.toHaveBeenCalled();
});

it('queues one cooperative stop for an unreachable owner and does not claim it stopped', async () => {
  running = true;
  expect(await control('stop')).toMatchObject({ control: { status: 'pending' }, warning: expect.stringContaining('not confirmed') });
  await control('stop');
  const inbox = await coordinateCodexSessions('/project', source, { operation: 'read' });
  expect(inbox.messages).toHaveLength(1); expect(inbox.messages![0].text).toContain('end this turn');
  expect(mocks.cancel).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  running = false; expect(await control('stop')).toMatchObject({ control: { status: 'completed' } });
});

it('waits for the source to end before starting a handover and starts exactly once', async () => {
  running = true;
  const args = { handoverToSessionId: destination, text: 'Finish the pending tests', start: true };
  expect(await control('handover', args)).toMatchObject({ control: { status: 'pending' } }); expect(mocks.send).not.toHaveBeenCalled();
  running = false;
  expect(await control('handover', args)).toMatchObject({ control: { status: 'completed' } });
  await control('handover', args); expect(mocks.send).toHaveBeenCalledOnce();
  expect(mocks.send.mock.calls[0][0]).toMatchObject({ sessionId: destination, text: expect.stringContaining('pending tests'), clearManualStop: true });
});

it('returns a handover to the calling session without impersonating another sender', async () => {
  const result = await control('handover', { handoverToSessionId: self, text: 'Current work summary' });
  expect(result.control).toMatchObject({ status: 'completed', message: expect.stringContaining('Current work summary') });
  expect(store.keys('session-coordination-messages')).toEqual([]); expect(mocks.send).not.toHaveBeenCalled();
});

it('rejects a changed expected turn before saving stop preferences or interrupting', async () => {
  mocks.summary.mockImplementation(async id => ({ id, projectPath: '/project', status: 'running', canStop: true, steerTurnId: 'new-turn' }));
  await expect(control('stop', { expectedTurnId: 'old-turn' })).rejects.toThrow('turn changed');
  expect(readCodexSessionPreferences(mocks.home, [source]).get(source)?.manualStop).not.toBe(true); expect(mocks.cancel).not.toHaveBeenCalled();
});

it('interrupts the verified turn and requires idle confirmation before handover', async () => {
  mocks.summary.mockImplementation(async id => ({ id, projectPath: '/project', status: running && id === source ? 'running' : 'idle', canStop: true, steerTurnId: 'expected' }));
  running = true; mocks.cancel.mockImplementation(async () => { running = false; return true; });
  expect(await control('handover', { expectedTurnId: 'expected', handoverToSessionId: destination, text: 'Continue tests', start: true })).toMatchObject({ control: { status: 'completed' } });
  expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(source, 'expected'); expect(mocks.send).toHaveBeenCalledOnce();
});

it('preserves an uncertain launch and never replays it after disconnection', async () => {
  mocks.send.mockRejectedValue(new Error('connection lost'));
  await expect(control('resume')).rejects.toThrow('connection lost');
  expect(await control('resume')).toMatchObject({ control: { status: 'unknown' } }); expect(mocks.send).toHaveBeenCalledOnce();
  expect(await coordinateCodexSessions('/project', self, { operation: 'controlStatus', operationId: 'attempt' })).toMatchObject({ control: { status: 'unknown' } });
  await expect(control('resume', { text: 'different' })).rejects.toThrow('different content');
});

it('does not report a user-stopped coordinated turn as a background failure', async () => {
  mocks.send.mockImplementationOnce(async options => { options.onStarted(); throw new CodexCliTurnCancelledError(); });
  expect(await control('resume')).toMatchObject({ control: { status: 'completed' } });
  expect(mocks.notice).not.toHaveBeenCalled();
});

it('aborts an unconfirmed launch at its bounded deadline and retains uncertainty', async () => {
  vi.useFakeTimers(); let signal!: AbortSignal;
  mocks.send.mockImplementation(options => { signal = options.signal; return new Promise(() => undefined); });
  const pending = expect(control('resume')).rejects.toThrow('not confirmed');
  await vi.advanceTimersByTimeAsync(15_001); await pending; expect(signal.aborted).toBe(true);
  expect(await control('resume')).toMatchObject({ control: { status: 'unknown' } }); expect(mocks.send).toHaveBeenCalledOnce();
});

it('rejects locked destinations, foreign projects and archived sessions before launching', async () => {
  for (const patch of [{ locked: true }, { projectPath: '/foreign' }, { archived: true }]) {
    mocks.summary.mockImplementation(async id => ({ id, projectPath: '/project', status: 'idle', ...patch }));
    await expect(control('resume')).rejects.toThrow(); expect(mocks.send).not.toHaveBeenCalled();
  }
});
