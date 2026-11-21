import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const origin = 'http://127.0.0.1:39875';
const output = path.resolve('output/login-ui');
await mkdir(output, { recursive: true });
const live = process.argv.includes('--live');
const source = await readFile('src/services/webDashboardServer.ts', 'utf8');
const css = source.match(/const BASE_CSS = `([^`]+)`;/)[1];
const htmlSource = source.slice(source.indexOf('function loginPage('), source.indexOf('\nfunction versionPublicAssets(')).replace('configured: boolean', 'configured').replace('): string {', ') {');
const escapeHtml = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const render = new Function('BASE_CSS', 'escapeHtml', 'normalizeWebDashboardReturnPath', `${htmlSource}; return loginPage;`)(css, escapeHtml, () => '/');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [1440, 512, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: width === 512 ? 417 : 900 }, serviceWorkers: 'block', extraHTTPHeaders: { 'x-forwarded-proto': 'https', 'cf-ray': 'read-only-login-smoke' } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (!live) await page.route(origin + '/login', route => route.fulfill({ contentType: 'text/html', body: render(true) }));
    const start = Date.now();
    await page.goto(origin + (live ? '/' : '/login'), { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
    assert.equal(await page.getByLabel('Email', { exact: true }).count(), 1);
    assert.equal(await page.getByLabel('Password', { exact: true }).getAttribute('type'), 'password');
    assert.equal(await page.getByLabel('Email', { exact: true }).getAttribute('type'), 'text', 'Master identifier must also be accepted');
    assert.equal(await page.getByLabel('Email', { exact: true }).getAttribute('required'), '');
    await page.getByLabel('Email', { exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator(':focus').getAttribute('id'), 'dashboard-password');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
    await page.screenshot({ path: path.join(output, `${live ? 'installed' : 'preview'}-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ live, width, domReadyMs: Date.now() - start, errors: errors.length }));
    await context.close();
  }
} finally { await browser.close(); }
