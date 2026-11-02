import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkWorkspaceUi(page, width, height, output) {
  const settings = page.getByRole('button', { name: 'Message settings', exact: true });
  const draft = page.getByRole('textbox', { name: 'Message Codex', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  const panel = page.locator('.cli-composer-options');
  const fits = async locator => {
    const bounds = await locator.boundingBox();
    const viewport = await page.evaluate(() => {
      const v = window.visualViewport;
      return { x: v?.offsetLeft ?? 0, y: v?.offsetTop ?? 0, width: v?.width ?? innerWidth, height: v?.height ?? innerHeight };
    });
    assert.ok(bounds && bounds.x >= viewport.x && bounds.y >= viewport.y && bounds.x + bounds.width <= viewport.x + viewport.width + 1 && bounds.y + bounds.height <= viewport.y + viewport.height + 1, 'Control fits the visible viewport');
  };
  const toolbar = async () => {
    await fits(page.locator('.cli-composer-toolbar'));
    const controls = page.locator('.cli-composer-toolbar button:visible');
    const boxes = [];
    for (const control of await controls.all()) {
      assert.ok(await control.getAttribute('aria-label'), 'Every composer icon action has an accessible name');
      await fits(control);
      const bounds = await control.boundingBox();
      if (width <= 760) assert.ok(bounds.width >= 44 && bounds.height >= 44, 'Composer actions have 44px mobile targets');
      boxes.push(bounds);
    }
    for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].x >= boxes[i - 1].x + boxes[i - 1].width - 1, 'Composer controls do not overlap');
    for (const label of ['.cli-composer-effort', '.cli-composer-permission']) {
      assert.ok(await page.locator(label).evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Reasoning and access remain readable independently of long model names');
    }
    const icons = await page.locator('.cli-composer-toolbar svg').evaluateAll(elements => elements.map(el => ({
      hidden: el.getAttribute('aria-hidden'), focusable: el.getAttribute('focusable'),
      width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height
    })));
    assert.ok(icons.every(icon => icon.hidden === 'true' && icon.focusable === 'false' && icon.width >= 14 && icon.width <= 20 && icon.width === icon.height), 'Composer SVG icons are square, consistent, and decorative');
  };
  await draft.waitFor();
  if (width <= 760) assert.ok((await page.locator('.cli-conversation-header').boundingBox()).height <= 46, 'Mobile header keeps 44px controls on one compact row');
  await draft.fill('');
  assert.equal(await send.isDisabled(), true, 'An empty message cannot be sent');
  await draft.fill('Keep my draft while changing settings');
  await toolbar();
  assert.ok((await page.locator('.cli-composer').boundingBox()).height <= 110, 'The empty one-line composer stays compact');
  await settings.click();
  await fits(panel);
  assert.ok(await page.getByRole('combobox', { name: 'Model', exact: true }).locator('option').count() > 1, 'A late model catalog survives newer session-status pushes');
  assert.equal(await panel.getAttribute('id'), await settings.getAttribute('aria-controls'));
  assert.equal(await settings.getAttribute('aria-expanded'), 'true');
  assert.match(await settings.getAttribute('title'), /GPT-6.1-Sol extended model label/);
  await page.getByRole('combobox', { name: 'Reasoning', exact: true }).selectOption('high');
  for (const [mode, summary, label] of [['read-only', 'Read', 'Read only'], ['danger-full-access', 'Full', 'Full access'], ['workspace-write', 'Write', 'Workspace write']]) {
    await page.getByRole('combobox', { name: 'Access mode', exact: true }).selectOption(mode);
    assert.equal(await page.locator('.cli-composer-permission').innerText(), summary);
    assert.equal(await page.locator('.cli-composer-permission').getAttribute('title'), label);
    assert.equal(await page.locator('.cli-composer-permission').evaluate(el => el.classList.contains('is-full-access')), mode === 'danger-full-access');
  }
  await page.getByRole('button', { name: 'Close message settings', exact: true }).click();
  assert.equal(await panel.count(), 0);
  assert.equal(await settings.evaluate(el => el === document.activeElement), true, 'Closing settings returns keyboard focus to its trigger');
  await settings.press('Enter');
  await fits(panel);
  await page.keyboard.press('Escape');
  assert.equal(await panel.count(), 0);
  assert.equal(await settings.evaluate(el => el === document.activeElement), true, 'Escape restores keyboard focus');
  await settings.click();
  await page.setViewportSize({ width, height: Math.min(height, 350) });
  await page.waitForFunction(() => document.querySelector('.cli-composer-options')?.getBoundingClientRect().bottom <= innerHeight);
  await fits(panel);
  await page.screenshot({ path: path.join(output, 'workspace-settings-short-' + width + '.png') });
  await page.setViewportSize({ width, height });
  await page.waitForFunction(() => {
    const menu = document.querySelector('.cli-composer-options').getBoundingClientRect();
    const composer = document.querySelector('.cli-composer').getBoundingClientRect();
    return menu.bottom <= composer.top || menu.top >= composer.bottom;
  });
  await draft.click();
  assert.equal(await panel.count(), 0, 'Clicking outside settings dismisses it');
  assert.equal(await draft.inputValue(), 'Keep my draft while changing settings');
  await page.locator('.cli-composer input[type="file"]').setInputFiles({
    name: 'a-long-attachment-name-that-must-not-displace-the-composer-controls.txt', mimeType: 'text/plain', buffer: Buffer.from('Read-only UI fixture')
  });
  const remove = page.getByRole('button', { name: /^Remove a-long-attachment/ });
  await remove.waitFor();
  if (width <= 760) {
    const bounds = await remove.boundingBox();
    assert.ok(bounds.width >= 44 && bounds.height >= 44, 'Attachment removal has a mobile touch target');
  }
  await remove.click();
  await toolbar();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await draft.fill('x'.repeat(60_001));
  await page.getByRole('status').filter({ hasText: '3999 characters left' }).waitFor();
  await toolbar();
  await draft.fill('Keep my draft while changing settings');
  await page.screenshot({ path: path.join(output, 'workspace-composer-' + width + '.png') });
  const actions = await page.evaluate(() => window.__uiActions.filter(action => ['sendCodexCliSessionMessage', 'startCodexCliSession'].includes(action.action)));
  assert.deepEqual(actions, [], 'Changing settings and attachments never submits a turn');
  await page.evaluate(() => {
    for (const session of window.__uiSessions.filter(item => item.id === window.__uiSessions[0].id)) {
      session.status = 'running'; session.locked = true; session.updatedAt = new Date().toISOString();
    }
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', requestId: 'realtime-scroll', action: 'listCodexCliSessions', status: 'completed', payload: { cliSessions: window.__uiSessions, realtimeRevision: 101 } } }));
  });
  const latest = page.getByRole('button', { name: 'Scroll to latest message', exact: true });
  await latest.waitFor();
  const latestBox = await latest.boundingBox(), regionBox = await page.locator('.cli-message-region').boundingBox();
  assert.ok(Math.abs(latestBox.x + latestBox.width / 2 - regionBox.x - regionBox.width / 2) <= 2, 'Scroll control is centered over the conversation');
  assert.equal(await latest.locator('.cli-scroll-dots i').count(), 3);
  assert.equal(await latest.locator('i').first().evaluate(el => getComputedStyle(el).animationName), 'none', 'Reduced motion disables the running animation');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await latest.locator('i').first().evaluate(el => getComputedStyle(el).animationName), 'cli-scroll-pulse');
  await page.screenshot({ path: path.join(output, 'workspace-scroll-running-' + width + '.png') });
  await latest.click();
  await page.goto(new URL('/', page.url()).href);
  await page.locator('#dashboard-main').waitFor();
  const connection = async connected => page.evaluate(connected => {
    for (const data of [{ type: 'dashboard:connection', connected }, { type: 'dashboard:host-status', stage: connected ? 'live' : 'unreachable' }])
      window.dispatchEvent(new MessageEvent('message', { data }));
  }, connected);
  await connection(false);
  await page.waitForTimeout(1_000);
  assert.equal(await page.locator('.dashboard-connection-banner').count(), 0, 'Brief disconnects do not flash a warning');
  await connection(true);
  await page.waitForTimeout(2_200);
  assert.equal(await page.locator('.dashboard-connection-banner').count(), 0, 'Recovery cancels the pending warning');
  await connection(false);
  await page.locator('.dashboard-connection-banner').waitFor();
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:notice', level: 'warning', message: 'The browser is offline. Reconnect before retrying.' } })));
  await page.locator('.dashboard-notice').filter({ hasText: 'The browser is offline.' }).waitFor();
  await connection(true);
  await page.locator('.dashboard-connection-banner').waitFor({ state: 'detached' });
  await page.locator('.dashboard-notice').filter({ hasText: 'The browser is offline.' }).waitFor({ state: 'detached' });
}
