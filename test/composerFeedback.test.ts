import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { VNode } from 'preact';
vi.mock('preact/hooks', () => ({ useState: (value: unknown) => [value, vi.fn()], useRef: (value: unknown) => ({ current: value ?? null }), useId: () => 'composer-fixture', useLayoutEffect: () => undefined, useEffect: () => undefined }));
import { Composer, TurnUsageStrip } from '../webview-src/dashboard/cliSessionsModal';
function nodes(node: unknown): VNode<any>[] { if (Array.isArray(node)) return node.flatMap(nodes); if (!node || typeof node !== 'object' || !('props' in node)) return []; const value = node as VNode<any>; return [value, ...nodes(value.props.children)]; }

it('keeps the composer stable without status rows or connection placeholders', () => {
  const config: Parameters<typeof Composer>[0] = { attachments: [], attachmentReading: false, draft: '', projects: [], models: [], reasoningOptions: [], sending: false, stopping: false, composerHeight: 160,
    onAttach() {}, onRemoveAttachment() {}, onDraft() {}, onModel() {}, onReasoning() {}, onSandbox() {}, onProject() {}, onSubmit() {}, onStop() {}, onResize() {}, onResizeKeyDown() {} };
  for (const level of ['info', 'warning', 'error'] as const) {
    const tree = nodes(Composer({ ...config, feedback: { level, message: 'Current action feedback' } }));
    expect(tree.find(node => node.type === 'textarea')?.props.placeholder).toBe('Message Codex…');
    expect(tree.some(node => node.props.class?.includes('cli-composer-state'))).toBe(false);
  }
  expect(nodes(Composer({ ...config, unavailableReason: 'Reconnecting…' })).find(node => node.type === 'textarea')?.props.placeholder).toBe('Message Codex…');
});

it('exposes Queue and Steer follow-up modes in Message settings', () => {
  const source = readFileSync('webview-src/dashboard/cliSessionsModal.tsx', 'utf8');
  expect(source).toContain('aria-label="Follow-up mode"');
  expect(source).toContain('value="queue">Queue until turn completes');
  expect(source).toContain('value="steer">Steer now');
  expect(source).toContain('class="cli-turn-account-name"');
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
