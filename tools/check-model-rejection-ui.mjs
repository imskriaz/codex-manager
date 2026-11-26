import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

const origin = 'http://127.0.0.1:39875';
const output = path.resolve('output/playwright/model-rejection');
const reason = "The 'gpt-6.2-sol' model is not supported when using Codex with a ChatGPT account.";
const failure = `The first response failed: ${JSON.stringify({ type: 'error', status: 400, error: { message: reason, code: 'model_not_found' } })}. Retry your message.`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await useWorkspaceDashboardAssets(page, origin);
      const started = performance.now();
      await page.goto(origin + '/workspace', { waitUntil: 'domcontentloaded' });
      await page.locator('.cli-workspace').waitFor();
      const loadMs = Math.round(performance.now() - started);
      await page.evaluate(message => dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:notice', level: 'error', message } })), failure);
      const toast = page.locator('.dashboard-notice.is-error');
      await toast.waitFor();
      assert.equal(await toast.locator('span').innerText(), reason + ' Choose another model in the composer, then retry.');
      const bounds = await toast.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: path.join(output, `toast-${width}.png`) });
      await toast.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
      await toast.waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ width, loadMs, checks: 'readable provider rejection, model recovery action, dismissal, responsive layout, no console errors' }));
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
