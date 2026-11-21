import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:39875';
const output = 'output/login-recovery';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    await context.addCookies([{ name: 'codex_dashboard_session', value: 'a'.repeat(64), url: origin }]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const returnPath = '/workspace/12345678-1234-1234-1234-123456789abc?device=remote';
    for (const path of ['/', returnPath, `/login?returnTo=${encodeURIComponent(returnPath)}`]) {
      const start = Date.now();
      const response = await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
      const domReadyMs = Date.now() - start;
      assert.equal(response.status(), 200);
      await page.locator('input[name="password"]').waitFor();
      assert.match(await page.locator('body').innerText(), /session expired/i);
      assert.equal(await page.locator('input[name="username"]').count(), 1);
      if (path !== '/') assert.equal(await page.locator('form').getAttribute('action'), `/login?returnTo=${encodeURIComponent(returnPath)}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
      console.log(JSON.stringify({ width, path, domReadyMs }));
    }
    await page.screenshot({ path: `${output}/${width}.png`, fullPage: true });
    assert.deepEqual(errors, [], 'No console errors or uncaught exceptions');
    await context.close();
  }
} finally { await browser.close(); }
