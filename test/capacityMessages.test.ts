import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { VNode } from 'preact';
import type { DashboardCliSessionMessage } from '../src/domain/dashboard/types';
vi.mock('preact/hooks', () => ({ useMemo: (factory: () => unknown) => factory(), useContext: () => undefined, useState: (initial: unknown) => [initial, vi.fn()] }));
import { SessionMessage, QueuedMessages, LiveTurnDetails, consolidateSessionMessages, groupCompletedTurns } from '../webview-src/dashboard/cliSessionsModal';

it('compacts every session usage counter while keeping exact totals on hover', () => {
  const node = LiveTurnDetails({ usage: { input: 276906687, cachedInput: 272657408, output: 251524, reasoningOutput: 96616, total: 277158211, contextWindow: 475000 } })!;
  const counts = node.props.children[1].props.children.props.children[0].props.children;
  expect(counts.map((count: VNode<any>) => count.props.children[2].props.children)).toEqual(['276.9M', '272.7M', '251.5K', '96.6K', '277.2M', '475K']);
  expect(counts[0].props.title).toBe('Input: 276,906,687 tokens');
});

function activity(message: DashboardCliSessionMessage): VNode<any> {
  const wrapped = SessionMessage({ message });
  const node = wrapped.props.children ?? wrapped;
  return (node.type as (props: unknown) => VNode<any>)(node.props);
}

it.each(['error', 'tool-call', 'compaction', 'review'] as const)('shows %s capacity messages immediately with optional diagnostics', kind => {
  for (const debug of [undefined, '{"error":"server_overloaded","request_id":"keep-me"}']) {
    const node = activity({ id: 'capacity', kind, text: 'Selected model is at capacity. Please try a different model.', status: 'failed', debug });
    expect(node.type).toBe('div');
    expect(node.props.open).not.toBe(true);
    const label = node.props.children[0];
    expect(label.props.role).toBe('status');
    expect(label.props.children).toBe('Model at capacity');
    expect(label.props.title).toBe('Selected model is at capacity. Please try a different model.');
    expect(label.props.class).toBe('is-error');
    const details = node.props.children[1];
    expect(details.type).toBe('details');
    expect(details.props.open).not.toBe(true);
    expect(details.props.children[1].props.text).toBe(["Selected model is at capacity. Please try a different model.", debug].filter(Boolean).join('\n\n'));
  }
});

it('recognizes capacity in tool results while preserving ordinary errors and command transcripts', () => {
  expect(activity({ id: 'result', kind: 'tool-call', text: '', result: '{"error":"model_overloaded"}', status: 'failed' }).props.class).toBe('cli-capacity-notice');
  for (const message of [
    { id: 'ordinary', kind: 'error' as const, text: 'Connection failed.' },
    { id: 'command', kind: 'command' as const, text: 'Selected model is at capacity.', command: 'echo capacity', output: 'Keep the original output.' }
  ]) {
    const node = activity(message);
    expect(node.props.class).not.toContain('cli-capacity-notice');
    expect(node.props.class).toContain(`is-${message.kind}`);
  }
});

it.each(['completed', 'inProgress', undefined] as const)('keeps %s tool output mentioning capacity in its original activity', status => {
  const node = activity({ id: 'source', kind: 'tool-call', text: 'Script completed', result: 'Selected model is at capacity. Please try a different model.\nmodelCapacityAutoSwitchEnabled: true', status });
  expect(node.type).toBe('details');
  expect(node.props.class).toContain('cli-activity is-tool-call');
});

it('retains every capacity diagnostic without repeating identical fields', () => {
  const result = '{"error":"model_overloaded"}';
  const node = activity({ id: 'result', kind: 'tool-call', text: 'Service unavailable', result, debug: result, status: 'failed' });
  expect(node.props.children[1].props.children[1].props.text).toBe(`Service unavailable\n\n${result}`);
  expect(node.props.children[0].props.title).toBe('Service unavailable');
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
  expect(node.props.children[0].props.children).toBe(expected);
});

it('does not show an active retry when reading historical notices', () => {
  const node = activity({ id: 'retry', kind: 'error', title: 'Retry attempt', text: 'Retrying in 2s.', status: 'interrupted' });
  expect(node.props.children[0].props.children).toBe('Retry attempt');
});

it('recognizes structured capacity codes while preserving ordinary error diagnostics', () => {
  const node = activity({ id: 'code-only', kind: 'error', text: 'Service unavailable', debug: '{"error":{"codexErrorInfo":"serverOverloaded"}}', status: 'failed' });
  expect(node.props.children[0].props.children).toBe('Model at capacity');
  expect(activity({ id: 'tool', kind: 'tool-call', text: 'Read error documentation', debug: '{"example":"serverOverloaded"}' }).props.class).toContain('cli-activity is-tool-call');
});

it('keeps queued messages visible above the composer with inline actions', () => {
  const item={id:'failed',draft:{text:'Keep this message',attachments:[]},state:'failed',error:'Storage could not save this message.',createdAt:1,seenIds:[]};
  const queue={items:[item],ready:true,connected:true} as unknown as Parameters<typeof QueuedMessages>[0]['queue'];
  const node=QueuedMessages({queue,onRefresh:()=>{}}) as VNode<any>;
  expect(node.props.class).toBe('cli-local-queue');
  const row=node.props.children.flat(Infinity).find((child: VNode<any>) => child?.props?.class?.includes('cli-queued-message'));
  expect(row.props.class).toContain('cli-queued-message');
  const details = row;
  expect(row.props.class).toContain('cli-goal-strip');
  expect(details.type).toBe('details');
  expect(details.props.open).toBeUndefined();
  expect(details.props.children[0].props.children.some((child: VNode<any>) => child?.props?.role === 'alert' && child.props.title === item.error)).toBe(true);
  const source = readFileSync('webview-src/dashboard/cliSessionsModal.tsx', 'utf8');
  const css = readFileSync('media/webview/quotaSummary.css', 'utf8');
  expect(source).toContain('aria-label="Edit queued message"');
  expect(source).toContain('queue.steerNow(item.id)');
  expect(source).not.toContain('class="cli-queued-steer is-sending"');
  expect(source).not.toContain('class="cli-queued-sending-status"');
  expect(source).toContain('<ApiIcon />');
  expect(source).toContain('aria-label="API access"');
  expect(source).toContain('<SignOutIcon />Sign out');
  expect(source).not.toContain('Turn off queueing');
  expect(css).toContain('.cli-queued-message-copy { min-width: 0; overflow: hidden; text-overflow: ellipsis;');
  expect(css).toContain('.cli-queued-message-thumb { flex: none; width: 14px; height: 14px;');
  expect(css).not.toContain('.cli-local-queue > details { display:none; }');
  expect(source).not.toContain('className="dashboard-modal-compact cli-queue-modal"');
  expect(source).not.toContain('class="cli-local-queue-summary"');
  expect(QueuedMessages({queue:{...queue,items:[],ready:false,error:'Storage unavailable'},onRefresh:()=>{}})).toBeNull();
  expect(QueuedMessages({queue:{...queue,items:[{...item,state:'sending'}],ready:true,connected:true},onRefresh:()=>{}})).not.toBeNull();
});

it('renders every waiting message and its controls without opening a dialog', () => {
  const steerNow = vi.fn(), remove = vi.fn(), resend = vi.fn(), onRefresh = vi.fn();
  const queue = { items: ['queued', 'failed', 'uncertain'].map((state, index) => ({ id: state, state, draft: { text: `Message ${index}`, attachments: [] }, createdAt: index, seenIds: [], ...(state !== 'queued' ? { error: `${state} error` } : {}) })), ready: true, connected: true, steerNow, remove, resend } as unknown as Parameters<typeof QueuedMessages>[0]['queue'];
  const node = QueuedMessages({ queue, onRefresh }) as VNode<any>;
  const rows = node.props.children.flat(Infinity).filter((child: VNode<any>) => child?.type === 'details');
  expect(rows).toHaveLength(3);
  for (const [index, row] of rows.entries()) {
    const summary = row.props.children[0];
    expect(summary.props.children[1].props.children).toBe(`Message ${index}`);
    const actions = summary.props.children.find((child: VNode<any>) => child?.props?.class === 'cli-queued-message-actions').props.children.filter(Boolean);
    for (const action of actions) action.props.onClick();
    expect(row.props.open).toBeUndefined();
  }
  expect(steerNow).toHaveBeenCalledExactlyOnceWith('queued');
  expect(resend.mock.calls).toEqual([['failed'], ['uncertain']]);
  expect(onRefresh).toHaveBeenCalledOnce();
  expect(remove.mock.calls).toEqual(['queued', 'failed', 'uncertain'].flatMap(id => [[id], [id, true]]));
});

it('lets the resized Account Center use columns without reserving a blank footer strip', () => {
  const css = readFileSync('media/webview/quotaSummary.css', 'utf8');
  expect(css).toContain('.cli-account-center .cli-account-dashboard .accounts-grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));');
  expect(css).toContain('max-height: calc(var(--dashboard-viewport-height, 100dvh) - 40px);');
  expect(css).toContain('@container account-card (max-width: 320px)');
  expect(css).toContain('.cli-account-center .cli-account-dashboard .dashboard-account-toolbar { display: flex; flex-wrap: nowrap;');
  expect(css).toContain('.cli-account-center .cli-account-navigation { flex-wrap: nowrap;');
  expect(css).toContain('.cli-account-resize-footer { position: absolute;');
  expect(css).toContain('.cli-account-resize-footer small { display: none; }');
});

it('keeps warning and error toasts visible on mobile while info stays silent', () => {
  const css = readFileSync('media/webview/quotaSummary.css', 'utf8');
  expect(css).not.toContain('.dashboard-notice-stack { display: none !important; }');
  expect(css).toContain('.dashboard-notice-stack { display: grid; top:');
});

it.each(["You have hit your usage limit. Retry tomorrow.", "Authentication failed", "Unexpected provider error"])('shows one error summary with full text available: %s', text => {
  const node = activity({ id: 'failed', kind: 'error', text, status: 'failed' });
  expect(node.type).toBe('div'); expect(node.props.role).toBe('alert');
  const summary = node.props.children[0];
  expect(summary.type).toBe('span');
  expect(summary.props.children).toContain(text);
  expect(summary.props.title).toBe(text);
  expect(node.props.children[1].props.children[1].props.text).toBe(text);
});

it('keeps errors outside collapsed completed turns even after the session recovers', () => {
  const error = { id: 'error', kind: 'error' as const, text: 'Provider failed', status: 'failed' as const };
  const result = groupCompletedTurns(consolidateSessionMessages([error, { id: 'answer', role: 'assistant', kind: 'message', text: 'Recovered answer' }]), false);
  expect(result[0]).toBe(error);
});
