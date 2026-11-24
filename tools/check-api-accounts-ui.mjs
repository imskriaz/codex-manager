import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';
import { dashboardCopyResources } from '../out/localization/resources/dashboard.js';
import { prepareDocsSnapshot } from './capture-docs-ui.mjs';

// Fixture actions never reach the host; navigation and assets are read-only.
const origin = 'http://127.0.0.1:39875';
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const state = { lang: 'en', panelTitle: 'Codex Manager', brandSub: '', logoUri: '/assets/codex.svg', onboardingCompleted: true, copy: dashboardCopyResources.en,
  settings: Object.fromEntries(Object.entries(manifest.contributes.configuration.properties).map(([key, schema]) => [key.slice('codexManager.'.length), schema.default])), accounts: [], tokenAutomation: { enabled: true }, indexHealth: { status: 'healthy', availableBackups: 0 } };
prepareDocsSnapshot(state, [{ goal: {} }, {}], []);
state.settings.privacyMode = false;
state.connectedPeers = [{ id: 'fixture-local', name: 'This PC', local: true, connected: true }];
const api = { ...state.accounts[0], id: 'api:openai:' + 'a'.repeat(64), authMode: 'apiKey', provider: 'codex', email: 'Work API', displayName: 'Work API', apiKeyHint: 'sk-••••1234', authProviderLabel: 'OpenAI', subscriptionText: 'API key', subscriptionTitle: 'API key', apiBaseUrl: 'https://api.openai.com/v1', enabled: true, isActive: false, isCurrentWindowAccount: false, metrics: [] };
state.accounts.push(api);
await mkdir('output/playwright', { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await useWorkspaceDashboardAssets(page, origin);
    await page.route('**/assets/browserHost.js*', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.addInitScript(({ state, api }) => {
      const dispatch = data => window.dispatchEvent(new MessageEvent('message', { data }));
      let attempts = 0;
      window.__apiFixture = { saves: 0, imports: 0 };
      window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message) {
        setTimeout(() => {
          if (message.type === 'dashboard:ready') { dispatch({ type: 'dashboard:snapshot', state }); dispatch({ type: 'dashboard:connection', connected: true }); }
          if (message.type !== 'dashboard:action') return;
          let payload = {};
          if (message.action === 'saveApiAccount') {
            window.__apiFixture.saves++; attempts++;
            if (attempts === 1) { dispatch({ type: 'dashboard:action-result', action: message.action, requestId: message.requestId, status: 'failed', error: 'Storage unavailable. Your details are kept.' }); return; }
            if (attempts === 2) return;
            const account = { ...api, id: 'api:anthropic:' + 'b'.repeat(64), provider: 'claude', email: message.payload.apiAccount.name, displayName: message.payload.apiAccount.name, authProviderLabel: 'Anthropic' };
            state.accounts.push(account); payload = { apiAccountSaved: { id: account.id }, notice: { level: 'info', message: 'API account saved.' } };
            dispatch({ type: 'dashboard:snapshot', state });
          }
          if (message.action === 'importCurrent') { window.__apiFixture.imports++; payload = { notice: { level: 'info', message: 'Imported current API account.' } }; }
          if (message.action === 'getUsageGraph') payload = { usageGraph: { capturedAt: Date.now(), rows: [] } };
          dispatch({ type: 'dashboard:action-result', action: message.action, requestId: message.requestId, status: 'completed', payload });
        }, 20);
      } });
    }, { state, api });
    const started = Date.now();
    await page.goto(origin);
    const card = page.getByRole('article', { name: 'API Key: OpenAI \u00b7 Work API', exact: true }); await card.waitFor();
    await card.getByRole('button', { name: 'Select API account', exact: true }).waitFor();
    await card.getByRole('button', { name: 'Verify API key', exact: true }).waitFor();
    await page.getByRole('button', { name: state.copy.addAccount, exact: true }).first().click();
    await page.getByRole('button', { name: 'Add API key', exact: true }).click();
    await page.getByRole('dialog', { name: 'API account details', exact: true }).waitFor();
    const provider = page.getByRole('combobox', { name: 'API provider', exact: true });
    await provider.selectOption('anthropic');
    await page.getByRole('textbox', { name: 'API account name', exact: true }).fill('Claude Work API');
    const key = page.getByLabel('Provider API key', { exact: true }); await key.fill('fixture-key-keep-private');
    assert.equal(await key.getAttribute('type'), 'password');
    assert.equal(await page.getByRole('textbox', { name: 'API base URL', exact: true }).getAttribute('placeholder'), 'https://api.anthropic.com');
    await page.getByRole('button', { name: 'Save API account', exact: true }).click();
    await page.getByRole('dialog', { name: 'API account details', exact: true }).getByRole('alert').filter({ hasText: 'Storage unavailable' }).waitFor();
    assert.equal(await key.inputValue(), 'fixture-key-keep-private');
    assert.equal(await page.getByRole('textbox', { name: 'API account name', exact: true }).inputValue(), 'Claude Work API');
    const dialog = page.getByRole('dialog', { name: 'API account details', exact: true });
    const bounds = await dialog.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, JSON.stringify(bounds));
    await page.screenshot({ path: `output/playwright/api-account-details-${width}.png` });
    await page.clock.install();
    await page.getByRole('button', { name: 'Save API account', exact: true }).click();
    await page.clock.runFor(50);
    await page.clock.fastForward(30_001);
    await dialog.getByRole('alert').filter({ hasText: 'outcome is unconfirmed' }).waitFor();
    assert.equal(await key.inputValue(), 'fixture-key-keep-private');
    await page.getByRole('button', { name: 'Save API account', exact: true }).click();
    await page.clock.runFor(50);
    await dialog.waitFor({ state: 'hidden' });
    const saved = page.getByRole('article', { name: 'API Key: OpenAI \u00b7 Work API', exact: true }); await saved.waitFor(); await saved.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `output/playwright/api-account-list-${width}.png` });
    assert.equal(await page.evaluate(() => window.__apiFixture.saves), 3);
    await page.getByRole('button', { name: state.copy.addAccount, exact: true }).first().click();
    await page.getByRole('button', { name: state.copy.importCurrent, exact: true }).click();
    await page.clock.runFor(50);
    assert.equal(await page.evaluate(() => window.__apiFixture.imports), 1);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, checkMs: Date.now() - started, errors, checks: 'Existing Add Account flow, provider details, API account title, failure and timeout draft retention, confirmed save, shared list and Import Current' }));
    await context.close();
  }
} finally { await browser.close(); }
