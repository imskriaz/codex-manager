import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VNode } from 'preact';
const fixture = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as Array<() => void>, send: vi.fn(), receive: undefined as undefined | ((event: any) => void) }));
vi.mock('preact/hooks', () => ({
  useState(initial: unknown) { const index = fixture.cursor++; fixture.slots[index] ??= { value: initial }; return [fixture.slots[index].value, (value: unknown) => { fixture.slots[index].value = value; }]; },
  useRef(initial: unknown) { const index = fixture.cursor++; return fixture.slots[index] ??= { current: initial }; },
  useEffect(setup: () => void | (() => void)) { const index = fixture.cursor++; if (fixture.slots[index]) return; const slot = { cleanup: undefined as void | (() => void) }; fixture.slots[index] = slot; fixture.effects.push(() => { slot.cleanup = setup(); }); }
}));
vi.mock('../webview-src/dashboard/host', () => ({ createActionRequestId: () => 'edit-id', postMessageToHost: fixture.send }));
import { EditProjectModal } from '../webview-src/dashboard/editProjectModal';
let props: Parameters<typeof EditProjectModal>[0];
function render() { fixture.cursor = 0; const node = EditProjectModal(props); fixture.effects.splice(0).forEach(effect => effect()); return node; }
function nodes(node: unknown): VNode<any>[] { if (Array.isArray(node)) return node.flatMap(nodes); if (!node || typeof node !== 'object' || !('props' in node)) return []; const value = node as VNode<any>; return [value, ...nodes(value.props.children)]; }
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(''); if (typeof node === 'string') return node; return node && typeof node === 'object' && 'props' in node ? text((node as VNode<any>).props.children) : ''; }
const button = (label: string) => nodes(render()).find(node => node.type === 'button' && text(node.props.children).trim() === label)!;
const reply = (status: string, action = 'renameWorkspaceProject', payload?: unknown, error?: string) => fixture.receive!({ data: { type: 'dashboard:action-result', requestId: 'edit-id', action, status, payload, error } });
beforeEach(() => {
  vi.useFakeTimers(); fixture.slots = []; fixture.cursor = 0; fixture.effects = []; fixture.send.mockReset();
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('window', { addEventListener: (_: string, listener: typeof fixture.receive) => { fixture.receive = listener; }, removeEventListener: () => {} });
  props = { project: { id: 'project', label: 'Project', path: 'D:\\Project' }, deviceId: 'peer', onClose: vi.fn(), onChanged: vi.fn(), onFeedback: vi.fn() }; render();
});
afterEach(() => { fixture.slots.forEach(slot => slot?.cleanup?.()); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('sends once, blocks closing while pending, and refreshes after a confirmed rename', () => {
  button('Save').props.onClick(); button('Saving…').props.onClick();
  expect(fixture.send).toHaveBeenCalledOnce();
  expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ action: 'renameWorkspaceProject', payload: { projectPath: props.project.path, projectName: 'Project', targetDeviceId: 'peer', automatic: true } }));
  expect(render().props.closeDisabled).toBe(true);
  reply('completed', 'renameWorkspaceProject', { workspaceProject: props.project });
  expect(props.onChanged).toHaveBeenCalledOnce(); expect(props.onClose).toHaveBeenCalledOnce();
});
it.each(['failed', 'cancelled', 'incomplete', 'timeout', 'offline', 'send-error'])('retains the editor and shows feedback on %s', outcome => {
  if (outcome === 'offline') vi.stubGlobal('navigator', { onLine: false });
  if (outcome === 'send-error') fixture.send.mockImplementation(() => { throw new Error('Disconnected'); });
  button('Save').props.onClick();
  if (outcome === 'timeout') vi.advanceTimersByTime(25_000);
  else if (outcome === 'incomplete') reply('completed');
  else if (outcome === 'failed' || outcome === 'cancelled') reply(outcome, 'renameWorkspaceProject', undefined, 'Storage failed');
  expect(props.onClose).not.toHaveBeenCalled(); expect(props.onChanged).not.toHaveBeenCalled();
  expect(props.onFeedback).toHaveBeenCalled(); expect(render().props.closeDisabled).toBe(false);
  expect(nodes(render()).some(node => node.props.role === 'alert')).toBe(true);
  if (outcome === 'timeout') { reply('completed', 'renameWorkspaceProject', { workspaceProject: props.project }); expect(props.onClose).not.toHaveBeenCalled(); }
});
it('requires confirmation before removing the project entry', () => {
  button('Remove').props.onClick(); expect(fixture.send).not.toHaveBeenCalled();
  button('Remove project').props.onClick();
  expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ action: 'removeWorkspaceProject', payload: expect.objectContaining({ confirmed: true }) }));
  reply('completed', 'removeWorkspaceProject'); expect(props.onClose).toHaveBeenCalledOnce();
});
