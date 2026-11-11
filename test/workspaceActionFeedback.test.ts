import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as Array<() => void>, request: vi.fn() }));
vi.mock('preact/hooks', async original => ({
  ...await original<typeof import('preact/hooks')>(),
  useState(initial: unknown) { const index = fixture.cursor++; fixture.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [fixture.slots[index].value, (next: unknown) => { fixture.slots[index].value = typeof next === 'function' ? next(fixture.slots[index].value) : next; }]; },
  useRef(initial: unknown) { const index = fixture.cursor++; return fixture.slots[index] ??= { current: initial }; },
  useEffect: () => {},
  useLayoutEffect(setup: () => void) { fixture.effects.push(setup); }
}));
vi.mock('../webview-src/dashboard/workspaceRequest', () => ({ useWorkspaceRequest: () => fixture.request }));
import { WorkspaceGit } from '../webview-src/dashboard/workspaceGit';
import { WorkspaceGitHub } from '../webview-src/dashboard/workspaceGitHub';
beforeEach(() => { fixture.slots = []; fixture.cursor = 0; fixture.effects = []; fixture.request.mockReset(); });
for (const [label, component, payload] of [
  ['Git', WorkspaceGit, 'workspaceGit'], ['GitHub', WorkspaceGitHub, 'workspaceGitHub']
] as const) {
  it(`${label} routes read failures through action feedback without losing the host error`, async () => {
    const onFeedback = vi.fn(); fixture.request.mockRejectedValue(new Error('Permission denied'));
    component({ connected: true, projectPath: 'D:/project', draft: '', onDraft: vi.fn(), onPending: vi.fn(), onOpenFile: vi.fn(), renderDiff: () => null, onFeedback });
    fixture.effects.splice(0).forEach(effect => effect());
    await vi.waitFor(() => expect(onFeedback).toHaveBeenCalledWith({ level: 'error', message: 'Permission denied' }));
  });
  it(`${label} keeps successful refresh quiet and preserves partial warnings`, async () => {
    const onFeedback = vi.fn(); fixture.request.mockResolvedValue({ [payload]: { warning: 'Partial repository data' } });
    component({ connected: true, projectPath: 'D:/project', draft: '', onDraft: vi.fn(), onPending: vi.fn(), onOpenFile: vi.fn(), renderDiff: () => null, onFeedback });
    fixture.effects.splice(0).forEach(effect => effect());
    await vi.waitFor(() => expect(onFeedback).toHaveBeenCalledWith({ level: 'warning', message: 'Partial repository data' }));
    expect(onFeedback.mock.calls.some(([notice]) => notice.level === 'info')).toBe(false);
  });
}
