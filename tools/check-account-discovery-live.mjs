import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

// Real read-only host. Delay its actual first project-discovery reply in this
// browser to reproduce opening Accounts before project metadata arrives.
const origin = 'http://127.0.0.1:39875';
const output = 'output/live-audit';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const width of [1440, 390]) for (const route of ['/', '/workspace', '/tasks']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (process.argv.includes('--workspace-assets')) await useWorkspaceDashboardAssets(page, origin);
    await page.addInitScript(() => {
      window.delayedDiscovery = undefined;
      window.addEventListener('message', event => {
        const message = event.data;
        if (!window.delayedDiscovery && message?.type === 'dashboard:action-result' && message.action === 'listCodexCliSessions' && message.status === 'completed' && message.payload?.cliComposerConfig) {
          window.delayedDiscovery = message;
          event.stopImmediatePropagation();
        }
      }, true);
    });
    try {
      await page.goto(origin + route);
      await page.locator('.cli-workspace').waitFor();
      const sidebar = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
      if (await sidebar.isVisible()) await sidebar.click();
      await page.getByRole('button', { name: 'Open account center', exact: true }).click();
      await page.locator('.workspace-accounts').waitFor();
      await page.waitForFunction(() => !!window.delayedDiscovery, undefined, { timeout: 30000 });
      await page.evaluate(() => window.postMessage(window.delayedDiscovery, '*'));
      // Include subsequent peer discovery and snapshot refreshes.
      await page.waitForTimeout(2500);
      assert.ok(await page.locator('.workspace-accounts').isVisible(), `${width}px ${route}: Accounts survives project discovery`);
      assert.equal(await page.locator('.cli-context-tabs-v3 [aria-selected="true"]').innerText(), 'Accounts');
      const tools = page.getByRole('complementary', { name: 'Workspace tools', exact: true });
      await tools.getByRole('button', { name: 'Close workspace tools', exact: true }).click();
      await page.locator('.workspace-accounts').waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []);
      results.push({ width, route, status: 'passed' });
      console.log(`PASS ${width}px ${route}: delayed project discovery preserves Accounts; Close works`);
    } catch (error) {
      await page.screenshot({ path: `${output}/account-discovery-failure-${width}-${route.slice(1) || 'home'}.png` });
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await writeFile(`${output}/account-discovery-results.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
