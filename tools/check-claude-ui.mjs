import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';
import { dashboardCopyResources } from '../out/localization/resources/dashboard.js';
import { prepareDocsSnapshot } from './capture-docs-ui.mjs';

// Read-only host smoke; fixture messages never reach a native runtime or account action.
const origin = 'http://127.0.0.1:39875';
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const state = { lang: 'en', panelTitle: 'Codex Manager', brandSub: '', logoUri: '/assets/codex.svg', onboardingCompleted: true, copy: dashboardCopyResources.en,
  settings: Object.fromEntries(Object.entries(manifest.contributes.configuration.properties).map(([key, schema]) => [key.slice('codexManager.'.length), schema.default])), accounts: [], tokenAutomation: { enabled: true }, indexHealth: { status: 'healthy', availableBackups: 0 } };
prepareDocsSnapshot(state, [{ goal: {} }, {}], []);
state.settings.privacyMode = false;
state.settings.cliIntegrationEnabled = true;
state.connectedPeers = [{ id: 'fixture-local', name: 'This PC', local: true, connected: true }];
state.accounts.push({ ...state.accounts[0], id: 'claude:fixture', provider: 'claude', email: 'native@example.test', displayName: 'Claude Code', subscriptionText: 'Native login', subscriptionTitle: 'Managed by Claude Code', enabled: false, isActive: false, isCurrentWindowAccount: false, canRefreshToken: false, metrics: [] });
const id = '01a04882-d037-7a42-ad24-9afb61901188';
const session = { id, title: 'Native Claude conversation', provider: 'claude', model: 'claude-code/opus', reasoningEffort: 'high', status: 'running', projectPath: 'D:/demo', updatedAt: new Date().toISOString(), canStop: true };
const config = { models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', reasoningEfforts: ['low', 'high'] }, { id: 'claude-code/opus', label: 'Native Opus', provider: 'claude', reasoningEfforts: ['low', 'high', 'max'] }, { id: 'claude-code/haiku', label: 'Native Haiku', provider: 'claude', reasoningEfforts: [] }], projects: [{ id: 'demo', path: 'D:/demo', label: 'demo' }], defaultModel: 'gpt-6.1-sol', defaultReasoningEffort: 'high', defaultSandboxMode: 'danger-full-access' };
await mkdir('output/playwright', { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await useWorkspaceDashboardAssets(page, origin);
    await page.route('**/assets/browserHost.js*', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.route('**/api/**', route => route.abort());
    await page.addInitScript(({ state, session, config }) => {
      const dispatch = data => window.dispatchEvent(new MessageEvent('message', { data }));
      window.__claudeFixture = { state, session, config };
      window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message) {
        setTimeout(() => {
          if (message.type === 'dashboard:ready') { dispatch({ type: 'dashboard:snapshot', state }); dispatch({ type: 'dashboard:connection', connected: true }); }
          if (message.type !== 'dashboard:action') return;
          const payload = message.action === 'listCodexCliSessions' ? { cliSessions: [session], cliComposerConfig: config }
            : message.action === 'getCodexCliSessionMessages' ? { cliSession: session, cliSessionMessages: [{ id: 'answer', role: 'assistant', text: 'Native runtime ready.' }], cliComposerConfig: config } : {};
          dispatch({ type: 'dashboard:action-result', action: message.action, requestId: message.requestId, status: 'completed', payload });
        }, 20);
      } });
    }, { state, session, config });
    const started = Date.now();
    await page.goto(`${origin}/workspace/${id}`);
    await page.getByRole('textbox', { name: 'Message Claude', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Message settings', exact: true }).click();
    const model = page.getByRole('combobox', { name: 'Model', exact: true });
    assert.equal(await model.isDisabled(), false, 'An active turn keeps provider/model changes available for the next turn');
    assert.equal(await page.getByText('Stop the active turn before changing model or provider.', { exact: true }).count(), 0, 'The old visible lock helper is not rendered');
    assert.equal(await model.getAttribute('title'), 'Changes apply to the next turn');
    assert.equal(await page.getByRole('combobox', { name: 'Reasoning', exact: true }).getAttribute('title'), 'Changes apply to the next turn');
    assert.deepEqual(await model.locator('optgroup').evaluateAll(nodes => nodes.map(node => node.label)), ['OpenAI', 'Claude']);
    assert.equal(await model.locator('option[value="gpt-6.1-sol"]').textContent(), 'GPT-6.1-Sol');
    assert.equal(await model.locator('option[value="claude-code/opus"]').textContent(), 'Native Opus');
    assert.deepEqual(await page.getByRole('combobox', { name: 'Reasoning', exact: true }).locator('option').evaluateAll(nodes => nodes.map(node => node.value)), ['low', 'high', 'max']);
    await page.screenshot({ path: `output/playwright/claude-native-running-${width}.png` });
    await page.evaluate(() => { const { session, config } = window.__claudeFixture; session.status = 'idle'; window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action: 'getCodexCliSessionMessages', requestId: 'fixture-idle', status: 'completed', payload: { cliSession: session, cliSessionMessages: [], cliComposerConfig: config } } })); });
    await page.waitForFunction(() => !document.querySelector('select[name="model"]')?.disabled);
    await model.selectOption('claude-code/haiku');
    assert.equal(await page.getByRole('combobox', { name: 'Reasoning', exact: true }).isDisabled(), true);
    await page.keyboard.press('Escape');
    await page.goto(origin);
    await page.locator('article').filter({ hasText: 'native@example.test' }).first().waitFor();
    await page.getByText('Quota not reported by Claude', { exact: true }).first().waitFor();
    await page.screenshot({ path: `output/playwright/claude-shared-accounts-${width}.png` });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, checkMs: Date.now() - started, errors, checks: 'Exact names, shared native account row, grouped picker, native reasoning, active-turn next-turn settings' }));
    await context.close();
  }
} finally { await browser.close(); }
