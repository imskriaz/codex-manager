import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CliQueuedMessage } from '../webview-src/dashboard/cliMessageQueue';

const harness = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as Array<() => void>, dirty: false, records: new Map<string, unknown>(), writes: vi.fn(), read: vi.fn() }));
vi.mock('preact/hooks', () => ({
  useState(initial: unknown) {
    const index = harness.cursor++;
    harness.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [harness.slots[index].value, (next: unknown) => { const value = typeof next === 'function' ? next(harness.slots[index].value) : next; if (!Object.is(value, harness.slots[index].value)) { harness.slots[index].value = value; harness.dirty = true; } }];
  },
  useRef(initial: unknown) { const index = harness.cursor++; return harness.slots[index] ??= { current: initial }; },
  useEffect(setup: () => void | (() => void), dependencies: unknown[]) {
    const index = harness.cursor++, previous = harness.slots[index];
    if (previous && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
    const slot = { dependencies, cleanup: undefined as void | (() => void) };
    harness.slots[index] = slot;
    harness.effects.push(() => { previous?.cleanup?.(); slot.cleanup = setup(); });
  }
}));
vi.mock('../webview-src/dashboard/cliSessionCache', () => ({ readBrowserCache: harness.read, writeBrowserCache: harness.writes }));
import { normalizeCliMessageQueue, queuedMessageEchoes, queuedMessageView, withAcceptedQueuedMessages, useCliMessageQueue } from '../webview-src/dashboard/cliMessageQueue';
import { canRestoreCliComposerDraft } from '../webview-src/dashboard/cliSessionComposerState';
import { cliComposerDraftKey } from '../webview-src/dashboard/cliSessionComposerState';
import { sessionQuestionReply } from '../src/domain/sessionQuestions';

const draft = (text = 'First') => ({ text, attachments: [] });
const entry = (patch: Partial<CliQueuedMessage> = {}): CliQueuedMessage => ({ id: 'one', draft: draft(), state: 'sending', createdAt: Date.now(), seenIds: ['old'], ...patch });
let options: Parameters<typeof useCliMessageQueue>[0], queue: ReturnType<typeof useCliMessageQueue>;
const send = vi.fn(), steer = vi.fn(), restore = vi.fn(), feedback = vi.fn(), locks = vi.fn();
function render(patch: Partial<typeof options> = {}) {
  options = { ...options, ...patch }; harness.cursor = 0; harness.dirty = false;
  queue = useCliMessageQueue(options); harness.effects.splice(0).forEach(effect => effect()); return queue;
}
async function flush() { for (let i = 0; i < 40; i++) { await Promise.resolve(); if (harness.dirty) render(); } }
beforeEach(() => {
  vi.useFakeTimers(); harness.slots = []; harness.cursor = 0; harness.effects = []; harness.dirty = false; harness.records.clear();
  send.mockReset().mockImplementation(() => 'request-' + send.mock.calls.length); steer.mockReset().mockImplementation(() => 'steer-' + steer.mock.calls.length); restore.mockReset().mockReturnValue(true); feedback.mockReset();
  harness.read.mockReset().mockImplementation(async key => structuredClone(harness.records.get(key)));
  harness.writes.mockReset().mockImplementation(async (key, value) => { harness.records.set(key, structuredClone(value)); return true; });
  locks.mockReset().mockImplementation(async (name, _options, work) => work({ name }));
  vi.stubGlobal('navigator', { locks: { request: locks } }); vi.stubGlobal('window', new EventTarget());
  options = { scope: 'pc:session', messages: [], results: [], canDispatch: false, send, restore, feedback };
});
afterEach(() => { for (const slot of harness.slots) slot?.cleanup?.(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('keeps the original queue intact while the floating workspace dispatches its own queue', async () => {
  const original = cliComposerDraftKey('pc', 'session'), floating = cliComposerDraftKey('pc', 'session', undefined, true);
  render({ scope: original }); await flush(); queue.enqueue(draft('Original queued work')); await flush();
  render({ scope: floating }); await flush(); queue.enqueue(draft('Floating queued work')); await flush();
  render({ canDispatch: true }); await flush();
  expect(send).toHaveBeenCalledExactlyOnceWith(draft('Floating queued work'));
  expect((harness.records.get(`message-queue:${original}`) as CliQueuedMessage[])[0]?.draft.text).toBe('Original queued work');
  render({ scope: original, canDispatch: false }); await flush();
  expect(queue.items[0]?.draft.text).toBe('Original queued work');
  expect(send).toHaveBeenCalledTimes(1);
});

it('queues an answer once immediately while offline and keeps the fence through failure and resend', async () => {
  render(); await flush();
  const ask = { id: 'ask', text: '', questions: [{ title: 'Continue?' }] };
  const reply = draft(sessionQuestionReply(ask, { '0': 'Yes' }));
  const id = queue.enqueue(reply);
  expect(queue.enqueue(draft(sessionQuestionReply(ask, { '0': 'Different answer' })))).toBe(id);
  await flush(); expect(queue.items).toHaveLength(1); expect(send).not.toHaveBeenCalled();
  render({ canDispatch: true }); await flush();
  render({ results: [{ requestId: 'request-1', status: 'failed', message: 'Offline' }] }); await flush();
  expect(queue.enqueue(reply)).toBe(id); expect(queue.items).toHaveLength(1);
  queue.resend(id!); await flush(); expect(send).toHaveBeenCalledTimes(2);
});

it('rejects replies to questions already answered in the transcript', async () => {
  const text = sessionQuestionReply({ id: 'ask', text: '', questions: [{ title: 'Continue?' }] }, { '0': 'Yes' });
  render({ messages: [{ id: 'sent', role: 'user', text }] }); await flush();
  expect(queue.enqueue(draft(text))).toBeUndefined(); expect(feedback).toHaveBeenCalledWith(expect.stringContaining('already answered'));
});

it('saves multiple offline messages immediately, fences each send, and drains in FIFO order after confirmation', async () => {
  render(); await flush(); expect(queue.ready).toBe(true);
  queue.enqueue(draft()); queue.enqueue(draft('Second')); await flush();
  expect(queue.items.map(item => queuedMessageView(item).text)).toEqual(['First','Second']); expect(send).not.toHaveBeenCalled();
  send.mockImplementation(value => { expect((harness.records.get('message-queue:pc:session') as CliQueuedMessage[]).find(item => item.draft.text === value.text)?.state).toBe('sending'); return 'request-' + send.mock.calls.length; });
  render({ canDispatch: true }); await flush(); expect(send).toHaveBeenCalledExactlyOnceWith(draft());
  render({ results: [{ requestId: 'request-1', status: 'completed' }] }); await flush();
  expect(send.mock.calls.map(call => call[0].text)).toEqual(['First','Second']);
  expect((harness.records.get('message-queue:pc:session') as CliQueuedMessage[]).some(item => item.draft.text === 'First')).toBe(false);
  render({ messages: [{ id: 'echo-1', role: 'user', text: 'First' }, { id: 'echo-2', role: 'user', text: 'Second' }] }); await flush();
  expect(queue.items).toEqual([]);
});

it('keeps failed sends in the conversation and resends in place without changing the composer', async () => {
  render({ canDispatch: true }); await flush(); queue.enqueue(draft()); queue.enqueue(draft('Later')); await flush();
  render({ results: [{ requestId: 'request-1', status: 'failed', message: 'Disconnected' }] }); await flush();
  expect(restore).not.toHaveBeenCalled(); expect(queue.items[0]?.state).toBe('failed'); expect(send).toHaveBeenCalledOnce();
  queue.resend(queue.items[0]!.id); queue.resend(queue.items[0]!.id); await flush();
  expect(send).toHaveBeenCalledTimes(2); expect(queue.items.map(item => item.draft.text)).toEqual(['First','Later']);
});

it('does not send on full storage and preserves the message in the conversation', async () => {
  harness.writes.mockResolvedValue(false); render({ canDispatch: true }); await flush(); queue.enqueue(draft()); await flush();
  expect(send).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled(); expect(queue.items[0]?.state).toBe('failed'); expect(feedback).not.toHaveBeenCalled(); expect(queue.items[0]?.error).toContain('storage');
});

it('does not dispatch when the durable send fence fails', async () => {
  render({ canDispatch: true }); await flush();
  harness.writes.mockImplementation(async (key, value) => { if (value.some((item: CliQueuedMessage) => item.state === 'sending')) return false; harness.records.set(key, structuredClone(value)); return true; });
  queue.enqueue(draft()); await flush(); expect(send).not.toHaveBeenCalled(); expect(queue.items[0]?.state).toBe('failed');
});

it('pauses uncertain messages after timeout and reboot without replay and reconciles a late echo', async () => {
  harness.records.set('message-queue:pc:session', [entry({ state: 'sent', requestId: 'old-request' }), entry({ id: 'two', draft: draft('Later'), state: 'queued' })]);
  render({ canDispatch: true }); await flush(); expect(queue.items[0]?.state).toBe('uncertain'); expect(send).not.toHaveBeenCalled();
  render({ messages: [{ id: 'echo', role: 'user', text: 'First' }] }); await flush(); expect(send).toHaveBeenCalledExactlyOnceWith(draft('Later'));
  await vi.advanceTimersByTimeAsync(65_000); await flush(); expect(queue.items[0]?.state).toBe('uncertain'); expect(send).toHaveBeenCalledOnce(); expect(restore).not.toHaveBeenCalled();
  queue.resend(queue.items[0]!.id); await flush(); expect(send).toHaveBeenCalledTimes(2);
});

it('rejects queue overflow, isolates another session, and refuses a second tab owner', async () => {
  render(); await flush();
  for (let i = 0; i < 20; i++) expect(queue.enqueue(draft(String(i)))).toBeTypeOf('string');
  expect(queue.enqueue(draft('overflow'))).toBeUndefined(); await flush(); expect(queue.items).toHaveLength(20);
  locks.mockImplementationOnce(async (_name, _options, work) => work(null)); render({ scope: 'other-pc:other-session', canDispatch: true }); await flush();
  expect(queue.ready).toBe(false); expect(queue.enqueue(draft())).toBeUndefined(); expect(send).not.toHaveBeenCalled(); expect(harness.records.has('message-queue:pc:session')).toBe(true);
});

it('keeps a failed message when a newer composer draft prevents restoration', async () => {
  harness.records.set('message-queue:pc:session', [entry({ state: 'failed' })]); render(); await flush();
  restore.mockReturnValue(false); queue.remove('one', true); await flush(); expect(queue.items).toHaveLength(1);
  expect(canRestoreCliComposerDraft(draft('Newer'), draft())).toBe(false);
  expect(canRestoreCliComposerDraft(draft(''), draft())).toBe(true);
});

it('shows accepted guidance immediately before subsequent output and replaces each transcript echo once', () => {
  const old = { id: 'old', role: 'assistant' as const, text: 'Earlier output' };
  const later = { id: 'later', role: 'assistant' as const, text: 'Later output' };
  const first = entry({ state: 'sent', turnId: 'turn' });
  const second = entry({ state: 'sent', id: 'two', turnId: 'turn' });
  expect(withAcceptedQueuedMessages([old, later], [first, second]).map(message => message.id)).toEqual(['old', 'pending-one', 'pending-two', 'later']);
  const echo = { id: 'echo', role: 'user' as const, turnId: 'turn', text: 'First' };
  expect(withAcceptedQueuedMessages([old, echo, later], [first, second]).filter(message => message.role === 'user')).toHaveLength(2);
  expect(withAcceptedQueuedMessages([old, echo, later], [first, second]).map(message => message.id)).toEqual(['old', 'echo', 'pending-two', 'later']);
  expect(withAcceptedQueuedMessages([old, later], [entry({ state: 'uncertain' }), entry({ id: 'failed', state: 'failed' })])).toEqual([old, later]);
  expect(withAcceptedQueuedMessages([], [first])[0]?.text).toBe('First');
  expect(withAcceptedQueuedMessages([old, echo, later], [first])).toEqual([old, echo, later]);
  expect(withAcceptedQueuedMessages([{ ...echo, turnId: 'native-next-turn' }], [first])).toEqual([{ ...echo, turnId: 'native-next-turn' }]);
  const image = entry({ state: 'sent', draft: { text: 'First', attachments: [{ id: 'image', kind: 'image', name: 'one.png', mimeType: 'image/png', data: 'data:image/png;base64,AA==', size: 1 }] } });
  const imageEcho = { id: 'image-echo', role: 'user' as const, text: 'First\n\n[Image unavailable]', images: [{ src: 'saved-image' }] };
  expect(withAcceptedQueuedMessages([imageEcho], [image])).toEqual([imageEcho]);
});

it('steers a queued message immediately and keeps its row in the sending state', async () => {
  render({ canDispatch: false, steer }); await flush();
  const id = queue.enqueue(draft('Steer this now'))!; await flush();
  options.canDispatch = true;
  queue.steerNow(id);
  await flush();
  expect(queue.items[0]?.state).toBe('sending');
  expect(steer).toHaveBeenCalledExactlyOnceWith(draft('Steer this now'));
  expect(send).not.toHaveBeenCalled();
  expect(queue.items[0]).toMatchObject({ id, state: 'sending', requestId: 'steer-1' });
});

it('matches repeated submissions to distinct new user echoes and never consumes old or different-turn messages', () => {
  const first = entry({ turnId: 'turn' }), second = entry({ id: 'two', turnId: 'turn' });
  const once = queuedMessageEchoes([first,second], [{ id: 'old', role: 'user', text: 'First' }, { id: 'wrong', role: 'user', text: 'First', turnId: 'other' }, { id: 'echo', role: 'user', text: 'First', turnId: 'turn' }]);
  expect(once.matched).toEqual(new Set(['one'])); expect(once.items).toHaveLength(1);
  expect(queuedMessageEchoes(once.items, [{ id: 'echo', role: 'user', text: 'First', turnId: 'turn' }]).matched.size).toBe(0);
  expect(queuedMessageEchoes(once.items, [{ id: 'echo-2', role: 'user', text: 'First', turnId: 'turn' }]).matched).toEqual(new Set(['two']));
  expect(() => normalizeCliMessageQueue([entry(),entry()])).toThrow();
  expect(() => normalizeCliMessageQueue([{ ...entry(), draft: { text: 'bad', attachments: [{ kind: 'binary' }] } }])).toThrow();
});


it('retains quoted message whitespace through dispatch and the inline Resend button', async () => {
  const quoted = draft('> Review this\n\n');
  render({ canDispatch: true }); await flush(); queue.enqueue(quoted); await flush();
  render({ results: [{ requestId: 'request-1', status: 'failed' }] }); await flush();
  expect(restore).not.toHaveBeenCalled(); expect(queuedMessageView(queue.items[0]!).text).toBe(quoted.text);
  queue.resend(queue.items[0]!.id); await flush(); expect(send.mock.calls.map(call => call[0])).toEqual([quoted, quoted]);
});

it('keeps a large document send pending through slow upload and exposes timeout without replay', async () => {
  const document = { id: 'doc', name: 'report.pdf', kind: 'file' as const, mimeType: 'application/pdf', size: 3 * 1024 * 1024, data: 'data:application/pdf;base64,' + 'A'.repeat(4 * 1024 * 1024) };
  render({ canDispatch: true }); await flush(); queue.enqueue({ text: 'Read this', attachments: [document] }); await flush();
  expect(queuedMessageView(queue.items[0]!).textAttachments?.[0]?.name).toBe('report.pdf');
  await vi.advanceTimersByTimeAsync(65001); await flush(); expect(queue.items[0]?.state).toBe('sending');
  await vi.advanceTimersByTimeAsync(235000); await flush(); expect(queue.items[0]?.state).toBe('uncertain'); expect(send).toHaveBeenCalledOnce(); expect(restore).not.toHaveBeenCalled();
});
it('keeps an unreadable saved queue untouched and blocks dispatch with visible feedback', async () => {
  harness.read.mockRejectedValue(new Error('Saved queue could not be read'));
  render({ canDispatch: true }); await flush(); expect(queue.ready).toBe(false);
  expect(queue.enqueue(draft())).toBeUndefined(); expect(send).not.toHaveBeenCalled(); expect(harness.writes).not.toHaveBeenCalled(); expect(feedback).toHaveBeenCalledExactlyOnceWith('The saved message queue is not ready. Your composer draft is kept.');
  expect(queue.error).toContain('could not be read'); harness.read.mockResolvedValue([]); queue.retryLoad(); await flush(); expect(queue.ready).toBe(true); expect(queue.error).toBeUndefined(); expect(send).not.toHaveBeenCalled();
});

it('keeps offline records and hides retry controls through the shared connection state', async () => {
  render({ connected: false }); await flush(); queue.enqueue(draft()); await flush();
  expect(queue.connected).toBe(false);
  expect((harness.records.get('message-queue:pc:session') as CliQueuedMessage[])[0]?.state).toBe('queued');
  expect(send).not.toHaveBeenCalled();
  render({ connected: true, canDispatch: true }); await flush();
  render({ results: [{ requestId: 'request-1', status: 'completed' }] }); await flush();
  expect(harness.records.get('message-queue:pc:session')).toEqual([]);
  expect(queue.items[0]?.state).toBe('sent');
});

it('recovers a failed queue load without replaying an in-flight message or losing the offline backlog', async () => {
  const saved = [entry({ requestId: 'before-restart' }), entry({ id: 'two', draft: draft('Later'), state: 'queued' })];
  harness.records.set('message-queue:pc:session', saved);
  harness.read.mockRejectedValueOnce(new DOMException('The database connection is closing', 'InvalidStateError'));
  render({ canDispatch: true }); await flush();
  expect(queue.ready).toBe(false); expect(queue.error).toContain('connection is closing');
  expect(harness.writes).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  queue.retryLoad(); await flush();
  expect(queue.ready).toBe(true); expect(queue.error).toBeUndefined();
  expect(queue.items.map(item => item.state)).toEqual(['uncertain', 'queued']);
  expect(send).not.toHaveBeenCalled();
  render({ messages: [{ id: 'late-echo', role: 'user', text: 'First' }] }); await flush();
  expect(send).toHaveBeenCalledExactlyOnceWith(draft('Later'));
});

it('settles a send when confirmation arrived before the request id was recorded', async () => {
  render({ canDispatch: true, results: [{ requestId: 'request-1', status: 'completed' }] }); await flush();
  queue.enqueue(draft()); await flush();
  expect(send).toHaveBeenCalledOnce();
  expect(queue.items[0]?.state).toBe('sent');
});

it('clears a failed local record when a late acknowledgement confirms delivery', async () => {
  render({ canDispatch: true }); await flush(); queue.enqueue(draft()); await flush();
  render({ results: [{requestId:'request-1',status:'failed',message:'Connection lost'}], connected:false, canDispatch:false }); await flush();
  expect(queue.items[0]?.state).toBe('failed');
  render({ results: [{requestId:'request-1',status:'completed'}] }); await flush();
  expect(queue.items[0]?.state).toBe('sent');
  expect(harness.records.get('message-queue:pc:session')).toEqual([]);
  expect(send).toHaveBeenCalledOnce();
});

it('rolls back an unconfirmed removal inline without a storage toast or automatic resend',async()=>{
  render();await flush();queue.enqueue(draft());await flush();const id=queue.items[0]!.id;
  harness.writes.mockResolvedValue(false);feedback.mockClear();queue.remove(id);await flush();
  expect(queue.items[0]).toMatchObject({id,state:'failed',error:expect.stringContaining('could not be removed')});expect(feedback).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
  harness.writes.mockResolvedValue(true);queue.remove(id);await flush();expect(queue.items).toEqual([]);
});

it('moves a waiting message to the front offline, saves the order, and sends it first after reconnect', async () => {
  render({ connected: false }); await flush();
  queue.enqueue(draft('First')); queue.enqueue(draft('Second')); const urgent = queue.enqueue(draft('Urgent'))!; await flush();
  queue.sendNow(urgent); queue.sendNow(urgent); await flush();
  expect(queue.items.map(item => item.draft.text)).toEqual(['Urgent', 'First', 'Second']);
  expect(queue.notice).toContain('Waiting for connection'); expect(send).not.toHaveBeenCalled();
  const saved = harness.records.get('message-queue:pc:session');
  expect(normalizeCliMessageQueue(saved).map(item => item.draft.text)).toEqual(['Urgent', 'First', 'Second']);
  queue.retryLoad(); await flush();
  render({ connected: true, canDispatch: true }); await flush();
  expect(send).toHaveBeenCalledExactlyOnceWith(draft('Urgent'));
  render({ results: [{ requestId: 'request-1', status: 'completed' }] }); await flush();
  expect(send.mock.calls.map(call => call[0].text)).toEqual(['Urgent', 'First']);
});

it.each(['sending', 'uncertain', 'failed'] as const)('keeps an earlier %s message ahead of a newly prioritized message', async state => {
  render({ canDispatch: true }); await flush();
  queue.enqueue(draft('Active')); queue.enqueue(draft('Later')); const urgent = queue.enqueue(draft('Urgent'))!; await flush();
  if (state === 'uncertain') { await vi.advanceTimersByTimeAsync(65_000); await flush(); }
  if (state === 'failed') { render({ results: [{ requestId: 'request-1', status: 'failed', message: 'Disconnected' }] }); await flush(); }
  queue.sendNow(urgent); await flush();
  expect(queue.items.map(item => item.draft.text)).toEqual(['Active', 'Urgent', 'Later']);
  expect(queue.items[0]?.state).toBe(state); expect(send).toHaveBeenCalledOnce();
  render({ results: [{ requestId: 'request-1', status: 'completed' }] }); await flush();
  expect(send.mock.calls.map(call => call[0].text)).toEqual(['Active', 'Urgent']);
});

it.each([false, 'reject'])('keeps a priority change unsent when storage returns %s', async failure => {
  render(); await flush(); queue.enqueue(draft('First')); const urgent = queue.enqueue(draft('Urgent'))!; await flush();
  if (failure === 'reject') harness.writes.mockRejectedValueOnce(new Error('Storage failed'));
  else harness.writes.mockResolvedValueOnce(false);
  queue.sendNow(urgent); await flush();
  render({ canDispatch: true }); await flush();
  expect(send).not.toHaveBeenCalled();
  expect(queue.items[0]).toMatchObject({ id: urgent, state: 'failed', error: expect.stringContaining('priority could not be saved') });
  expect(queue.notice).toContain('not sent');
  queue.resend(urgent); await flush(); expect(send).toHaveBeenCalledExactlyOnceWith(draft('Urgent'));
});

it('waits for priority storage and ignores its completion after changing sessions', async () => {
  render(); await flush(); queue.enqueue(draft('First')); const urgent = queue.enqueue(draft('Urgent'))!; await flush();
  let finish!: (saved: boolean) => void;
  harness.writes.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
  queue.sendNow(urgent); render({ canDispatch: true }); await flush();
  expect(send).not.toHaveBeenCalled(); expect(queue.items[0]?.durable).toBe(false);
  render({ scope: 'another-session', canDispatch: false }); await flush();
  finish(true); await flush();
  expect(queue.items).toEqual([]); expect(queue.notice).toBeUndefined(); expect(send).not.toHaveBeenCalled();
});

it('reports stale or non-owned priority actions and can reorder a full queue without adding messages', async () => {
  queue = render(); queue.sendNow('missing'); await flush(); expect(queue.notice).toContain('not ready');
  for (let index = 0; index < 20; index++) queue.enqueue(draft(String(index)));
  await flush(); const urgent = queue.items.at(-1)!.id;
  queue.sendNow(urgent); await flush(); expect(queue.items).toHaveLength(20); expect(queue.items[0]?.id).toBe(urgent);
  queue.sendNow('missing'); await flush(); expect(queue.items).toHaveLength(20); expect(queue.notice).toContain('not ready');
  locks.mockImplementationOnce(async (_name, _options, work) => work(null));
  render({ scope: 'another-session' }); await flush(); queue.sendNow(urgent); await flush();
  expect(queue.notice).toContain('not ready'); expect(send).not.toHaveBeenCalled();
});
