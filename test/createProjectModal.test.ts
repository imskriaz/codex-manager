import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VNode } from 'preact';
const fixture = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, nextId: 0, effects: [] as Array<() => void>, send: vi.fn(), receive: undefined as undefined | ((event: any) => void) }));
const local = vi.hoisted(() => ({ choose: vi.fn(), connect: vi.fn() }));
vi.mock('../webview-src/dashboard/localFolderConnection', () => ({ chooseLocalFolder: local.choose, connectLocalFolder: local.connect }));
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
  local.choose.mockReset(); local.connect.mockReset();
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('window', { addEventListener: (_name: string, listener: typeof fixture.receive) => { fixture.receive = listener; }, removeEventListener: () => { fixture.receive = undefined; } });
  props = { deviceId: 'selected-pc', initialFolder: 'D:\\Projects', onClose: vi.fn(), onCreated: vi.fn(), onFeedback: vi.fn() };
  render();
});
afterEach(() => { fixture.slots.forEach(slot => slot?.cleanup?.()); vi.useRealTimers(); vi.unstubAllGlobals(); });
const modal = (title = 'Add Project') => nodes(render()).find(node => node.props.title === title)!;
function text(node: unknown): string { if (Array.isArray(node)) return node.map(text).join(''); if (typeof node === 'string') return node; return node && typeof node === 'object' && 'props' in node ? text((node as VNode<any>).props.children) : ''; }
const button = (label: string, title?: string) => nodes(title ? modal(title) : render()).find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node.props.children) === label))!;
const input = (label: string) => find('input').find(node => node.props['aria-label'] === label)!;
const reply = (requestId: string, payload: unknown, status = 'completed', error?: string) => fixture.receive!({ data: { type: 'dashboard:action-result', requestId, status, payload, error } });
const listing = (path = 'D:\\Selected') => ({ workspaceFolders: { path, parent: 'D:\\', folders: [], roots: ['D:\\'] } });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const projectName = (value: string) => { const node = input('Project name'); (node.props.onInput ?? node.props.oninput)({ currentTarget: { value } }); };

it('shows the optional folder connection only after the user workspace project name', () => {
  expect(button('Local folder (optional)')).toBeUndefined();
  render({ simple: true });
  expect(find('input')).toHaveLength(1); expect(input('Project name')).toBeDefined();
  expect(find('input').some(node => node.props.type === 'file')).toBe(false);
  expect(text(modal())).toContain('Local folder (optional)');
  projectName('My project'); submit();
  expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ action: 'createWorkspaceProject', payload: expect.objectContaining({ projectName: 'My project' }) }));
  expect(local.connect).not.toHaveBeenCalled();
});
const localButton = () => nodes(render()).find(node => node.type === 'button' && node.props['aria-labelledby'] === 'local-project-folder-label')!;
it('connects a chosen directory without uploading it and prevents duplicate creation', async () => {
  render({ simple: true }); const handle = { name: 'Local project' };
  local.choose.mockResolvedValue(handle); localButton().props.onClick(); await flush();
  projectName('My project');
  let done: (value: any) => void = () => {};
  local.connect.mockReturnValue(new Promise(resolve => { done = resolve; }));
  submit(); submit(); expect(local.connect).toHaveBeenCalledOnce();
  expect(local.connect).toHaveBeenCalledWith(handle, 'My project'); expect(fixture.send).not.toHaveBeenCalled();
  const project = { id: 'local-project', label: 'My project', path: '/scoped-marker', localFolder: { name: 'Local project' } };
  done(project); await flush();
  expect(props.onCreated).toHaveBeenCalledWith(project); expect(props.onClose).toHaveBeenCalledOnce();
  expect(props.onFeedback).toHaveBeenCalledWith(expect.objectContaining({ message: 'Project connected to your local folder.' }));
});
it('keeps the project draft after cancelled folder selection or failed connection', async () => {
  render({ simple: true }); projectName('My project');
  local.choose.mockRejectedValue(new DOMException('Cancelled', 'AbortError')); localButton().props.onClick(); await flush();
  expect(text(modal())).toContain('Folder selection cancelled.'); expect(input('Project name').props.value).toBe('My project');
  local.choose.mockResolvedValue({ name: 'Local project' }); localButton().props.onClick(); await flush();
  local.connect.mockRejectedValue(new Error('Connection unavailable')); submit(); await flush();
  expect(text(modal())).toContain('Connection unavailable'); expect(props.onClose).not.toHaveBeenCalled();
  expect(button('Add project').props.disabled).toBeFalsy(); expect(input('Project name').props.value).toBe('My project');
  button('Remove local folder').props.onClick(); submit(); expect(fixture.send).toHaveBeenCalledOnce();
});

it('sends once and silently selects only the confirmed created folder', () => {
  submit(); submit(); expect(fixture.send).toHaveBeenCalledOnce();
  expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ action: 'createWorkspaceProject', payload: { parentFolder: 'D:\\Projects', targetDeviceId: 'selected-pc', automatic: true } }));
  expect(modal().props.closeDisabled).toBe(true);
  const project = { id: 'new', label: 'new-project', path: 'D:\\Projects\\new-project' };
  reply('create-id', { workspaceProject: project, notice: { level: 'info', message: 'Created new-project.' } });
  expect(props.onCreated).toHaveBeenCalledWith(project); expect(props.onClose).toHaveBeenCalledOnce();
  expect(props.onFeedback).not.toHaveBeenCalled();
});
it('shows only the project folder field and submits it without a project name', () => {
  expect(find('input')).toHaveLength(1);
  expect(input('Project folder').props.required).toBe(true);
  expect(button('Add project').props.disabled).toBeFalsy();
  expect(find('code')[0]!.props.children).toBe('D:\\Projects');
  submit(); submit();
  expect(fixture.send).toHaveBeenCalledOnce();
  expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ payload: { parentFolder: 'D:\\Projects', targetDeviceId: 'selected-pc', automatic: true } }));
  const project = { id: 'D:\\Projects', label: 'Projects', path: 'D:\\Projects' };
  reply('create-id', { workspaceProject: project });
  expect(props.onCreated).toHaveBeenCalledWith(project); expect(props.onClose).toHaveBeenCalledOnce();
});
it('requires a project folder', () => {
  (input('Project folder').props.onInput ?? input('Project folder').props.oninput)({ currentTarget: { value: '  ' } });
  expect(button('Add project').props.disabled).toBe(true);
  submit(); expect(fixture.send).not.toHaveBeenCalled();
});
it('uses verified host connectivity rather than the browser Internet hint', () => {
  vi.stubGlobal('navigator', { onLine: false }); submit();
  expect(fixture.send).toHaveBeenCalledOnce();
});
it('ignores a late nameless result after timeout and accepts only the explicit retry', () => {
  submit(); vi.advanceTimersByTime(25_000); submit();
  const project = { id: 'D:\\Projects', label: 'Projects', path: 'D:\\Projects' };
  reply('create-id', { workspaceProject: project }); expect(props.onCreated).not.toHaveBeenCalled();
  reply('request-2', { workspaceProject: project }); expect(props.onCreated).toHaveBeenCalledWith(project);
  expect(fixture.send).toHaveBeenCalledTimes(2);
});
it('preserves input and sends the host error to action feedback for retry', () => {
  submit(); reply('create-id', undefined, 'failed', 'Storage full');
  expect(props.onFeedback).toHaveBeenCalledWith({ level: 'error', message: 'Storage full' });
  expect(find('p').some(node => node.props.role === 'alert')).toBe(false);
  expect(find('input')[0]?.props.value).toBe('D:\\Projects'); expect(props.onClose).not.toHaveBeenCalled();
  expect(modal().props.closeDisabled).toBe(false);
});
it('reports an unconfirmed timeout and ignores late replies without replaying creation', () => {
  submit(); vi.advanceTimersByTime(25_000);
  expect(props.onFeedback).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', message: expect.stringContaining('not replayed') }));
  reply('create-id', { workspaceProject: { path: 'late' } });
  expect(fixture.send).toHaveBeenCalledOnce(); expect(props.onCreated).not.toHaveBeenCalled();
});
it('blocks disconnected host submission without discarding the draft', () => {
  props.disabled = true; submit(); expect(fixture.send).not.toHaveBeenCalled();
  expect(find('input')[0]?.props.value).toBe('D:\\Projects');
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
  expect(fixture.send).toHaveBeenCalledOnce(); expect(modal('Select project folder')).toBeDefined();
  expect(modal().props.closeDisabled).toBe(true);
  expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ action: 'browseWorkspaceFolders', payload: expect.objectContaining({ targetDeviceId: 'selected-pc' }) }));
  submit(); expect(fixture.send).toHaveBeenCalledOnce();
  reply('create-id', listing()); button('Select folder').props.onClick();
  expect(input('Project folder').props.value).toBe('D:\\Selected');
  expect(modal('Select project folder')).toBeUndefined(); expect(modal().props.closeDisabled).toBe(false);
  expect(props.onCreated).not.toHaveBeenCalled(); expect(props.onFeedback).not.toHaveBeenCalled();
});
it('cancels only the folder picker, preserves the draft and ignores a late reply after reopening', () => {
  button('Browse folders…').props.onClick(); button('Cancel', 'Select project folder').props.onClick();
  expect(find('input')[0]?.props.value).toBe('D:\\Projects'); expect(input('Project folder').props.value).toBe('D:\\Projects');
  expect(props.onClose).not.toHaveBeenCalled(); expect(props.onFeedback).not.toHaveBeenCalled();
  button('Browse folders…').props.onClick(); expect(fixture.send).toHaveBeenCalledTimes(2);
  reply('create-id', listing('D:\\Late')); expect(button('Select folder').props.disabled).toBe(true);
  reply('request-2', listing('D:\\Current')); button('Select folder').props.onClick();
  expect(input('Project folder').props.value).toBe('D:\\Current');
  vi.advanceTimersByTime(12000); expect(props.onFeedback).not.toHaveBeenCalled();
});
it('reports browse timeout and offline failure with input preserved', () => {
  button('Browse folders…').props.onClick(); vi.advanceTimersByTime(12000);
  expect(props.onFeedback).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('timed out') }));
  expect(button('Select folder').props.disabled).toBe(true);
  button('Cancel', 'Select project folder').props.onClick();
  vi.stubGlobal('navigator', { onLine: false }); button('Browse folders…').props.onClick();
  expect(fixture.send).toHaveBeenCalledTimes(2); expect(find('input')[0]?.props.value).toBe('D:\\Projects');
});
it('does not select a stale listing after typed navigation fails and supports navigation recovery', () => {
  button('Browse folders…').props.onClick(); reply('create-id', listing());
  (input('Folder path').props.onInput ?? input('Folder path').props.oninput)({ currentTarget: { value: 'D:\\Missing' } });
  expect(button('Select folder').props.disabled).toBe(true);
  find('form')[1]!.props.onSubmit({ preventDefault() {} }); reply('request-2', undefined, 'failed', 'Folder not found');
  expect(button('Select folder').props.disabled).toBe(true);
  expect(props.onFeedback).toHaveBeenCalledWith({ level: 'error', message: 'Folder not found' });
  (input('Folder path').props.onInput ?? input('Folder path').props.oninput)({ currentTarget: { value: 'D:\\Selected' } });
  find('form')[1]!.props.onSubmit({ preventDefault() {} });
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

const openNewFolder = () => {
  button('Browse folders\u2026').props.onClick(); reply('create-id', listing());
  button('New folder').props.onClick();
  (input('Folder name').props.onInput ?? input('Folder name').props.oninput)({ currentTarget: { value: 'New folder' } });
};
const submitFolder = () => nodes(modal('New folder')).find(node => node.type === 'form')!.props.onSubmit({ preventDefault() {} });
it('creates a folder once on the selected system and selects it only after confirmation', () => {
  openNewFolder(); submitFolder(); submitFolder();
  expect(fixture.send).toHaveBeenCalledTimes(2);
  expect(fixture.send).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'createWorkspaceFolder', payload: { parentFolder: 'D:\\Selected', folderName: 'New folder', targetDeviceId: 'selected-pc', automatic: true } }));
  expect(modal('Select project folder').props.closeDisabled).toBe(true);
  modal('Select project folder').props.onClose(); expect(modal('Select project folder')).toBeDefined();
  expect(button('Select folder').props.disabled).toBe(true);
  reply('request-2', { workspaceFolder: 'D:\\Selected\\New folder' });
  expect(text(modal('Select project folder'))).toContain('Folder created:');
  expect(button('Select folder').props.disabled).toBe(false);
  button('Select folder').props.onClick();
  expect(input('Project folder').props.value).toBe('D:\\Selected\\New folder');
  expect(props.onCreated).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
});
it('retains the folder name and renders host failures in the picker for retry', () => {
  openNewFolder(); submitFolder(); reply('request-2', undefined, 'failed', 'Permission denied');
  expect(nodes(modal('Select project folder')).find(node => node.props.role === 'alert')?.props.children).toBe('Permission denied');
  expect(input('Folder name').props.value).toBe('New folder');
  expect(button('Create folder').props.disabled).toBeFalsy();
  submitFolder(); expect(fixture.send).toHaveBeenCalledTimes(3);
});
it('times out without replay, ignores late creation and permits explicit navigation recovery', () => {
  openNewFolder(); submitFolder(); vi.advanceTimersByTime(12000);
  expect(text(modal('Select project folder'))).toContain('not replayed');
  reply('request-2', { workspaceFolder: 'D:\\Late' });
  expect(input('Folder path').props.value).toBe('D:\\Selected');
  expect(fixture.send).toHaveBeenCalledTimes(2);
  button('Cancel new folder').props.onClick();
  expect(text(modal('Select project folder'))).toContain('Folder creation cancelled.');
  expect(button('Select folder').props.disabled).toBe(false);
});
it('shows transport failure and cancellation in the folder picker without losing input', () => {
  openNewFolder(); fixture.send.mockImplementationOnce(() => { throw new Error('Connection lost'); }); submitFolder();
  expect(text(modal('Select project folder'))).toContain('Connection lost');
  expect(modal('Select project folder').props.closeDisabled).toBe(false);
  submitFolder(); reply('request-3', undefined, 'cancelled');
  expect(text(modal('Select project folder'))).toContain('Folder creation cancelled.');
  expect(input('Folder name').props.value).toBe('New folder');
});
it('prevents folder creation in an unvisited path or while disconnected', () => {
  openNewFolder(); (input('Folder path').props.onInput ?? input('Folder path').props.oninput)({ currentTarget: { value: 'D:\\Other' } });
  submitFolder(); expect(fixture.send).toHaveBeenCalledOnce();
  (input('Folder path').props.onInput ?? input('Folder path').props.oninput)({ currentTarget: { value: 'D:\\Selected' } });
  render({ disabled: true }); submitFolder(); expect(fixture.send).toHaveBeenCalledOnce();
});
