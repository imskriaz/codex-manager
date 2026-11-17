import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

const origin = 'http://127.0.0.1:39875';
const output = path.join(tmpdir(), 'codex-manager-compact-dashboard');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const width of [320, 390, 560, 768, 1024, 1440, 1920]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    if (process.argv.includes('--workspace-assets')) await useWorkspaceDashboardAssets(page, origin);
    const started = Date.now();
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('#dashboard-main .overview-shell').waitFor();
    const loadMs = Date.now() - started;
    async function inspect(scope, label) {
      const layout = await scope.evaluate(element => ({
        width: element.clientWidth, scroll: element.scrollWidth,
        overview: element.querySelector('.overview-shell').getBoundingClientRect().height,
        cards: [...element.querySelectorAll('.saved-card-front')].map(card => card.getBoundingClientRect().height),
        toolbar: element.querySelector('.dashboard-account-toolbar').getBoundingClientRect().height,
      }));
      assert.ok(layout.scroll <= layout.width + 2, `${label}: no horizontal overflow ${JSON.stringify(layout)}`);
      assert.ok(layout.overview < 510, `${label}: compact overview ${layout.overview}`);
      assert.ok(layout.cards.every(height => height < 200), `${label}: intrinsic account card heights ${layout.cards}`);
      assert.ok(layout.toolbar < 110, `${label}: controls fit within two rows ${layout.toolbar}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), `${label}: viewport fits`);
      assert.equal(await page.locator('.hero').count(), 1, `${label}: one dashboard instance`);
      await page.screenshot({ path: path.join(output, `${label}.png`) });
      results.push({ label, loadMs, ...layout });
    }
    await inspect(page.locator('#dashboard-main'), `home-${width}`);
    await page.goto(origin + '/workspace', { waitUntil: 'domcontentloaded' });
    await page.locator('.cli-workspace').waitFor();
    const sidebar = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
    if (await sidebar.isVisible()) await sidebar.click();
    await page.getByRole('button', { name: 'Open account center', exact: true }).click();
    const dashboard = page.locator('.workspace-dashboard');
    await dashboard.locator('.hero').waitFor();
    const tab = page.getByRole('tab', { name: 'Dashboard', exact: true });
    assert.equal(await tab.getAttribute('aria-selected'), 'true');
    assert.equal(await tab.locator('svg').innerHTML(), await page.locator('.cli-dashboard-nav[aria-label="Dashboard"] svg').innerHTML(), 'Dashboard icons match');
    for (const panel of width >= 1024 ? [280, 420, 720] : [undefined]) {
      if (panel) await page.locator('.cli-workspace').evaluate((element, size) => element.style.setProperty('--cli-terminal-width', size + 'px'), panel);
      await inspect(dashboard, `tool-${width}-${panel ?? 'mobile'}`);
    }
    await page.getByRole('button', { name: 'Close Dashboard', exact: true }).click();
    await dashboard.waitFor({ state: 'detached' });
    if (await sidebar.isVisible()) await sidebar.click();
    await page.getByRole('button', { name: 'Open account center', exact: true }).click();
    await dashboard.locator('.hero').waitFor();
    assert.deepEqual(errors, [], `${width}: no browser errors`);
    await context.close();
    console.log(`${width}px: compact home and Dashboard tool passed`);
  }
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ output, results }, null, 2));
} finally { await browser.close(); }
