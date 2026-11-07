import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

function bridge() {
  const events: any[] = [], sockets: Socket[] = [], listeners = new Map<string, () => void>();
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const reads: Array<(response: unknown) => void> = [];
  let now = 1000;
  class Socket {
    static OPEN = 1;
    readyState = 0;
    bufferedAmount = 0;
    listeners = new Map<string, (event?: any) => void>();
    send = vi.fn();
    close = vi.fn(() => { this.readyState = 3; });
    constructor() { sockets.push(this); }
    addEventListener(name: string, callback: (event?: any) => void) { this.listeners.set(name, callback); }
    open() { this.readyState = 1; this.listeners.get('open')!(); }
    receive(data: unknown) { this.listeners.get('message')!({ data: JSON.stringify(data) }); }
  }
  const fetch = vi.fn(() => new Promise(resolve => reads.push(resolve)));
  const host: any = { WebSocket: Socket, dispatchEvent: (event: any) => events.push(event.data),
    setTimeout: (callback: () => void, delay: number) => { timers.push({ callback, delay }); return timers.length; }, clearTimeout: vi.fn(),
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback), location: { protocol: 'http:', host: '127.0.0.1:39875', assign: vi.fn() } };
  class Event { constructor(_type: string, public init: any) {} get data() { return this.init.data; } }
  runInNewContext(readFileSync('media/webview/browserHost.js', 'utf8'), { window: host, fetch, MessageEvent: Event, console: { error: vi.fn() }, Date: { now: () => now } });
  return { events, sockets, timers, reads, fetch, listeners, post: host.acquireVsCodeApi().postMessage,
    advance: (ms: number) => { now += ms; },
    finish: () => reads.at(-1)!({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}) }) };
}

it('shares overlapping retries and leaves healthy or connecting sockets alone on online', async () => {
  const h = bridge(); h.sockets[0]!.open();
  const first = h.post({ type: 'dashboard:retry-connection' });
  const second = h.post({ type: 'dashboard:retry-connection' });
  h.listeners.get('online')!();
  expect(h.sockets).toHaveLength(2); expect(h.fetch).toHaveBeenCalledOnce();
  expect(h.sockets[1]!.close).not.toHaveBeenCalled();
  h.sockets[1]!.open();
  await h.post({ type: 'dashboard:action', action: 'cancelCodexCliSessionTurn', requestId: 'stop' });
  expect(h.sockets[1]!.send).toHaveBeenCalledOnce();
  h.finish(); await Promise.all([first, second]);
  expect(h.events.filter(event => event.type === 'dashboard:notice')).toHaveLength(1);
  h.listeners.get('online')!(); expect(h.sockets).toHaveLength(2);
});

it('rejects transport backpressure immediately, and permits explicit retry once it drains', async () => {
  const h = bridge(); const socket = h.sockets[0]!; socket.open();
  socket.bufferedAmount = 4 * 1024 * 1024 + 1;
  const action = { type: 'dashboard:action', action: 'saveWorkspaceFile', requestId: 'save' };
  await h.post(action);
  expect(h.events).toContainEqual(expect.objectContaining({ requestId: 'save', status: 'failed', error: expect.stringContaining('was not sent') }));
  expect(socket.send).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
  socket.bufferedAmount = 0; await h.post({ ...action, requestId: 'retry' });
  expect(socket.send).toHaveBeenCalledOnce();
});

it('keeps first connection timings stable and reports recovery for manual retry', async () => {
  const h = bridge(); h.advance(20); h.sockets[0]!.open();
  h.sockets[0]!.receive({ type: 'dashboard:notice' });
  expect(h.events.filter(event => event.type === 'dashboard:host-status').at(-1).timings.firstLiveMs).toBeUndefined();
  h.advance(30); h.sockets[0]!.receive({ type: 'dashboard:codex-session-live', state: {} });
  const retry = h.post({ type: 'dashboard:retry-connection' });
  h.advance(100); h.sockets[1]!.open(); h.finish(); await retry;
  const status = h.events.filter(event => event.type === 'dashboard:host-status').at(-1);
  expect(status.timings).toEqual({ socketMs: 20, firstLiveMs: 50, reconnectMs: 100 });
});

it('replays the bounded latest live tail and prompts once when the dashboard mounts', async () => {
  const h = bridge(); const socket = h.sockets[0]!; socket.open();
  for (let id = 0; id < 35; id++) socket.receive({ type: 'dashboard:codex-session-live', state: { sessionId: String(id), sequence: 1 } });
  socket.receive({ type: 'dashboard:codex-session-live', state: { sessionId: '34', sequence: 2 } });
  socket.receive({ type: 'dashboard:codex-requests', requests: [{ id: 'old' }] });
  socket.receive({ type: 'dashboard:codex-requests', requests: [{ id: 'current' }] });
  h.events.length = 0;
  const ready = h.post({ type: 'dashboard:ready' });
  const live = h.events.filter(event => event.type === 'dashboard:codex-session-live');
  expect(live).toHaveLength(30);
  expect(live[0].state.sessionId).toBe('5');
  expect(live.at(-1).state).toEqual({ sessionId: '34', sequence: 2 });
  expect(h.events.filter(event => event.type === 'dashboard:codex-requests')).toEqual([{ type: 'dashboard:codex-requests', requests: [{ id: 'current' }] }]);
  h.finish(); await ready; h.events.length = 0;
  const refresh = h.post({ type: 'dashboard:ready' }); h.finish(); await refresh;
  expect(h.events.some(event => ['dashboard:codex-session-live', 'dashboard:codex-requests'].includes(event.type))).toBe(false);
});

it.each(['source change', 'authentication loss'])('clears startup replay after %s', async outcome => {
  const h = bridge(); const socket = h.sockets[0]!; socket.open();
  socket.receive({ type: 'dashboard:snapshot', state: { accounts: [], connectedPeers: [{ id: 'first', local: true }] } });
  socket.receive({ type: 'dashboard:codex-session-live', state: { sessionId: 'old' } });
  socket.receive({ type: 'dashboard:codex-requests', requests: [{ id: 'old' }] });
  if (outcome === 'source change') socket.receive({ type: 'dashboard:snapshot', state: { accounts: [], connectedPeers: [{ id: 'second', local: true }] } });
  else socket.listeners.get('close')!({ code: 4001 });
  h.events.length = 0;
  const ready = h.post({ type: 'dashboard:ready' });
  expect(h.events.some(event => ['dashboard:codex-session-live', 'dashboard:codex-requests'].includes(event.type))).toBe(false);
  if (outcome === 'source change') h.finish();
  else expect(h.fetch).not.toHaveBeenCalled();
  await ready;
});
