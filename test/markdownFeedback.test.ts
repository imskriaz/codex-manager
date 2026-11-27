import { readFileSync } from 'node:fs';
import type { VNode } from 'preact';
import { afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ feedback: vi.fn(), links: undefined as Record<string, unknown> | undefined }));
vi.mock('preact/hooks', () => ({
  useContext: () => fixture.links ?? fixture.feedback,
  useMemo: (compute: () => unknown) => compute(),
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (value: unknown) => ({ current: value }),
  useEffect() {}, useLayoutEffect() {}, useId: () => 'markdown-fixture'
}));
import { isDownloadLink, isInternalWorkspaceLink, MarkdownPreview, SessionMessage } from '../webview-src/dashboard/cliSessionsModal';
function nodes(node: unknown): VNode<any>[] { if (Array.isArray(node)) return node.flatMap(nodes); if (!node || typeof node !== 'object' || !('props' in node)) return []; const value = node as VNode<any>; return [value, ...nodes(value.props.children)]; }
function markdown(onFeedback?: typeof fixture.feedback, text = '```ts\nhello\n```') {
  const message = SessionMessage({ message: { id: 'm', role: 'assistant', text }, onActionFeedback: onFeedback });
  const component = nodes(message).find(node => typeof node.type === 'function' && node.type.name === 'MarkdownMessage')!;
  return nodes((component.type as (props: any) => VNode<any>)(component.props)).find(node => node.props.class === 'cli-message-markdown')!;
}
afterEach(() => { fixture.links = undefined; fixture.feedback.mockReset(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('classifies remote workspace and download links before external links', () => {
  const anchor = { hasAttribute: (name: string) => name === 'download', textContent: 'Download report' };
  expect(isInternalWorkspaceLink('/reports/latest')).toBe(false);
  expect(isInternalWorkspaceLink('http://127.0.0.1:3000/reports/latest')).toBe(true);
  expect(isInternalWorkspaceLink('https://example.com/reports/latest')).toBe(false);
  expect(isDownloadLink(anchor, 'https://example.com/reports/latest')).toBe(true);
  expect(isDownloadLink({ hasAttribute: () => false, textContent: 'Open page' }, 'https://example.com/page')).toBe(false);
});
it.each(['http://localhost:5173', 'https://app.localhost:3000', 'http://127.12.0.1:8080', 'http://[::1]:3000'])('keeps loopback URL %s in the workspace Browser', href => {
  expect(isInternalWorkspaceLink(href)).toBe(true);
});
it.each(['https://example.com', 'http://192.168.1.2', 'http://10.0.0.2', 'http://172.16.0.2', 'https://localhost.example.com', '//example.com', 'javascript:alert(1)'])('does not automatically put %s in the right panel', href => {
  expect(isInternalWorkspaceLink(href)).toBe(false);
});
it.each([
  ['https://example.com/help', null, false, 'external'],
  ['http://localhost:5173', null, false, 'internal'],
  ['https://example.com/preview', 'workspace-browser', false, 'internal'],
  ['https://example.com/ai-tab', null, true, 'internal'],
  ['https://example.com/help', 'ordinary title', false, 'external']
])('routes clicked session URL %s to %s', (href, title, aiPage, destination) => {
  const external = vi.fn(), openInternal = vi.fn(), download = vi.fn();
  fixture.links = { external, openInternal, download, browserNeeded: () => aiPage };
  const link = { href, textContent: 'Open page', hasAttribute: () => false, getAttribute: () => title };
  const preventDefault = vi.fn();
  markdown().props.onClick({ preventDefault, target: { closest: (selector: string) => selector === 'a[href]' ? link : null } });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(destination === 'external' ? external : openInternal).toHaveBeenCalledExactlyOnceWith(href);
  expect(destination === 'external' ? openInternal : external).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
});
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
  expect(source).toContain('<MarkdownPreview content={draft} fileLinks=');
});

it('opens and downloads Markdown file links in their workspace and sends external URLs to the host', () => {
  const open = vi.fn(), download = vi.fn(), feedback = vi.fn(), external = vi.fn();
  fixture.links = { external };
  const preview = MarkdownPreview({ content: '[Guide](guide.md)', fileLinks: { documentPath: 'docs/README.md', download }, onOpenFile: open, onFeedback: feedback });
  const component = nodes(preview).find(node => typeof node.type === 'function' && node.type.name === 'MarkdownMessage')!;
  const control = nodes((component.type as (props: any) => VNode<any>)(component.props)).find(node => node.props.class === 'cli-message-markdown')!;
  const clickFile = (workspaceFile: string, download = false) => control.props.onClick({
    preventDefault: vi.fn(),
    target: { closest: () => ({ dataset: { workspaceFile }, hasAttribute: () => download }) }
  });
  clickFile('guide.md');
  clickFile('../CHANGELOG.md');
  clickFile('archive.zip', true);
  clickFile('../../outside.md');
  expect(open.mock.calls).toEqual([['docs/guide.md'], ['CHANGELOG.md']]);
  expect(download).toHaveBeenCalledExactlyOnceWith('docs/archive.zip');
  expect(feedback).toHaveBeenCalledExactlyOnceWith({ level: 'warning', message: 'This link points outside the workspace project.' });
  control.props.onClick({ preventDefault: vi.fn(), target: { closest: (selector: string) =>
    selector === 'a[href]' ? { href: 'https://example.com/releases', getAttribute: () => null, hasAttribute: () => false, textContent: 'Latest release' } : null
  } });
  expect(external).toHaveBeenCalledExactlyOnceWith('https://example.com/releases');
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
