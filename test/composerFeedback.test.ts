import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { VNode } from 'preact';
vi.mock('preact/hooks', () => ({ useState: (value: unknown) => [value, vi.fn()], useRef: (value: unknown) => ({ current: value ?? null }), useId: () => 'composer-fixture', useLayoutEffect: () => undefined, useEffect: () => undefined }));
import { Composer } from '../webview-src/dashboard/cliSessionsModal';
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
});
