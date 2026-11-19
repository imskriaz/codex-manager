import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as Array<() => void> }));
vi.mock('preact/hooks', () => ({
  useState(initial: unknown) { const i = fixture.cursor++; fixture.slots[i] ??= { value: initial }; return [fixture.slots[i].value, (next: any) => { fixture.slots[i].value = typeof next === 'function' ? next(fixture.slots[i].value) : next; }]; },
  useRef(initial: unknown) { const i = fixture.cursor++; return fixture.slots[i] ??= { current: initial }; },
  useEffect(setup: () => void | (() => void)) { const i = fixture.cursor++; if (fixture.slots[i]) return; fixture.slots[i] = {}; fixture.effects.push(() => { fixture.slots[i].cleanup = setup(); }); }
}));
import { useSharedImportModal } from '../webview-src/dashboard/sharedImportHook';
class Reader {
  static all: Reader[] = [];
  result: string | null = null;
  readyState = 0;
  onload: null | (() => void) = null;
  onerror: null | (() => void) = null;
  onabort: null | (() => void) = null;
  readAsText = vi.fn(() => { this.readyState = 1; });
  abort = vi.fn(() => { this.readyState = 2; this.onabort?.(); });
  constructor() { Reader.all.push(this); }
  finish(text: string) { this.result = text; this.readyState = 2; this.onload?.(); }
}
const sendAction = vi.fn();
const params = { sendAction, importJsonFileReadError: 'Could not read JSON file.' };
function render() { fixture.cursor = 0; const hook = useSharedImportModal(params); fixture.effects.splice(0).forEach(effect => effect()); return hook; }
function select() { render().handleImportFileSelected({} as File); return Reader.all.at(-1)!; }
beforeEach(() => { vi.useFakeTimers(); fixture.slots = []; fixture.cursor = 0; fixture.effects = []; Reader.all = []; sendAction.mockReset(); vi.stubGlobal('FileReader', Reader); });
afterEach(() => { fixture.slots.forEach(slot => slot.cleanup?.()); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('accepts only the newest selected file, including already queued stale callbacks', () => {
  const first = select(), staleLoad = first.onload!, staleError = first.onerror!;
  const second = select();
  expect(first.abort).toHaveBeenCalledOnce();
  second.finish('{"new":true}'); first.result = '{"old":true}'; staleLoad(); staleError();
  expect(render().importJsonText).toBe('{"new":true}'); expect(render().importJsonError).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['manual edit', 'clear feedback', 'unmount'])('invalidates a pending read on %s', reason => {
  render().handleImportTextChange('kept draft');
  const reader = select(), staleLoad = reader.onload!, staleError = reader.onerror!;
  if (reason === 'manual edit') render().handleImportTextChange('manual JSON');
  else if (reason === 'clear feedback') render().clearImportFeedback();
  else fixture.slots.forEach(slot => slot.cleanup?.());
  const before = fixture.slots.map(slot => slot.value);
  reader.result = 'late JSON'; staleLoad(); staleError();
  expect(fixture.slots.map(slot => slot.value)).toEqual(before);
  expect(render().importJsonText).toBe(reason === 'manual edit' ? 'manual JSON' : 'kept draft');
  expect(reader.abort).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('bounds a stalled read, preserves the draft, reports failure, and ignores late completion', () => {
  render().handleImportTextChange('preserve me'); const reader = select(), lateLoad = reader.onload!;
  vi.advanceTimersByTime(15000);
  expect(render().importJsonError).toBe(params.importJsonFileReadError);
  expect(render().importJsonText).toBe('preserve me'); expect(reader.abort).toHaveBeenCalledOnce();
  reader.result = 'late'; lateLoad(); expect(render().importJsonText).toBe('preserve me');
  const retry = select(); retry.finish('retry JSON');
  expect(render().importJsonText).toBe('retry JSON'); expect(render().importJsonError).toBeUndefined();
});
it.each(['error', 'abort', 'throw'])('surfaces %s read failure and clears its timeout', failure => {
  if (failure === 'throw') {
    vi.stubGlobal('FileReader', class extends Reader { readAsText = vi.fn(() => { throw new Error('Cannot read'); }); });
  }
  const reader = select();
  if (failure === 'error') reader.onerror!();
  if (failure === 'abort') { reader.readyState = 2; reader.onabort!(); }
  expect(render().importJsonError).toBe(params.importJsonFileReadError); expect(vi.getTimerCount()).toBe(0);
});
