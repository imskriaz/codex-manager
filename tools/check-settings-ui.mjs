import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

// Read-only checks against the local host; never submit settings or Team forms.
const origin = 'http://127.0.0.1:39875';
const output = path.join(tmpdir(), 'codex-manager-settings-ui');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const [width, height] of [[1440, 1000], [1024, 768], [390, 844], [320, 667], [844, 390]]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 760, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.url().includes('/api/office/') && response.status() >= 400) console.log(JSON.stringify({url:response.url(),status:response.status()})); });
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await useWorkspaceDashboardAssets(page, origin);
    const start = Date.now();
    await page.goto(`${origin}/?settings=general`, { waitUntil: 'domcontentloaded' });
    const settings = page.locator('.settings-master-modal');
    await settings.waitFor({ state: 'visible' });
    const openMs = Date.now() - start;
    const picker = settings.locator('.settings-mobile-picker select');
    const sections = await picker.locator('option').evaluateAll(options => options.map(option => option.value));
    assert.ok(sections.includes('modules') && sections.includes('tools'));
    for (const section of sections) {
      if (await picker.isVisible()) await picker.selectOption(section);
      else await settings.locator(`#settings-tab-${section}`).click();
      await settings.locator(`#settings-panel-${section}`).waitFor({ state: 'visible' });
      if (['users', 'workspace', 'mcp', 'database', 'logs', 'proxy'].includes(section)) {
        await settings.getByText(/Loading (Team settings|activity|proxy)/).waitFor({ state: 'hidden' });
      }
      const geometry = await settings.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const body = element.querySelector('.settings-modal-body');
        return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
          width: body.clientWidth, scrollWidth: body.scrollWidth };
      });
      assert.ok(geometry.x >= 0 && geometry.y >= 0 && geometry.right <= width + 1 && geometry.bottom <= height + 1, `${width}/${section}: Settings fits the viewport ${JSON.stringify(geometry)}`);
      assert.ok(geometry.scrollWidth <= geometry.width + 1, `${width}/${section}: content fits without horizontal scrolling ${JSON.stringify(geometry)}`);
      assert.equal(await page.getByRole('dialog').count(), 1, 'One Settings dialog owns the flow');
      if (['general', 'modules', 'connections', 'tools', 'users'].includes(section)) await page.screenshot({ path: path.join(output, `${section}-${width}x${height}.png`) });
    }
    // Opening and cancelling an inline editor sends no mutation.
    if (sections.includes('users')) {
      if (await picker.isVisible()) await picker.selectOption('users');
      else await settings.locator('#settings-tab-users').click();
      await settings.getByRole('button', { name: 'Add user', exact: true }).click();
      await settings.getByRole('region', { name: 'Add Team user', exact: true }).waitFor();
      assert.equal(await page.getByRole('dialog').count(), 1);
      await settings.getByRole('button', { name: 'Back to users', exact: true }).click();
      await settings.getByText('User editing cancelled.', { exact: true }).waitFor();
    }
    await settings.locator('.settings-close').click();
    await settings.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, [], `${width}: browser console/runtime errors`);
    results.push({ width, height, openMs, sections, consoleErrors: errors.length });
    console.log(JSON.stringify(results.at(-1)));
    await context.close();
  }
} finally { await browser.close(); }
await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
console.log(`Screenshots: ${output}`);
