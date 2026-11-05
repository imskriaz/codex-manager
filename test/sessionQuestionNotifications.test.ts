import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const harness = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, cleanups: [] as Array<() => void> }));
vi.mock('preact/hooks', () => ({
  useState(initial: unknown) {
    const index = harness.cursor++;
    harness.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [harness.slots[index].value, (next: unknown) => { harness.slots[index].value = typeof next === 'function' ? next(harness.slots[index].value) : next; }];
  },
  useRef(initial: unknown) { return harness.slots[harness.cursor++] ??= { current: initial }; },
  useEffect(setup: () => () => void) { const index = harness.cursor++; if (!harness.slots[index]) { harness.slots[index] = true; harness.cleanups.push(setup()); } }
}));
import { questionNotificationKey, useSessionQuestionNotifications } from '../webview-src/dashboard/sessionQuestionNotifications';

const records = new Map<string, string>(), notice = vi.fn();
let events: EventTarget, full = false;
const request = (extra = {}) => ({ id: 'owner-request', threadId: 'thread', sourceMessageId: 'question', kind: 'question', title: 'Private question', questions: [{ id: 'secret', question: 'Secret question text', isSecret: true }], ...extra });
const render = () => { harness.cursor = 0; return useSessionQuestionNotifications(notice); };
const emit = (data: unknown) => events.dispatchEvent(new MessageEvent('message', { data }));
const reopen = () => { harness.cleanups.splice(0).forEach(cleanup => cleanup()); harness.slots = []; return render(); };
beforeEach(() => {
  harness.slots = []; harness.cursor = 0; harness.cleanups = []; records.clear(); notice.mockReset(); full = false;
  events = new EventTarget(); vi.stubGlobal('window', events);
  vi.stubGlobal('localStorage', { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { if (full) throw Error('Full'); records.set(key, value); } });
});
afterEach(() => { harness.cleanups.forEach(cleanup => cleanup()); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('keeps questions until dismissed through timeouts, missing snapshots, owner reconnects and reloads without storing secret text', () => {
  vi.useFakeTimers(); render(); emit({ type: 'dashboard:codex-request', request: request() });
  expect(render().active?.sourceMessageId).toBe('question');
  vi.advanceTimersByTime(60 * 60_000);
  emit({ type: 'dashboard:codex-requests', requests: [] });
  emit({ type: 'dashboard:codex-request-resolved', requestId: 'owner-request' });
  expect(render().active).toBeDefined(); expect(reopen().active).toBeDefined();
  emit({ type: 'dashboard:codex-request', request: request({ id: 'reconnected-owner' }) });
  expect(render().active?.id).toBe('reconnected-owner');
  const saved = records.get('codexManager.questionNotifications.v1')!;
  expect(JSON.parse(saved)).toHaveLength(1); expect(saved).not.toContain('Secret question text'); expect(saved).not.toContain('Private question');
});

it('persists dismissal of transcript questions across owner IDs and reloads while allowing new questions', () => {
  render(); emit({ type: 'dashboard:codex-request', request: request() });
  const hook = render(); hook.dismiss(hook.active!); expect(render().active).toBeUndefined();
  reopen(); emit({ type: 'dashboard:codex-requests', requests: [request({ id: 'new-owner' })] });
  expect(render().active).toBeUndefined();
  emit({ type: 'dashboard:codex-request', request: request({ sourceMessageId: 'next-question' }) });
  expect(render().active?.sourceMessageId).toBe('next-question'); expect(notice).not.toHaveBeenCalled();
});

it('isolates systems, ignores approvals and invalid records, and handles dismissal from another tab', () => {
  records.set('codexManager.questionNotifications.v1', '{broken');
  render();
  for (const value of [request({ kind: 'command' }), request({ threadId: 1 }), request({ sourceMessageId: {} })]) emit({ type: 'dashboard:codex-request', request: value });
  expect(render().active).toBeUndefined();
  emit({ type: 'dashboard:codex-requests', requests: [request(), request({ deviceId: 'remote' })] });
  const hook = render(); hook.dismiss(hook.active!); expect(render().active?.deviceId).toBe('remote');
  records.set('codexManager.dismissedRequests.v1', JSON.stringify([questionNotificationKey(render().active!)]));
  events.dispatchEvent(Object.assign(new Event('storage'), { key: 'codexManager.dismissedRequests.v1' }));
  expect(render().active).toBeUndefined();
});

it('keeps notifications usable and dismissal quiet after storage fills, with an explicit persistence warning', () => {
  full = true; render(); emit({ type: 'dashboard:codex-request', request: request() });
  const hook = render(); expect(hook.active).toBeDefined(); hook.dismiss(hook.active!);
  expect(render().active).toBeUndefined(); expect(notice).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('this tab') }));
  emit({ type: 'dashboard:codex-request', request: request() }); expect(render().active).toBeUndefined();
});

it('respects dismissals saved by earlier versions', () => {
  records.set('codexManager.dismissedRequests.v1', JSON.stringify([JSON.stringify(['local', 'owner-request'])]));
  render(); emit({ type: 'dashboard:codex-request', request: request() });
  expect(render().active).toBeUndefined();
});
