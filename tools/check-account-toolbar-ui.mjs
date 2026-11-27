import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

// Read-only local host checks; pane sizes and optional columns change only this DOM.
const origin = 'http://127.0.0.1:39875';
const output = path.resolve('output/playwright/account-toolbar');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const width of [280, 320, 390, 600, 601, 748, 760, 761, 1024, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    if (process.argv.includes('--workspace-assets')) await useWorkspaceDashboardAssets(page, origin);
    const started = Date.now();
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const toolbar = page.locator('.dashboard-account-toolbar').first();
    await toolbar.waitFor();
    const loadMs = Date.now() - started;
    const search = toolbar.getByRole('searchbox');
    const initialSearch = await search.inputValue();
    await search.fill('');
    for (const paneWidth of width === 1440 ? [280, 420, 600, 720, 1440] : [width]) {
      await toolbar.evaluate((element, size) => { element.closest('.dashboard-content').style.width = `${size}px`; }, paneWidth);
      for (const tags of [true, false]) {
        await toolbar.evaluate((element, show) => {
          const tag = element.querySelector('.account-tag-filter');
          if (!show) { tag?.remove(); return; }
          if (tag) return;
          const fixture = element.querySelector('.account-sort-control').cloneNode(true);
          fixture.className = 'dashboard-select-control account-tag-filter';
          fixture.querySelector('select').innerHTML = '<option>All tags</option>';
          element.insertBefore(fixture, element.querySelector('.metric-priority-control'));
        }, tags);
        const label = `${width}-${paneWidth}-${tags ? 'tags' : 'no-tags'}`;
        const layout = await toolbar.evaluate(element => ({
          width: element.clientWidth, scroll: element.scrollWidth,
          controls: [...element.children].map(child => ({
            ...child.getBoundingClientRect().toJSON(),
            widthInside: child.clientWidth, scroll: child.scrollWidth,
            icon: child.querySelector('.account-filter-icon') ? getComputedStyle(child.querySelector('.account-filter-icon')).display !== 'none' : false,
          })),
          input: element.querySelector('input').getBoundingClientRect().width,
        }));
        assert.ok(layout.scroll <= layout.width + 1, `${label}: toolbar fits its pane`);
        assert.ok(layout.controls.every(control => Math.abs(control.y - layout.controls[0].y) < 1 && Math.abs(control.height - layout.controls[0].height) < 1), `${label}: controls align on one row`);
        assert.ok(layout.controls.every(control => control.scroll <= control.widthInside + 1), `${label}: controls do not overflow`);
        assert.ok(layout.input >= 60, `${label}: search text has usable space (${layout.input}px)`);
        if (paneWidth <= 600) assert.ok(layout.controls.slice(1, -1).every(control => control.icon && Math.abs(control.width - control.height) < 1), `${label}: narrow filters use square icons`);
        else assert.ok(layout.controls[0].width >= 140, `${label}: text filters cannot squeeze search`);
        if (tags) {
          for (const theme of ['light', 'dark']) {
            await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
            await toolbar.screenshot({ path: path.join(output, `${label}-${theme}.png`) });
          }
          // Local search adds a clear button, which must also fit narrow panes.
          await search.fill('toolbar-layout-check');
          assert.ok(await search.evaluate(element => element.getBoundingClientRect().width >= 20), `${label}: typing leaves room for search and clear`);
          await toolbar.getByRole('button', { name: 'Clear search', exact: true }).click();
        }
        results.push({ label, loadMs, searchWidth: layout.controls[0].width, inputWidth: layout.input });
      }
    }
    await search.fill(initialSearch);
    assert.deepEqual(errors, [], `${width}: no browser errors`);
    await context.close();
    console.log(`${width}px: toolbar layout passed`);
  }
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ checks: results.length, output, loadMs: results.map(result => result.loadMs) }));
} finally { await browser.close(); }
