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
    const [token,setToken]=useState();
    const [tokenId,setTokenId]=useState();
    const [saved,setSaved]=useState();
    window.keyRequests ??= [];
    const [pending,setPending]=useState(false);
    const [error,setError]=useState();
    const [notice,setNotice]=useState();
    window.failModels=()=>{setCatalogue([]);setWarning('Codex sign-in unavailable. Refresh models to retry.');};
    return <ApiWorkspace open tokens={[
      {id:'existing',name:'Existing key',permissions:['aiProxy'],createdAt:1},
      {id:'other',name:'Other key',permissions:['aiProxy'],createdAt:1},
      {id:'legacy',name:'Legacy key',permissions:['aiProxy'],createdAt:1}
    ]} proxy={{capturedAt:Date.now(),requests:[],models:catalogue,modelDiscoveryWarning:warning,claudeMapping:saved}}
      token={token} tokenId={tokenId} enabled connected pending={pending} loading={loading} error={error} notice={notice}
      onRefresh={()=>{setError(undefined);setLoading(true);setTimeout(()=>{setCatalogue(models);setWarning(undefined);setLoading(false);},30);}}
      onSaveMapping={mapping=>{setPending(true);setError(undefined);setTimeout(()=>{setPending(false);if(window.rejectSave){setError('Mapping storage unavailable');return;}setSaved(mapping);setNotice('Claude model mapping saved.');window.savedMapping=mapping;},30);}}
      onGenerate={()=>{throw new Error('Model discovery must not create a key');}}
      onCopy={id=>{window.keyRequests.push(id);setPending(true);setToken(undefined);setTokenId(undefined);setError(undefined);setTimeout(()=>{setPending(false);if(id==='legacy'){setError('This older key has only a saved hash and cannot be copied. Create a replacement key.');return;}if(window.rejectKey){setError('Key storage unavailable');return;}setToken('cm_'+(id==='existing'?'a':'b').repeat(64));setTokenId(id);},100);}}
      onEdit={()=>{}} onRevoke={()=>{}}/>;
  }
  render(<App/>,document.getElementById('app'));
`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', jsx: 'automatic', jsxImportSource: 'preact' });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
async function selectSection(scope, label, name) {
  const picker = scope.getByRole('combobox', { name: label, exact: true });
  if (await picker.isVisible()) await picker.selectOption({ label: name });
  else await scope.getByRole('tab', { name, exact: true }).click();
}
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
    await selectSection(page, 'API view', 'Proxy');
    await page.getByRole('button', { name: 'Proxy connection settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Proxy connection' });
    assert.deepEqual(await dialog.getByRole('tab', { includeHidden: true }).allTextContents(), ['Claude', 'Codex'], 'Claude is the first proxy tab');
    assert.equal(await dialog.getByRole('tab', { includeHidden: true, name: 'Claude', exact: true }).getAttribute('aria-selected'), 'true', 'Claude opens by default');
    await selectSection(dialog, 'Proxy client', 'Codex');
    await dialog.getByRole('button', { name: 'Copy Codex launch command', exact: true }).click();
    assert.ok((await page.evaluate(() => window.copied)).includes('cm_'+'a'.repeat(64)), 'Codex launch includes the selected key');
    await selectSection(dialog, 'Proxy client', 'Claude');
    assert.ok(!/Claude Desktop gateway|Save these host-wide routes|Available models \(|Claude model names stay/.test(await dialog.innerText()), 'Removed setup explanations stay absent');
    await page.waitForFunction(() => document.querySelector('[aria-label="Claude configuration"]').textContent.includes('cm_'+'a'.repeat(64)));
    assert.equal(await dialog.getByLabel('Key value', { exact: true }).count(), 0, 'No manual key field');
    const mapping = dialog.getByRole('region', { name: 'Claude model mapping' });
    const opus = mapping.getByLabel('Proxy model for claude-opus', { exact: true });
    await opus.waitFor();
    assert.deepEqual(await opus.locator('option').evaluateAll(rows => rows.map(row => row.value)), ['gpt-codex', 'gpt-fast']);
    await opus.selectOption('gpt-fast');
    await page.evaluate(() => { window.rejectKey=true; });
    await dialog.getByLabel('Proxy API key', { exact: true }).selectOption('other');
    await dialog.getByRole('alert').filter({ hasText: 'Key storage unavailable' }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Copy Claude configuration', exact: true }).isDisabled(), true, 'Cannot copy a placeholder after key load failure');
    assert.ok(!(await dialog.getByLabel('Claude configuration', { exact: true }).textContent()).includes('cm_'+'a'.repeat(64)), 'Previous key is never used for a new selection');
    assert.deepEqual(await page.evaluate(() => window.keyRequests), ['existing','other'], 'Failed key loads are not replayed');
    await page.evaluate(() => { window.rejectKey=false; });
    await dialog.getByRole('button', { name: 'Retry loading key', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Claude configuration"]').textContent.includes('cm_'+'b'.repeat(64)));
    assert.equal(await opus.inputValue(), 'gpt-fast', 'Changing existing keys retains available models and mapping');
    await page.evaluate(() => { window.rejectSave=true; });
    await mapping.getByRole('button', { name: 'Save model mapping', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Mapping storage unavailable' }).waitFor();
    assert.equal(await opus.inputValue(), 'gpt-fast', 'Save failure retains the draft');
    await page.evaluate(() => { window.rejectSave=false; });
    await mapping.getByRole('button', { name: 'Save model mapping', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Claude model mapping saved.' }).waitFor();
    assert.equal(await page.evaluate(() => window.savedMapping.opus), 'gpt-fast');
    assert.equal(await mapping.getByRole('button', { name: 'Save model mapping', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: 'Copy Claude configuration', exact: true }).click();
    const copied = JSON.parse(await page.evaluate(() => window.copied));
    assert.equal(copied.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus');
    assert.equal(copied.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, 'claude-opus (GPT Fast)');
    assert.equal(copied.modelOverrides['claude-opus-5-5'], 'claude-opus');
    assert.equal(copied.env.ANTHROPIC_AUTH_TOKEN, 'cm_'+'b'.repeat(64), 'Ready-to-paste configuration includes the selected stored API key');
    assert.ok(!JSON.stringify(copied).includes('YOUR_MANAGER_API_KEY'));
    await dialog.getByLabel('Proxy API key', { exact: true }).selectOption('legacy');
    await dialog.getByRole('alert').filter({ hasText: 'older key' }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Copy Claude configuration', exact: true }).isDisabled(), true);
    await dialog.getByLabel('Proxy API key', { exact: true }).selectOption('existing');
    await page.waitForFunction(() => document.querySelector('[aria-label="Claude configuration"]').textContent.includes('cm_'+'a'.repeat(64)));
    await mapping.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'mapping-' + width + '.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'No page overflow');
    assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 2), 'No modal overflow');
    const keyLoadCount = await page.evaluate(() => window.keyRequests.length);
    await page.evaluate(() => window.failModels());
    await mapping.getByRole('alert').waitFor();
    await mapping.getByRole('button', { name: 'Refresh Codex models' }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Claude model mapping"] [role="alert"]'));
    assert.equal(await opus.locator('option').count(), 2, 'Refresh recovers the catalogue without a secret');
    assert.deepEqual(apiRequests.filter(value => value !== '/favicon.ico'), [], 'No direct model or secret API calls from the browser');
    assert.equal(await page.evaluate(() => window.keyRequests.length), keyLoadCount, 'Model refresh does not reload key secrets');
    assert.deepEqual(errors, []);
    results.push({ width, elapsedMs: Date.now() - started });
    await page.close();
  }
  console.log(JSON.stringify({ results, screenshots: output }, null, 2));
} finally { await browser.close(); }
