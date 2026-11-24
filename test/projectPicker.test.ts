import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VNode } from 'preact';
const fixture = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as Array<() => void> }));
vi.mock('preact/compat', () => ({ createPortal: (node: unknown) => node }));
vi.mock('preact/hooks', () => ({
  useState(initial: unknown) { const index = fixture.cursor++; fixture.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [fixture.slots[index].value, (next: any) => { fixture.slots[index].value = typeof next === 'function' ? next(fixture.slots[index].value) : next; }]; },
  useRef(initial: unknown) { const index = fixture.cursor++; return fixture.slots[index] ??= { current: initial }; },
  useId: () => 'picker',
  useLayoutEffect: () => {},
  useEffect(setup: () => void | (() => void), deps: unknown[]) { const index = fixture.cursor++, previous = fixture.slots[index]; if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return; const slot = { deps, cleanup: undefined as void | (() => void) }; fixture.slots[index] = slot; fixture.effects.push(() => { previous?.cleanup?.(); slot.cleanup = setup(); }); }
}));
import { ProjectPicker } from '../webview-src/dashboard/projectPicker';
let props: Parameters<typeof ProjectPicker>[0], storage: Map<string, string>;
function render(patch: Partial<typeof props> = {}) { props = { ...props, ...patch }; fixture.cursor = 0; const node = ProjectPicker(props); fixture.effects.splice(0).forEach(effect => effect()); return node; }
function nodes(node: unknown): VNode<any>[] { if (Array.isArray(node)) return node.flatMap(nodes); if (!node || typeof node !== 'object' || !('props' in node)) return []; const value = node as VNode<any>; return [value, ...nodes(value.props.children)]; }
const find = (predicate: (node: VNode<any>) => boolean) => nodes(render()).find(predicate)!;
const trigger = () => find(node => node.props.role === 'combobox');
const open = () => { trigger().props.onClick(); render(); };
const options = () => nodes(render()).filter(node => node.props.role === 'option');
const remove = () => find(node => node.props['aria-label'] === 'Remove Alpha from recent').props.onClick();
const confirmation = () => find(node => typeof node.type === 'function' && !!node.props.onConfirm);
const confirmRemoval = () => { remove(); confirmation().props.onConfirm(); open(); };
beforeEach(() => {
  fixture.slots = []; fixture.cursor = 0; fixture.effects = []; storage = new Map();
  vi.stubGlobal('localStorage', { getItem: vi.fn((key: string) => storage.get(key) ?? null), setItem: vi.fn((key: string, value: string) => storage.set(key, value)) });
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', { body: {} });
  props = { label: 'Project', value: 'D:/Alpha', projects: [{ path: 'D:/Alpha', label: 'Alpha' }, { path: 'D:/Beta', label: 'Beta' }], onChange: vi.fn(), onAdd: vi.fn() };
  render(); open();
});
afterEach(() => { fixture.slots.forEach(slot => slot?.cleanup?.()); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('searches project labels and paths without losing the no-folder choice', () => {
  const input = find(node => node.type === 'input');
  (input.props.onInput ?? input.props.oninput)({ currentTarget: { value: 'd:/beta' } });
  expect(options().map(node => node.props['data-value'])).toEqual([undefined, 'D:/Beta']);
  expect(trigger().props['data-value']).toBe('D:/Alpha');
});
it('removes only a recent entry, preserves selection and does not send a project change', () => {
  confirmRemoval();
  expect(options().map(node => node.props['data-value'])).toEqual([undefined, 'D:/Beta']);
  expect(props.onChange).not.toHaveBeenCalled(); expect(props.projects).toHaveLength(2);
  expect(trigger().props['data-value']).toBe('D:/Alpha');
  expect(storage.get('codexManager.projectPicker.removed.local')).toBe(JSON.stringify(['d:/alpha']));
  expect(nodes(render()).some(node => node.props.class === 'project-picker-notice')).toBe(false);
  trigger().props.onClick(); open();
  expect(options()).toHaveLength(2);
});
it('keeps remote systems separate and reloads persisted removal preferences', () => {
  confirmRemoval(); render({ scope: 'remote-pc' }); open();
  expect(options()).toHaveLength(3);
  render({ scope: 'local' }); open(); expect(options()).toHaveLength(2);
});
it('keeps removed projects searchable without restoring them to recents', () => {
  confirmRemoval();
  const input = find(node => node.type === 'input');
  (input.props.onInput ?? input.props.oninput)({ currentTarget: { value: 'Alpha' } });
  expect(options().map(node => node.props['data-value'])).toEqual([undefined, 'D:/Alpha']);
  options()[1]!.props.onClick(); expect(props.onChange).toHaveBeenCalledWith('D:/Alpha');
  open(); expect(options()).toHaveLength(2);
});
it('reports storage failures and preserves the entry for retry', () => {
  vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error('quota'); });
  remove(); confirmation().props.onConfirm();
  expect(confirmation().props.error).toContain('Could not remove');
  expect(storage.size).toBe(0);
  expect(props.onChange).not.toHaveBeenCalled();
  expect(nodes(render()).some(node => node.props.class === 'dashboard-notice-stack project-picker-toast')).toBe(false);
});
it('requires confirmation and cancels without changing recents', () => {
  remove(); expect(storage.size).toBe(0); expect(trigger().props['aria-expanded']).toBe(false);
  confirmation().props.onCancel(); open(); expect(options()).toHaveLength(3);
  expect(storage.size).toBe(0); expect(props.onChange).not.toHaveBeenCalled();
  expect(nodes(render()).some(node => node.props.class === 'dashboard-notice-stack project-picker-toast')).toBe(false);
});
it('shows a dismissible success toast and expires it without changing the picker layout', () => {
  vi.useFakeTimers();
  confirmRemoval();
  expect(find(node => node.props.role === 'status').props.children[0].props.children).toBe('Removed Alpha from recent projects.');
  expect(nodes(render()).some(node => node.props.class === 'sr-only' && node.props.role === 'status')).toBe(false);
  vi.advanceTimersByTime(4499);
  expect(nodes(render()).some(node => node.props.class === 'dashboard-notice-stack project-picker-toast')).toBe(true);
  vi.advanceTimersByTime(1);
  expect(nodes(render()).some(node => node.props.class === 'dashboard-notice-stack project-picker-toast')).toBe(false);
  const input = find(node => node.type === 'input');
  input.props.onInput({ currentTarget: { value: 'Alpha' } });
  remove(); confirmation().props.onConfirm();
  find(node => node.props['aria-label'] === 'Dismiss project notification').props.onClick();
  expect(nodes(render()).some(node => node.props.class === 'dashboard-notice-stack project-picker-toast')).toBe(false);
});
it('restarts the toast timer when the same searchable project is removed again', () => {
  vi.useFakeTimers();
  confirmRemoval();
  vi.advanceTimersByTime(3000);
  find(node => node.type === 'input').props.onInput({ currentTarget: { value: 'Alpha' } });
  remove(); confirmation().props.onConfirm(); render();
  vi.advanceTimersByTime(1500);
  expect(nodes(render()).some(node => node.props.class === 'dashboard-notice-stack project-picker-toast')).toBe(true);
  vi.advanceTimersByTime(3000);
  expect(nodes(render()).some(node => node.props.class === 'dashboard-notice-stack project-picker-toast')).toBe(false);
});
it('reports malformed saved preferences and leaves all projects available', () => {
  storage.set('codexManager.projectPicker.removed.local', '{broken');
  window.dispatchEvent(new Event('storage')); expect(options()).toHaveLength(3);
  expect(find(node => node.props.role === 'alert')).toBeDefined();
});
it('selects a project or no folder and closes the menu', () => {
  options()[2]!.props.onClick(); expect(props.onChange).toHaveBeenCalledWith('D:/Beta');
  expect(trigger().props['aria-expanded']).toBe(false);
  open(); options()[0]!.props.onClick(); expect(props.onChange).toHaveBeenLastCalledWith('');
});
it('opens folder creation independently of project selection', () => {
  find(node => node.props.class === 'project-picker-add').props.onClick();
  expect(props.onAdd).toHaveBeenCalledOnce(); expect(props.onChange).not.toHaveBeenCalled();
  expect(trigger().props['aria-expanded']).toBe(false);
});
it('deduplicates paths and omits no-folder for required project selectors', () => {
  render({ projects: [...props.projects, { path: 'd:\\alpha\\', label: 'Alpha duplicate' }], allowEmpty: false });
  expect(options()).toHaveLength(2); expect(options().every(node => node.props['data-value'])).toBe(true);
});
