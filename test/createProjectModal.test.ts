import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VNode } from 'preact';
const fixture = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as Array<() => void>, send: vi.fn(), receive: undefined as undefined | ((event: any) => void) }));
vi.mock('preact/hooks', () => ({
  useState(initial: unknown) { const index = fixture.cursor++; fixture.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [fixture.slots[index].value, (next: unknown) => { fixture.slots[index].value = typeof next === 'function' ? next(fixture.slots[index].value) : next; }]; },
  useRef(initial: unknown) { const index = fixture.cursor++; return fixture.slots[index] ??= { current: initial }; },
  useEffect(setup: () => void | (() => void), deps: unknown[]) { const index = fixture.cursor++, previous = fixture.slots[index]; if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return; const slot = { deps, cleanup: undefined as void | (() => void) }; fixture.slots[index] = slot; fixture.effects.push(() => { previous?.cleanup?.(); slot.cleanup = setup(); }); }
}));
vi.mock('../webview-src/dashboard/host', () => ({ createActionRequestId: () => 'create-id', postMessageToHost: fixture.send }));
import { CreateProjectModal } from '../webview-src/dashboard/createProjectModal';
let props: Parameters<typeof CreateProjectModal>[0];
function render(patch: Partial<typeof props> = {}) { props = { ...props, ...patch }; fixture.cursor = 0; const node = CreateProjectModal(props); fixture.effects.splice(0).forEach(effect => effect()); return node; }
function nodes(node: unknown): VNode<any>[] { if (Array.isArray(node)) return node.flatMap(nodes); if (!node || typeof node !== 'object' || !('props' in node)) return []; const value = node as VNode<any>; return [value, ...nodes(value.props.children)]; }
const find = (type: string) => nodes(render()).filter(node => node.type === type);
const submit = () => find('form')[0]!.props.onSubmit({ preventDefault() {} });
beforeEach(() => {
  vi.useFakeTimers(); fixture.slots = []; fixture.cursor = 0; fixture.effects = []; fixture.send.mockReset();
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('window', { addEventListener: (_name: string, listener: typeof fixture.receive) => { fixture.receive = listener; }, removeEventListener: () => { fixture.receive = undefined; } });
  props = { deviceId: 'selected-pc', initialFolder: 'D:\\Projects', onClose: vi.fn(), onCreated: vi.fn(), onFeedback: vi.fn() };
  render(); const input = find('input')[0]!;
  (input.props.onInput ?? input.props.oninput)({ currentTarget: { value: 'new-project' } });
});
afterEach(() => { fixture.slots.forEach(slot => slot?.cleanup?.()); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('sends once to the selected system and selects only the confirmed created folder', () => {
  submit(); submit(); expect(fixture.send).toHaveBeenCalledOnce();
  expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ action: 'createWorkspaceProject', payload: expect.objectContaining({ projectName: 'new-project', parentFolder: 'D:\\Projects', targetDeviceId: 'selected-pc' }) }));
  expect(render().props.closeDisabled).toBe(true);
  const project = { id: 'new', label: 'new-project', path: 'D:\\Projects\\new-project' };
  fixture.receive!({ data: { type: 'dashboard:action-result', requestId: 'create-id', status: 'completed', payload: { workspaceProject: project } } });
  expect(props.onCreated).toHaveBeenCalledWith(project); expect(props.onClose).toHaveBeenCalledOnce();
});
it('preserves input and the host error for retry', () => {
  submit(); fixture.receive!({ data: { type: 'dashboard:action-result', requestId: 'create-id', status: 'failed', error: 'Storage full' } });
  expect(find('p').find(node => node.props.role === 'alert')?.props.children).toBe('Storage full');
  expect(find('input')[0]?.props.value).toBe('new-project'); expect(props.onClose).not.toHaveBeenCalled();
});
it('reports an unconfirmed timeout and ignores late replies without replaying creation', () => {
  submit(); vi.advanceTimersByTime(25_000);
  expect(find('p').find(node => node.props.role === 'alert')?.props.children).toContain('not replayed');
  fixture.receive!({ data: { type: 'dashboard:action-result', requestId: 'create-id', status: 'completed', payload: { workspaceProject: { path: 'late' } } } });
  expect(fixture.send).toHaveBeenCalledOnce(); expect(props.onCreated).not.toHaveBeenCalled();
});
it('blocks offline submission and reports cancellation beside the action', () => {
  vi.stubGlobal('navigator', { onLine: false }); submit(); expect(fixture.send).not.toHaveBeenCalled();
  expect(find('p').find(node => node.props.role === 'alert')?.props.children).toContain('Reconnect');
  render().props.onClose(); expect(props.onFeedback).toHaveBeenCalledWith(expect.objectContaining({ message: 'Project creation cancelled.' }));
});
