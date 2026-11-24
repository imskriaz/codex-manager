import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

const origin = 'http://127.0.0.1:39875';
const output = path.join(os.tmpdir(), 'codex-manager-account-actions-ui');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [320, 390, 760, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await useWorkspaceDashboardAssets(page, origin, context);
    const started = Date.now();
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const dashboard = page.locator('#dashboard-main');
    await dashboard.locator('.overview-shell').waitFor();
    const readyMs = Date.now() - started;
    const toggle = dashboard.locator('.dashboard-account-toolbar .dashboard-view-toggle');
    const listInitially = await dashboard.locator('.saved-table-row').count() > 0;
    for (const list of [false, true]) {
      if ((await dashboard.locator('.saved-table-row').count() > 0) !== list) await toggle.click();
      const rows = dashboard.locator(list ? '.saved-table-row' : '.saved-card-front');
      await rows.first().waitFor();
      const actions = rows.locator('.saved-actions .action-btn.icon-only, .saved-overflow-trigger, .saved-table-actions .action-btn.icon-only');
      const geometry = await actions.evaluateAll(buttons => buttons.map(button => {
        const rect = button.getBoundingClientRect(), style = getComputedStyle(button);
        return { width: rect.width, height: rect.height, radius: style.borderRadius };
      }));
      assert.ok(geometry.length > 0, 'Check actual account actions');
      assert.ok(geometry.every(action => Math.abs(action.width - action.height) < 1 && action.width <= 32 && (action.radius === '50%' || parseFloat(action.radius) >= action.width / 2)), JSON.stringify({ width, list, geometry }));
      assert.ok(await rows.evaluateAll(elements => elements.every(row => row.scrollWidth <= row.clientWidth + 1)), 'Account rows fit');
      for (const theme of ['light', 'dark']) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await page.screenshot({ path: path.join(output, `${width}-${list ? 'list' : 'cards'}-${theme}.png`) });
      }
    }
    if ((await dashboard.locator('.saved-table-row').count() > 0) !== listInitially) await toggle.click();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, readyMs, circularActions: true, cardsAndLists: true, errors: 0 }));
    await context.close();
  }
  console.log(`Screenshots: ${output}`);
} finally { await browser.close(); }
