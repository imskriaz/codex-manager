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
  for (const width of [280, 320, 390, 420, 440, 480, 500, 560, 760, 768, 1024, 1440, 1920, 2560]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width <= 760, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    if (process.argv.includes('--workspace-assets')) await useWorkspaceDashboardAssets(page, origin);
    const started = Date.now();
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('#dashboard-main .overview-shell').waitFor();
    const loadMs = Date.now() - started;
    async function inspect(scope, label) {
      assert.equal(await scope.locator('.hero').isVisible(), label.startsWith('home-'), `${label}: header appears only on dashboard home`);
      const toolbar = scope.locator('.dashboard-account-toolbar');
      async function inspectControls() {
        const controls = await toolbar.evaluate(element => [...element.children].map(child => ({
          ...child.getBoundingClientRect().toJSON(),
          select: child.querySelector('select')?.getBoundingClientRect().toJSON(),
          clientWidth: child.clientWidth, scroll: child.scrollWidth,
        })));
        assert.ok(controls.every(control => control.height >= 28 && control.scroll <= control.clientWidth + 1), `${label}: every control stays visible without overflow`);
        assert.ok(controls.filter(control => control.select).every(control => Math.abs(control.width - control.select.width) <= 2), `${label}: dropdowns fill their columns`);
        assert.ok(controls.every(control => Math.abs(control.y - controls[0].y) < 2 && Math.abs(control.height - controls[0].height) < 2), `${label}: search, filters and view toggle stay on one row`);
        assert.ok(controls.slice(1).every((control, index) => Math.abs(control.x - controls[index].right - 4) < 2), `${label}: no empty gaps between controls`);
        assert.ok(controls[0].width >= 55, `${label}: search retains usable space`);
        assert.ok(await toolbar.getByRole('searchbox').isVisible(), `${label}: search stays visible`);
        if (await toolbar.locator('.account-filter-icon').first().isVisible()) {
          assert.ok(controls.filter(control => control.select).every(control => Math.abs(control.width - control.height) <= 2), `${label}: narrow filters are separate square icons`);
        }
      }
      await inspectControls();
      const search = toolbar.getByRole('searchbox');
      const originalSearch = await search.inputValue();
      await search.fill('zzzz-no-account-layout-fixture');
      await scope.locator('.accounts-empty-filter').waitFor();
      await inspectControls();
      await toolbar.getByRole('button', { name: 'Clear search', exact: true }).click();
      if (originalSearch) await search.fill(originalSearch);
      const sort = toolbar.getByRole('combobox', { name: 'Sort accounts', exact: true });
      const originalSort = await sort.inputValue();
      await sort.selectOption('email');
      await sort.selectOption(originalSort);
      const metric = toolbar.getByRole('combobox', { name: 'Metric', exact: true });
      const originalMetric = await metric.inputValue();
      const alternativeMetric = await metric.locator('option').evaluateAll(options => options.at(-1).value);
      await metric.selectOption(alternativeMetric);
      await metric.selectOption(originalMetric);
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
      const toggle = toolbar.locator('.dashboard-view-toggle');
      const listInitially = await scope.locator('.saved-table-row').count() > 0;
      for (const list of [false, true]) {
        if ((await scope.locator('.saved-table-row').count() > 0) !== list) await toggle.click();
        const rows = scope.locator(list ? '.saved-table-row' : '.saved-card-front');
        await rows.first().waitFor();
        const cards = await rows.evaluateAll(elements => elements.map(card => {
          const bounds = card.getBoundingClientRect();
          return {
            width: card.clientWidth, scroll: card.scrollWidth,
            metrics: [...card.querySelectorAll('.row-head')].map(row => ({
              width: row.clientWidth, scroll: row.scrollWidth,
              fonts: [...row.querySelectorAll('.metric-label, .metric-reset-inline, .percent')].map(node => getComputedStyle(node).fontSize),
              percentRight: row.querySelector('.percent').getBoundingClientRect().right,
              cardRight: bounds.right,
            })),
          };
        }));
        assert.ok(cards.every(card => card.scroll <= card.width + 1), `${label}/${list ? 'list' : 'cards'}: each account fits its pane ${JSON.stringify(cards)}`);
        assert.ok(cards.every(card => card.metrics.every(row => row.scroll <= row.width + 1 && row.percentRight <= row.cardRight + 1 && new Set(row.fonts).size === 1)), `${label}: quota text uses one font size and percentages fit`);
        const paneWidth = await scope.locator('.dashboard-content').evaluate(element => element.clientWidth);
        if (paneWidth <= 760) {
          const heights = await toolbar.evaluate(element => [...element.children].map(child => child.getBoundingClientRect().height));
          assert.ok(heights.every(height => height <= 32), `${label}: small panes use controls no taller than 32px: ${heights}`);
        }
        await page.screenshot({ path: path.join(output, `${label}-${list ? 'list' : 'cards'}.png`) });
      }
      if ((await scope.locator('.saved-table-row').count() > 0) !== listInitially) await toggle.click();
      const layout = await scope.evaluate(element => ({
        width: element.clientWidth, scroll: element.scrollWidth,
        overview: element.querySelector('.overview-shell').getBoundingClientRect().height,
        cards: [...element.querySelectorAll('.saved-card-front')].map(card => card.getBoundingClientRect().height),
        toolbar: element.querySelector('.dashboard-account-toolbar').getBoundingClientRect().height,
        quotas: [...element.querySelectorAll('.saved-progress')].map(grid => ({
          width: grid.clientWidth,
          rows: [...grid.querySelectorAll(':scope > .row')].map(row => ({
            ...row.getBoundingClientRect().toJSON(),
            overflow: row.scrollWidth > row.clientWidth + 1,
            percent: row.querySelector('.percent').getBoundingClientRect().toJSON(),
          })),
        })),
      }));
      assert.ok(layout.scroll <= layout.width + 2, `${label}: no horizontal overflow ${JSON.stringify(layout)}`);
      assert.ok(layout.overview < 510, `${label}: compact overview ${layout.overview}`);
      assert.ok(layout.cards.every(height => height < 200), `${label}: intrinsic account card heights ${layout.cards}`);
      assert.ok(layout.toolbar < 55, `${label}: controls fit within one row ${layout.toolbar}`);
      for (const quota of layout.quotas) {
        assert.ok(quota.rows.every(row => !row.overflow && row.percent.width > 10 && row.percent.right <= row.right + 1), `${label}: quota values fit their meters`);
        if (quota.rows.length === 2) {
          const [first, second] = quota.rows;
          if (quota.width >= 408) {
            assert.ok(Math.abs(first.y - second.y) < 2 && second.x > first.x + first.width, `${label}: two quotas share a row when the card has room (${quota.width}px)`);
          } else {
            assert.ok(second.y > first.y + first.height, `${label}: narrow cards stack quotas (${quota.width}px)`);
          }
        }
      }
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
    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Open account center', exact: true }).click();
    const dashboard = page.locator('.workspace-dashboard');
    await dashboard.locator('.overview-shell').waitFor();
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
    await page.getByRole('button', { name: 'Account menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Open account center', exact: true }).click();
    await dashboard.locator('.overview-shell').waitFor();
    assert.deepEqual(errors, [], `${width}: no browser errors`);
    await context.close();
    console.log(`${width}px: compact home and Dashboard tool passed`);
  }
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ output, results }, null, 2));
} finally { await browser.close(); }
