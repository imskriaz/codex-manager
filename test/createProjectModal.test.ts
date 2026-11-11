import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VNode } from 'preact';
const fixture = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, nextId: 0, effects: [] as Array<() => void>, send: vi.fn(), receive: undefined as undefined | ((event: any) => void) }));
vi.mock('preact/hooks', () => ({
  useState(initial: unknown) { const index = fixture.cursor++; fixture.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [fixture.slots[index].value, (next: unknown) => { fixture.slots[index].value = typeof next === 'function' ? next(fixture.slots[index].value) : next; }]; },
  useRef(initial: unknown) { const index = fixture.cursor++; return fixture.slots[index] ??= { current: initial }; },
  useEffect(setup: () => void | (() => void), deps: unknown[]) { const index = fixture.cursor++, previous = fixture.slots[index]; if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return; const slot = { deps, cleanup: undefined as void | (() => void) }; fixture.slots[index] = slot; fixture.effects.push(() => { previous?.cleanup?.(); slot.cleanup = setup(); }); }
}));
vi.mock('../webview-src/dashboard/host', () => ({ createActionRequestId: () => fixture.nextId++ === 0 ? 'create-id' : `request-${fixture.nextId}`, postMessageToHost: fixture.send }));
import { CreateProjectModal } from '../webview-src/dashboard/createProjectModal';
let props: Parameters<typeof CreateProjectModal>[0];
function render(patch: Partial<typeof props> = {}) { props = { ...props, ...patch }; fixture.cursor = 0; const node = CreateProjectModal(props); fixture.effects.splice(0).forEach(effect => effect()); return node; }
function nodes(node: unknown): VNode<any>[] { if (Array.isArray(node)) return node.flatMap(nodes); if (!node || typeof node !== 'object' || !('props' in node)) return []; const value = node as VNode<any>; return [value, ...nodes(value.props.children)]; }
const find = (type: string) => nodes(render()).filter(node => node.type === type);
const submit = () => find('form')[0]!.props.onSubmit({ preventDefault() {} });
beforeEach(() => {
  vi.useFakeTimers(); fixture.slots = []; fixture.cursor = 0; fixture.nextId = 0; fixture.effects = []; fixture.send.mockReset();
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('window', { addEventListener: (_name: string, listener: typeof fixture.receive) => { fixture.receive = listener; }, removeEventListener: () => { fixture.receive = undefined; } });
  props = { deviceId: 'selected-pc', initialFolder: 'D:\\Projects', onClose: vi.fn(), onCreated: vi.fn(), onFeedback: vi.fn() };
  render(); const input = find('input')[0]!;
  (input.props.onInput ?? input.props.oninput)({ currentTarget: { value: 'new-project' } });
});
afterEach(() => { fixture.slots.forEach(slot => slot?.cleanup?.()); vi.useRealTimers(); vi.unstubAllGlobals(); });
const modal = (title = 'Create new project') => nodes(render()).find(node => node.props.title === title)!;
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(''); if (typeof node === 'string') return node; return node && typeof node === 'object' && 'props' in node ? text((node as VNode<any>).props.children) : ''; }
const button = (label: string, title?: string) => nodes(title ? modal(title) : render()).find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node.props.children) === label))!;
const input = (label: string) => find('input').find(node => node.props['aria-label'] === label)!;
const reply = (requestId: string, payload: unknown, status = 'completed', error?: string) => fixture.receive!({ data: { type: 'dashboard:action-result', requestId, status, payload, error } });
const listing = (path = 'D:\\Selected') => ({ workspaceFolders: { path, parent: 'D:\\', folders: [], roots: ['D:\\'] } });

it('sends once and silently selects only the confirmed created folder', () => {
  submit(); submit(); expect(fixture.send).toHaveBeenCalledOnce();
  expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ action: 'createWorkspaceProject', payload: expect.objectContaining({ projectName: 'new-project', parentFolder: 'D:\\Projects', targetDeviceId: 'selected-pc' }) }));
  expect(modal().props.closeDisabled).toBe(true);
  const project = { id: 'new', label: 'new-project', path: 'D:\\Projects\\new-project' };
  reply('create-id', { workspaceProject: project, notice: { level: 'info', message: 'Created new-project.' } });
  expect(props.onCreated).toHaveBeenCalledWith(project); expect(props.onClose).toHaveBeenCalledOnce();
  expect(props.onFeedback).not.toHaveBeenCalled();
});
it('preserves input and sends the host error to action feedback for retry', () => {
  submit(); reply('create-id', undefined, 'failed', 'Storage full');
  expect(props.onFeedback).toHaveBeenCalledWith({ level: 'error', message: 'Storage full' });
  expect(find('p').some(node => node.props.role === 'alert')).toBe(false);
  expect(find('input')[0]?.props.value).toBe('new-project'); expect(props.onClose).not.toHaveBeenCalled();
  expect(modal().props.closeDisabled).toBe(false);
});
it('reports an unconfirmed timeout and ignores late replies without replaying creation', () => {
  submit(); vi.advanceTimersByTime(25_000);
  expect(props.onFeedback).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', message: expect.stringContaining('not replayed') }));
  reply('create-id', { workspaceProject: { path: 'late' } });
  expect(fixture.send).toHaveBeenCalledOnce(); expect(props.onCreated).not.toHaveBeenCalled();
});
it('blocks offline submission without discarding the draft', () => {
  vi.stubGlobal('navigator', { onLine: false }); submit(); expect(fixture.send).not.toHaveBeenCalled();
  expect(props.onFeedback).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Reconnect') }));
  expect(find('input')[0]?.props.value).toBe('new-project');
  modal().props.onClose(); expect(props.onClose).toHaveBeenCalledOnce();
});
it('ignores unrelated action replies without request ids', () => {
  expect(() => fixture.receive!({ data: { type: 'dashboard:action-result', status: 'completed', payload: listing() } })).not.toThrow();
  expect(props.onCreated).not.toHaveBeenCalled(); expect(props.onFeedback).not.toHaveBeenCalled();
});
it('preserves warning details when project creation succeeds partially', () => {
  submit(); reply('create-id', { workspaceProject: { id: 'new', label: 'new-project', path: 'D:\\Projects\\new-project' }, notice: { level: 'warning', message: 'Folder created; Git initialization failed.' } });
  expect(props.onCreated).toHaveBeenCalledOnce();
  expect(props.onFeedback).toHaveBeenCalledWith({ level: 'warning', message: 'Folder created; Git initialization failed.' });
});
it('browses in a separate dialog and selects a parent without creating a project', () => {
  button('Browse folders…').props.onClick(); button('Browse folders…').props.onClick();
  expect(fixture.send).toHaveBeenCalledOnce(); expect(modal('Select parent folder')).toBeDefined();
  expect(modal().props.closeDisabled).toBe(true);
  expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ action: 'browseWorkspaceFolders', payload: expect.objectContaining({ targetDeviceId: 'selected-pc' }) }));
  submit(); expect(fixture.send).toHaveBeenCalledOnce();
  reply('create-id', listing()); button('Select folder').props.onClick();
  expect(input('Parent folder').props.value).toBe('D:\\Selected');
  expect(modal('Select parent folder')).toBeUndefined(); expect(modal().props.closeDisabled).toBe(false);
  expect(props.onCreated).not.toHaveBeenCalled(); expect(props.onFeedback).not.toHaveBeenCalled();
});
it('cancels only the folder picker, preserves the draft and ignores a late reply after reopening', () => {
  button('Browse folders…').props.onClick(); button('Cancel', 'Select parent folder').props.onClick();
  expect(find('input')[0]?.props.value).toBe('new-project'); expect(input('Parent folder').props.value).toBe('D:\\Projects');
  expect(props.onClose).not.toHaveBeenCalled(); expect(props.onFeedback).not.toHaveBeenCalled();
  button('Browse folders…').props.onClick(); expect(fixture.send).toHaveBeenCalledTimes(2);
  reply('create-id', listing('D:\\Late')); expect(button('Select folder').props.disabled).toBe(true);
  reply('request-2', listing('D:\\Current')); button('Select folder').props.onClick();
  expect(input('Parent folder').props.value).toBe('D:\\Current');
  vi.advanceTimersByTime(12000); expect(props.onFeedback).not.toHaveBeenCalled();
});
it('reports browse timeout and offline failure with input preserved', () => {
  button('Browse folders…').props.onClick(); vi.advanceTimersByTime(12000);
  expect(props.onFeedback).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('timed out') }));
  expect(button('Select folder').props.disabled).toBe(true);
  button('Cancel', 'Select parent folder').props.onClick();
  vi.stubGlobal('navigator', { onLine: false }); button('Browse folders…').props.onClick();
  expect(props.onFeedback).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Reconnect') }));
  expect(fixture.send).toHaveBeenCalledOnce(); expect(find('input')[0]?.props.value).toBe('new-project');
});
it('does not select a stale listing after typed navigation fails and retains refresh for recovery', () => {
  button('Browse folders…').props.onClick(); reply('create-id', listing());
  (input('Folder path').props.onInput ?? input('Folder path').props.oninput)({ currentTarget: { value: 'D:\\Missing' } });
  expect(button('Select folder').props.disabled).toBe(true);
  find('form')[1]!.props.onSubmit({ preventDefault() {} }); reply('request-2', undefined, 'failed', 'Folder not found');
  expect(button('Select folder').props.disabled).toBe(true);
  expect(props.onFeedback).toHaveBeenCalledWith({ level: 'error', message: 'Folder not found' });
  button('Refresh folders').props.onClick();
  expect(fixture.send).toHaveBeenLastCalledWith(expect.objectContaining({ payload: expect.objectContaining({ parentFolder: 'D:\\Selected' }) }));
  reply('request-3', listing()); expect(button('Select folder').props.disabled).toBe(false);
});
it('retains a partial folder list and surfaces its warning through feedback', () => {
  button('Browse folders…').props.onClick(); reply('create-id', { workspaceFolders: { ...listing().workspaceFolders, warning: 'Some folders could not be read.' } });
  expect(props.onFeedback).toHaveBeenCalledWith({ level: 'warning', message: 'Some folders could not be read.' });
  expect(button('Select folder').props.disabled).toBe(false);
});
it('reports transport failure without leaving the picker busy', () => {
  fixture.send.mockImplementationOnce(() => { throw new Error('Connection lost'); });
  button('Browse folders…').props.onClick();
  expect(props.onFeedback).toHaveBeenCalledWith({ level: 'error', message: 'Connection lost' });
  expect(input('Folder path').props.disabled).toBeFalsy(); expect(button('Select folder').props.disabled).toBe(true);
});
