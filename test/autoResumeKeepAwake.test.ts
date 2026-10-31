import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

vi.unmock('../src/services/autoResumeKeepAwake');
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), notice: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../src/services/dashboardRealtime', () => ({ publishDashboardRealtime: mocks.notice }));
import { createAutoResumeKeepAwake } from '../src/services/autoResumeKeepAwake';

const requests: ReturnType<typeof createAutoResumeKeepAwake>[] = [];
const children: Array<EventEmitter & { stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }; stdout: { resume: ReturnType<typeof vi.fn> }; stderr: { resume: ReturnType<typeof vi.fn> }; kill: ReturnType<typeof vi.fn> }> = [];
const start = () => { const request = createAutoResumeKeepAwake(); requests.push(request); return request; };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }), stdout: { resume: vi.fn() }, stderr: { resume: vi.fn() }, kill: vi.fn() });
    children.push(child); return child;
  });
});
afterEach(() => { requests.splice(0).forEach(item => item.dispose()); children.length = 0; vi.useRealTimers(); });

it('holds one request through refreshes and releases on completion, disabling, or shutdown', async () => {
  const request = start();
  expect(mocks.spawn).not.toHaveBeenCalled();
  request.setActive(true);
  await vi.advanceTimersByTimeAsync(60_000); request.setActive(true);
  expect(mocks.spawn).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(children[0]!.kill).not.toHaveBeenCalled();
  request.setActive(false);
  expect(children[0]!.stdin.end).toHaveBeenCalledOnce();
  expect(children[0]!.kill).toHaveBeenCalledOnce();
  children[0]!.emit('exit', 0);
  expect(mocks.notice).not.toHaveBeenCalled();
  request.setActive(true); request.dispose(); request.setActive(true);
  expect(mocks.spawn).toHaveBeenCalledTimes(2);
  expect(children[1]!.kill).toHaveBeenCalledOnce();
});

it('expires without fresh eligibility and tolerates pipe errors during cleanup', async () => {
  const request = start(); request.setActive(true);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(children[0]!.kill).toHaveBeenCalledOnce();
  children[0]!.stdin.emit('error', new Error('pipe closed'));
  expect(mocks.notice).not.toHaveBeenCalled();
});

it('warns once and backs off before retrying failed OS requests', async () => {
  const request = start(); request.setActive(true);
  children[0]!.emit('error', new Error('missing inhibitor'));
  request.setActive(true);
  expect(mocks.spawn).toHaveBeenCalledOnce();
  expect(mocks.notice).toHaveBeenCalledWith(expect.objectContaining({ type: 'dashboard:notice', level: 'warning' }));
  expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000); request.setActive(true);
  children[1]!.emit('exit', 1);
  expect(mocks.notice).toHaveBeenCalledOnce();
});

it('uses a hidden lifetime-bound OS request without changing power settings', () => {
  start().setActive(true);
  expect(mocks.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const args = mocks.spawn.mock.calls[0]![1] as string[];
  if (process.platform === 'win32') {
    expect(args.at(-1)).toContain('2147483649');
    expect(args.at(-1)).toContain('finally');
    expect(args.at(-1)).toContain('[Console]::ReadLine()');
    expect(children[0]!.stdin.write).toHaveBeenCalledWith('awake\n');
  } else if (process.platform === 'darwin') expect(args).toContain(String(process.pid));
  else expect(args).toContain('cat');
});
