import { expect, it, vi } from 'vitest';
import { useContext } from 'preact/hooks';
import type { VNode } from 'preact';
import type { DashboardCliSessionMessage } from '../src/domain/dashboard/types';

vi.mock('preact/hooks', () => ({ useMemo: (factory: () => unknown) => factory(), useContext: vi.fn(() => undefined), useState: (initial: unknown) => [initial, vi.fn()] }));
import { SessionMessage } from '../webview-src/dashboard/cliSessionsModal';

function activity(message: DashboardCliSessionMessage, recoveryId?: string): VNode<any> | null {
  const wrapped = SessionMessage({ message });
  const node = wrapped.props.children ?? wrapped;
  vi.mocked(useContext).mockReturnValueOnce(undefined).mockReturnValueOnce(recoveryId);
  return (node.type as (props: unknown) => VNode<any> | null)(node.props);
}

it('suppresses only the quota error represented by the live recovery notice', () => {
  const quota: DashboardCliSessionMessage = { id: 'quota', kind: 'error', text: 'You have hit your usage limit.' };
  expect(activity(quota, 'quota')).toBeNull();
  expect(activity(quota)?.props.role).toBe('alert');
  expect(activity({ ...quota, id: 'earlier' }, 'quota')).not.toBeNull();
  expect(activity({ ...quota, id: 'other', text: 'Connection failed.' }, 'quota')).not.toBeNull();
});

it('uses one error summary and preserves all distinct diagnostics in a closed disclosure', () => {
  const message: DashboardCliSessionMessage = { id: 'failed', kind: 'error', text: 'Connection failed.\nOriginal details', result: 'Socket closed', debug: 'request-id: preserve-me' };
  const node = activity(message)!;
  const [summary, details] = node.props.children;
  expect(summary.type).toBe('span');
  expect(node.props.role).toBe('alert');
  expect(summary.props.title).toBe(message.text);
  expect(typeof summary.props.children).toBe('string');
  expect(details.type).toBe('details');
  expect(details.props.open).not.toBe(true);
  expect(details.props.children[0].props['aria-label']).toBe('Show diagnostics');
  expect(details.props.children[1].props.text).toBe('Connection failed.\nOriginal details\n\nSocket closed\n\nrequest-id: preserve-me');
  const repeated = activity({ ...message, result: message.text, debug: message.text })!;
  expect(repeated.props.children[1].props.children[1].props.text).toBe(message.text);
});
