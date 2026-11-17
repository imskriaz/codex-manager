import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

// Real dashboard reads; all Browser operations below stay in this browser fixture.
const origin = 'http://127.0.0.1:39875';
const response = await fetch(origin + '/api/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Codex-Dashboard': '1', Origin: origin }, body: JSON.stringify({ type: 'dashboard:action', action: 'listCodexCliSessions', requestId: crypto.randomUUID() }) });
assert.ok(response.ok, 'The local host must answer session discovery.');
const discovered = await response.json();
const sessions = discovered.messages?.find(message => message.action === 'listCodexCliSessions')?.payload?.cliSessions ?? [];
const session = sessions.find(item => !item.remote && !item.subAgent && !item.parentSessionId && !item.archived && item.projectPath?.replaceAll('\\', '/').toLowerCase() === process.cwd().replaceAll('\\', '/').toLowerCase());
assert.ok(session, 'A local workspace conversation is required for this read-only UI check.');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    await useWorkspaceDashboardAssets(page, origin);
    if (process.env.CODEX_MANAGER_UI_ASSETS) {
      const assets = path.resolve(process.env.CODEX_MANAGER_UI_ASSETS);
      await page.route('**/assets/dashboard.js*', route => route.fulfill({ contentType: 'text/javascript', path: path.join(assets, 'dashboard.js') }));
      await page.route('**/assets/chunks/*.js', route => route.fulfill({ contentType: 'text/javascript', path: path.join(assets, 'chunks', new URL(route.request().url()).pathname.split('/').at(-1)) }));
    }
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      let pages = [];
      window.__browserOperations = [];
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        send(data) {
          let message; try { message = JSON.parse(data); } catch { return super.send(data); }
          if (message.action !== 'workspaceBrowser') return super.send(data);
          const request = message.payload.browserRequest;
          window.__browserOperations.push(request.operation);
          if (request.operation === 'open') pages = [{ id: 'fixture-page', title: 'Fixture browser page', url: 'about:blank', revision: '1' }];
          if (request.operation === 'close') pages = [];
          const state = { pages, feedback: [], ...(pages.length ? { pageId: 'fixture-page', revision: '1' } : {}) };
          setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action: message.action, requestId: message.requestId, status: 'completed', payload: { workspaceBrowser: state } } })), 0);
        }
      };
    });
    await page.route('**/api/message', async route => {
      const message = route.request().postDataJSON();
      if (message?.action !== 'workspaceBrowser') return route.fallback();
      const state = await page.evaluate(request => {
        window.__browserOperations.push(request.operation);
        const pages = request.operation === 'open' ? [{ id: 'fixture-page', title: 'Fixture browser page', url: 'about:blank', revision: '1' }] : [];
        return { pages, feedback: [], ...(pages.length ? { pageId: 'fixture-page', revision: '1' } : {}) };
      }, message.payload.browserRequest);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ messages: [{ type: 'dashboard:action-result', action: message.action, requestId: message.requestId, status: 'completed', payload: { workspaceBrowser: state } }] }) });
    });
    await page.goto(origin + '/workspace/' + session.id);
    await page.locator('.cli-workspace').waitFor();
    await page.getByRole('textbox', { name: 'Message Codex', exact: true }).waitFor();
    const rail = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
    if (await rail.isVisible()) await rail.click();
    await page.locator('.cli-account-footer').getByRole('button', { name: 'Open account center', exact: true }).click();
    await page.locator('.workspace-accounts').waitFor();
    await page.getByRole('button', { name: 'Add workspace tool', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Browser', exact: true }).click();
    await page.waitForFunction(() => window.__browserOperations.includes('list'), undefined, { timeout: 10000 });
    const create = page.getByRole('button', { name: 'Open new browser page', exact: true });
    await create.waitFor();
    await page.waitForTimeout(2700); // Include the first background list refresh.
    assert.ok(await create.isVisible(), 'An empty Browser remains usable after discovery and refresh.');
    await create.click();
    await page.getByRole('tab', { name: 'Fixture browser page', exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Browser', exact: true }).count(), 0, 'A real page replaces the empty Browser tab.');
    const close = page.getByRole('button', { name: 'Close Fixture browser page', exact: true });
    await close.click();
    await page.waitForFunction(() => window.__browserOperations.includes('close'));
    await page.getByRole('tab', { name: 'Fixture browser page', exact: true }).waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('tab', { name: 'Env', exact: true }).getAttribute('aria-selected'), 'true', 'Closing the final page returns to Environment.');
    assert.deepEqual(errors, [], 'Browser lifecycle has no runtime errors.');
    console.log(`PASS ${width}px: empty Browser, background refresh, first page, final close`);
    await context.close();
  }
} finally { await browser.close(); }
