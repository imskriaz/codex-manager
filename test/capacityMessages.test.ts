import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { VNode } from 'preact';
import type { DashboardCliSessionMessage } from '../src/domain/dashboard/types';
vi.mock('preact/hooks', () => ({ useMemo: (factory: () => unknown) => factory(), useContext: () => undefined, useState: (initial: unknown) => [initial, vi.fn()] }));
import { SessionMessage, QueuedMessages } from '../webview-src/dashboard/cliSessionsModal';

function activity(message: DashboardCliSessionMessage): VNode<any> {
  const node = SessionMessage({ message });
  return (node.type as (props: unknown) => VNode<any>)(node.props);
}

it.each(['error', 'tool-call', 'compaction', 'review'] as const)('renders %s capacity failures in one row with optional diagnostics', kind => {
  for (const debug of [undefined, '{"error":"server_overloaded","request_id":"keep-me"}']) {
    const node = activity({ id: 'capacity', kind, text: 'Selected model is at capacity. Choose another model or retry later.', status: 'failed', debug });
    expect(node.type).toBe(debug ? 'details' : 'div');
    expect(node.props.open).not.toBe(true);
    const label = debug ? node.props.children[0].props.children[0] : node.props.children;
    expect(label.props.role).toBe('status');
    expect(label.props.children).toBe('Model at capacity');
    expect(label.props.title).toBe('Selected model is at capacity. Choose another model or retry later.');
    if (debug) expect(node.props.children[1].props.text).toBe(debug);
  }
});

it('recognizes capacity in tool results while preserving ordinary errors and command transcripts', () => {
  expect(activity({ id: 'result', kind: 'tool-call', text: '', result: '{"error":"model_overloaded"}' }).props.class).toBe('cli-capacity-notice');
  for (const message of [
    { id: 'ordinary', kind: 'error' as const, text: 'Connection failed.' },
    { id: 'command', kind: 'command' as const, text: 'Selected model is at capacity.', command: 'echo capacity', output: 'Keep the original output.' }
  ]) {
    const node = activity(message);
    expect(node.props.class).not.toContain('cli-capacity-notice');
    expect(node.props.class).toContain(`is-${message.kind}`);
  }
});

it.each([
  ['Reconnecting... 2/5', 'Reconnecting 2/5'],
  ['Selected model is at capacity. Retry in 2 seconds.', 'Model at capacity · Retrying · 2s delay'],
  ['Connection lost. Retrying request in 1.5s.', 'Retrying · 1.5s delay'],
  ['Connection lost.', 'Retrying…'],
  ['Retry in -2s.', 'Retrying…'],
  ['Retry in 9999999999999999999999s.', 'Retrying…']
])('shows native retry information for %s without inventing timing', (text, expected) => {
  const node = activity({ id: 'retry', kind: 'error', text, status: 'inProgress' });
  expect(node.props.class).toBe('cli-capacity-notice');
  expect(node.props.children.props.children).toBe(expected);
});

it('does not show an active retry when reading historical notices', () => {
  const node = activity({ id: 'retry', kind: 'error', title: 'Retry attempt', text: 'Retrying in 2s.', status: 'interrupted' });
  expect(node.props.children.props.children).toBe('Retry attempt');
});

it('recognizes structured capacity codes while preserving ordinary error diagnostics', () => {
  const node = activity({ id: 'code-only', kind: 'error', text: 'Service unavailable', debug: '{"error":{"codexErrorInfo":"serverOverloaded"}}', status: 'failed' });
  expect(node.props.children[0].props.children[0].props.children).toBe('Model at capacity');
  expect(activity({ id: 'tool', kind: 'tool-call', text: 'Read error documentation', debug: '{"example":"serverOverloaded"}' }).props.class).toContain('cli-activity is-tool-call');
});

it('keeps queued messages visible above the composer with inline actions', () => {
  const item={id:'failed',draft:{text:'Keep this message',attachments:[]},state:'failed',error:'Storage could not save this message.',createdAt:1,seenIds:[]};
  const queue={items:[item],ready:true,connected:true} as unknown as Parameters<typeof QueuedMessages>[0]['queue'];
  const node=QueuedMessages({queue,onRefresh:()=>{}}) as VNode<any>;
  expect(node.props.class).toBe('cli-local-queue');
  const row=node.props.children[0];
  expect(row.props.class).toContain('cli-queued-message');
  expect(row.props.children[0].props.children[0].props.children).toBe('Failed');
  expect(row.props.children[0].props.children.some((child: VNode<any>) => child?.props?.role === 'alert')).toBe(true);
  const source = readFileSync('webview-src/dashboard/cliSessionsModal.tsx', 'utf8');
  expect(source).toContain('aria-label="Edit queued message"');
  expect(source).not.toContain('Turn off queueing');
  expect(QueuedMessages({queue:{...queue,items:[],ready:false,error:'Storage unavailable'},onRefresh:()=>{}})).toBeNull();
});

it('lets the resized Account Center use columns without reserving a blank footer strip', () => {
  const css = readFileSync('media/webview/quotaSummary.css', 'utf8');
  expect(css).toContain('.cli-account-center .cli-account-dashboard .accounts-grid { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }');
  expect(css).toContain('@media (max-width: 519px)');
  expect(css).toContain('.cli-account-resize-footer { position: absolute;');
  expect(css).toContain('.cli-account-resize-footer small { display: none; }');
});

it('hides fixed dashboard notices on mobile so they do not cover the workspace', () => {
  const css = readFileSync('media/webview/quotaSummary.css', 'utf8');
  expect(css).toContain('.dashboard-notice-stack { display: none !important; }');
});
