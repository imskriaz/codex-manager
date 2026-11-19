import { beforeEach, expect, it, vi } from 'vitest';
import type { DashboardHostMessage } from '../src/domain/dashboard/types';
const fixture = vi.hoisted(() => ({ slots: [] as any[], cursor: 0 }));
vi.mock('preact/hooks', () => ({
  useState(initial: unknown) { const i = fixture.cursor++; fixture.slots[i] ??= { value: initial }; return [fixture.slots[i].value, (next: any) => { fixture.slots[i].value = typeof next === 'function' ? next(fixture.slots[i].value) : next; }]; },
  useRef(initial: unknown) { const i = fixture.cursor++; return fixture.slots[i] ??= { current: initial }; }
}));
import { useShareModal } from '../webview-src/dashboard/shareModalHook';
import { noticeFromActionResult } from '../webview-src/dashboard/actionFeedback';
const sendAction = vi.fn(), showCopyFeedback = vi.fn();
function render() { fixture.cursor = 0; return useShareModal({ sendAction, showCopyFeedback }); }
const reply = (requestId: string, status: 'completed' | 'failed' | 'cancelled' = 'completed', action: 'copyText' | 'exportBackup' = 'copyText'): Extract<DashboardHostMessage, { type: 'dashboard:action-result' }> => ({ type: 'dashboard:action-result', requestId, status, action, error: status === 'completed' ? undefined : 'Clipboard unavailable' });
beforeEach(() => { fixture.slots = []; fixture.cursor = 0; sendAction.mockReset().mockReturnValue('copy-1'); showCopyFeedback.mockReset(); });
it('waits for the exact completed copy acknowledgement before showing success once', () => {
  render().applyActionResult({ ...reply('export'), action: 'shareTokens', payload: { sharedJson: '{"share":true}' } });
  render().handleCopyShareJson();
  expect(sendAction).toHaveBeenCalledExactlyOnceWith('copyText', undefined, { text: '{"share":true}' });
  expect(showCopyFeedback).not.toHaveBeenCalled();
  expect(render().applyActionResult(reply('other-copy'))).toBe(false);
  expect(render().applyActionResult(reply('copy-1', 'completed', 'exportBackup'))).toBe(false);
  expect(showCopyFeedback).not.toHaveBeenCalled();
  expect(render().applyActionResult(reply('copy-1'))).toBe(true);
  expect(showCopyFeedback).toHaveBeenCalledExactlyOnceWith('share-json');
  expect(render().applyActionResult(reply('copy-1'))).toBe(false);
});
it.each(['failed', 'cancelled'] as const)('keeps %s copies available to global failure feedback, never successful', status => {
  render().handleCopyShareJson(); const message = reply('copy-1', status);
  expect(render().applyActionResult(message)).toBe(false);
  expect(noticeFromActionResult(message, false)).toEqual(expect.objectContaining({ message: expect.stringContaining('Clipboard unavailable') }));
  expect(render().applyActionResult(reply('copy-1'))).toBe(false);
  expect(showCopyFeedback).not.toHaveBeenCalled();
});
it('ignores superseded copies and accepts the newest completed request', () => {
  render().handleCopyShareJson(); sendAction.mockReturnValue('copy-2'); render().handleCopyShareJson();
  render().applyActionResult(reply('copy-1')); expect(showCopyFeedback).not.toHaveBeenCalled();
  render().applyActionResult(reply('copy-2')); expect(showCopyFeedback).toHaveBeenCalledOnce();
});
it('does not acknowledge an unsent copy or open a cancelled export', () => {
  sendAction.mockReturnValue(''); render().handleCopyShareJson();
  expect(render().applyActionResult(reply(''))).toBe(false);
  expect(render().applyActionResult({ ...reply(''), requestId: undefined } as unknown as ReturnType<typeof reply>)).toBe(false);
  render().applyActionResult({ ...reply('export', 'cancelled', 'exportBackup'), payload: { sharedJson: 'not exported' } });
  expect(render().shareModalOpen).toBe(false); expect(showCopyFeedback).not.toHaveBeenCalled();
});
