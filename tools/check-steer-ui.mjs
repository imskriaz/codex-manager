import assert from 'node:assert/strict';

export async function checkSteerUi(page, { origin, parentId }) {
  await page.goto(`${origin}/workspace/${parentId}`);
  const input = page.getByRole('textbox', { name: 'Message Codex', exact: true });
  await input.waitFor();
  await page.evaluate(sessionId => {
    window.__steerState = { sessionId, streamId: 'steer-fixture', sequence: 1, turnId: 'turn-fixture', status: 'running', updatedAt: Date.now() + 1000, messages: [] };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: window.__steerState } }));
  }, parentId);
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  assert.equal(await page.locator('.cli-send-button:visible, .cli-stop-button:visible').count(), 1, 'An empty running composer shows only Stop');
  await input.fill('First steering message');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: window.__steerState } })));
  const send = page.getByRole('button', { name: 'Send follow-up', exact: true });
  await send.waitFor();
  assert.equal(await page.locator('.cli-send-button:visible, .cli-stop-button:visible').count(), 1, 'Text replaces Stop with a single Send control');
  await page.evaluate(() => { window.__holdNextSteer = true; });
  await send.click();
  await page.waitForFunction(() => window.__heldSteerResult);
  assert.equal(await input.inputValue(), '', 'Steering clears immediately');
  await page.locator('.cli-composer').evaluate(form => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(await page.evaluate(() => window.__uiActions.filter(action => action.action === 'steerCodexCliSessionTurn').length), 1, 'Repeated submit events send only once');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { ...window.__heldSteerResult, status: 'failed', error: 'Confirmation lost; verify before retrying.' } })));
  await page.waitForFunction(() => document.querySelector('textarea[name="codex-message"]')?.value === 'First steering message');
  await input.fill('My next draft');
  await page.evaluate(() => {
    window.__steerState = { ...window.__steerState, sequence: 2, updatedAt: Date.now(), messages: [{ id: 'steer-echo', role: 'user', kind: 'message', turnId: 'turn-fixture', text: 'First steering message' }] };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: window.__steerState } }));
    window.dispatchEvent(new MessageEvent('message', { data: window.__heldSteerResult }));
  });
  await page.locator('.cli-session-message.is-user').filter({ hasText: 'First steering message' }).waitFor();
  assert.equal(await input.inputValue(), 'My next draft', 'An echo and late acknowledgement preserve newer edits');
  assert.equal(await page.locator('.dashboard-notice').filter({ hasText: /Follow-up sent|Sending message/ }).count(), 0, 'Successful steering adds no information toast');
  await page.evaluate(() => { window.__holdNextSteer = true; window.__heldSteerResult = undefined; });
  await send.click();
  await page.waitForFunction(() => window.__heldSteerResult);
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { ...window.__heldSteerResult, status: 'failed', error: 'Uncertain result' } }));
  });
  await page.waitForFunction(() => document.querySelector('textarea[name="codex-message"]')?.value === 'My next draft');
  await page.evaluate(() => {
    window.__steerState = { ...window.__steerState, sequence: 3, updatedAt: Date.now(), messages: [...window.__steerState.messages, { id: 'second-steer-echo', role: 'user', kind: 'message', turnId: 'turn-fixture', text: 'My next draft' }, { id: 'later-reply', role: 'assistant', kind: 'message', turnId: 'turn-fixture', text: 'Working on the follow-up' }] };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: window.__steerState } }));
  });
  await page.waitForFunction(() => document.querySelector('textarea[name="codex-message"]')?.value === '');
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  assert.equal(await page.locator('.cli-send-button:visible, .cli-stop-button:visible').count(), 1, 'Clearing a running composer restores only Stop');
  await page.locator('.cli-session-message-text').filter({ hasText: 'Working on the follow-up' }).waitFor();
  const messages = (await page.locator('.cli-session-message-text').allTextContents()).map(text => text.trim());
  assert.ok(messages.indexOf('Working on the follow-up') > messages.indexOf('My next draft'), 'Subsequent output follows the steering message');
}
