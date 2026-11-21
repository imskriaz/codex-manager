import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkSendRecoveryUi(page, { origin, parentId, output, width }) {
  await page.goto(`${origin}/workspace/${parentId}`);
  const input = page.getByRole('textbox', { name: 'Message Codex', exact: true });
  await input.waitFor();
  await page.evaluate(sessionId => {
    const session = window.__uiSessions.find(item => item.id === sessionId);
    Object.assign(session, { status: 'unknown', locked: true, steerTurnId: undefined, updatedAt: new Date(Date.now() + 1000).toISOString() });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action: 'listCodexCliSessions', requestId: 'dashboard-auto-unknown-send', status: 'completed', payload: { cliSessions: window.__uiSessions } } }));
    window.__holdNextSend = true;
    window.__heldSendResult = undefined;
  }, parentId);
  await input.fill('Send despite stale status');
  await page.locator('.cli-send-button').click();
  await page.waitForFunction(() => window.__heldSendResult);
  assert.equal(await input.inputValue(), '', 'Dispatch clears the saved draft immediately');
  await page.locator('.cli-session-message.is-user').filter({ hasText: 'Send despite stale status' }).waitFor();
  await input.fill('Keep my newer draft');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { ...window.__heldSendResult, payload: undefined, status: 'failed', error: 'Ownership check failed. Retry after reconnecting.' } })));
  const failed = page.locator('.cli-queued-message.is-failed').filter({ hasText: 'Send despite stale status' });
  const inlineError = failed.getByRole('alert');
  await inlineError.waitFor({ state: 'visible' });
  assert.equal(await inlineError.getAttribute('title'), 'Ownership check failed. Retry after reconnecting.', 'The full error is available on its message warning icon');
  assert.equal(await page.locator('.cli-local-queue > small').count(), 0, 'No repeated error row beneath the queue');
  assert.equal(await page.locator('.cli-local-queue-summary, .cli-queue-modal').count(), 0, 'Recovery needs no summary button or modal');
  assert.equal(await failed.evaluate(element => element.open), false, 'Failed messages stay collapsed until the user expands them');
  assert.equal(await input.inputValue(), 'Keep my newer draft', 'A failure preserves newer input');
  await page.screenshot({ path: path.join(output, `send-failure-${width}.png`) });
  await page.evaluate(() => { window.__holdNextSend = true; window.__heldSendResult = undefined; });
  await failed.getByRole('button', { name: 'Resend queued message', exact: true }).click();
  await page.waitForFunction(() => window.__heldSendResult);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: window.__heldSendResult })));
  await failed.waitFor({ state: 'hidden' });
  await inlineError.waitFor({ state: 'hidden' });
  assert.equal(await input.inputValue(), 'Keep my newer draft', 'Retry preserves newer input');
  assert.equal(await page.evaluate(() => window.__uiActions.filter(item => item.action === 'sendCodexCliSessionMessage' && item.payload.text === 'Send despite stale status').length), 2, 'Exactly one initial send and one explicit retry');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Send recovery fits the viewport');
}
