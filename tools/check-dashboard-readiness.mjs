import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// Reads only: compare rendered cards to the host snapshot without changing accounts.
const origin = 'http://127.0.0.1:39875';
const output = path.resolve('output/playwright/readiness');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.addEventListener('message', event => {
        if (event.data?.type === 'dashboard:snapshot') window.__readinessSnapshot = event.data.state;
      });
    });
    const started = performance.now();
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Array.isArray(window.__readinessSnapshot?.accounts));
    await page.locator('#dashboard-main').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.accounts-grid > .saved-card-container, .accounts-grid > .saved-table-row').length === window.__readinessSnapshot.accounts.length);
    const readyMs = Math.round(performance.now() - started);
    const cards = await page.locator('.accounts-grid > .saved-card-container, .accounts-grid > .saved-table-row').count();
    assert.equal(cards, await page.evaluate(() => window.__readinessSnapshot.accounts.length));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, `${width}.png`) });
    console.log(JSON.stringify({ width, readyMs, cards, errors }));
    await page.close();
  }
} finally { await browser.close(); }
