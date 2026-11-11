import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const started = Date.now();
  await page.goto('http://127.0.0.1:39875/', { waitUntil: 'domcontentloaded' });
  await page.locator('.brand-version').waitFor({ state: 'visible', timeout: 45000 });
  assert.equal((await page.locator('.brand-version').innerText()).trim(), `v${version}`);
  assert.deepEqual(errors, []);
  await mkdir('output/account-center-cleanup-ui', { recursive: true });
  await page.screenshot({ path: 'output/account-center-cleanup-ui/dashboard-version.png' });
  console.log(JSON.stringify({ version, durationMs: Date.now() - started, consoleErrors: errors.length, fixture: false }));
} finally { await browser.close(); }
