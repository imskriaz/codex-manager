import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkRecoveryToastUi(page, { origin, parentId, width, output }) {
  await page.goto(`${origin}/workspace/${parentId}`);
  const input = page.getByRole('textbox', { name: 'Message Codex', exact: true });
  await input.waitFor();
  await page.evaluate(id => {
    const session = window.__uiSessions.find(row => row.id === id);
    Object.assign(session, { status: 'unknown', locked: true, steerTurnId: undefined, statusError: 'Running state is being checked. Conversation history remains available.', updatedAt: new Date(Date.now() + 100_000).toISOString() });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action: 'listCodexCliSessions', requestId: 'dashboard-auto-recovery-fixture', status: 'completed', payload: { cliSessions: window.__uiSessions } } }));
  }, parentId);
  await input.fill('Old queued work to cancel');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const row = page.locator('.cli-queued-message').filter({ hasText: 'Old queued work to cancel' });
  await row.getByRole('button', { name: /Steer$/ }).click();
  const toast = page.locator('.dashboard-notice');
  await toast.getByRole('button', { name: 'Dismiss notification', exact: true }).waitFor();
  const box = await toast.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= width + 1, 'Recovery toast fits viewport');
  assert.equal(await toast.getByRole('button').count(), 1, 'Only the original close button remains');
  const close = await toast.getByRole('button', { name: 'Dismiss notification', exact: true }).boundingBox();
  assert.ok(close.x >= box.x && close.x + close.width <= box.x + box.width + 1 && close.y + close.height <= box.y + box.height + 1, 'Close button stays inside the compact toast');
  await page.screenshot({ path: path.join(output, `recovery-toast-${width}.png`), animations: 'disabled' });
  await toast.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await toast.waitFor({ state: 'hidden' });
  assert.equal(await row.isVisible(), true, 'Closing a notification keeps the queued message');
  await row.getByRole('button', { name: 'Delete queued message', exact: true }).click();
  await row.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__uiActions.filter(m => ['sendCodexCliSessionMessage', 'steerCodexCliSessionTurn', 'cancelCodexCliSessionTurn'].includes(m.action)).length), 0, 'Closing the notice and deleting queued work never sends or interrupts a turn');

  const before = await page.evaluate(() => window.__uiActions.length);
  await page.waitForTimeout(4_500);
  const reads = await page.evaluate(before => window.__uiActions.slice(before).filter(m => m.action === 'listCodexCliSessions'), before);
  assert.ok(reads.length > 0 && reads.length <= 5, 'Unknown status retries with bounded backoff');
  assert.ok(reads.every(m => m.payload.automatic === true), 'Recovery never masquerades as manual Refresh');
  assert.equal(await toast.count(), 0, 'Background status progress emits no warning toast');
}
