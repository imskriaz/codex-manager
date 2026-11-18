import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const origin = 'http://127.0.0.1:39875';
const output = path.join(tmpdir(), 'codex-manager-proxy-models');
await mkdir(output, { recursive: true });
// Read the local host once; browser interactions below use only in-memory fixtures.
assert.equal((await fetch(origin + '/api/state')).ok, true);
const compiled = await build({ stdin: { contents: `
  import { render } from 'preact';
  import { useState } from 'preact/hooks';
  import { ApiWorkspace } from './webview-src/dashboard/apiWorkspace';
  const models=[{id:'gpt-codex',name:'GPT Codex'},{id:'gpt-fast',name:'GPT Fast'}];
  function App(){
    const [catalogue,setCatalogue]=useState(models);
    const [warning,setWarning]=useState();
    const [loading,setLoading]=useState(false);
    const [saved,setSaved]=useState();
    const [pending,setPending]=useState(false);
    const [error,setError]=useState();
    const [notice,setNotice]=useState();
    window.failModels=()=>{setCatalogue([]);setWarning('Codex sign-in unavailable. Refresh models to retry.');};
    return <ApiWorkspace open tokens={[
      {id:'existing',name:'Existing key',permissions:['aiProxy'],createdAt:1},
      {id:'other',name:'Other key',permissions:['aiProxy'],createdAt:1}
    ]} proxy={{capturedAt:Date.now(),requests:[],models:catalogue,modelDiscoveryWarning:warning,claudeMapping:saved}}
      enabled connected pending={pending} loading={loading} error={error} notice={notice}
      onRefresh={()=>{setError(undefined);setLoading(true);setTimeout(()=>{setCatalogue(models);setWarning(undefined);setLoading(false);},30);}}
      onSaveMapping={mapping=>{setPending(true);setError(undefined);setTimeout(()=>{setPending(false);if(window.rejectSave){setError('Mapping storage unavailable');return;}setSaved(mapping);setNotice('Claude model mapping saved.');window.savedMapping=mapping;},30);}}
      onGenerate={()=>{throw new Error('Model discovery must not create a key');}}
      onCopy={()=>{throw new Error('Model discovery must not retrieve a secret');}}
      onEdit={()=>{}} onRevoke={()=>{}}/>;
  }
  render(<App/>,document.getElementById('app'));
`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', jsx: 'automatic', jsxImportSource: 'preact' });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 950 }, serviceWorkers: 'block' });
    const errors = [], apiRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/__proxy-models') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/__proxy-models.js"></script></body></html>' });
      if (url.pathname === '/__proxy-models.js') return route.fulfill({ contentType: 'text/javascript', body: compiled.outputFiles[0].text });
      apiRequests.push(url.pathname);
      return route.abort();
    });
    const started = Date.now();
    await page.goto(origin + '/__proxy-models');
    for (const file of ['shared.css', 'quotaSummary.css']) await page.addStyleTag({ content: await readFile('media/webview/' + file, 'utf8') });
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.copied = value; } } }));
    await page.getByRole('tab', { name: 'Proxy', exact: true }).click();
    await page.getByRole('button', { name: 'Proxy connection settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Proxy connection' });
    await dialog.getByRole('tab', { name: 'Claude', exact: true }).click();
    const mapping = dialog.getByRole('region', { name: 'Claude model mapping' });
    const opus = mapping.getByLabel('Proxy model for claude-opus-4-6', { exact: true });
    await opus.waitFor();
    assert.deepEqual(await opus.locator('option').evaluateAll(rows => rows.map(row => row.value)), ['gpt-codex', 'gpt-fast']);
    await opus.selectOption('gpt-fast');
    await dialog.getByLabel('Proxy API key', { exact: true }).selectOption('other');
    assert.equal(await opus.inputValue(), 'gpt-fast', 'Changing existing keys retains available models and mapping');
    await page.evaluate(() => { window.rejectSave=true; });
    await mapping.getByRole('button', { name: 'Save model mapping', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Mapping storage unavailable' }).waitFor();
    assert.equal(await opus.inputValue(), 'gpt-fast', 'Save failure retains the draft');
    await page.evaluate(() => { window.rejectSave=false; });
    await mapping.getByRole('button', { name: 'Save model mapping', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Claude model mapping saved.' }).waitFor();
    assert.equal(await page.evaluate(() => window.savedMapping.opus), 'gpt-fast');
    assert.equal(await mapping.getByRole('button', { name: 'Save model mapping', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: 'Copy Claude configuration', exact: true }).click();
    assert.equal(JSON.parse(await page.evaluate(() => window.copied)).env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-4-6');
    await mapping.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'mapping-' + width + '.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'No page overflow');
    assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 2), 'No modal overflow');
    await page.evaluate(() => window.failModels());
    await mapping.getByRole('alert').waitFor();
    await mapping.getByRole('button', { name: 'Refresh Codex models' }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Claude model mapping"] [role="alert"]'));
    assert.equal(await opus.locator('option').count(), 2, 'Refresh recovers the catalogue without a secret');
    assert.deepEqual(apiRequests.filter(value => value !== '/favicon.ico'), [], 'No model API requests or secret fetches from the browser');
    assert.deepEqual(errors, []);
    results.push({ width, elapsedMs: Date.now() - started });
    await page.close();
  }
  console.log(JSON.stringify({ results, screenshots: output }, null, 2));
} finally { await browser.close(); }
