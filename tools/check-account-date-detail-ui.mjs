import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { dashboardCopyResources } from '../out/localization/resources/dashboard.js';
import { prepareDocsSnapshot } from './capture-docs-ui.mjs';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

const origin = 'http://127.0.0.1:39875';
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const state = { lang: 'en', panelTitle: 'Codex Manager', copy: dashboardCopyResources.en,
  settings: Object.fromEntries(Object.entries(manifest.contributes.configuration.properties).map(([key, schema]) => [key.slice('codexManager.'.length), schema.default])) };
prepareDocsSnapshot(state, [{ goal: {} }, {}], []);
state.onboardingCompleted = true;
state.peerAccounts = {};
state.accounts = state.accounts.slice(0, 2);
Object.assign(state.accounts[0], { addedAtLabel: '2026/11/24 10:00', addedAt: 1795492800000, loginAt: 1795485600000, lastQuotaAt: 1795492800000 });
Object.assign(state.accounts[1], { addedAtLabel: '', addedAt: undefined, loginAt: undefined, lastQuotaAt: undefined });
await mkdir('output/playwright', { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [320, 390, 760, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await useWorkspaceDashboardAssets(page, origin);
    await page.route('**/assets/browserHost.js*', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.addInitScript(state => {
      const dispatch = data => window.dispatchEvent(new MessageEvent('message', { data }));
      window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message) {
        setTimeout(() => {
          if (message.type === 'dashboard:ready') {
            dispatch({ type: 'dashboard:snapshot', state });
            dispatch({ type: 'dashboard:connection', connected: true });
          }
          if (message.type === 'dashboard:action') dispatch({ type: 'dashboard:action-result', requestId: message.requestId,
            action: message.action, status: 'completed', payload: {} });
        }, 0);
      } });
    }, state);
    const started = Date.now();
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const dashboard = page.locator('#dashboard-main');
    await dashboard.locator('.saved-card-front, .saved-table-row').first().waitFor();
    const readyMs = Date.now() - started;
    for (const list of [false, true]) {
      if ((await dashboard.locator('.saved-table-row').count() > 0) !== list) await dashboard.locator('.dashboard-account-toolbar .dashboard-view-toggle').click();
      const rows = dashboard.locator(list ? '.saved-table-row' : '.saved-card-front');
      const metadata = rows.locator(list ? '.saved-table-meta' : '.saved-credit-summary');
      for (const [sort, label, value] of [
        ['date-added', 'Added', state.accounts[0].addedAtLabel],
        ['last-refresh', 'Refreshed', new Date(state.accounts[0].lastQuotaAt).toLocaleString()],
        ['login-date', 'Login', new Date(state.accounts[0].loginAt).toLocaleString()]
      ]) {
        await dashboard.locator('.account-sort-control select').selectOption(sort);
        await page.waitForFunction(({ list, label }) => [...document.querySelectorAll(`#dashboard-main ${list ? '.saved-table-meta' : '.saved-credit-summary'}`)].every(element => element.textContent.startsWith(label + ': ')), { list, label });
        assert.deepEqual(await metadata.allTextContents(), [`${label}: ${value}`, `${label}: —`]);
        assert.ok(await metadata.evaluateAll(elements => elements.every(element => element.children.length === 1 && element.firstElementChild.classList.contains('saved-sort-detail'))));
        assert.equal(await metadata.locator('.pill, .saved-account-tags, button').count(), 0);
        assert.ok(await rows.evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1)), 'Account rows fit');
        const firstDetail = metadata.first().locator('.saved-sort-detail');
        assert.ok(await firstDetail.isVisible(), `Selected date is visible at ${width}px in ${list ? 'list' : 'cards'}`);
        assert.equal(await firstDetail.getAttribute('title'), `${label}: ${value}`);
        if (sort === 'date-added') await page.screenshot({ path: `output/playwright/account-date-${width}-${list ? 'list' : 'cards'}.png` });
      }
      await dashboard.locator('.account-sort-control select').selectOption('time-left');
      await metadata.first().locator('.saved-plan-badge').waitFor();
      assert.equal(await metadata.locator('.saved-sort-detail').count(), 0);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, readyMs, elapsedMs: Date.now() - started, layouts: 2, dateSorts: 3, errors }));
    await context.close();
  }
} finally { await browser.close(); }
