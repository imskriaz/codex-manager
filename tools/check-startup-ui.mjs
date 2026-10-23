import { readFile, mkdir } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Intercept the disposable browser only; the running dashboard remains untouched.
const origin = 'http://127.0.0.1:39875', output = path.join(tmpdir(), 'codex-manager-startup-ui');
await mkdir(output, { recursive: true });
const source = await readFile('tools/always-online-server.js', 'utf8');
const fragment = source.slice(source.indexOf('function waitForDashboard()'), source.indexOf('const httpServer ='));
const { html, hash } = runInNewContext(`(()=>{${fragment};return {html:startupPage,hash:startupScriptHash};})()`, { crypto });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let ready = false, probes = 0;
    await page.route('**/*', route => {
      if (route.request().headers()['x-codex-startup-probe']) {
        probes++;
        return route.fulfill(ready ? { status: 200, contentType: 'text/html', body: 'Ready' }
          : { status: 204, headers: { 'X-Codex-Starting': '1' } });
      }
      return route.fulfill(ready ? { contentType: 'text/html', body: '<main>Dashboard ready</main>' } : {
        status: 503, contentType: 'text/html', headers: { 'Cache-Control': 'no-store',
          'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; connect-src 'self'` }, body: html
      });
    });
    const url = `${origin}/workspace?device=fixture#history`;
    await page.clock.install();
    await page.goto(url);
    await page.getByRole('heading', { name: 'Starting Codex Manager…' }).waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes('WebSocket'));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(output, `starting-${width}.png`) });
    // Advance the same bounded wait rather than waiting one minute per viewport.
    await page.clock.fastForward(65_000);
    await page.clock.runFor(1000);
    await page.getByRole('heading', { name: 'Dashboard offline' }).waitFor();
    assert.ok(probes <= 22);
    await page.screenshot({ path: path.join(output, `offline-${width}.png`) });
    ready = true;
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByText('Dashboard ready', { exact: true }).waitFor();
    assert.equal(page.url(), url, 'Recovery preserves the selected system, route and hash');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, startup: 'passed', boundedOffline: 'passed', retry: 'passed', probes }));
    await context.close();
  }
} finally { await browser.close(); }
