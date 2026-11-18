import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkRecoveryToastUi(page, { origin, parentId, width, output }) {
  await page.goto(`${origin}/workspace/${parentId}`);
  const input = page.getByRole('textbox', { name: 'Message Codex', exact: true });
  await input.waitFor();
  await page.evaluate(() => {
    window.__recoveryCopiedText = undefined;
    const clipboard = navigator.clipboard;
    if (clipboard) clipboard.writeText = async text => { window.__recoveryCopiedText = text; };
  });
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
  await toast.getByRole('button', { name: 'Cancel queued message', exact: true }).waitFor();
  const box = await toast.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= width + 1, 'Recovery toast fits viewport');
  for (const name of ['Cancel queued message', 'Copy notification', 'Clear notification']) {
    const button = await toast.getByRole('button', { name, exact: true }).boundingBox();
    assert.ok(button.x >= box.x && button.x + button.width <= box.x + box.width + 1 && button.y + button.height <= box.y + box.height + 1, `${name} stays inside the compact toast`);
  }
  await page.screenshot({ path: path.join(output, `recovery-toast-${width}.png`), animations: 'disabled' });
  await toast.getByRole('button', { name: 'Cancel queued message', exact: true }).click();
  await row.waitFor({ state: 'hidden' });
  await toast.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__uiActions.filter(m => ['sendCodexCliSessionMessage', 'steerCodexCliSessionTurn', 'cancelCodexCliSessionTurn'].includes(m.action)).length), 0, 'Cancelling queued work neither sends it nor interrupts a running turn');

  const show = message => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:notice', level: 'warning', message } })), message);
  await show('Notification to copy and clear');
  await toast.getByRole('button', { name: 'Copy notification', exact: true }).click();
  await toast.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__recoveryCopiedText), 'Notification to copy and clear');

  await page.evaluate(() => {
    window.__copy = navigator.clipboard.writeText.bind(navigator.clipboard);
    window.__exec = document.execCommand.bind(document);
    navigator.clipboard.writeText = async () => { throw new Error('Denied'); };
    document.execCommand = () => false;
  });
  await show('Keep the original failure when copying fails');
  await toast.getByRole('button', { name: 'Copy notification', exact: true }).click();
  await toast.getByRole('alert').filter({ hasText: 'Copy failed' }).waitFor();
  assert.ok((await toast.innerText()).includes('Keep the original failure'), 'Clipboard failure preserves the original error');
  await page.screenshot({ path: path.join(output, `recovery-copy-failed-${width}.png`), animations: 'disabled' });
  await toast.getByRole('button', { name: 'Clear notification', exact: true }).click();
  await toast.waitFor({ state: 'hidden' });
  await page.evaluate(() => { navigator.clipboard.writeText = window.__copy; document.execCommand = window.__exec; });

  const before = await page.evaluate(() => window.__uiActions.length);
  await page.waitForTimeout(4_500);
  const reads = await page.evaluate(before => window.__uiActions.slice(before).filter(m => m.action === 'listCodexCliSessions'), before);
  assert.ok(reads.length > 0 && reads.length <= 5, 'Unknown status retries with bounded backoff');
  assert.ok(reads.every(m => m.payload.automatic === true), 'Recovery never masquerades as manual Refresh');
  assert.equal(await toast.count(), 0, 'Background status progress emits no warning toast');
}
