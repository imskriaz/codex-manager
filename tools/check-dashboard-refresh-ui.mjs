import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

const origin = 'http://127.0.0.1:39875';
const response = await fetch(`${origin}/api/state`);
assert.ok(response.ok, 'Local dashboard is available');
const snapshot = await response.json();
assert.ok(snapshot.accounts[0], 'A saved account supplies the rendering fixture');
snapshot.onboardingCompleted = true;
Object.assign(snapshot.settings, { cliIntegrationEnabled: false, privacyMode: false, dailyTokenUsageEnabled: false });
snapshot.accounts = snapshot.accounts.slice(0, 2).map(account => ({ ...account, canRefreshToken: true }));
const host = `(() => {
  const state = ${JSON.stringify(snapshot)};
  const dispatch = data => window.dispatchEvent(new MessageEvent('message', { data }));
  window.__refreshActions = [];
  window.__finishRefresh = (status = 'completed') => {
    const result = window.__heldRefresh;
    window.__heldRefresh = undefined;
    dispatch({ ...result, status, error: status === 'failed' ? 'Quota refresh failed. Saved accounts were kept.' : undefined });
  };
  window.acquireVsCodeApi = () => ({ postMessage(message) {
    window.__refreshActions.push(message);
    setTimeout(() => {
      if (message.type === 'dashboard:ready') {
        dispatch({ type: 'dashboard:snapshot', state });
        dispatch({ type: 'dashboard:connection', connected: true });
      }
      if (message.type !== 'dashboard:action') return;
      let payload = {};
      if (message.action === 'getUsageGraph') payload.usageGraph = { ...message.payload.usageGraph, history: [], dailyUsageCache: [], truncated: false };
      if (message.action === 'getDailyUsage') payload = { dailyUsage: { days: 30, points: [] }, dailyUsageFetchedAt: Date.now() };
      const result = { type: 'dashboard:action-result', requestId: message.requestId, action: message.action, accountId: message.accountId, status: 'completed', payload };
      if (window.__holdRefresh && ['refreshAll', 'refresh'].includes(message.action)) window.__heldRefresh = result;
      else dispatch(result);
    }, 150);
  }, getState() {}, setState() {} });
})();`;
const output = path.join(tmpdir(), 'codex-manager-dashboard-refresh');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await useWorkspaceDashboardAssets(page, origin);
    await page.route('**/api/**', route => route.abort());
    await page.route('**/assets/browserHost.js*', route => route.fulfill({ contentType: 'text/javascript', body: host }));
    await page.goto(origin);
    const refreshAll = page.locator('.overview-actions').getByRole('button', { name: snapshot.copy.refreshAll, exact: true });
    await refreshAll.waitFor();
    assert.equal(await refreshAll.locator('svg').count(), 1, 'Overview refresh has its icon');
    await page.evaluate(() => { window.__holdRefresh = true; });
    await refreshAll.click();
    await page.waitForFunction(() => !!window.__heldRefresh);
    assert.ok(await refreshAll.isDisabled(), 'Refresh all prevents duplicate requests while pending');
    await page.evaluate(() => window.__finishRefresh('failed'));
    await page.getByRole('alert').filter({ hasText: 'Quota refresh failed. Saved accounts were kept.' }).waitFor();
    await refreshAll.click();
    await page.waitForFunction(() => !!window.__heldRefresh);
    await page.evaluate(() => window.__finishRefresh());
    await page.waitForFunction(button => !button.disabled, await refreshAll.elementHandle());
    const refreshAccount = page.locator('.accounts-grid').getByRole('button', { name: snapshot.copy.refreshBtn, exact: true }).first();
    await refreshAccount.click();
    await page.waitForFunction(() => window.__heldRefresh?.action === 'refresh');
    assert.ok(await refreshAccount.isDisabled(), 'Account refresh prevents duplicate requests');
    assert.ok(await page.evaluate(() => !!window.__heldRefresh.accountId), 'Account refresh preserves its target');
    await page.evaluate(() => { window.__holdRefresh = false; window.__finishRefresh(); });
    await page.waitForFunction(button => !button.disabled, await refreshAccount.elementHandle());
    await page.screenshot({ path: path.join(output, `dashboard-${width}.png`) });
    await page.getByRole('button', { name: 'Graph settings', exact: true }).click();
    const graph = page.getByRole('dialog', { name: 'Graph settings', exact: true });
    await graph.getByRole('button', { name: 'Token usage', exact: true }).click();
    await page.getByRole('button', { name: 'Graph settings', exact: true }).click();
    await graph.getByRole('button', { name: 'Refresh all', exact: true }).click();
    await graph.getByRole('status').filter({ hasText: 'Finished:' }).waitFor();
    assert.equal(await graph.locator('.usage-graph-account-refresh').count(), snapshot.accounts.length, 'Token history has per-account refresh controls');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Dashboard fits the viewport');
    assert.deepEqual(errors, [], 'No browser runtime errors');
    console.log(`${width}px: refresh icons, routing, pending guards, failure/success feedback and token history passed`);
    await context.close();
  }
  console.log(`Screenshots: ${output}`);
} finally { await browser.close(); }
