import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';
import { dashboardCopyResources } from '../out/localization/resources/dashboard.js';
import { prepareDocsSnapshot } from './capture-docs-ui.mjs';

// Every action is handled by the fixture; the real host receives read-only requests.
const origin = 'http://127.0.0.1:39875';
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const state = { lang: 'en', panelTitle: 'Codex Manager', brandSub: '', logoUri: '/assets/codex.svg', onboardingCompleted: true, copy: dashboardCopyResources.en,
  settings: Object.fromEntries(Object.entries(manifest.contributes.configuration.properties).map(([key, schema]) => [key.slice('codexManager.'.length), schema.default])), accounts: [], tokenAutomation: { enabled: true }, indexHealth: { status: 'healthy', availableBackups: 0 } };
prepareDocsSnapshot(state, [{ goal: {} }, {}], []);
state.settings.privacyMode = false;
state.connectedPeers = [{ id: 'fixture-local', name: 'This PC', local: true, connected: true }];
for (const [provider, name, digit] of [['OpenAI', 'Work API', 'a'], ['Anthropic', 'Claude API', 'b']]) state.accounts.push({ ...state.accounts[0], id: `api:${provider === 'OpenAI' ? 'openai' : 'anthropic'}:${digit.repeat(64)}`, authMode: 'apiKey', provider: provider === 'OpenAI' ? 'codex' : 'claude', email: name, displayName: name, apiKeyHint: 'sk-••••1234', authProviderLabel: provider, apiBaseUrl: 'https://provider.example.test/' + 'long-endpoint/'.repeat(20), enabled: true, queuePriority: false, isActive: false, isCurrentWindowAccount: false, healthKind: 'healthy', apiTokenUsage: { input: 1000, cachedInput: 250, output: 200 }, metrics: [] });
await mkdir('output/playwright', { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of (process.argv.length > 2 ? process.argv.slice(2).map(Number) : [1440, 390, 280])) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await useWorkspaceDashboardAssets(page, origin);
    await page.route('**/assets/browserHost.js*', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.addInitScript(({ state }) => {
      localStorage.setItem('codexManager.dashboardUiPreferences.v2', JSON.stringify({ view: 'cards', filter: 'all', metricPriority: 'hourly', accountSearch: '' }));
      const dispatch = data => window.dispatchEvent(new MessageEvent('message', { data }));
      window.__apiLayout = { actions: [], stars: 0 };
      window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message) {
        setTimeout(() => {
          if (message.type === 'dashboard:ready') { dispatch({ type: 'dashboard:snapshot', state }); dispatch({ type: 'dashboard:connection', connected: true }); }
          if (message.type !== 'dashboard:action') return;
          window.__apiLayout.actions.push(message);
          const account = state.accounts.find(account => account.id === message.accountId);
          let status = 'completed', error, payload = {};
          if (message.action === 'setAccountQueuePriority') {
            if (++window.__apiLayout.stars === 1) { status = 'failed'; error = 'Fixture star storage unavailable'; }
            else { account.queuePriority = message.payload.queuePriority; payload.notice = { level: 'info', message: 'API account starred.' }; }
          }
          if (message.action === 'toggleAccountEnabled') { account.enabled = message.payload.enabled; if (!account.enabled) account.isActive = false; payload.notice = { level: 'info', message: `API account ${account.enabled ? 'enabled' : 'disabled'}.` }; }
          if (message.action === 'switch') { account.isActive = true; payload.notice = { level: 'info', message: 'Selected API account.' }; }
          if (message.action === 'refresh') { status = 'failed'; error = 'Fixture API verification could not connect or timed out. The saved account was kept.'; }
          if (message.action === 'getUsageGraph') payload.usageGraph = { capturedAt: Date.now(), rows: [] };
          dispatch({ type: 'dashboard:snapshot', state });
          dispatch({ type: 'dashboard:action-result', action: message.action, requestId: message.requestId, status, error, payload });
        }, 20);
      } });
    }, { state });
    const started = Date.now();
    await page.goto(origin);
    const api = page.getByRole('article', { name: 'API Key: OpenAI · Work API', exact: true });
    await api.waitFor();
    const loadMs = Date.now() - started;
    for (const view of ['cards', 'list']) {
      if (view === 'list') await page.locator('.dashboard-view-toggle').first().click();
      for (const provider of ['OpenAI · Work API', 'Anthropic · Claude API']) {
        const card = page.getByRole('article', { name: `API Key: ${provider}`, exact: true });
        assert.equal(await card.locator(view === 'cards' ? '.saved-title-text' : '.saved-table-name-line strong').textContent(), 'API Key');
        assert.equal(await card.locator('.saved-plan-badge').textContent(), 'API');
        assert.equal(await card.locator('.bar').count(), 2);
        assert.equal(await card.getByText('Input tokens', { exact: true }).count(), 1);
        assert.equal(await card.getByText('Output tokens', { exact: true }).count(), 1);
        assert.equal(await card.locator('.saved-api-fresh').evaluate(element => element.style.width), '75%');
        assert.equal(await card.locator('.saved-api-cached').evaluate(element => element.style.width), '25%');
        assert.notEqual(await card.locator('.saved-api-fresh').evaluate(element => getComputedStyle(element).backgroundColor), await card.locator('.saved-api-cached').evaluate(element => getComputedStyle(element).backgroundColor));
        assert.equal(await card.locator('.percent').count(), 0);
        assert.equal(await card.getByRole('button', { name: state.copy.selectAccount, exact: true }).count(), 1);
        for (const name of ['Star API account', 'Disable API account', 'Select API account', 'Verify API key', 'More account actions']) await card.getByRole('button', { name, exact: true }).waitFor();
        const bounds = await card.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, JSON.stringify({ width, view, bounds }));
      }
      await api.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `output/playwright/api-account-${view}-${width}.png` });
    }
    await api.getByRole('button', { name: 'Star API account', exact: true }).click();
    await page.getByText('Fixture star storage unavailable', { exact: false }).first().waitFor();
    assert.equal(await api.getByRole('button', { name: 'Star API account', exact: true }).getAttribute('aria-pressed'), 'false');
    await api.getByRole('button', { name: 'Star API account', exact: true }).click();
    await api.getByRole('button', { name: 'Unstar API account', exact: true }).waitFor();
    await api.getByRole('button', { name: 'Disable API account', exact: true }).click();
    await api.getByRole('button', { name: 'Enable API account', exact: true }).waitFor();
    assert.ok(await api.getByRole('button', { name: 'Select API account', exact: true }).isDisabled());
    await api.getByRole('button', { name: 'Enable API account', exact: true }).click();
    await api.getByRole('button', { name: 'Disable API account', exact: true }).waitFor();
    await api.getByRole('button', { name: 'Select API account', exact: true }).click();
    await api.getByRole('button', { name: 'Selected API account', exact: true }).waitFor();
    await api.getByRole('button', { name: 'Verify API key', exact: true }).click();
    await page.getByText('Fixture API verification could not connect or timed out.', { exact: false }).first().waitFor();
    await api.getByRole('button', { name: 'More account actions', exact: true }).click();
    const menu = page.locator('.saved-overflow-menu[role="menu"]');
    await menu.getByText('sk-••••1234', { exact: false }).waitFor();
    const menuBounds = await menu.boundingBox();
    assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= width + 1, JSON.stringify(menuBounds));
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    assert.ok(await api.getByRole('button', { name: 'More account actions', exact: true }).evaluate(element => element === document.activeElement));
    await api.getByRole('button', { name: 'More account actions', exact: true }).click();
    await menu.getByRole('menuitem', { name: 'Remove account', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Remove account', exact: true });
    await confirmation.waitFor();
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__apiLayout.actions.filter(action => action.action === 'remove').length), 0);
    if (width >= 390) {
      await page.goto(origin + '/workspace');
      await page.locator('.cli-workspace').waitFor();
      const showSidebar = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
      if (await showSidebar.isVisible()) await showSidebar.click();
      await page.locator('.cli-account-footer:not(.is-standalone)').getByRole('button', { name: 'Account menu', exact: true }).click();
      await page.getByRole('menu', { name: 'Account menu', exact: true }).getByRole('menuitem', { name: 'Open account center', exact: true }).click();
      const center = page.locator('.workspace-dashboard');
      await center.waitFor();
      for (const view of ['cards', 'list']) {
        if (view === 'list') await center.locator('.dashboard-view-toggle').click();
        const compactApi = center.getByRole('article', { name: 'API Key: OpenAI \u00b7 Work API', exact: true });
        await compactApi.getByRole('button', { name: 'Disable API account', exact: true }).waitFor();
        await compactApi.getByRole('button', { name: 'Star API account', exact: true }).waitFor();
        assert.equal(await compactApi.locator('.saved-plan-badge').textContent(), 'API');
        assert.equal(await compactApi.locator('.bar').count(), 2);
        await compactApi.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `output/playwright/api-account-center-${view}-${width}.png` });
      }
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, loadMs, checkMs: Date.now() - started, checks: 'Both providers, grid/list, API title/badge, input/output tokens and fresh/cached bar colors, selection, star failure/success, enable/disable, key verification failure, overflow, keyboard and remove cancellation', errors }));
    await context.close();
  }
} finally { await browser.close(); }
