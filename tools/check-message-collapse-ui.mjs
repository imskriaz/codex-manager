import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

const origin = 'http://127.0.0.1:39875';
const response = await fetch(`${origin}/api/state`);
assert.equal(response.status, 200);
const state = await response.json();
Object.assign(state.settings, { cliIntegrationEnabled: true, privacyMode: false });
state.connectedPeers = [{ id: 'fixture-local', name: 'This PC', local: true, connected: true }];
state.peerAccounts = {};
const session = { id: '01a04882-d037-7a42-ad24-9afb61901188', title: 'Pasted logs', status: 'idle', projectPath: 'D:/demo', model: 'gpt-5', updatedAt: new Date().toISOString() };
const log = ['Windows PowerShell', '', ...Array.from({ length: 24 }, (_, index) => `Log line ${index}: command output preserved`), 'Access denied. Original error details.'].join('\n');
const wrapped = 'Wrapped output stays available. '.repeat(30);
const messages = [
  { id: 'log', kind: 'message', role: 'user', text: log },
  { id: 'answer', kind: 'message', role: 'assistant', text: log },
  { id: 'short', kind: 'message', role: 'user', text: 'Short message' },
  { id: 'eight', kind: 'message', role: 'user', text: Array.from({ length: 8 }, (_, i) => `Line ${i}`).join('\n') },
  { id: 'wrapped', kind: 'message', role: 'user', text: wrapped },
  { id: 'responsive', kind: 'message', role: 'user', text: 'Responsive message. '.repeat(22) }
];
await mkdir('output/playwright', { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await useWorkspaceDashboardAssets(page, origin, context);
    // Only navigation and static assets reach the host; all actions use the fixture.
    await context.route('**/api/**', route => route.fulfill({ json: {} }));
    await context.route('**/api/email/preferences', route => route.fulfill({ json: { watches: [], available: false } }));
    await context.route('**/assets/browserHost.js*', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.addInitScript(({ state, session, messages }) => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copiedText = text; } } });
      const dispatch = data => window.dispatchEvent(new MessageEvent('message', { data }));
      const config = { standalone: true, models: [{ id: 'gpt-5', label: 'GPT-5', reasoningEfforts: ['medium'] }], projects: [{ id: 'demo', path: 'D:/demo', label: 'demo' }], defaultModel: 'gpt-5' };
      window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message) {
        setTimeout(() => {
          if (message.type === 'dashboard:ready') {
            dispatch({ type: 'dashboard:snapshot', state });
            dispatch({ type: 'dashboard:connection', connected: true });
          }
          if (message.type !== 'dashboard:action') return;
          let payload = {};
          if (message.action === 'listCodexCliSessions') payload = { cliSessions: [session], cliComposerConfig: config };
          if (message.action === 'getCodexCliSessionMessages') payload = { cliSession: session, cliSessionMessages: messages };
          if (message.action === 'getWorkspaceEnvironment') payload = { workspaceEnvironment: { projectPath: 'D:/demo', projectName: 'demo', branch: 'main', isGitRepository: true, changes: 0 } };
          if (message.action === 'listWorkspaceFiles') payload = { workspaceFiles: [] };
          if (message.action === 'listWorkspaceTerminals') payload = { workspaceTerminals: [] };
          dispatch({ type: 'dashboard:action-result', action: message.action, requestId: message.requestId, status: 'completed', payload });
        }, 0);
      } });
    }, { state, session, messages });
    const start = Date.now();
    await page.goto(`${origin}/workspace/${session.id}`, { waitUntil: 'domcontentloaded' });
    const users = page.locator('.cli-conversation .cli-session-message.is-user');
    const pasted = users.filter({ hasText: 'Windows PowerShell' });
    const more = pasted.getByRole('button', { name: 'Show more', exact: true });
    await more.waitFor();
    const readyMs = Date.now() - start;
    assert.equal(await more.getAttribute('aria-expanded'), 'false');
    assert.equal(await pasted.locator('.cli-user-message-preview').textContent(), log);
    const preview = pasted.locator('.cli-user-message-preview');
    const collapsedHeight = await preview.evaluate(element => element.getBoundingClientRect().height);
    assert.ok(await preview.evaluate(element => element.clientHeight <= parseFloat(getComputedStyle(element).lineHeight) * 8 + 1));
    for (const text of ['Short message', /Line 0\nLine 1/]) {
      const message = users.filter({ hasText: text });
      assert.equal(await message.locator('.cli-user-message-toggle').count(), 0, JSON.stringify(await message.locator('.cli-user-message-preview > div').evaluate(element => ({ text: element.textContent, height: element.scrollHeight, lineHeight: getComputedStyle(element).lineHeight, width: element.clientWidth }))));
    }
    assert.equal(await page.locator('.cli-conversation .cli-session-message.is-assistant .cli-user-message-toggle').count(), 0);
    const wrappedMessage = users.filter({ hasText: wrapped });
    assert.equal(await wrappedMessage.getByRole('button', { name: 'Show more', exact: true }).count(), 1);
    await pasted.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `output/playwright/message-collapsed-${width}.png` });
    await more.focus();
    await page.keyboard.press('Enter');
    const less = pasted.getByRole('button', { name: 'Show less', exact: true });
    assert.equal(await less.getAttribute('aria-expanded'), 'true');
    assert.ok(await preview.evaluate(element => element.clientHeight >= element.scrollHeight));
    assert.ok(await preview.evaluate(element => element.getBoundingClientRect().height) > collapsedHeight);
    assert.equal(await wrappedMessage.getByRole('button', { name: 'Show more', exact: true }).getAttribute('aria-expanded'), 'false');
    await page.screenshot({ path: `output/playwright/message-expanded-${width}.png` });
    await less.focus();
    await page.keyboard.press('Space');
    assert.equal(await more.getAttribute('aria-expanded'), 'false');
    assert.equal(await preview.evaluate(element => element.getBoundingClientRect().height), collapsedHeight);
    await pasted.hover();
    await pasted.getByRole('button', { name: 'Copy message', exact: true }).click();
    assert.equal(await page.evaluate(() => window.copiedText), log);
    await pasted.getByRole('button', { name: 'Edit and resend', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Message Codex', exact: true }).inputValue(), log);
    assert.ok(await pasted.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    if (width === 1440) {
      const responsive = users.filter({ hasText: 'Responsive message.' });
      assert.equal(await responsive.locator('.cli-user-message-toggle').count(), 0);
      await page.setViewportSize({ width: 320, height: 900 });
      await responsive.getByRole('button', { name: 'Show more', exact: true }).waitFor();
      await page.setViewportSize({ width: 1440, height: 900 });
      await responsive.locator('.cli-user-message-toggle').waitFor({ state: 'detached' });
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, readyMs, consoleErrors: errors.length, checks: 'collapse, expand, keyboard, independent messages, full copy/edit, responsive wrapping' }));
    await context.close();
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await useWorkspaceDashboardAssets(page, origin);
  const start = Date.now();
  await page.goto(`${origin}/workspace`, { waitUntil: 'domcontentloaded' });
  await page.locator('.cli-workspace').waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ live: true, readyMs: Date.now() - start, consoleErrors: errors.length }));
} finally { await browser.close(); }
