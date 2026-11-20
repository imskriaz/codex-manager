import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

// Requests that edit Team state are fulfilled in the browser; no real users or settings change.
const origin = 'http://127.0.0.1:39875';
const output = path.join(os.tmpdir(), 'codex-manager-team-ui');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [1440, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await useWorkspaceDashboardAssets(page, origin);
    const user = { id: 'fixture-user', username: 'alex', displayName: 'Alex Morgan', role: 'user', enabled: true, features: ['generalChat', 'tasks', 'files', 'browser'], defaultPrompt: '', workspacePath: 'C:/team/alex', mcpServers: [], createdAt: 0 };
    let failSave = true;
    let saved;
    await page.route('**/api/office/**', async route => {
      const request = route.request(), url = new URL(request.url());
      let body;
      if (url.pathname === '/api/office/users') body = { users: [user] };
      else if (url.pathname === '/api/office/mcp') body = { servers: [{ id: 'smartoffice', label: 'SmartOffice', endpoint: 'https://data.example/mcp', enabled: true, allowedRoles: ['user'] }] };
      else if (url.pathname === '/api/office/settings') body = { workspaceRoot: 'C:/team', databaseProvider: 'sqlite', postgresConfigured: false };
      else if (url.pathname === '/api/office/users/fixture-user' && request.method() === 'PATCH') {
        saved = request.postDataJSON();
        if (failSave) return route.fulfill({ status: 409, json: { error: 'User changed in another window. Refresh and retry.' } });
        body = { user: { ...user, ...saved } };
      } else throw new Error(`Unexpected Team request: ${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 200, json: body });
    });
    const start = Date.now();
    const response = await page.goto(origin + '/manage');
    assert.equal(response.status(), 200);
    await page.getByRole('button', { name: 'Edit alex', exact: true }).waitFor();
    const loadMs = Date.now() - start;
    const fits = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), `Page fits ${width}px viewport`);
    await fits();
    await page.screenshot({ path: path.join(output, `users-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Edit alex', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit alex', exact: true });
    await editor.getByRole('tab', { name: 'Profile', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await editor.getByRole('tab', { name: 'Permissions', exact: true }).getAttribute('aria-selected'), 'true');
    await editor.getByRole('checkbox', { name: /Terminal/ }).check();
    await editor.getByRole('tab', { name: 'Data access', exact: true }).click();
    await editor.getByRole('checkbox', { name: /SmartOffice/ }).check();
    await editor.getByRole('tab', { name: 'Permissions', exact: true }).click();
    await page.screenshot({ path: path.join(output, `permissions-${width}.png`), fullPage: true });
    await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
    console.log(`${width}px: failed save requested`);
    await editor.getByRole('alert').filter({ hasText: 'User changed in another window' }).waitFor();
    assert.ok(saved.features.includes('terminal'));
    assert.deepEqual(saved.mcpServers, ['smartoffice']);
    failSave = false;
    await editor.getByRole('button', { name: 'Save changes', exact: true }).click();
    console.log(`${width}px: successful save requested`);
    await editor.waitFor({ state: 'hidden' });
    await page.getByRole('status').filter({ hasText: 'User settings saved.' }).waitFor();
    if (width <= 700) {
      await page.getByRole('combobox', { name: 'Team settings section', exact: true }).selectOption('database');
      assert.equal(await page.locator('.team-settings-sidebar').isVisible(), false);
    } else {
      assert.equal(await page.getByRole('combobox', { name: 'Team settings section', exact: true }).isVisible(), false);
      await page.getByRole('navigation', { name: 'Team settings sections' }).getByRole('button', { name: 'Database', exact: true }).click();
    }
    await page.getByLabel(/^Database provider/).selectOption('postgres');
    await page.getByLabel(/^PostgreSQL connection URL/).waitFor();
    await fits();
    await page.screenshot({ path: path.join(output, `database-${width}.png`), fullPage: true });
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    if (width === 390) await page.getByRole('button', { name: 'Show sessions sidebar', exact: true }).click();
    await page.locator('.cli-settings-shortcut').click();
    const settings = page.getByRole('dialog', { name: /settings/i }).first();
    const sidebar = settings.locator('.settings-sidebar');
    if (width <= 700) {
      const picker = settings.getByRole('combobox', { name: 'Settings section', exact: true });
      await picker.waitFor();
      assert.equal(await sidebar.isVisible(), false);
      await picker.selectOption('automation');
      assert.equal(await picker.inputValue(), 'automation');
      await picker.selectOption('general');
    } else {
    await sidebar.waitFor();
    assert.equal(await sidebar.getByRole('tablist').getAttribute('aria-orientation'), 'vertical');
    const general = sidebar.getByRole('tab', { name: 'General', exact: true });
    await general.focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await sidebar.getByRole('tab', { name: 'Automation', exact: true }).getAttribute('aria-selected'), 'true');
    await general.click();
    }
    const teamToggle = settings.locator('.settings-dashboard-column .settings-block').filter({ has: page.locator('.settings-block-title', { hasText: 'Enable Team workspace' }) });
    await teamToggle.waitFor();
    await fits();
    assert.equal(await teamToggle.count(), 1, 'Team enablement is a single Dashboard column card');
    await teamToggle.evaluate(element => element.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: path.join(output, `settings-${width}.png`), fullPage: true });
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    console.log(JSON.stringify({ width, loadMs, saveFailureRetained: true, permissionsSaved: true, consoleErrors: errors.length }));
    await context.close();
  }
  console.log(`Team UI screenshots: ${output}`);
} finally { await browser.close(); }
