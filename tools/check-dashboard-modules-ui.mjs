import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

// Disposable static host: no connection to Codex and no write endpoint.
const snapshot = await (await fetch('http://127.0.0.1:39875/api/state')).json();
snapshot.accounts = [];
snapshot.connectedPeers = [];
const manifest = JSON.parse(await readFile('media/webview/dashboard/dashboard-manifest.json', 'utf8'));
const entry = Object.keys(manifest).find(key => manifest[key].isEntry);
const core = new Set();
function visit(key) {
  if (core.has(manifest[key].file)) return;
  core.add(manifest[key].file);
  for (const dependency of manifest[key].imports || []) visit(dependency);
}
visit(entry);
const requested = [], writes = [];
const host = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    requested.push(url.pathname);
    if (request.method !== 'GET') {
      writes.push(url.pathname); response.writeHead(405); response.end(); return;
    }
    if (url.pathname === '/api/state') {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(snapshot)); return;
    }
    const assets = {
      '/': ['media/webview/pwaDashboard.html', 'text/html'],
      '/offline-dashboard.html': ['media/webview/pwaDashboard.html', 'text/html'],
      '/offline.html': ['media/webview/pwaOffline.html', 'text/html'],
      '/service-worker.js': ['media/webview/pwaServiceWorker.js', 'text/javascript'],
      '/assets/dashboard.js': ['media/webview/dashboard/dashboard.js', 'text/javascript'],
      '/assets/dashboard-manifest.json': ['media/webview/dashboard/dashboard-manifest.json', 'application/json'],
      '/assets/shared.css': ['media/webview/shared.css', 'text/css'],
      '/assets/dashboard.css': ['media/webview/quotaSummary.css', 'text/css']
    };
    if (url.pathname === '/assets/browserHost.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(`window.acquireVsCodeApi=()=>{window.__bridgeCount=(window.__bridgeCount||0)+1;return{postMessage(message){if(message.type==='dashboard:ready')fetch('/api/state').then(r=>r.json()).then(state=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:snapshot',state}}))).catch(()=>{});}}};navigator.serviceWorker.register('/service-worker.js?v=module-smoke');`);
      return;
    }
    const chunk = /^\/assets\/(chunks\/[A-Za-z0-9_-]+\.js)$/.exec(url.pathname);
    const asset = assets[url.pathname] || (chunk ? ['media/webview/dashboard/' + chunk[1], 'text/javascript'] : undefined);
    if (!asset) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', asset[1]); response.end(await readFile(asset[0]));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${host.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.locator('#dashboard-main').waitFor();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const cached = await page.evaluate(async () => (await (await caches.open('codex-manager-static-module-smoke')).keys()).map(request => new URL(request.url).pathname));
  for (const file of core) assert.ok(cached.includes('/assets/' + file), `Core module cached: ${file}`);
  assert.ok(!requested.some(path => /(?:editor-vendor|terminal-vendor|workspaceCodeEditor|workspaceTerminal)-/.test(path)), 'Unused panels are neither fetched nor cached at startup');
  assert.ok(!cached.some(path => path.startsWith('/api/')), 'Private API data stays out of the shell cache');
  assert.equal(await page.evaluate(() => window.__bridgeCount), 1, 'Module graph bootstraps the dashboard once');
  await context.setOffline(true);
  await page.goto(origin);
  await page.locator('#dashboard-main').waitFor();
  assert.equal(await page.evaluate(() => window.__bridgeCount), 1, 'Cold offline module graph bootstraps once');
  await page.locator('#settingsOpenButton').click();
  await page.locator('#settings-tab-tools').click();
  await page.getByRole('region', { name: 'Storage Management', exact: true }).waitFor();
  assert.deepEqual(errors, [], 'Cold offline core has no runtime errors');
  assert.deepEqual(writes, [], 'The fixture sent no write requests');
  await context.close();
  console.log(JSON.stringify({ coreModules: core.size, coldOffline: 'passed', deferredPanelsUnfetched: true, singleBootstrap: true, writes: 0 }));
} finally {
  await browser.close();
  await new Promise(resolve => { host.close(resolve); host.closeAllConnections(); });
}
