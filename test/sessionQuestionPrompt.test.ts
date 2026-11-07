import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VNode } from 'preact';
const harness = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as Array<() => void>, read: vi.fn(), write: vi.fn() }));
vi.mock('preact/hooks', () => ({
  useId: () => 'composer-fixture', useLayoutEffect: () => undefined,
  useState(initial: unknown) { const i = harness.cursor++; harness.slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [harness.slots[i].value, (next: unknown) => { harness.slots[i].value = typeof next === 'function' ? next(harness.slots[i].value) : next; }]; },
  useRef(initial: unknown) { const i = harness.cursor++; return harness.slots[i] ??= { current: initial }; },
  useEffect(setup: () => void | (() => void), dependencies: unknown[]) { const i = harness.cursor++, previous = harness.slots[i]; if (previous && dependencies.every((value, j) => Object.is(value, previous.dependencies[j]))) return; const slot = { dependencies, cleanup: undefined as void | (() => void) }; harness.slots[i] = slot; harness.effects.push(() => { previous?.cleanup?.(); slot.cleanup = setup(); }); }
}));
vi.mock('../webview-src/dashboard/cliSessionCache', () => ({ readBrowserCache: harness.read, writeBrowserCache: harness.write }));
import { SessionQuestionPrompt } from '../webview-src/dashboard/sessionQuestions';
import { answeredSessionQuestionIds, sessionQuestionReply } from '../src/domain/sessionQuestions';
let props: Parameters<typeof SessionQuestionPrompt>[0];
const submit = vi.fn();
function render(patch: Partial<typeof props> = {}) { props = { ...props, ...patch }; harness.cursor = 0; const node = SessionQuestionPrompt(props); harness.effects.splice(0).forEach(effect => effect()); return node; }
function nodes(node: unknown): VNode<any>[] { if (Array.isArray(node)) return node.flatMap(nodes); if (!node || typeof node !== 'object' || !('props' in node)) return []; const value = node as VNode<any>; return [value, ...nodes(value.props.children)]; }
const find = (type: string) => nodes(render()).find(node => node.type === type)!;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers(); harness.slots = []; harness.cursor = 0; harness.effects = [];
  harness.read.mockReset().mockResolvedValue(undefined); harness.write.mockReset().mockResolvedValue(true); submit.mockReset().mockReturnValue('queue-id');
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  props = { message: { id: 'ask', text: '', timestamp: new Date().toISOString(), questions: [{ title: 'Continue?', options: ['Yes', 'No'] }] }, onReply: submit, scope: 'session', autoOpen: true, answered: new Set() };
});
afterEach(() => { harness.slots.forEach(slot => slot?.cleanup?.()); vi.useRealTimers(); vi.unstubAllGlobals(); });


it('automatically closes after two minutes and only reopens on Answer', async () => {
  render(); await flush(); expect(find('form')).toBeDefined();
  vi.advanceTimersByTime(120_000); expect(find('form')).toBeUndefined();
  find('button').props.onClick(); expect(find('form')).toBeDefined();
  vi.advanceTimersByTime(120_000); expect(find('form')).toBeDefined(); expect(submit).not.toHaveBeenCalled();
});
it('shows a button for old questions and closes immediately after queueing once', async () => {
  render({ autoOpen: false }); await flush(); expect(find('form')).toBeUndefined();
  find('button').props.onClick(); find('textarea').props.onInput({ currentTarget: { value: 'Typed answer' } });
  const form = find('form'); form.props.onSubmit({ preventDefault() {} }); form.props.onSubmit({ preventDefault() {} });
  expect(submit).toHaveBeenCalledOnce(); expect(submit.mock.calls[0]![0]).toContain('Typed answer'); expect(find('form')).toBeUndefined(); expect(find('button').props.disabled).toBe(true);
});
it('closes an automatic question when work continues but keeps a failed enqueue editable', async () => {
  render(); await flush(); render({ autoOpen: false }); expect(find('form')).toBeUndefined();
  find('button').props.onClick(); find('textarea').props.onInput({ currentTarget: { value: 'Kept answer' } });
  submit.mockReturnValue(undefined); find('form').props.onSubmit({ preventDefault() {} });
  expect(find('form')).toBeDefined(); expect(find('textarea').props.value).toBe('Kept answer');
  submit.mockReturnValue('retried'); find('form').props.onSubmit({ preventDefault() {} }); expect(submit).toHaveBeenCalledTimes(2); expect(find('form')).toBeUndefined();
});
it('retains partial answers with their original indices and renders public history without answer controls', async () => {
  const firstId = JSON.stringify(['request_user_input_async', 'ask', 0]);
  render({ message: { ...props.message, questions: [{ title: 'First?' }, { title: 'Second?' }] }, answered: new Set([firstId]) }); await flush();
  expect(find('legend').props.children).toBe('Second?'); find('textarea').props.onInput({ currentTarget: { value: 'Second answer' } }); find('form').props.onSubmit({ preventDefault() {} });
  expect(submit.mock.calls[0]![0]).not.toContain('First?'); expect(submit.mock.calls[0]![0]).toContain('Second answer');
  expect(nodes(render({ onReply: undefined })).some(node => node.type === 'button' || node.type === 'textarea')).toBe(false);
});

it('hides an open prompt when its answer arrives from another client and after reopening history', async () => {
  render(); await flush(); expect(find('form')).toBeDefined();
  const reply = { id: 'reply', role: 'user' as const, text: sessionQuestionReply(props.message, { '0': 'Yes' }) };
  const answered = answeredSessionQuestionIds([props.message, reply, reply]);
  expect(render({ answered })).toBeNull();
  expect(submit).not.toHaveBeenCalled();
  harness.slots.forEach(slot => slot?.cleanup?.()); harness.slots = [];
  expect(render()).toBeNull(); await flush(); expect(render()).toBeNull();
  expect(render({ onReply: undefined })).toBeNull();
});

it('keeps queued answers visible until confirmed and hides only after every question is answered', async () => {
  const message = { ...props.message, questions: [{ title: 'First?' }, { title: 'Second?' }] };
  const first = { id: 'first', role: 'user' as const, text: sessionQuestionReply(message, { '0': 'Yes' }) };
  render({ message, answered: answeredSessionQuestionIds([first]) }); await flush();
  expect(find('legend').props.children).toBe('Second?');
  const second = { id: 'second', role: 'user' as const, text: sessionQuestionReply(message, { '1': 'No' }) };
  const answered = answeredSessionQuestionIds([first, second]);
  const queued = render({ answered, pending: true });
  expect(nodes(queued).some(node => node.props['aria-label'] === 'Queued Codex answer')).toBe(true);
  expect(nodes(queued).some(node => node.type === 'form')).toBe(false);
  expect(render({ pending: false })).toBeNull();
});

it('keeps the prompt available when a reply is incomplete or belongs to another question', async () => {
  const other = { ...props.message, id: 'other' };
  for (const text of [sessionQuestionReply(other, { '0': 'Yes' }), sessionQuestionReply(props.message, { '0': ' ' }), '<send_user_message_question_reply>{broken}</send_user_message_question_reply>']) {
    render({ answered: answeredSessionQuestionIds([{ id: 'reply', role: 'user', text }]) }); await flush();
    expect(find('form')).toBeDefined();
  }
});
