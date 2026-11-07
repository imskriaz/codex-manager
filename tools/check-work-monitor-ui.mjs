import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkWorkMonitorUi(page, { origin, parentId, runningId, width, height, output }) {
  const context = page.context(), errors = [];
  const track = child => { child.on('pageerror', error => errors.push(error.message)); child.on('console', message => { if (message.type() === 'error') console.log('Monitor console:', message.text()); }); };
  context.on('page', track);
  const original = page.getByRole('textbox', { name: 'Message Codex', exact: true });
  await original.fill('Keep the original window draft');
  await page.evaluate(() => {
    window.__monitorOriginalOpen = window.open;
    Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: undefined });
    window.open = () => null;
  });
  const toggle = page.getByRole('button', { name: 'Keep on top', exact: true });
  await toggle.click();
  await page.locator('.dashboard-notice').filter({ hasText: 'Allow pop-ups' }).waitFor();
  await page.evaluate(() => { window.open = window.__monitorOriginalOpen; });
  const popup = page.waitForEvent('popup'); await toggle.click();
  const monitor = await popup;
  monitor.setDefaultTimeout(30_000);
  console.log(`${width}px: floating dashboard opened`);
  await monitor.setViewportSize({ width: Math.min(width, 390), height: Math.max(390, height) });
  await monitor.locator('.browser-work-monitor').waitFor();
  assert.equal(await monitor.locator('.browser-work-monitor').evaluate(element => getComputedStyle(element).display), 'flex', 'Floating shell uses the mobile layout');
  const mobile = monitor.frameLocator('iframe');
  const composer = mobile.getByRole('textbox', { name: 'Message Codex', exact: true });
  await composer.waitFor();
  const content = monitor.frames().find(frame => frame.parentFrame());
  assert.ok(content, 'Embedded workspace document is available');
  assert.equal(await composer.inputValue(), '', 'The monitor never copies the original draft');
  assert.equal(await mobile.getByRole('button', { name: 'Keep on top', exact: true }).count(), 0, 'No recursive monitors');
  await mobile.locator('.cli-activity-group-details').evaluateAll(elements => elements.forEach(element => { element.open = true; }));
  await mobile.locator('.cli-activity').evaluateAll(elements => elements.forEach(element => { element.open = true; }));
  const toolCall = mobile.locator('.cli-activity.is-tool-call').filter({ hasText: 'Script completed' }).first();
  assert.ok(await toolCall.getByLabel('Arguments', { exact: true }).evaluate(element => Boolean(element.textContent)), 'Tool arguments remain available');
  assert.ok(await toolCall.getByLabel('Result', { exact: true }).evaluate(element => Boolean(element.textContent)), 'Tool results remain available');
  await mobile.locator('.cli-activity.is-command').locator('summary').click({ force: true });
  assert.ok(await mobile.getByLabel('Command output', { exact: true }).evaluate(element => Boolean(element.textContent)), 'Command output remains available');
  console.log(`${width}px: full tool arguments, results and command output visible`);
  const latest = mobile.getByRole('button', { name: 'Scroll to latest message', exact: true });
  if (await latest.count()) {
    await latest.click({ force: true });
    const viewport = mobile.locator('.cli-message-viewport');
    await content.waitForFunction(() => Boolean(document.querySelector('.cli-message-viewport')));
    assert.ok(await viewport.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 8), 'Live workspace reaches the latest message');
  }
  await content.evaluate(() => dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:codex-session-live', state: { sessionId: location.pathname.split('/').pop(), streamId: 'monitor-stream', sequence: 99, status: 'running', updatedAt: Date.now(), messages: [{ id: 'monitor-live-message', kind: 'message', role: 'assistant', text: 'Live auditor update' }] } } })));
  await mobile.getByText('Live auditor update', { exact: true }).waitFor();
  await composer.fill('Send once from the mobile workspace');
  const send = mobile.getByRole('button', { name: 'Send message', exact: true });
  await send.waitFor({ state: 'visible' });
  assert.equal(await send.isEnabled(), true, 'Mobile workspace enables Send after its queue is ready');
  await send.click();
  await content.waitForFunction(() => document.body.textContent?.includes('Send once from the mobile workspace'));
  assert.equal(await mobile.getByText('Send once from the mobile workspace', { exact: true }).count(), 1, 'Exactly one send despite two views of the same chat');
  assert.equal(await original.inputValue(), 'Keep the original window draft');
  console.log(`${width}px: independent composer sent once`);
  await composer.fill('Keep the floating draft through reconnect and reload');
  await content.evaluate(() => dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:connection', connected: false } })));
  await mobile.locator('.dashboard-connection-banner').waitFor();
  assert.equal(await send.isEnabled(), false, 'Offline sends are disabled');
  await content.evaluate(() => dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:connection', connected: true } })));
  await mobile.locator('.dashboard-connection-banner').waitFor({ state: 'hidden' });
  assert.equal(await composer.inputValue(), 'Keep the floating draft through reconnect and reload');
  await toggle.click(); assert.equal(context.pages().length, 2, 'Repeat open focuses the existing window');

  await mobile.getByRole('button', { name: 'Message settings', exact: true }).click();
  const options = mobile.locator('.cli-composer-options'); await options.waitFor();
  assert.ok(await options.evaluate(element => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; }), 'Composer popover fits');
  await content.locator('body').press('Escape');
  await mobile.getByRole('button', { name: 'Session actions', exact: true }).click();
  await mobile.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await mobile.getByRole('textbox', { name: 'Session name', exact: true }).waitFor();
  await mobile.getByRole('button', { name: 'Cancel', exact: true }).click();
  await mobile.getByRole('button', { name: 'Show sessions sidebar', exact: true }).click();
  await mobile.locator('.cli-session-row-select').filter({ hasText: 'Running workspace task' }).click();
  await mobile.locator('.cli-conversation-title h1').filter({ hasText: 'Running workspace task' }).waitFor();
  assert.equal(new URL(page.url()).pathname, `/workspace/${parentId}`, 'Conversation switching stays inside the monitor');
  assert.equal(new URL(content.url()).pathname, `/workspace/${runningId}`);
  await mobile.getByRole('button', { name: 'Show sessions sidebar', exact: true }).click();
  await mobile.getByRole('button', { name: 'Open dashboard', exact: true }).click();
  await mobile.locator('#dashboard-main').waitFor({ state: 'visible' });
  await mobile.locator('.dashboard-mobile-actions > summary').click();
  await mobile.locator('.dashboard-mobile-actions-menu').getByRole('menuitem', { name: /Settings/ }).click();
  const settings = mobile.locator('.settings-modal'); await settings.waitFor();
  for (const tab of await mobile.locator('.settings-tab:visible').all()) {
    await tab.click();
    assert.ok(await settings.evaluate(element => { const r = element.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1; }), 'Every settings tab stays inside the floating viewport');
  }
  await monitor.screenshot({ path: path.join(output, `work-monitor-settings-${width}x${height}.png`), animations: 'disabled' });
  await content.locator('body').press('Escape');
  await content.goto(`${origin}/workspace/${parentId}`);
  await composer.waitFor();
  await content.waitForFunction(() => document.querySelector('textarea[name="codex-message"]')?.value === 'Keep the floating draft through reconnect and reload');
  assert.ok(await content.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Full dashboard fits its iframe');
  assert.ok(await monitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Floating shell fits');
  await monitor.screenshot({ path: path.join(output, `work-monitor-${width}x${height}.png`), animations: 'disabled' });
  await monitor.getByRole('button', { name: 'Back to workspace', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('button[aria-label="Keep on top"]')?.getAttribute('aria-pressed') === 'false');
  assert.equal(await original.inputValue(), 'Keep the original window draft');

  if (width === 1440) {
    await page.evaluate(() => {
      Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: { requestWindow: () => Promise.reject(new Error('Picture-in-picture permission denied.')) } });
    });
    await toggle.click(); await page.locator('.dashboard-notice').filter({ hasText: 'permission denied' }).waitFor();
    await page.evaluate(() => {
      window.__monitorSetTimeout = window.setTimeout;
      window.setTimeout = (callback, delay, ...args) => window.__monitorSetTimeout(callback, delay === 10_000 || delay === 15_000 ? 500 : delay, ...args);
      Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: { requestWindow: options => {
        window.__pipOptions = options;
        window.__lateMonitor = window.__monitorOriginalOpen('', '_blank', 'popup,width=390,height=844');
        return new Promise(resolve => { window.__resolveMonitor = resolve; });
      } } });
    });
    const latePopup = page.waitForEvent('popup'); await toggle.click(); const late = await latePopup;
    await page.locator('.dashboard-notice').filter({ hasText: 'did not open in time' }).waitFor();
    const lateClosed = late.waitForEvent('close');
    await page.evaluate(() => window.__resolveMonitor(window.__lateMonitor)); await lateClosed;
    assert.deepEqual(await page.evaluate(() => window.__pipOptions), { width: 390, height: 844 });

    let release;
    const held = new Promise(resolve => { release = resolve; });
    const hold = async route => { if (route.request().isNavigationRequest() && route.request().frame().parentFrame()) await held; await route.fallback(); };
    await context.route(`${origin}/workspace/*`, hold);
    await page.evaluate(() => { window.documentPictureInPicture.requestWindow = () => Promise.resolve(window.__monitorOriginalOpen('', '_blank', 'popup,width=390,height=844')); });
    const pendingPopup = page.waitForEvent('popup'); await toggle.click(); const loading = await pendingPopup;
    await loading.getByRole('alert').filter({ hasText: 'taking longer to load' }).waitFor();
    release(); await context.unroute(`${origin}/workspace/*`, hold);
    await loading.frameLocator('iframe').getByRole('textbox', { name: 'Message Codex', exact: true }).waitFor();
    await loading.getByRole('alert').waitFor({ state: 'hidden' });
    await loading.close();
    await page.evaluate(() => { window.setTimeout = window.__monitorSetTimeout; });

    const failedNavigation = async route => route.fulfill({ status: 503, contentType: 'text/html', body: '<h1>Unavailable</h1>' });
    await context.route(`${origin}/workspace/*`, failedNavigation);
    const failedPopup = page.waitForEvent('popup'); await toggle.click(); const failed = await failedPopup;
    await failed.getByRole('alert').filter({ hasText: 'could not load' }).waitFor();
    await context.unroute(`${origin}/workspace/*`, failedNavigation);
    await failed.getByRole('button', { name: 'Retry loading', exact: true }).click();
    await failed.frameLocator('iframe').getByRole('textbox', { name: 'Message Codex', exact: true }).waitFor();
    await failed.getByRole('alert').waitFor({ state: 'hidden' });
    await failed.close();
    assert.equal(failed.isClosed(), true, 'Failed monitor can be closed cleanly');
  }
  context.off('page', track);
  assert.deepEqual(errors, [], 'Floating dashboard has no runtime errors');
}
