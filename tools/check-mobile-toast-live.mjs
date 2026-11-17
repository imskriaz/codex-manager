import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

// Real host reads only. Disconnect only this disposable browser context.
// The extra notice is injected to check stacking without failing a real action.
const origin = 'http://127.0.0.1:39875';
await mkdir('output/live-audit', { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [320, 390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      if (process.argv.includes('--workspace-assets')) await useWorkspaceDashboardAssets(page, origin);
      await page.addInitScript(() => {
        window.__toastSockets = [];
        const NativeWebSocket = window.WebSocket;
        window.WebSocket = class extends NativeWebSocket {
          constructor(...args) { super(...args); window.__toastSockets.push(this); }
        };
      });
      const started = Date.now();
      await page.goto(`${origin}/workspace`, { waitUntil: 'domcontentloaded' });
      await page.locator('.cli-workspace').waitFor();
      await page.waitForFunction(() => window.__toastSockets.some(socket => socket.readyState === WebSocket.OPEN));
      const rail = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
      if (await rail.isVisible()) await rail.click();
      await page.getByRole('button', { name: 'Open account center', exact: true }).click();
      await page.locator('.workspace-accounts').waitFor();
      await context.setOffline(true);
      await page.evaluate(() => window.__toastSockets.forEach(socket => socket.close()));
      const banner = page.locator('.dashboard-notice-stack > .dashboard-connection-banner');
      await banner.waitFor({ timeout: 45000 });
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'dashboard:notice', level: 'error', message: 'Dashboard action failed (502): a longer message that must fit within two compact lines.' }
      })));
      await page.locator('.dashboard-notice-stack .dashboard-notice').waitFor();
      const bounds = await banner.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const notice = element.parentElement.querySelector('.dashboard-notice').getBoundingClientRect();
        const button = element.querySelector('button').getBoundingClientRect();
        return {
          top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
          right: innerWidth - rect.right, noticeTop: notice.top, noticeHeight: notice.height,
          first: element.parentElement.firstElementChild === element,
          onTop: element.contains(document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2))
        };
      });
      assert.ok(bounds.first, 'The connection banner is the first notification');
      assert.ok(bounds.top >= 8 && bounds.top <= 20, 'The banner stays at the viewport top');
      assert.ok(bounds.noticeTop >= bounds.bottom, 'Other notices follow below without overlapping');
      assert.ok(bounds.onTop, 'Reload remains clickable above the open Account Center');
      assert.ok(bounds.right >= 8 && bounds.width < width, 'The banner fits the viewport');
      if (width <= 600) {
        assert.ok(bounds.width <= 300 && bounds.height <= 52, 'Mobile banner stays compact');
        assert.ok(bounds.noticeHeight <= 52, 'Mobile errors fit within two lines');
      }
      await page.screenshot({ path: `output/live-audit/top-banner-${width}.png` });
      await context.setOffline(false);
      await banner.waitFor({ state: 'detached', timeout: 45000 });
      assert.deepEqual(errors, [], 'No browser runtime errors during disconnect and reconnect');
      console.log(JSON.stringify({ passed: true, width, bounds, durationMs: Date.now() - started, runtimeErrors: errors.length }));
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
