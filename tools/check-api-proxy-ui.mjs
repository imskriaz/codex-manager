import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

const origin = 'http://127.0.0.1:39875';
const output = path.join(tmpdir(), 'codex-manager-api-proxy-ui');
await mkdir(output, { recursive: true });
const compiled = await build({ stdin: { contents: `
  import { render } from 'preact';
  import { useState } from 'preact/hooks';
  import { ApiTokenModal } from './webview-src/dashboard/apiTokenModal';
  const now=Date.now();
  const requests=['completed','failed','cancelled','incomplete','running'].map((status,index)=>({id:'request-'+index,startedAt:now-index*1000,method:'POST',path:'/v1/responses',model:'fixture-model',status,httpStatus:status==='failed'?502:200,durationMs:123,inputTokens:56511,outputTokens:6500,error:status==='failed'?'Backend unavailable <script>unsafe</script>':undefined}));
  function App(){
    const [snapshot,setSnapshot]=useState({capturedAt:now,requests});
    const [error,setError]=useState();
    const [loading,setLoading]=useState(false);
    const [connected,setConnected]=useState(true);
    window.failRefresh=()=>{setError('Proxy refresh failed. Retry after reconnecting.');setLoading(false)};
    window.offline=()=>setConnected(false);
    window.missing=()=>setSnapshot(undefined);
    window.empty=()=>setSnapshot({capturedAt:Date.now(),requests:[]});
    return <ApiTokenModal open token={undefined} tokens={[]} proxy={snapshot} enabled connected={connected} pending={false} loading={loading} error={error} onClose={()=>{}} onGenerate={()=>{}} onRevoke={()=>{}} onRefresh={()=>{setLoading(true);setTimeout(()=>{setLoading(false);setSnapshot(current=>current?{...current,capturedAt:Date.now()}:current);setError(undefined)},50)}}/>;
  }
  render(<App/>,document.getElementById('app'));
`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', jsx: 'automatic', jsxImportSource: 'preact' });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  // Live host check: navigation, API listing and tab refreshes are read-only.
  const live = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await useWorkspaceDashboardAssets(live, origin);
  const liveErrors = [];
  live.on('pageerror', error => liveErrors.push(error.message));
  const started = Date.now();
  await live.goto(origin, { waitUntil: 'domcontentloaded' });
  await live.locator('#dashboard-main').waitFor();
  const rail = live.getByRole('button', { name: 'Show sessions sidebar', exact: true });
  if (await rail.isVisible()) await rail.click();
  // API access is available from the secondary account tools area.
  await live.goto(origin + '/dash', { waitUntil: 'domcontentloaded' });
  await live.getByRole('button', { name: 'Open account center', exact: true }).click();
  await live.getByRole('dialog', { name: 'Account center', exact: true }).getByRole('button', { name: 'API access', exact: true }).click();
  const modal = live.getByRole('dialog', { name: 'API access', exact: true });
  await modal.getByRole('tab', { name: 'Proxy', exact: true }).click();
  await modal.getByRole('button', { name: 'Refresh proxy', exact: true }).waitFor();
  await live.screenshot({ path: path.join(output, 'proxy-live.png') });
  assert.deepEqual(liveErrors, []);
  results.push({ mode: 'live-host', loadAndOpenMs: Date.now() - started, status: 'passed' });
  await live.close();
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(origin + '/__proxy-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/__proxy-fixture.js"></script></body></html>' }));
    await page.route(origin + '/__proxy-fixture.js', route => route.fulfill({ contentType: 'text/javascript', body: compiled.outputFiles[0].text }));
    await page.goto(origin + '/__proxy-fixture');
    for (const file of ['shared.css', 'quotaSummary.css']) await page.addStyleTag({ content: await readFile('media/webview/' + file, 'utf8') });
    const modal = page.getByRole('dialog', { name: 'API access', exact: true });
    const keys = modal.getByRole('button', { name: 'Manage API keys', exact: true });
    await keys.click();
    const manager = page.getByRole('dialog', { name: 'API keys', exact: true });
    await manager.getByRole('button', { name: '+ Create token', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'Create API token', exact: true });
    await create.getByLabel('Token name', { exact: true }).waitFor();
    await create.getByRole('button', { name: 'Cancel', exact: true }).click();
    await manager.getByRole('button', { name: 'Close key management', exact: true }).click();
    await keys.waitFor();
    await modal.getByRole('tab', { name: 'Proxy', exact: true }).click();
    await page.getByRole('img', { name: /API clients connect/ }).waitFor();
    await modal.locator('.api-proxy-split').waitFor();
    assert.equal(await modal.locator('.api-proxy-diagram-pane').count(), 1);
    assert.equal(await modal.locator('.api-proxy-log-pane').count(), 1);
    if (width > 900) {
      const split = await modal.locator('.api-proxy-split').evaluate(element => [...element.children].map(child => child.getBoundingClientRect().width));
      assert.equal(split.length, 2);
      assert.ok(split[0] > 0 && split[1] > 0 && split[1] > split[0], 'Diagram and recent logs share the Proxy tab');
    }
    assert.equal(await page.locator('.api-playground').isVisible(), false);
    await page.getByText('56,511 ↑', { exact: true }).first().waitFor();
    await page.screenshot({ path: path.join(output, `proxy-${width}.png`) });
    await modal.getByRole('tab', { name: 'Proxy', exact: true }).press('ArrowRight');
    assert.equal(await modal.getByRole('tab', { name: 'Logs', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('cell', { name: /Backend unavailable/ }).waitFor();
    assert.equal(await page.locator('.api-proxy-table tbody tr').count(), 5);
    assert.equal(await page.locator('.api-proxy-table script').count(), 0);
    assert.ok(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 2));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    await page.screenshot({ path: path.join(output, `proxy-logs-${width}.png`) });
    await keys.focus();
    await keys.press('Enter');
    await manager.waitFor();
    await manager.press('Escape');
    assert.equal(await modal.getByRole('tab', { name: 'Logs', exact: true }).getAttribute('aria-selected'), 'true');
    await modal.getByRole('button', { name: 'Refresh proxy', exact: true }).waitFor();
    await page.evaluate(() => window.failRefresh());
    await modal.getByRole('alert').filter({ hasText: 'Proxy refresh failed' }).waitFor();
    await modal.getByRole('button', { name: 'Refresh proxy', exact: true }).click();
    await modal.getByRole('alert').waitFor({ state: 'detached' });
    await page.evaluate(() => window.missing());
    await page.getByRole('status').filter({ hasText: 'Proxy activity unavailable' }).waitFor();
    await page.evaluate(() => window.empty());
    await page.getByText('No proxy requests recorded in this host process yet.').waitFor();
    await page.evaluate(() => window.offline());
    assert.equal(await modal.getByRole('button', { name: 'Refresh proxy', exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []);
    results.push({ width, status: 'passed' });
    await context.close();
  }
  console.log(JSON.stringify({ results, screenshots: output }, null, 2));
} finally { await browser.close(); }
