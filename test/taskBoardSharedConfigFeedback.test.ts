import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VNode } from 'preact';
import type { ProjectBoard, TaskStage } from '../src/domain/projectTasks';
const fixture = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as Array<() => void>, readCache: vi.fn(), writeCache: vi.fn(), outbox: vi.fn() }));
vi.mock('preact/hooks', () => {
  const effect = (setup: () => void | (() => void), deps: unknown[]) => {
    const i = fixture.cursor++, previous = fixture.slots[i];
    if (previous && deps.every((value, j) => Object.is(value, previous.deps[j]))) return;
    const slot = { deps, cleanup: undefined as void | (() => void) }; fixture.slots[i] = slot;
    fixture.effects.push(() => { previous?.cleanup?.(); slot.cleanup = setup(); });
  };
  return {
    useState(initial: unknown) { const i = fixture.cursor++; fixture.slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [fixture.slots[i].value, (next: any) => { fixture.slots[i].value = typeof next === 'function' ? next(fixture.slots[i].value) : next; }]; },
    useRef(initial: unknown) { const i = fixture.cursor++; return fixture.slots[i] ??= { current: initial }; },
    useMemo: (factory: () => unknown) => factory(), useEffect: effect, useLayoutEffect: effect, useId: () => 'task-fixture'
  };
});
vi.mock('preact/compat', async importOriginal => ({ ...await importOriginal<typeof import('preact/compat')>(), createPortal: (node: unknown) => node }));
vi.mock('../webview-src/dashboard/taskViewPosition', () => ({ useTaskViewPosition: () => ({ current: null }) }));
vi.mock('../webview-src/dashboard/cliSessionCache', () => ({ readBrowserCache: fixture.readCache, writeBrowserCache: fixture.writeCache, listBrowserOutbox: fixture.outbox, deleteBrowserCache: vi.fn(), readCliSessionMessagesCache: vi.fn(), writeCliSessionMessagesCache: vi.fn() }));
import { TaskBoard } from '../webview-src/dashboard/taskBoard';
let props: Parameters<typeof TaskBoard>[0];
const sendAction = vi.fn(), feedback = vi.fn();
const task = (id: string, stage: TaskStage) => ({ id, stage, title: id, prompt: '', revision: 1, createdAt: 1, updatedAt: 1 });
const board: ProjectBoard = { projectPath: 'D:/project', tasks: [task('planned-task', 'planned'), task('running-task', 'running'), task('done-task', 'completed')], comments: [], sessions: [], updatedAt: 1, revision: 1 };
function render(patch: Partial<typeof props> = {}) { props = { ...props, ...patch }; fixture.cursor = 0; const node = TaskBoard(props); fixture.effects.splice(0).forEach(effect => effect()); return node; }
function nodes(node: unknown): VNode<any>[] { if (Array.isArray(node)) return node.flatMap(nodes); if (!node || typeof node !== 'object' || !('props' in node)) return []; const value = node as VNode<any>; return [value, ...nodes(value.props.children)]; }
const columns = () => nodes(render()).filter(node => typeof node.type === 'function' && node.type.name === 'TaskColumn');
const notices = () => nodes(render()).filter(node => typeof node.props.class === 'string' && node.props.class.startsWith('dashboard-notice is-'));
const emit = (status: 'completed' | 'failed', payload?: object, error?: string) => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action: 'moveProjectTask', requestId: 'move-id', status, payload, error } }));
async function settle() { for (let i = 0; i < 4; i++) { await Promise.resolve(); render(); } }
beforeEach(() => {
  vi.useFakeTimers(); fixture.slots = []; fixture.cursor = 0; fixture.effects = [];
  fixture.readCache.mockReset().mockImplementation((key: string) => Promise.resolve(key.startsWith('board:') ? board : undefined));
  fixture.writeCache.mockReset().mockResolvedValue(true); fixture.outbox.mockReset().mockResolvedValue([]);
  sendAction.mockReset().mockReturnValue('move-id'); feedback.mockReset();
  vi.stubGlobal('location', { protocol: 'http:', origin: 'http://127.0.0.1' });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: { getItem: () => null, setItem() {} } }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: true, body: {} }));
  props = { sessions: [], projects: [{ id: 'project', path: board.projectPath, label: 'Project' }], connected: true, targetDeviceId: 'pc', sendAction, onOpenSession() {}, onActionFeedback: feedback };
});
afterEach(() => { fixture.slots.forEach(slot => slot.cleanup?.()); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('uses shared columns and stageFilter instead of local preferences and all stages', () => {
  props.shared = { draftKey: 'draft', board: { ...board, boardConfig: { columns: ['running', 'completed'], stageFilter: 'completed' } }, permissions: [], request: vi.fn() };
  render(); render();
  const rendered = columns();
  expect(rendered.map(node => node.props.stage)).toEqual(['running', 'completed']);
  expect(rendered.map(node => node.props.tasks.map((task: { id: string }) => task.id))).toEqual([[], ['done-task']]);
  expect(nodes(render()).find(node => node.props.class === 'task-board-columns')?.props.style.gridTemplateColumns).toBe('repeat(2,minmax(240px,1fr))');
});
it('updates shared restrictions on new board props without resetting local preferences', () => {
  props.shared = { draftKey: 'draft', board, permissions: [], request: vi.fn() }; render(); render();
  expect(columns()).toHaveLength(4);
  render({ shared: { ...props.shared!, board: { ...board, boardConfig: { columns: ['planned'], stageFilter: 'planned' } } } });
  expect(columns().map(node => node.props.stage)).toEqual(['planned']);
  expect(columns()[0]!.props.tasks.map((task: { id: string }) => task.id)).toEqual(['planned-task']);
});
it('passes the shared stage filter to alternate views', () => {
  props.shared = { draftKey: 'draft', board: { ...board, boardConfig: { view: 'list', stageFilter: 'running', columns: ['running'] } }, permissions: [], request: vi.fn() }; render(); render();
  const alternate = nodes(render()).find(node => typeof node.type === 'function' && node.type.name === 'TaskAlternateView');
  expect(alternate?.props.tasks.map((task: { id: string }) => task.id)).toEqual(['running-task']);
});
it('shows confirmed task success locally even when global feedback is configured, then dismisses it', async () => {
  render(); await settle();
  columns()[0]!.props.onMove(board.tasks[0], 'completed');
  expect(notices()).toHaveLength(0);
  emit('completed'); await settle();
  expect(notices()).toHaveLength(1);
  expect(notices()[0]!.props.class).toBe('dashboard-notice is-info');
  expect(nodes(notices()[0]).find(node => node.type === 'span')?.props.children).toBe('Moved to Completed.');
  expect(feedback).not.toHaveBeenCalled();
  vi.advanceTimersByTime(3000); expect(notices()).toHaveLength(0);
});
it('keeps task failures on the existing global path without duplicating a local toast', async () => {
  render(); await settle(); columns()[0]!.props.onMove(board.tasks[0], 'completed');
  emit('failed', undefined, 'Owner disconnected'); await settle();
  expect(feedback).toHaveBeenCalledWith({ level: 'warning', message: 'Owner disconnected' });
  expect(notices()).toHaveLength(0);
});
it('retains local warning feedback when there is no global callback', async () => {
  props.onActionFeedback = undefined; render(); await settle();
  columns()[0]!.props.onMove(board.tasks[0], 'completed'); emit('failed', undefined, 'Owner disconnected'); await settle();
  expect(notices()[0]!.props.class).toBe('dashboard-notice is-warning');
});
