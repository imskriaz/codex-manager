import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { VNode } from 'preact';
vi.mock('preact/hooks', () => ({ useState: vi.fn((value: unknown) => [value, vi.fn()]), useRef: (value: unknown) => ({ current: value ?? null }), useId: () => 'composer-fixture', useLayoutEffect: () => undefined, useEffect: () => undefined }));
import { useState } from 'preact/hooks';
import { ProjectPicker } from '../webview-src/dashboard/projectPicker';
import { Composer, QueuedMessages, TurnUsageStrip } from '../webview-src/dashboard/cliSessionsModal';
import { VoiceDictation } from '../webview-src/dashboard/voiceDictation';
function nodes(node: unknown): VNode<any>[] { if (Array.isArray(node)) return node.flatMap(nodes); if (!node || typeof node !== 'object' || !('props' in node)) return []; const value = node as VNode<any>; return [value, ...nodes(value.props.children)]; }

it('keeps unsupported thinking visible without changing the model or hiding the saved preference', () => {
  vi.mocked(useState).mockReturnValueOnce([false, vi.fn()]).mockReturnValueOnce([[], vi.fn()]).mockReturnValueOnce([true, vi.fn()]);
  const config: Parameters<typeof Composer>[0] = { attachments: [], attachmentReading: false, draft: '', projects: [], model: 'selected', reasoningEffort: 'xhigh', models: [{ id: 'selected', label: 'Selected', reasoningEfforts: ['medium'] }], reasoningOptions: ['medium'], sending: false, stopping: false, composerHeight: 160,
    onFeedback() {}, onAttach() {}, onRemoveAttachment() {}, onDraft() {}, onModel() {}, onReasoning() {}, onSandbox() {}, onProject() {}, onSubmit() {}, onStop() {}, onResize() {}, onResizeKeyDown() {} };
  const tree = nodes(Composer(config));
  expect(tree.find(node => node.type === 'select' && node.props.name === 'model')?.props.value).toBe('selected');
  expect(tree.find(node => node.type === 'select' && node.props.name === 'reasoning-effort')?.props.value).toBe('xhigh');
  expect(tree.find(node => node.type === 'option' && node.props.value === 'xhigh')?.props.children).toContain(' (not supported)');
});

it('keeps the entered local project name when session discovery supplies its internal folder name', () => {
  const path = 'D:/workspace/Local-720e12a6-9647-4170-a789-001bd78538f1';
  vi.mocked(useState).mockReturnValueOnce([false, vi.fn()]).mockReturnValueOnce([[{ path, label: 'My project' }], vi.fn()]);
  const config: Parameters<typeof Composer>[0] = { attachments: [], attachmentReading: false, draft: '', projects: [{ path, label: 'Local-720e12a6-9647-4170-a789-001bd78538f1' }], projectPath: path, simple: true, models: [], reasoningOptions: [], sending: false, stopping: false, composerHeight: 160,
    onFeedback() {}, onAttach() {}, onRemoveAttachment() {}, onDraft() {}, onModel() {}, onReasoning() {}, onSandbox() {}, onProject() {}, onSubmit() {}, onStop() {}, onResize() {}, onResizeKeyDown() {} };
  const picker = nodes(Composer(config)).find(node => node.type === ProjectPicker)!;
  expect(picker.props.projects).toEqual([{ path, label: 'My project' }]);
  expect(picker.props.title).toBe('My project');
});

it('appends browser speech to the current textarea without losing edits or dropping successive segments', () => {
  const onDraft = vi.fn(), onFeedback = vi.fn();
  const config: Parameters<typeof Composer>[0] = { attachments: [], attachmentReading: false, draft: 'Saved draft', projects: [], models: [], reasoningOptions: [], sending: false, stopping: false, composerHeight: 160,
    onFeedback, onAttach() {}, onRemoveAttachment() {}, onDraft, onModel() {}, onReasoning() {}, onSandbox() {}, onProject() {}, onSubmit() {}, onStop() {}, onResize() {}, onResizeKeyDown() {} };
  const tree = nodes(Composer(config));
  const input = tree.find(node => node.type === 'textarea')!;
  const textarea = { value: 'Edited draft', focus: vi.fn() };
  (input.ref as { current: unknown }).current = textarea;
  const voice = tree.find(node => node.type === VoiceDictation)!;
  expect(voice.props.onText('বাংলা')).toBe(true);
  expect(voice.props.onText('日本語')).toBe(true);
  expect(onDraft).toHaveBeenLastCalledWith("Edited draft\n\u09ac\u09be\u0982\u09b2\u09be\n\u65e5\u672c\u8a9e");
  textarea.value = 'x'.repeat(64_000);
  expect(voice.props.onText('More')).toBe(false);
  expect(onFeedback).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning' }));
  expect(textarea.value).toHaveLength(64_000);
});

it('keeps queue rows collapsed with error details on the warning icon', () => {
  const tree = nodes(QueuedMessages({ queue: {
    items: [{ id: 'failed-send', state: 'failed', draft: { text: 'Keep this prompt', attachments: [] }, error: 'The owner disconnected.', createdAt: 0, seenIds: [] }],
    ready: true, connected: true, reason: 'Waiting for the current turn to finish.',
  } as Parameters<typeof QueuedMessages>[0]['queue'], onRefresh() {} }));
  expect(tree.find(node => node.type === 'details')?.props.open).toBeUndefined();
  expect(tree.find(node => node.props.role === 'alert')?.props.title).toBe('The owner disconnected.');
  expect(tree.find(node => node.props.class === 'cli-queued-message-error')?.props.children).toBe('The owner disconnected.');
  expect(tree.some(node => node.props.title === 'Expand message, attachments, and error details')).toBe(true);
  expect(tree.some(node => node.props.role === 'status')).toBe(false);
  expect(tree.some(node => node.props['aria-label'] === 'Resend queued message')).toBe(true);
});

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
  const sending = nodes(Composer({ ...config, draft: 'Send immediately', resuming: true, stopping: true }));
  expect(sending.find(node => node.type === 'button' && node.props.type === 'submit')?.props.disabled).toBe(false);
});

it('shows one Auto label for automatic composers while preserving resolved thinking values', () => {
  const config: Parameters<typeof Composer>[0] = { attachments: [], attachmentReading: false, draft: '', projects: [], models: [], reasoningOptions: [], sending: false, stopping: false, composerHeight: 160,
    onFeedback() {}, onAttach() {}, onRemoveAttachment() {}, onDraft() {}, onModel() {}, onReasoning() {}, onSandbox() {}, onProject() {}, onSubmit() {}, onStop() {}, onResize() {}, onResizeKeyDown() {} };
  for (const autoLocked of [false, true]) {
    const props = { ...config, simple: true, automaticModels: true, autoLocked, model: 'auto', models: [{ id: 'auto', label: 'Auto', reasoningEfforts: [] }] };
    const automatic = nodes(Composer(props));
    expect(automatic.find(node => node.props.class === 'cli-composer-model')?.props.children).toBe('Auto');
    expect(automatic.some(node => node.props.class === 'cli-composer-effort')).toBe(false);
    const explicitAuto = nodes(Composer({ ...props, automaticThinking: 'auto' }));
    expect(explicitAuto.some(node => node.props.class === 'cli-composer-effort')).toBe(false);
    const profiled = nodes(Composer({ ...props, automaticProfile: 'regular', automaticThinking: 'low' }));
    expect(profiled.find(node => node.props.class === 'cli-composer-model')?.props.children).toBe('Regular');
    expect(profiled.find(node => node.props.class === 'cli-composer-effort')?.props.children).toBe('Low');
    const thinking = nodes(Composer({ ...props, automaticThinking: 'high' }));
    expect(thinking.find(node => node.props.class === 'cli-composer-effort')?.props.children).toBe('High');
  }
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

it('keeps routine results quiet while showing task form failures inline', () => {
  const source = readFileSync('webview-src/dashboard/cliSessionsModal.tsx', 'utf8');
  const tasks = readFileSync('webview-src/dashboard/taskBoard.tsx', 'utf8');
  expect(source).not.toContain('projectNotice');
  expect(source).toContain('onFeedback={props.onFeedback} onCreated=');
  expect(source).toContain("if (props.notice && props.notice.level !== 'info') feedback.current(props.notice)");
  expect(source).not.toContain('{props.notice.message}</div>');
  expect(source).not.toContain('>{props.feedback.message}');
  expect(source).toContain('onClick={props.onRetryFeedback}>Retry</button>');
  expect(tasks).not.toContain('task-inline-feedback');
  expect(tasks).toContain("status && (statusLevel === 'info' || props.shared || !props.onActionFeedback) ? createPortal");
  expect(tasks).toContain("status && statusLevel !== 'info' ? <p class=\"settings-note\" role=\"alert\">{status}</p>");
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
  expect(source.match(/<SessionAccountFooter [^>]*onFeedback={props.onActionFeedback}/g)).toHaveLength(2);
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

it('shows Stop only without a follow-up draft or attachments, with pending and connection guards', () => {
  const onStop = vi.fn();
  const config: Parameters<typeof Composer>[0] = { attachments: [], attachmentReading: false, draft: '', projects: [], models: [], reasoningOptions: [], sending: true, stopping: false, stopDisabled: false, composerHeight: 160,
    onFeedback() {}, onAttach() {}, onRemoveAttachment() {}, onDraft() {}, onModel() {}, onReasoning() {}, onSandbox() {}, onProject() {}, onSubmit() {}, onStop, onResize() {}, onResizeKeyDown() {} };
  for (const state of [{ draft: '' }, { draft: 'Follow up' }, { draft: '', attachments: [{ id: 'note', name: 'note.txt', kind: 'text' as const, mimeType: 'text/plain', size: 4, data: 'test' }] }]) {
    const tree = nodes(Composer({ ...config, ...state }));
    const stop = tree.find(node => node.props['aria-label'] === 'Stop')!;
    const hasMessage = Boolean(state.draft || state.attachments?.length);
    expect(Boolean(stop)).toBe(!hasMessage);
    expect(tree.some(node => node.type === 'button' && node.props.type === 'submit')).toBe(hasMessage);
    if (stop) { expect(stop.props.disabled).toBe(false); stop.props.onClick(); }
  }
  expect(onStop).toHaveBeenCalledTimes(1);
  for (const state of [{ stopping: true }, { stopDisabled: true }]) {
    const stop = nodes(Composer({ ...config, ...state })).find(node => node.props.class === 'cli-stop-button')!;
    expect(stop.props.disabled).toBe(true);
  }
  for (const file of ['cliSessionsModal.tsx', 'taskSessionConversation.tsx']) {
    const source = readFileSync(`webview-src/dashboard/${file}`, 'utf8');
    expect(source).toMatch(/stopDisabled=\{(?:props.connected === false|!props.connected)\}/);
  }
});
