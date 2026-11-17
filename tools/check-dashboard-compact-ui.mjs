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
  for (const width of [280, 320, 390, 500, 560, 760, 768, 1024, 1440, 1920, 2560]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width <= 760, serviceWorkers: 'block' });
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
      const toolbar = scope.locator('.dashboard-account-toolbar');
      async function inspectControls() {
        const controls = await toolbar.evaluate(element => [...element.children].map(child => ({
          ...child.getBoundingClientRect().toJSON(),
          select: child.querySelector('select')?.getBoundingClientRect().toJSON(),
          clientWidth: child.clientWidth, scroll: child.scrollWidth,
        })));
        assert.ok(controls.every(control => control.height >= 28 && control.scroll <= control.clientWidth + 1), `${label}: every control stays visible without overflow`);
        assert.ok(controls.filter(control => control.select).every(control => Math.abs(control.width - control.select.width) <= 2), `${label}: dropdowns fill their columns`);
        const filters = controls.slice(1);
        assert.ok(filters.every(control => Math.abs(control.y - filters[0].y) < 2 && Math.abs(control.height - filters[0].height) < 2), `${label}: filters and view toggle align`);
        assert.ok(filters.slice(1).every((control, index) => Math.abs(control.x - filters[index].right - 4) < 2), `${label}: no empty gaps between filters`);
        assert.ok(controls[0].y < filters[0].y - 2 ? Math.abs(controls[0].width - filters.at(-1).right + filters[0].x) < 2 : controls[0].width >= 130, `${label}: search fills its row or retains usable space`);
      }
      await inspectControls();
      // Exercise the optional tag column without changing any real account data.
      const tagFixture = await toolbar.evaluate(element => {
        if (element.querySelector('.account-tag-filter')) return false;
        const tag = element.querySelector('.dashboard-select-control').cloneNode(true);
        tag.classList.add('account-tag-filter');
        tag.querySelector('select').innerHTML = '<option>Long account tag for responsive layout</option>';
        element.insertBefore(tag, element.querySelector('.metric-priority-control'));
        return true;
      });
      try { await inspectControls(); }
      finally { if (tagFixture) await toolbar.locator('.account-tag-filter').evaluate(element => element.remove()); }
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
      if (width === 500 || label === 'tool-1440-280') {
        const section = toolbar.locator('..');
        await section.scrollIntoViewIfNeeded();
        for (const theme of ['light', 'dark']) {
          await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
          const bounds = await section.boundingBox();
          await page.screenshot({ path: path.join(output, `${label}-${theme}.png`), clip: { x: Math.max(0, bounds.x), y: Math.max(0, bounds.y), width: bounds.width, height: Math.min(400, 900 - Math.max(0, bounds.y)) } });
        }
      }
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
