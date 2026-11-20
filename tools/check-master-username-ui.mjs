import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

const origin = 'http://127.0.0.1:39875';
const output = path.join(os.tmpdir(), 'codex-manager-master-username-ui');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await useWorkspaceDashboardAssets(page, origin);
    const start = Date.now();
    await page.goto(origin);
    // Exercise the signed-in remote presentation against the read-only local host.
    await page.evaluate(() => {
      document.documentElement.dataset.dashboardRemote = 'true';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { if (!text) throw new Error('Empty username'); } } });
    });
    if (width === 390) await page.getByRole('button', { name: 'Show sessions sidebar', exact: true }).click();
    await page.locator('.cli-settings-shortcut').click();
    const settings = page.getByRole('dialog', { name: /settings/i }).first();
    const settingsUsername = settings.getByLabel('Master username', { exact: true });
    await settingsUsername.waitFor();
    await page.waitForFunction(() => !!document.querySelector('.settings-master-modal .master-username-input input')?.value);
    assert.equal(await settingsUsername.getAttribute('readonly'), '');
    assert.equal(await settings.getByRole('button', { name: 'Rotate master username', exact: true }).count(), 0);
    await settings.getByRole('button', { name: 'Change Password', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Change password', exact: true });
    const username = dialog.getByLabel('Master username', { exact: true });
    await username.waitFor();
    await page.waitForFunction(input => !!input.value, await username.elementHandle());
    assert.ok(await username.inputValue(), 'Signed-in master identity loaded');
    assert.equal(await username.getAttribute('readonly'), '');
    await dialog.getByRole('button', { name: 'Copy master username', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Master username copied.' }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Rotate master username', exact: true }).count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    await page.screenshot({ path: path.join(output, `password-${width}.png`), mask: [settingsUsername, username], fullPage: true });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, elapsedMs: Date.now() - start, identityVisible: true, copyFeedback: true, errors: 0 }));
    await context.close();
  }
  console.log(`Masked screenshots: ${output}`);
} finally { await browser.close(); }
