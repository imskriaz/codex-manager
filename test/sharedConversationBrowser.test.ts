import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());
function viewer() {
  vi.useFakeTimers();
  const listeners = new Map<string, () => void>(), sources: Source[] = [], reads: Array<(value: unknown) => void> = [];
  class Source {
    static readonly CLOSED = 2; readyState = 1; listeners = new Map<string, () => void>(); close = vi.fn();
    constructor() { sources.push(this); }
    addEventListener(name: string, changed: () => void) { this.listeners.set(name, changed); }
  }
  const element = () => ({ textContent: '', after: vi.fn(), replaceChildren: vi.fn(), classList: { add: vi.fn(), remove: vi.fn() } });
  const state = element(), conversation = element(), header = element();
  const document = { hidden: false, getElementById: (id: string) => id === 'live-state' ? state : id === 'conversation' ? conversation : id === 'shared-header' ? header : element(), createElement: element,
    addEventListener: (name: string, changed: () => void) => listeners.set(name, changed) };
  const navigator = { onLine: true };
  const window = { EventSource: Source, renderCodexSharedMessages: vi.fn(), clearCodexSharedMessages: vi.fn(), addEventListener: (name: string, changed: () => void) => listeners.set(name, changed) };
  const fetch = vi.fn(() => new Promise(resolve => reads.push(resolve)));
  runInNewContext(readFileSync('media/webview/sharedConversation.js', 'utf8'), { window, document, navigator, EventSource: Source, fetch, AbortController, setTimeout, clearTimeout,
    location: { pathname: '/share/' + 'a'.repeat(64) }, JSON });
  const complete = async (n: number, text = 'Saved message') => {
    reads[n]!({ ok: true, status: 200, json: async () => ({ title: 'Shared', messages: [{ role: 'assistant', text }] }) });
    for (let n = 0; n < 10; n++) await Promise.resolve();
  };
  return { listeners, sources, reads, state, header, conversation, window, document, navigator, fetch, complete };
}

it('uses live invalidations without idle polling and ignores late responses after revocation', async () => {
  const v = viewer(); await v.complete(0);
  expect(v.sources).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(60000); expect(v.fetch).toHaveBeenCalledOnce();
  v.sources[0]!.listeners.get('change')!();
  for (let n = 0; n < 20; n++) v.sources[0]!.listeners.get('change')!();
  expect(v.fetch).toHaveBeenCalledTimes(2);
  await v.complete(1, 'New message'); expect(v.fetch).toHaveBeenCalledTimes(3);
  v.sources[0]!.listeners.get('revoked')!(); await v.complete(2, 'Late message');
  expect(v.window.renderCodexSharedMessages).toHaveBeenCalledTimes(2);
  expect(v.window.clearCodexSharedMessages).toHaveBeenCalledWith(v.conversation);
  expect(v.window.clearCodexSharedMessages).toHaveBeenCalledWith(v.header);
  expect(v.state.textContent).toContain('revoked');
  v.listeners.get('focus')!(); expect(v.fetch).toHaveBeenCalledTimes(3);
});

it('suspends hidden viewers and catches up once after offline recovery during a pending read', async () => {
  const v = viewer(); await v.complete(0);
  v.document.hidden = true; v.listeners.get('visibilitychange')!();
  expect(v.sources[0]!.close).toHaveBeenCalledOnce();
  v.listeners.get('focus')!(); expect(v.fetch).toHaveBeenCalledOnce();
  v.document.hidden = false; v.listeners.get('visibilitychange')!();
  v.navigator.onLine = false; v.listeners.get('offline')!();
  v.navigator.onLine = true; v.listeners.get('online')!();
  await v.complete(1, 'Stale before reconnect');
  expect(v.fetch).toHaveBeenCalledTimes(3);
  await v.complete(2, 'After reconnect');
  expect(v.window.renderCodexSharedMessages).toHaveBeenCalledTimes(2);
  expect(v.sources).toHaveLength(2);
  expect(v.state.textContent).toBe('');
});

it('checks the offline recovery page on events without hidden or idle polling', async () => {
  vi.useFakeTimers();
  const listeners = new Map<string, () => void>(), status = { textContent: '' };
  const document = { visibilityState: 'visible', getElementById: () => status, addEventListener: (name: string, callback: () => void) => listeners.set(name, callback) };
  const window = { location: { reload: vi.fn() }, addEventListener: (name: string, callback: () => void) => listeners.set(name, callback) };
  const fetch = vi.fn(async () => ({ ok: false, status: 503 }));
  runInNewContext(readFileSync('media/webview/pwaRecovery.js', 'utf8'), { window, document, navigator: { onLine: true }, fetch, AbortController, setTimeout, clearTimeout });
  await vi.advanceTimersByTimeAsync(60000); expect(fetch).toHaveBeenCalledOnce();
  document.visibilityState = 'hidden'; listeners.get('focus')!(); expect(fetch).toHaveBeenCalledOnce();
  document.visibilityState = 'visible'; fetch.mockResolvedValueOnce({ ok: false, status: 401 }); listeners.get('visibilitychange')!();
  await vi.advanceTimersByTimeAsync(0); expect(window.location.reload).toHaveBeenCalledOnce();
});
