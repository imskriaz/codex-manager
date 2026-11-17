import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

// All failures and writes belong to this in-memory page, never the running host.
const origin = 'http://127.0.0.1:39875';
const output = path.join(tmpdir(), 'codex-manager-deferred-panels');
await mkdir(output, { recursive: true });
const compiled = await build({ stdin: { contents: `
  import { render } from 'preact';
  import { deferredPanel } from './webview-src/dashboard/deferredPanel';
  let calls=0, resolve, reject;
  const mode=new URL(location.href).searchParams.get('mode');
  const good={ default: props => <output>Loaded {props.label}</output> };
  const Panel=deferredPanel(()=>{
    calls++; window.calls=calls;
    if(mode==='invalid') return Promise.resolve({default:42});
    if(mode==='empty') return Promise.reject(undefined);
    if(mode==='string') return Promise.reject('String failure detail');
    if(mode==='sync') throw new Error('Synchronous import failure');
    if(mode==='reject'||mode==='retry'&&calls===1) return Promise.reject(new Error('Fixture import failed <script>alert(1)</script>'));
    if(mode==='pending'||mode==='shared') return new Promise((yes,no)=>{resolve=yes;reject=no;});
    return Promise.resolve(good);
  },'browser');
  window.finish=()=>resolve(good); window.fail=()=>reject(new Error('Late rejection'));
  window.mount=(label='browser')=>render(<Panel label={label}/>,document.querySelector('#app'));
  window.unmount=()=>render(null,document.querySelector('#app'));
  window.second=()=>render(<Panel label='second'/>,document.querySelector('#second'));
  window.mount();
`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', jsx: 'automatic', jsxImportSource: 'preact' });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block' });
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(`${origin}/__deferred**`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="app"></main><aside id="second"></aside><textarea aria-label="Manual input"></textarea><script type="module" src="/__deferred.js"></script>' }));
    await page.route(`${origin}/__deferred.js`, route => route.fulfill({ contentType: 'text/javascript', body: compiled.outputFiles[0].text }));
    const open = async mode => { await page.goto(`${origin}/__deferred?mode=${mode}`, { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.mount); };
    const check = (name) => results.push({ width, name, status: 'passed' });
    await open('success'); await page.getByText('Loaded browser', { exact: true }).waitFor();
    await page.evaluate(() => window.mount('updated')); await page.getByText('Loaded updated', { exact: true }).waitFor();
    await page.evaluate(() => { window.unmount(); window.mount('cached'); });
    await page.getByText('Loaded cached', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.calls), 1); check('success, prop update, cached remount');

    await open('retry'); await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /Fixture import failed <script>/);
    assert.equal(await page.locator('#app script').count(), 0, 'Errors render as text');
    await page.getByRole('textbox', { name: 'Manual input' }).fill('draft stays usable');
    await page.getByRole('button', { name: 'Retry browser', exact: true }).click();
    await page.getByText('Loaded browser', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox').inputValue(), 'draft stays usable');
    assert.equal(await page.evaluate(() => window.calls), 2); check('preserved error, escaped text, retry success, manual input');

    for (const [mode, text] of [['sync', 'Synchronous import failure'], ['invalid', 'module is incomplete'], ['string', 'String failure detail'], ['empty', 'module could not be loaded']]) {
      await open(mode); await page.getByRole('alert').waitFor();
      assert.ok((await page.getByRole('alert').innerText()).includes(text)); check(mode);
    }
    await page.addStyleTag({ content: await readFile('media/webview/shared.css', 'utf8') });
    await page.addStyleTag({ content: await readFile('media/webview/quotaSummary.css', 'utf8') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(output, `load-error-${width}.png`) });
    check('responsive error and recovery controls');

    await page.clock.install();
    await open('pending'); await page.getByRole('status').waitFor();
    await page.waitForFunction(() => window.calls === 1);
    await page.clock.runFor(12500);
    await page.getByRole('alert').waitFor(); assert.match(await page.getByRole('alert').innerText(), /timed out/);
    await page.getByRole('button', { name: 'Retry browser', exact: true }).click();
    await page.clock.runFor(100); await page.getByRole('status').waitFor();
    await page.waitForFunction(() => window.calls === 2);
    await page.evaluate(() => window.finish()); await page.clock.runFor(100);
    await page.getByText('Loaded browser', { exact: true }).waitFor(); check('bounded timeout and retry after timeout');
    await page.clock.resume();

    await open('shared'); await page.evaluate(() => window.second());
    await page.waitForTimeout(50); assert.equal(await page.evaluate(() => window.calls), 1);
    await page.evaluate(() => window.finish());
    await page.getByText('Loaded browser', { exact: true }).waitFor();
    await page.getByText('Loaded second', { exact: true }).waitFor(); check('concurrent instances share loading');

    await open('pending'); await page.waitForFunction(() => window.calls === 1);
    await page.evaluate(() => { window.unmount(); window.fail(); }); await page.waitForTimeout(50);
    assert.equal(await page.locator('#app').innerText(), ''); check('unmount during rejected load');

    await open('reject'); await page.getByRole('alert').waitFor();
    await page.getByRole('button', { name: 'Reload dashboard', exact: true }).click();
    await page.waitForFunction(() => window.mount); await page.getByRole('alert').waitFor(); check('explicit dashboard reload');
    assert.deepEqual(errors, [], 'No unhandled runtime failures');
    await context.close();
  }
  console.log(JSON.stringify({ results, screenshots: output }, null, 2));
} finally { await browser.close(); }
