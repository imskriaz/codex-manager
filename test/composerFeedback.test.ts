import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { VNode } from 'preact';
vi.mock('preact/hooks', () => ({ useState: (value: unknown) => [value, vi.fn()], useRef: (value: unknown) => ({ current: value ?? null }), useId: () => 'composer-fixture', useLayoutEffect: () => undefined, useEffect: () => undefined }));
import { Composer, TurnUsageStrip } from '../webview-src/dashboard/cliSessionsModal';
function nodes(node: unknown): VNode<any>[] { if (Array.isArray(node)) return node.flatMap(nodes); if (!node || typeof node !== 'object' || !('props' in node)) return []; const value = node as VNode<any>; return [value, ...nodes(value.props.children)]; }

it('keeps the composer stable without status rows or connection placeholders', () => {
  const config: Parameters<typeof Composer>[0] = { attachments: [], attachmentReading: false, draft: '', projects: [], models: [], reasoningOptions: [], sending: false, stopping: false, composerHeight: 160,
    onFeedback() {}, onAttach() {}, onRemoveAttachment() {}, onDraft() {}, onModel() {}, onReasoning() {}, onSandbox() {}, onProject() {}, onSubmit() {}, onStop() {}, onResize() {}, onResizeKeyDown() {} };
  for (const level of ['info', 'warning', 'error'] as const) {
    const tree = nodes(Composer({ ...config, feedback: { level, message: 'Current action feedback' } }));
    expect(tree.find(node => node.type === 'textarea')?.props.placeholder).toBe('Message Codex…');
    expect(tree.some(node => node.props.class?.includes('cli-composer-state'))).toBe(false);
    expect(tree.some(node => node.props.role === 'alert')).toBe(false);
  }
  expect(nodes(Composer({ ...config, unavailableReason: 'Reconnecting…' })).find(node => node.type === 'textarea')?.props.placeholder).toBe('Message Codex…');
});

it('exposes Queue and Steer follow-up modes in Message settings', () => {
  const source = readFileSync('webview-src/dashboard/cliSessionsModal.tsx', 'utf8');
  expect(source).toContain('aria-label="Follow-up mode"');
  expect(source).toContain('value="queue">Queue until turn completes');
  expect(source).toContain('value="steer">Steer now');
  expect(source).toContain('class="cli-turn-account-name"');
  expect(source).not.toContain('value="auto-approve">Auto approve');
  expect(source).toContain('class="cli-approval-control"');
  expect(source).toContain('type="checkbox" aria-label="Auto approve"');
});

it('uses task context without account placeholders and preserves changed-file actions', () => {
  const open = vi.fn();
  const tree = nodes(TurnUsageStrip({ privacyMode: true, contextLabel: 'Review task', changedFiles: 2, additions: 5, deletions: 1, onOpenChanges: open }));
  expect(tree.find(node => node.props.class === 'cli-turn-context')?.props.children).toBe('Review task');
  expect(tree.some(node => node.props.class === 'cli-turn-account' || node.props.class === 'cli-turn-quota')).toBe(false);
  tree.find(node => node.props['aria-label'] === 'View 2 changed files')?.props.onClick();
  expect(open).toHaveBeenCalledOnce();
  expect(nodes(TurnUsageStrip({ privacyMode: true, onOpenChanges: open })).some(node => node.props.class === 'cli-turn-context')).toBe(false);
});

it('keeps the mobile account name from being squeezed out by quota metadata', () => {
  const css = readFileSync('media/webview/quotaSummary.css', 'utf8');
  expect(css).toContain('.cli-turn-usage-strip .cli-turn-account:has(.cli-turn-account-name) { max-width: none; }');
  expect(css).toContain('@media (max-width: 420px)');
  expect(css).toContain('max-width: min(54vw, 220px);');
  expect(css).toContain('.cli-turn-usage-strip .cli-turn-quota { gap: 5px; }');
});

it('routes transient project and file results through feedback without inline notices', () => {
  const source = readFileSync('webview-src/dashboard/cliSessionsModal.tsx', 'utf8');
  const tasks = readFileSync('webview-src/dashboard/taskBoard.tsx', 'utf8');
  expect(source).not.toContain('projectNotice');
  expect(source).toContain('onFeedback={props.onFeedback} onCreated=');
  expect(source).toContain("if (props.notice && props.notice.level !== 'info') feedback.current(props.notice)");
  expect(source).not.toContain('{props.notice.message}</div>');
  expect(source).not.toContain('>{props.feedback.message}');
  expect(source).toContain('onClick={props.onRetryFeedback}>Retry</button>');
  expect(tasks).not.toContain('task-inline-feedback');
  expect(tasks).toContain("status && statusLevel !== 'info' && (props.shared || !props.onActionFeedback) ? createPortal");
  expect(tasks).not.toContain('{status}</p>');
});

it('keeps task agent views mounted and cached messages available through refresh', () => {
  const source = readFileSync('webview-src/dashboard/taskBoard.tsx', 'utf8');
  expect(source).toContain(`hidden={tab !== 'agents'} class="task-detail-scroll cli-workspace cli-message-surface cli-agent-panel"`);
  expect(source).toContain("<TaskAgents active={tab === 'agents'}");
  expect(source).toContain('<AgentWorkspace active={active}');
  expect(source).toContain('messages: data[mainKey]?.messages ?? messages');
  expect(source).toContain("if (!next) throw new Error('Agent messages were not returned. Retry refresh.')");
  expect(source).not.toContain('Agent messages updated.');
});

it('keeps account center resize success and cancellation silent while reporting storage failure', () => {
  const source = readFileSync('webview-src/dashboard/cliSessionsModal.tsx', 'utf8');
  expect(source.match(/<SessionAccountFooter onFeedback={props.onActionFeedback}/g)).toHaveLength(2);
  expect(source).not.toContain('sizeNotice');
  expect(source).not.toContain('Size saved');
  expect(source).not.toContain('Resize cancelled');
  expect(source).toContain("props.onFeedback({ level: 'warning', message: 'Size changed for this tab. Browser storage could not remember it.' })");
});

 it('keeps workspace connection recovery compact and reloads the page', () => {
  const source = readFileSync('webview-src/dashboard/main.tsx', 'utf8');
  const banner = source.slice(source.indexOf('function WorkspaceConnectionBanner('), source.indexOf('function sortAccounts('));
  expect(banner).toContain('Connection interrupted');
  expect(banner).toContain('onClick={props.onReload}>Reload</button>');
  expect(banner).not.toContain('<small>');
  expect(source.match(/onReload=\{\(\) => window.location.reload\(\)\}/g)).toHaveLength(2);
  expect(source).toContain("notice && notice.level !== 'info'");
});
