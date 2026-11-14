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
function markdown(onFeedback?: typeof fixture.feedback, text = '```ts\nhello\n```') {
  const message = SessionMessage({ message: { id: 'm', role: 'assistant', text }, onActionFeedback: onFeedback });
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
it('keeps the code copy icon intact and confirms success through its title without a toast', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('HTMLImageElement', class {});
  vi.stubGlobal('window', { setTimeout });
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  const button = { disabled: false, textContent: '', title: 'Copy code', isConnected: true, parentElement: { querySelector: () => ({ textContent: 'hello' }) } };
  markdown().props.onClick({ target: { closest: (selector: string) => selector === '.cli-code-copy' ? button : null } });
  await Promise.resolve(); await Promise.resolve();
  expect(button.title).toBe('Copied'); expect(button.textContent).toBe(''); expect(button.disabled).toBe(false); expect(fixture.feedback).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1500); expect(button.title).toBe('Copy code');
});
it('renders safe keyboard-operable inline copy controls while preserving linked code and fenced blocks', () => {
  const html = markdown(undefined, 'Copy `admin@example.test`, `a < b & "quoted"`, and [`linked`](https://example.test).\n\n```ts\nblock\n```').props.dangerouslySetInnerHTML.__html;
  expect(html).toContain('type="button" class="cli-inline-code-copy"');
  expect(html).toContain('aria-label="Copy admin@example.test"');
  expect(html).toContain('a &lt; b &amp; &quot;quoted&quot;');
  expect(html.match(/class="cli-inline-code-copy"/g)).toHaveLength(2);
  expect(html).toContain('<code>linked</code></a>');
  expect(html).toContain('class="cli-code-copy cli-code-copy-float"');
  expect(html).toContain('title="Copy code"><svg');
});
it('copies exact inline text silently, blocks pending duplicates, and allows another copy', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('HTMLImageElement', class {});
  vi.stubGlobal('window', { setTimeout });
  let resolveCopy!: () => void;
  const writeText = vi.fn(() => new Promise<void>(resolve => { resolveCopy = resolve; }));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const button = { disabled: false, title: 'Copy text', isConnected: true, classList: { add: vi.fn(), remove: vi.fn() }, querySelector: () => ({ textContent: 'admin@example.test' }) };
  const control = markdown();
  const event = { target: { closest: (selector: string) => selector === '.cli-inline-code-copy' ? button : null } };
  control.props.onClick(event); control.props.onClick(event);
  expect(writeText).toHaveBeenCalledExactlyOnceWith('admin@example.test');
  resolveCopy(); await Promise.resolve(); await Promise.resolve();
  expect(button.title).toBe('Copy text'); expect(button.querySelector().textContent).toBe('admin@example.test');
  expect(button.disabled).toBe(false);
  expect(button.classList.add).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  control.props.onClick(event);
  expect(writeText).toHaveBeenCalledTimes(2);
  resolveCopy(); await Promise.resolve(); await Promise.resolve();
  expect(fixture.feedback).not.toHaveBeenCalled();
});
it('silently handles inline clipboard failure and allows retry', async () => {
  vi.stubGlobal('HTMLImageElement', class {});
  const writeText = vi.fn().mockRejectedValue(new Error('denied'));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  vi.stubGlobal('document', { createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove() {} }), body: { appendChild() {} }, execCommand: () => false });
  const button = { disabled: false, classList: { remove: vi.fn() }, querySelector: () => ({ textContent: '<admin@example.test>' }) };
  const control = markdown();
  const event = { target: { closest: (selector: string) => selector === '.cli-inline-code-copy' ? button : null } };
  control.props.onClick(event);
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  expect(fixture.feedback).not.toHaveBeenCalled();
  expect(button.querySelector().textContent).toBe('<admin@example.test>');
  writeText.mockResolvedValue(undefined);
  control.props.onClick(event);
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  expect(writeText).toHaveBeenCalledTimes(2);
  expect(fixture.feedback).not.toHaveBeenCalled();
});
