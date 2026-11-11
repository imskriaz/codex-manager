import { afterEach, expect, it, vi } from 'vitest';
const effects = vi.hoisted(() => [] as Array<() => void>);
vi.mock('preact/hooks', () => ({ useRef: (current: unknown) => ({ current }), useLayoutEffect: (effect: () => void) => { effects.push(effect); } }));
import { useModalAccessibility } from '../webview-src/dashboard/primitives';
afterEach(() => { effects.splice(0); vi.unstubAllGlobals(); });
it('lets an open child menu handle Escape before closing its dialog', () => {
  vi.stubGlobal('document', { querySelectorAll: () => [{ getClientRects: () => [{}] }] });
  const close = vi.fn(), stopPropagation = vi.fn(), preventDefault = vi.fn();
  useModalAccessibility(true, close).onKeyDown({ key: 'Escape', stopPropagation, preventDefault } as unknown as KeyboardEvent);
  expect(close).not.toHaveBeenCalled(); expect(stopPropagation).not.toHaveBeenCalled(); expect(preventDefault).not.toHaveBeenCalled();
});
it('closes the dialog once its child menu is gone, ignoring hidden menus', () => {
  vi.stubGlobal('document', { querySelectorAll: () => [{ getClientRects: () => [] }] });
  const close = vi.fn();
  useModalAccessibility(true, close).onKeyDown({ key: 'Escape', stopPropagation() {}, preventDefault() {} } as KeyboardEvent);
  expect(close).toHaveBeenCalledOnce();
});

it('lets another focused dialog own Escape even when its portal appears earlier in DOM order', () => {
  class Target { closest() { return {}; } }
  vi.stubGlobal('Element', Target);
  let capture: ((event: KeyboardEvent) => void) | undefined;
  vi.stubGlobal('document', { addEventListener: (_type: string, listener: typeof capture) => { capture = listener; }, removeEventListener() {}, querySelectorAll: () => [] });
  const close = vi.fn(), accessibility = useModalAccessibility(true, close);
  accessibility.modalRef.current = { contains: () => false } as unknown as HTMLDivElement;
  effects[1]!();
  const stopPropagation = vi.fn(), preventDefault = vi.fn();
  capture!({ key: 'Escape', target: new Target(), stopPropagation, preventDefault } as unknown as KeyboardEvent);
  expect(close).not.toHaveBeenCalled(); expect(stopPropagation).not.toHaveBeenCalled(); expect(preventDefault).not.toHaveBeenCalled();
});
it('still routes Escape from body to the last visible dialog', () => {
  class Target { closest() { return null; } }
  vi.stubGlobal('Element', Target);
  let capture: ((event: KeyboardEvent) => void) | undefined;
  const modal = { contains: () => false, getClientRects: () => [{}] };
  vi.stubGlobal('document', { addEventListener: (_type: string, listener: typeof capture) => { capture = listener; }, removeEventListener() {}, querySelectorAll: (selector: string) => selector.includes('dialog') ? [modal] : [] });
  const close = vi.fn(), accessibility = useModalAccessibility(true, close);
  accessibility.modalRef.current = modal as unknown as HTMLDivElement;
  effects[1]!();
  capture!({ key: 'Escape', target: new Target(), stopPropagation() {}, preventDefault() {} } as unknown as KeyboardEvent);
  expect(close).toHaveBeenCalledOnce();
});
