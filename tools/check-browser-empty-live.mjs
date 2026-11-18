import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

// Real dashboard reads; all Browser operations below stay in this browser fixture.
const origin = 'http://127.0.0.1:39875';
const response = await fetch(origin + '/api/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Codex-Dashboard': '1', Origin: origin }, body: JSON.stringify({ type: 'dashboard:action', action: 'listCodexCliSessions', requestId: crypto.randomUUID() }) });
assert.ok(response.ok, 'The local host must answer session discovery.');
const discovered = await response.json();
const sessions = discovered.messages?.find(message => message.action === 'listCodexCliSessions')?.payload?.cliSessions ?? [];
const session = sessions.find(item => !item.remote && !item.subAgent && !item.parentSessionId && !item.archived && item.projectPath?.replaceAll('\\', '/').toLowerCase() === process.cwd().replaceAll('\\', '/').toLowerCase());
assert.ok(session, 'A local workspace conversation is required for this read-only UI check.');
const browser = await chromium.launch({ channel: 'msedge', headless: process.env.CODEX_MANAGER_HEADED !== '1' });
await mkdir('output/browser-live', { recursive: true });
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
      window.__browserOperations = [];
      window.__fixtureBrowserPages = [];
      let sequence = 0;
      window.__fixtureBrowserAction = request => {
        window.__browserOperations.push(request.operation);
        if (request.operation === 'open') {
          const number = ++sequence;
          window.__fixtureBrowserPages.push({ id: `fixture-${number}`, title: `Fixture browser page ${number}`, url: 'about:blank', revision: '1' });
        }
        if (request.operation === 'close') window.__fixtureBrowserPages = window.__fixtureBrowserPages.filter(page => page.id !== request.pageId);
        const pages = window.__fixtureBrowserPages;
        const selected = pages.find(page => page.id === request.pageId) ?? pages.at(-1);
        return { pages, feedback: [], ...(request.operation !== 'list' && selected ? { pageId: selected.id, revision: selected.revision } : {}) };
      };
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        send(data) {
          let message; try { message = JSON.parse(data); } catch { return super.send(data); }
          if (message.action !== 'workspaceBrowser') return super.send(data);
          const request = message.payload.browserRequest;
          const state = window.__fixtureBrowserAction(request);
          setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action: message.action, requestId: message.requestId, status: 'completed', payload: { workspaceBrowser: state } } })), 0);
        }
      };
    });
    await page.route('**/api/message', async route => {
      const message = route.request().postDataJSON();
      if (message?.action !== 'workspaceBrowser') return route.fallback();
      const state = await page.evaluate(request => window.__fixtureBrowserAction(request), message.payload.browserRequest);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ messages: [{ type: 'dashboard:action-result', action: message.action, requestId: message.requestId, status: 'completed', payload: { workspaceBrowser: state } }] }) });
    });
    await page.goto(origin + '/workspace/' + session.id);
    await page.locator('.cli-workspace').waitFor();
    await page.getByRole('textbox', { name: 'Message Codex', exact: true }).waitFor();
    const rail = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
    if (await rail.isVisible()) await rail.click();
    await page.locator('.cli-account-footer').getByRole('button', { name: 'Open account center', exact: true }).click();
    await page.locator('.workspace-dashboard').waitFor();
    await page.getByRole('button', { name: 'Add workspace tool', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Browser', exact: true }).click();
    await page.getByRole('tab', { name: 'Fixture browser page 1', exact: true }).waitFor();
    for (const number of [2, 3]) {
      await page.getByRole('button', { name: 'Add workspace tool', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Browser', exact: true }).click();
      await page.getByRole('tab', { name: `Fixture browser page ${number}`, exact: true }).waitFor();
    }
    assert.equal(await page.getByRole('button', { name: 'Open new browser page', exact: true }).count(), 0, 'The redundant new-page icon is removed.');
    await page.waitForTimeout(2700); // Include the first background refresh.
    assert.equal(await page.evaluate(() => window.__fixtureBrowserPages.length), 3, 'Background refresh preserves all pages.');
    const address = await page.locator('.workspace-browser-address').boundingBox();
    const actions = await page.locator('.workspace-browser-actions').boundingBox();
    assert.ok(address.x + address.width - actions.x - actions.width < 10, 'URL controls fill the toolbar.');
    assert.equal(await page.locator('.workspace-browser-workbench-header').count(), 0, 'The redundant Page/Comments row is removed.');
    assert.equal(await page.locator('.workspace-browser-toast').count(), 0, 'Successful actions do not show redundant toasts.');
    await page.locator('.workspace-browser-address').getByRole('button', { name: 'Comments', exact: true }).click();
    assert.equal(await page.locator('.workspace-browser-inspector-tools').count(), 1, 'Marking tools sit before inspector tabs.');
    const toolRows = await page.locator('.workspace-browser-inspector-tools button').evaluateAll(buttons => buttons.map(button => Math.round(button.getBoundingClientRect().top)));
    assert.ok(Math.max(...toolRows) - Math.min(...toolRows) < 3, 'Inspector tools stay on one compact row.');
    await page.getByRole('region', { name: 'Saved feedback', exact: true }).getByText('Comments (0)', { exact: true }).waitFor();
    await page.locator('.workspace-browser-inspector-actions').getByRole('button', { name: 'Close browser inspector', exact: true }).click();
    await page.locator('.workspace-browser').screenshot({ path: `output/browser-live/browser-${width}.png` });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Dashboard fits the viewport.');
    for (const number of [3, 2, 1]) {
      await page.getByRole('button', { name: `Close Fixture browser page ${number}`, exact: true }).click();
      await page.getByRole('tab', { name: `Fixture browser page ${number}`, exact: true }).waitFor({ state: 'detached' });
    }
    await page.waitForFunction(() => window.__browserOperations.includes('close'));
    assert.equal(await page.getByRole('tab', { name: 'Env', exact: true }).getAttribute('aria-selected'), 'true', 'Closing the final page returns to Environment.');
    assert.deepEqual(errors, [], 'Browser lifecycle has no runtime errors.');
    console.log(`PASS ${width}px: repeated Browser adds, compact controls, Comments icon, no extra row or success toast, background refresh, final close; load ${Math.round(await page.evaluate(() => performance.now()))}ms`);
    await context.close();
  }
} finally { await browser.close(); }
