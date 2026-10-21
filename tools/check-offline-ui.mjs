import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

// Real host reads only. Browser storage and service workers belong to a disposable context.
const origin = 'http://127.0.0.1:39875', output = path.join(tmpdir(), 'codex-manager-offline-ui');
await mkdir(output, { recursive: true });
const servedBundle = await fetch(origin + '/assets/dashboard.js', { signal: AbortSignal.timeout(10000) });
assert.ok(servedBundle.ok, 'The installed dashboard bundle is available');
const expectedHash = createHash('sha256').update(Buffer.from(await servedBundle.arrayBuffer())).digest('hex');

async function checkWorkerUpgrade(browser) {
  const source = await readFile('media/webview/pwaServiceWorker.js');
  let failShell = false, failedAssets = 0;
  const host = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/service-worker.js') {
      response.setHeader('Content-Type', 'text/javascript'); response.setHeader('Cache-Control', 'no-store'); response.end(source); return;
    }
    if (failShell && url.pathname === '/assets/dashboard.js' && url.searchParams.get('v') === 'second') {
      failedAssets++; response.statusCode = 503; response.end('Unavailable'); return;
    }
    const type = url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.js') ? 'text/javascript'
      : url.pathname.endsWith('.png') ? 'image/png' : url.pathname.endsWith('.svg') ? 'image/svg+xml'
        : url.pathname.endsWith('.webmanifest') ? 'application/manifest+json' : 'text/html';
    response.setHeader('Content-Type', type);
    response.end(url.pathname === '/offline-dashboard.html' ? '<!doctype html><title>Saved shell</title><p>Working offline shell</p>' : type === 'text/html' ? '<!doctype html><title>Worker upgrade fixture</title>' : url.pathname + ':' + url.searchParams.get('v'));
  });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  const fixtureOrigin = `http://127.0.0.1:${host.address().port}`;
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  try {
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    await page.goto(fixtureOrigin);
    await page.evaluate(() => navigator.serviceWorker.register('/service-worker.js?v=first'));
    await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.endsWith('v=first'));
    const newer = await page.evaluate(() => fetch('/assets/dashboard.js?v=second').then(response => response.text()));
    assert.equal(newer, '/assets/dashboard.js:second', 'The controlling old worker leaves newer asset versions to the network');
    failShell = true;
    const state = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register('/service-worker.js?v=second');
      const worker = registration.installing;
      if (!worker) return 'missing';
      return new Promise(resolve => {
        const timer = setTimeout(() => resolve('timeout'), 10000);
        const changed = () => { if (['redundant', 'activated'].includes(worker.state)) { clearTimeout(timer); resolve(worker.state); } };
        worker.addEventListener('statechange', changed); changed();
      });
    });
    assert.equal(state, 'redundant', 'An incomplete update fails installation instead of replacing the working worker');
    assert.ok(failedAssets > 0, 'The test exercised a real failed required-asset response');
    assert.equal(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL.endsWith('v=first')), true);
    assert.ok((await page.evaluate(() => caches.keys())).includes('codex-manager-static-first'), 'The working cache remains intact');
    await context.setOffline(true); await page.goto(fixtureOrigin);
    await page.getByText('Working offline shell', { exact: true }).waitFor();
    console.log('Workspace worker: newer assets, partial update, retained controller/cache and cold offline fallback passed');
  } finally {
    await context.close();
    await new Promise(resolve => { host.close(resolve); host.closeAllConnections(); });
  }
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'allow' });
  // Keep real network response metadata: synthetic worker responses alter local-network permission checks.
  page = await context.newPage();
  const errors = [], actions = [];
  page.setDefaultTimeout(45000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /WebSocket|Content Security Policy/i.test(message.text())) console.log(message.text()); });
  page.on('websocket', socket => socket.on('framesent', frame => {
    try { const message = JSON.parse(String(frame.payload)); if (message.type === 'dashboard:action') actions.push(message.action); } catch { /* transport control frame */ }
  }));
  await page.addInitScript(() => {
    window.__offlineEvents = [];
    window.addEventListener('message', event => { if (['dashboard:connection', 'dashboard:host-status'].includes(event.data?.type)) window.__offlineEvents.push(event.data); });
  });
  await page.goto(origin + '/'); await page.locator('#dashboard-main').waitFor();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.waitForFunction(() => window.__offlineEvents.filter(event => event.type === 'dashboard:connection').at(-1)?.connected === true);
  console.log('Current worker controls the online dashboard');
  await page.waitForFunction(() => document.querySelectorAll('.saved-card-container, .saved-table-row').length > 0);
  await page.getByRole('button', { name: 'Project task board', exact: true }).click();
  await page.locator('.task-board-card').first().waitFor();
  await page.waitForFunction(async () => {
    const database = await new Promise(resolve => { const request = indexedDB.open('codex-manager-cache', 1); request.onsuccess = () => resolve(request.result); });
    try {
      const keys = await new Promise(resolve => { const request = database.transaction('cli-sessions').objectStore('cli-sessions').getAllKeys(); request.onsuccess = () => resolve(request.result); });
      return keys.includes('dashboard-state') && keys.includes('list') && keys.some(key => String(key).startsWith('browser:board:'));
    } finally { database.close(); }
  });
  const cachedHash = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const version = new URL(registration.active.scriptURL).searchParams.get('v');
    const cache = await caches.open('codex-manager-static-' + version);
    const response = await cache.match('/assets/dashboard.js', { ignoreSearch: true });
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
  });
  assert.equal(cachedHash, expectedHash, 'The worker cached the bundle actually served by the host');
  await context.setOffline(true);
  await page.goto(origin + '/'); await page.locator('#dashboard-main').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.saved-card-container, .saved-table-row').length > 0);
  await page.screenshot({ path: path.join(output, 'dashboard-cold-offline.png') });
  console.log('Cold offline dashboard restored');
  await page.goto(origin + '/tasks'); await page.locator('.task-board-card').first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Share project', exact: true }).isDisabled(), true, 'Sharing remains live-only offline');
  await page.screenshot({ path: path.join(output, 'tasks-cold-offline.png') });
  console.log('Cold offline task board restored');
  const cachePaths = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)))).flat());
  assert.ok(cachePaths.length > 0 && cachePaths.every(value => !value.startsWith('/api/') && !value.includes('/share/') && value !== '/'), 'Cache Storage holds only the data-free shell');
  await context.setOffline(false);
  await page.waitForFunction(() => window.__offlineEvents.filter(event => event.type === 'dashboard:connection').at(-1)?.connected === true);
  assert.ok(actions.every(action => ['listCodexCliSessions', 'getProjectBoard', 'getProjectTaskDetails', 'getCodexCliSessionMessages', 'getUsageGraph', 'getDailyUsage'].includes(action)), 'Offline reload and reconnect send no mutations; observed: ' + [...new Set(actions)].join(', '));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ coldOfflineDashboard: 'passed', coldOfflineTasks: 'passed', reconnect: 'passed', privateResponsesCached: false, mutationsSent: false, screenshots: output }));
  await context.close();
  await checkWorkerUpgrade(browser);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
    await writeFile(path.join(output, 'failure.json'), JSON.stringify(await page.evaluate(() => ({ path: location.pathname, online: navigator.onLine, bridge: typeof window.acquireVsCodeApi, controller: navigator.serviceWorker.controller?.scriptURL, events: window.__offlineEvents?.slice(-20) })).catch(() => ({})), null, 2));
  }
  throw error;
} finally { await browser.close(); }
