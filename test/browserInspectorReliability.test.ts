import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VNode } from 'preact';
const fixture = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as Array<() => void>, cleanups: [] as Array<() => void> }));
vi.mock('preact/hooks', () => ({
  useState(initial: any) { const i = fixture.cursor++; fixture.slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [fixture.slots[i].value, (next: any) => { fixture.slots[i].value = typeof next === 'function' ? next(fixture.slots[i].value) : next; }]; },
  useRef(initial: any) { return fixture.slots[fixture.cursor++] ??= { current: initial }; },
  useEffect(setup: () => any, deps: any[]) { const i = fixture.cursor++, prior = fixture.slots[i]; if (prior && deps.every((v,j) => Object.is(v, prior.deps[j]))) return; const slot = { deps, cleanup: undefined as any }; fixture.slots[i] = slot; fixture.effects.push(() => { prior?.cleanup?.(); slot.cleanup = setup(); if (slot.cleanup) fixture.cleanups.push(slot.cleanup); }); },
  useMemo: (factory: () => any) => factory()
}));
import { BrowserInspectorContent, consoleEventLevel, emptyBrowserConsole } from '../webview-src/dashboard/workspaceBrowserInspector';
let props: Parameters<typeof BrowserInspectorContent>[0];
function render() { fixture.cursor = 0; const tree = BrowserInspectorContent(props); fixture.effects.splice(0).forEach(fn => fn()); return tree; }
function nodes(value: any): VNode<any>[] { if (Array.isArray(value)) return value.flatMap(nodes); return value && typeof value === 'object' && 'props' in value ? [value, ...nodes(value.props.children)] : []; }
beforeEach(() => { vi.useFakeTimers(); fixture.slots = []; fixture.effects = []; fixture.cleanups = []; vi.stubGlobal('document', { visibilityState: 'visible' }); props = { panel: 'console', pageId: 'page', connected: true, busy: false, request: vi.fn(() => new Promise(() => {})), onCommand: vi.fn(), onEvaluate: vi.fn(), onClearConsole: vi.fn() }; });
afterEach(() => { fixture.cleanups.forEach(fn => fn()); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('keeps at most one events read pending during slow polling', async () => { render(); await vi.advanceTimersByTimeAsync(30_000); render(); expect(props.request).toHaveBeenCalledOnce(); });
it('does not start a duplicate parent events reader for Network', () => { props.panel = 'network'; render(); expect(props.request).not.toHaveBeenCalled(); });
it('preserves an external console draft across unmount and remount', () => {
  let saved = emptyBrowserConsole(); props.consoleState = saved; props.onConsoleState = next => { saved = next; };
  const input = nodes(render()).find(node => node.type === 'textarea')!;
  input.props.onInput({ currentTarget: { value: 'document.title' } });
  fixture.cleanups.forEach(fn => fn()); fixture.slots = []; fixture.cleanups = []; props.consoleState = saved;
  expect(nodes(render()).find(node => node.type === 'textarea')!.props.value).toBe('document.title');
});
it('normalizes both CDP info and log events into Info', () => { expect(consoleEventLevel('info')).toBe('log'); expect(consoleEventLevel('log')).toBe('log'); expect(consoleEventLevel('warn')).toBe('warning'); expect(consoleEventLevel('error')).toBe('error'); });
