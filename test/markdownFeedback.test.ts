import { readFileSync } from 'node:fs';
import type { VNode } from 'preact';
import { afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ feedback: vi.fn() }));
vi.mock('preact/hooks', () => ({
  useContext: () => fixture.feedback,
  useMemo: (compute: () => unknown) => compute(),
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
  useEffect() {}, useLayoutEffect() {}, useId: () => 'markdown-fixture'
}));
import { SessionMessage } from '../webview-src/dashboard/cliSessionsModal';
function nodes(node: unknown): VNode<any>[] { if (Array.isArray(node)) return node.flatMap(nodes); if (!node || typeof node !== 'object' || !('props' in node)) return []; const value = node as VNode<any>; return [value, ...nodes(value.props.children)]; }
function markdown(onFeedback?: typeof fixture.feedback) {
  const message = SessionMessage({ message: { id: 'm', role: 'assistant', text: '```ts\nhello\n```' }, onActionFeedback: onFeedback });
  const component = nodes(message).find(node => typeof node.type === 'function' && node.type.name === 'MarkdownMessage')!;
  return nodes((component.type as (props: any) => VNode<any>)(component.props)).find(node => node.props.class === 'cli-message-markdown')!;
}
afterEach(() => { fixture.feedback.mockReset(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('reports failed Markdown clipboard fallback through the initiating feedback callback', async () => {
  const direct = vi.fn();
  vi.stubGlobal('HTMLImageElement', class {});
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
  const remove = vi.fn();
  vi.stubGlobal('document', { createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove }), body: { appendChild() {} }, execCommand: () => false });
  const button = { disabled: false, parentElement: { querySelector: () => ({ textContent: 'hello' }) } };
  markdown(direct).props.onClick({ target: { closest: (selector: string) => selector === '.cli-code-copy' ? button : null } });
  await vi.waitFor(() => expect(direct).toHaveBeenCalledWith({ level: 'error', message: 'Code could not be copied. Select the code and copy it manually.' }));
  expect(button.disabled).toBe(false); expect(remove).toHaveBeenCalledOnce(); expect(fixture.feedback).not.toHaveBeenCalled();
});
it('uses scoped transcript feedback for unsupported links without adding an inline banner', () => {
  const preventDefault = vi.fn();
  markdown().props.onClick({ preventDefault, target: { closest: () => ({ dataset: { workspaceFile: '/file.ts' } }) } });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(fixture.feedback).toHaveBeenCalledWith({ level: 'warning', message: 'Open this conversation in its workspace to view this file.' });
  const source = readFileSync('webview-src/dashboard/cliSessionsModal.tsx', 'utf8');
  expect(source).not.toContain('cli-code-copy-feedback');
  expect(source).toContain('<SessionFeedbackContext.Provider value={onActionFeedback}>');
  expect(source).toContain('<SessionFeedbackContext.Provider value={feedback}><ActivityMessage');
  expect(source).toContain('<MarkdownPreview content={draft} onFeedback={props.onFeedback} />');
});
it('shows successful copy on the existing button without an informational toast', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('HTMLImageElement', class {});
  vi.stubGlobal('window', { setTimeout });
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  const button = { disabled: false, textContent: 'Copy code', isConnected: true, parentElement: { querySelector: () => ({ textContent: 'hello' }) } };
  markdown().props.onClick({ target: { closest: (selector: string) => selector === '.cli-code-copy' ? button : null } });
  await Promise.resolve(); await Promise.resolve();
  expect(button.textContent).toBe('Copied'); expect(button.disabled).toBe(false); expect(fixture.feedback).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1500); expect(button.textContent).toBe('Copy code');
});
