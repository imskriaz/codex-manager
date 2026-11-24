import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

const origin = 'http://127.0.0.1:39875';
const output = 'output/playwright/auto-queue';
await mkdir(output, { recursive: true });
const response = await fetch(`${origin}/api/state`, { signal: AbortSignal.timeout(15_000) });
assert.ok(response.ok, 'Canonical local dashboard snapshot is readable');
const snapshot = await response.json();
const template = snapshot.accounts.find(account => account.provider !== 'claude' && account.authMode !== 'apiKey');
assert.ok(template, 'Local snapshot has a Codex card template');
snapshot.lang = 'en';
snapshot.connectedPeers = [];
snapshot.peerAccounts = {};
snapshot.currentAccountId = undefined;
Object.assign(snapshot.settings, { privacyMode: false, autoSwitchEnabled: true, autoResetEnabled: false, dashboardTheme: 'dark' });
const now = Date.now();
snapshot.accounts = [68, 84, 106, 24, 3 * 1440].map((minutes, index) => ({
  ...template, id: `queue-fixture-${index}`, email: `reset-${minutes}m@example.test`, displayName: `Reset ${minutes}m`,
  isActive: false, isCurrentWindowAccount: false, enabled: true, queuePriority: false, switchQueued: false,
  provider: 'codex', healthKind: 'healthy', healthLabel: '', healthMessage: '', hasQuotaError: false, hasPendingResetCreditAttempt: false,
  creditsBalance: 0, creditsUnlimited: false, resetCreditsAvailable: 0, tags: [],
  runningDeviceName: undefined, runningOnThisDevice: false, subscriptionExpiresAt: undefined,
  addedAt: now - (index + 1) * 86400_000, lastQuotaAt: now - 1000, sessionStartedAt: undefined,
  metrics: [{ key: 'hourly', period: 'hourly', label: '5h', visible: true, percentage: 0, resetAt: now / 1000 + minutes * 60 },
    { key: 'weekly', period: 'weekly', label: 'Weekly', visible: true, percentage: index === 4 ? 0 : 53, resetAt: now / 1000 + (index === 4 ? 3 : 6) * 86400 }]
}));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const width of [390, 602, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await useWorkspaceDashboardAssets(page, origin);
    // All host actions stay in memory; the live service receives GET requests only.
    await page.route('**/assets/browserHost.js*', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('**/*', route => ['GET', 'HEAD'].includes(route.request().method()) ? route.fallback() : route.abort());
    await page.addInitScript(state => {
      window.__queueState = state;
      localStorage.setItem('codexManager.dashboardAccountSort.v3', 'auto-queue');
      const dispatch = data => window.dispatchEvent(new MessageEvent('message', { data }));
      window.acquireVsCodeApi = () => ({ setState() {}, postMessage(message) {
        setTimeout(() => {
          if (message.type === 'dashboard:ready') {
            dispatch({ type: 'dashboard:snapshot', state });
            dispatch({ type: 'dashboard:connection', connected: true });
          } else if (message.type === 'dashboard:action') {
            dispatch({ type: 'dashboard:action-result', action: message.action, requestId: message.requestId, status: 'completed', payload: { cliSessions: [], cliSessionsDeviceId: undefined } });
          }
        }, 0);
      } });
    }, snapshot);
    const start = Date.now();
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('.saved-card-front, .saved-table-row').first().waitFor();
    const loadMs = Date.now() - start;
    const toolbar = page.locator('.dashboard-account-toolbar:visible');
    await toolbar.getByRole('combobox', { name: 'Sort accounts', exact: true }).selectOption('auto-queue');
    const expected = [24, 68, 84, 106, 4320].map(minutes => `reset-${minutes}m@example.test`);
    for (const list of [false, true]) {
      if ((await page.locator('.saved-table-row').count() > 0) !== list) await toolbar.locator('.dashboard-view-toggle').click();
      const rows = page.locator(list ? '.saved-table-row' : '.saved-card-front');
      await rows.first().waitFor();
      const names = await rows.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
      assert.deepEqual(names, expected, `${width}px: resets stay chronological in ${list ? 'list' : 'cards'}`);
      assert.equal(await page.locator('.saved-auto-queue-next').count(), 0, 'Ordering adds no badges');
      assert.ok(await rows.evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1)), 'Cards fit their width');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Viewport has no horizontal overflow');
      await rows.first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/${width}-${list ? 'list' : 'cards'}.png` });
    }
    await page.evaluate(() => {
      const state = window.__queueState;
      state.accounts[0].metrics[0].percentage = 70;
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:snapshot', state: structuredClone(state) } }));
    });
    await page.waitForFunction(() => document.querySelector('.saved-table-row')?.getAttribute('aria-label') === 'reset-68m@example.test');
    assert.equal(await page.locator('.saved-table-row').first().getAttribute('aria-label'), 'reset-68m@example.test');
    assert.deepEqual(errors, [], 'No runtime or console errors');
    results.push({ width, loadMs, layouts: ['cards', 'list'], resetOrder: 'passed', eligibleOrder: 'passed', consoleErrors: errors.length });
    await context.close();
  }
} finally { await browser.close(); }
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
