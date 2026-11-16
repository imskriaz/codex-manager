import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';

// Disposable state and a fixture website; never mutate the running dashboard.
const root = await mkdtemp(path.join(tmpdir(), 'manager-browser-terminal-'));
process.env.CODEX_MANAGER_STORAGE_ROOT = root;
process.env.NODE_PATH = path.resolve('tools/node-vscode-shim');
const require = createRequire(import.meta.url);
require('node:module').Module._initPaths();
const { SqliteStateStore, configureSqliteStateStore } = require('../out/storage/sqliteState.js');
const { workspaceBrowser, disposeWorkspaceBrowsers } = require('../out/services/workspaceBrowser.js');
const { workspaceTerminal, disposeSharedTerminals } = require('../out/services/workspaceTerminalPty.js');
const { createWorkspaceTerminal, listWorkspaceTerminals } = require('../out/services/workspaceTools.js');
const store = await SqliteStateStore.open(path.join(root, 'manager.sqlite'));
configureSqliteStateStore(store);
let uiBrowser;
const server = createServer((_request, response) => {
  if (_request.url === '/api/data') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true })); return; }
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Browser fixture</title><button onclick="this.textContent=\'Saved\'">Save</button><input aria-label="Name">');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const url = `http://127.0.0.1:${server.address().port}`;
  const opened = await workspaceBrowser(root, { operation: 'open', operationId: randomUUID(), url });
  const secondPage = await workspaceBrowser(root, { operation: 'open', operationId: randomUUID(), url });
  assert.equal(secondPage.pages.length, 2);
  assert.notEqual(opened.pageId, secondPage.pageId);
  assert.ok(opened.image.startsWith('data:image/jpeg;base64,'));
  const changed = await workspaceBrowser(root, { operation: 'click', operationId: randomUUID(), pageId: opened.pageId, revision: opened.revision, selector: 'button' });
  const snapshot = await workspaceBrowser(root, { operation: 'snapshot', pageId: opened.pageId });
  assert.match(snapshot.text, /Saved/);
  await assert.rejects(workspaceBrowser(root, { operation: 'click', operationId: randomUUID(), pageId: opened.pageId, revision: opened.revision, selector: 'button' }), /changed/);
  const saved = await workspaceBrowser(root, { operation: 'feedback', operationId: randomUUID(), pageId: opened.pageId, revision: changed.revision, feedback: { id: randomUUID(), pageId: opened.pageId, revision: changed.revision, kind: 'area', points: [{ x: 10, y: 10 }, { x: 100, y: 50 }], text: 'Widen this control' } });
  assert.equal(saved.feedback[0].text, 'Widen this control');
  console.log('Real browser navigation, snapshot, stale revision, and feedback storage passed.');
  let debugPage = (await workspaceBrowser(root, { operation: 'screenshot', pageId: opened.pageId }));
  const debugCommand = async request => {
    const result = await workspaceBrowser(root, { operationId: randomUUID(), pageId: opened.pageId, revision: debugPage.revision, ...request });
    debugPage = result; return result;
  };
  assert.match((await debugCommand({ operation: 'html' })).value, /<button/);
  assert.ok((await debugCommand({ operation: 'styles', selector: 'button' })).value.styles.display);
  await debugCommand({ operation: 'evaluate', confirmed: true, text: `(async()=>{localStorage.setItem('theme','dark');sessionStorage.setItem('draft','kept');document.querySelector('button').style.color='rgb(255, 0, 0)';console.log('BROWSER_DEBUG_OK');return await (await fetch('/api/data')).json();})()` });
  assert.equal((await debugCommand({ operation: 'storage' })).value.localStorage.theme, 'dark');
  assert.equal((await debugCommand({ operation: 'styles', selector: 'button' })).value.styles.color, 'rgb(255, 0, 0)');
  const events = await debugCommand({ operation: 'events' });
  assert.ok(events.events.some(event=>event.method==='Runtime.consoleAPICalled'));
  const apiRequest = events.events.find(event=>event.method==='Network.responseReceived' && event.params.response.url.endsWith('/api/data'));
  assert.ok(apiRequest);
  assert.match((await debugCommand({ operation: 'cdp', confirmed: true, method: 'Network.getResponseBody', params: { requestId: apiRequest.params.requestId } })).value.body, /"ok":true/);
  await debugCommand({ operation: 'storage', confirmed: true, params: { action: 'setCookies', cookies: [{ name: 'fixture', value: 'cookie-ok', url }] } });
  assert.equal((await debugCommand({ operation: 'storage' })).value.cookies.find(cookie=>cookie.name==='fixture').value, 'cookie-ok');
  await debugCommand({ operation: 'cdp', confirmed: true, method: 'Page.addScriptToEvaluateOnNewDocument', params: { source: "window.injectedByManager = true" } });
  await debugCommand({ operation: 'reload' });
  assert.equal((await debugCommand({ operation: 'evaluate', confirmed: true, text: 'window.injectedByManager' })).value, true);
  await debugCommand({ operation: 'cdp', confirmed: true, method: 'Fetch.enable', params: { patterns: [{ urlPattern: '*/api/intercept', requestStage: 'Request' }] } });
  await debugCommand({ operation: 'cdp', confirmed: true, method: 'Runtime.evaluate', params: { expression: "void fetch('/api/intercept').then(r=>r.text()).then(text=>window.intercepted = text)" } });
  let paused;
  for(let attempt=0;attempt<30;attempt++) { paused=(await debugCommand({ operation: 'events' })).events.find(event=>event.method==='Fetch.requestPaused');if(paused)break;await new Promise(resolve=>setTimeout(resolve,50)); }
  assert.ok(paused);
  await debugCommand({ operation: 'cdp', confirmed: true, method: 'Fetch.fulfillRequest', params: { requestId: paused.params.requestId, responseCode: 200, body: Buffer.from('MOCKED_BY_MANAGER').toString('base64') } });
  await debugCommand({ operation: 'cdp', confirmed: true, method: 'Fetch.disable' });
  assert.equal((await debugCommand({ operation: 'evaluate', confirmed: true, text: 'window.intercepted' })).value, 'MOCKED_BY_MANAGER');
  console.log('Real HTML/CSS, JS modification/injection, console/events, network response body/interception, storage/cookies passed.');
  const frontend = await build({ stdin: { contents: `
    import { render } from 'preact';
    import Browser from './webview-src/dashboard/workspaceBrowser';
    import { useRef, useState } from 'preact/hooks';
    import { SystemPicker, SystemStatusRows } from './webview-src/dashboard/systemPicker';
    const peers = [{id:'local',name:'Development PC',connected:true,local:true,sessionCount:5,systemStatus:{observedAt:Date.now(),battery:{percent:72,charging:true},networkConnected:true,cpuPercent:18,memoryUsed:8*1024**3,memoryTotal:16*1024**3,diskFree:128*1024**3,diskTotal:512*1024**3,uptimeSeconds:12500}},{id:'remote',name:'Build host',connected:false,sessionCount:2,systemStatus:{observedAt:Date.now()-120000,networkConnected:false,cpuPercent:40,memoryUsed:4*1024**3,memoryTotal:8*1024**3,uptimeSeconds:8000}}];
    function Systems(){const anchor=useRef(null);const [open,setOpen]=useState(false),[selected,setSelected]=useState('local'),[enabled,setEnabled]=useState(true);return <><label><input type='checkbox' checked={enabled} onChange={e=>setEnabled(e.currentTarget.checked)}/>System Info</label><button ref={anchor} onClick={()=>setOpen(value=>!value)}>Choose system</button><output aria-label='Chosen system'>{selected}</output>{enabled?<SystemStatusRows peer={peers.find(p=>p.id===selected)} connected={selected==='local'}/>:null}{open?<SystemPicker anchor={anchor} peers={peers} selectedId={selected} connected={true} privacyMode={false} systemInfoEnabled={enabled} accountCount={()=>3} onSelect={setSelected} onClose={()=>setOpen(false)}/>:null}</>};render(<Systems/>,document.querySelector('#systems'));
    render(<Browser projectPath={${JSON.stringify(root)}} connected={true} onFeedback={()=>{}} onInstruction={(text,image)=>{document.querySelector('#instruction').value=text;document.querySelector('#instruction-image').src=image||'';}} />,document.querySelector('#app'));
  `, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', jsx: 'automatic', jsxImportSource: 'preact' });
  uiBrowser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [];
  const ui = await uiBrowser.newPage({ viewport: { width: 1000, height: 1000 } });
  ui.on('pageerror', error => errors.push(error.message));
  let rejectSave = false;
  await ui.exposeFunction('browserAction', async message => {
    try {
      if (rejectSave && message.payload.browserRequest.operation === 'feedback') throw new Error('Fixture storage full');
      return { type: 'dashboard:action-result', requestId: message.requestId, status: 'completed', payload: { workspaceBrowser: await workspaceBrowser(root, message.payload.browserRequest) } };
    } catch (error) { return { type: 'dashboard:action-result', requestId: message.requestId, status: 'failed', error: error.message }; }
  });
  await ui.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage: message => { void window.browserAction(message).then(reply => window.postMessage(reply, '*')); } }); });
  await ui.route('http://127.0.0.1:39875/__browser-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="app" style="width:600px;height:900px"></main><section id="systems"></section><textarea id="instruction" aria-label="Instruction"></textarea><img id="instruction-image" alt="Marked instruction" />' }));
  await ui.goto('http://127.0.0.1:39875/__browser-fixture');
  await ui.addStyleTag({ content: await readFile('media/webview/shared.css', 'utf8') });
  await ui.addStyleTag({ content: await readFile('media/webview/quotaSummary.css', 'utf8') });
  await ui.addScriptTag({ content: frontend.outputFiles[0].text });
  await ui.getByRole('button', { name: 'Browser actions', exact: true }).click();
  await ui.getByRole('menu', { name: 'Browser actions', exact: true }).waitFor();
  await ui.keyboard.press('Escape');
  assert.equal(await ui.getByRole('menu', { name: 'Browser actions', exact: true }).count(), 0);
  assert.equal(await ui.locator('.workspace-browser-page-tabs').count(), 0, 'Browser pages use the parent workspace tab track.');
  await ui.locator('.workspace-browser-preview img').waitFor();
  await ui.getByRole('button', { name: 'Open browser inspector', exact: true }).click();
  const inspector = ui.getByRole('complementary', { name: 'Browser inspector', exact: true });
  await inspector.waitFor();
  assert.equal(await inspector.evaluate(element => getComputedStyle(element).position), 'static', 'Browser Inspector stays in the workspace layout');
  const previewBounds = await ui.locator('.workspace-browser-preview').boundingBox();
  const inspectorBounds = await inspector.boundingBox();
  assert.ok(inspectorBounds.y >= previewBounds.y + previewBounds.height - 1, 'Browser Inspector is docked below the preview');
  for (const name of ['Elements', 'Console', 'Sources', 'Network', 'Feedback']) {
    const tab = inspector.getByRole('tab', { name, exact: true });
    await tab.click();
    assert.equal(await tab.getAttribute('aria-selected'), 'true');
  }
  await ui.getByRole('button', { name: 'area', exact: true }).click();
  const preview = ui.locator('.workspace-browser-preview svg');
  await preview.focus();
  assert.equal(await preview.evaluate(element => document.activeElement === element), true, 'Browser preview must support keyboard focus.');
  await ui.keyboard.press('Enter'); await ui.keyboard.press('Shift+ArrowRight'); await ui.keyboard.press('Shift+ArrowDown');
  await ui.getByRole('textbox', { name: 'Area instruction or design feedback' }).fill('Improve this layout');
  assert.equal(await preview.locator('rect').count(), 1, 'Keyboard selection must create the current area mark.');
  console.log('Browser preview keyboard focus and area marking passed.');
  rejectSave = true;
  await ui.getByRole('button', { name: 'Save feedback' }).click();
  await ui.getByRole('alert').filter({ hasText: 'Fixture storage full' }).waitFor();
  assert.equal(await ui.getByRole('textbox', { name: 'Area instruction or design feedback' }).inputValue(), 'Improve this layout');
  rejectSave = false;
  await ui.getByRole('button', { name: 'Save feedback' }).click();
  await ui.waitForFunction(() => document.querySelector('[aria-label="Area instruction or design feedback"]').value === '');
  console.log('Storage failure preserves the draft; saving after recovery passed.');
  await ui.getByText('Saved feedback (2)', { exact: true }).click();
  const note = ui.locator('.workspace-browser article').filter({ hasText: 'Improve this layout' });
  await note.getByRole('button', { name: 'Add to instruction' }).click();
  await ui.waitForFunction(() => document.querySelector('#instruction').value.includes('Improve this layout') && document.querySelector('#instruction-image').src.startsWith('data:image/jpeg'));
  console.log('Marked feedback screenshot added to the instruction composer.');
  assert.deepEqual(errors, []);
  const artifacts = path.resolve('output/browser-check'); await mkdir(artifacts, { recursive: true });
  await ui.screenshot({ path: path.join(artifacts, 'feedback-desktop.png') });
  await ui.setViewportSize({ width: 390, height: 844 });
  await ui.locator('#app').evaluate(element => { element.style.width = '100%'; });
  await ui.locator('#instruction-image').evaluate(element => { element.style.maxWidth = '100%'; });
  await ui.screenshot({ path: path.join(artifacts, 'feedback-mobile.png') });
  const layout = await ui.evaluate(() => ({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body *')].filter(element=>element.getBoundingClientRect().right>innerWidth+2).map(element=>({tag:element.tagName,className:element.className,width:element.getBoundingClientRect().width,right:element.getBoundingClientRect().right})).slice(0,12)}));
  assert.ok(layout.scrollWidth <= layout.width + 2, JSON.stringify(layout));
  await ui.getByRole('button', { name: 'Choose system', exact: true }).click();
  await ui.getByRole('listbox', { name: 'Choose system' }).waitFor();
  assert.equal(await ui.locator('.system-picker-dropdown:popover-open').count(), 1);
  assert.equal(await ui.getByRole('option', { name: /Development PC/ }).evaluate(element => document.activeElement === element), true);
  await ui.keyboard.press('ArrowDown');
  assert.equal(await ui.getByRole('option', { name: /Build host/ }).evaluate(element => document.activeElement === element), true);
  const pickerBounds = await ui.getByRole('listbox', { name: 'Choose system' }).boundingBox();
  assert.ok(pickerBounds.x >= 0 && pickerBounds.x + pickerBounds.width <= 390 && pickerBounds.y >= 0 && pickerBounds.y + pickerBounds.height <= 844);
  await ui.evaluate(() => document.documentElement.style.setProperty('--dashboard-text-scale', '1.155'));
  for (const width of [320, 390]) {
    await ui.setViewportSize({ width, height: 844 });
    assert.deepEqual(await ui.locator('.system-picker-dropdown .system-status-rows > div').evaluateAll(rows => rows.filter(row => row.scrollWidth > row.clientWidth + 1).map(row => ({ width: row.clientWidth, contentWidth: row.scrollWidth }))), [], `System stats must fit ${width}px with browser text scaling.`);
  }
  await ui.screenshot({ path: path.join(artifacts, 'system-picker-mobile.png') });
  await ui.getByRole('option', { name: /Build host/ }).click();
  assert.equal(await ui.getByLabel('Chosen system').textContent(), 'remote');
  await ui.getByRole('checkbox', { name: 'System Info', exact: true }).uncheck();
  await ui.getByRole('button', { name: 'Choose system', exact: true }).click();
  assert.equal(await ui.locator('.system-status-rows').count(), 0);
  await ui.keyboard.press('Escape');
  assert.equal(await ui.getByRole('listbox', { name: 'Choose system' }).count(), 0);
  assert.equal(await ui.getByRole('button', { name: 'Choose system', exact: true }).evaluate(element => document.activeElement === element), true);
  await ui.getByRole('button', { name: 'Choose system', exact: true }).click();
  await ui.getByRole('checkbox', { name: 'System Info', exact: true }).click();
  assert.equal(await ui.getByRole('listbox', { name: 'Choose system' }).count(), 0);
  await ui.evaluate(() => {
    const fixture = document.createElement('div'); fixture.id = 'status-fixture';
    fixture.innerHTML = '<div class="cli-session-row" style="width:180px;height:30px;position:fixed;top:10px;left:10px;z-index:9999"><span class="cli-session-row-status is-interrupted"><i class="cli-session-status-dot"></i><span class="cli-session-row-menu-wrap"><button aria-label="Fixture session actions">⋯</button></span></span></div>';
    document.body.append(fixture);
  });
  await ui.mouse.move(380, 830);
  const dot = ui.locator('#status-fixture .cli-session-status-dot');
  assert.equal(await dot.evaluate(element => getComputedStyle(element).opacity), '1');
  await ui.locator('#status-fixture .cli-session-row').hover();
  await ui.waitForFunction(() => getComputedStyle(document.querySelector('#status-fixture .cli-session-status-dot')).opacity === '0');
  await ui.waitForFunction(() => getComputedStyle(document.querySelector('#status-fixture .cli-session-row-menu-wrap')).opacity === '1');
  await ui.locator('#status-fixture').evaluate(element => element.remove());
  console.log('System picker selection, counts, saved readings, mobile layout, setting visibility and Escape passed.');
  await uiBrowser.close(); uiBrowser = undefined;
  await disposeWorkspaceBrowsers();
  assert.equal((await workspaceBrowser(root, { operation: 'list' })).feedback.length, 2);

  const shell = await createWorkspaceTerminal(root, 'default', 'Standalone native');
  assert.ok(shell.shared);
  assert.ok(listWorkspaceTerminals().some(item => item.id === shell.id));
  const clientId = 'manager-terminal';
  const read = await workspaceTerminal(root, shell.id, { operation: 'read', clientId });
  await workspaceTerminal(root, shell.id, { operation: 'input', clientId, epoch: read.terminalSnapshot.epoch, sequence: 1, data: 'node -e "process.stdout.write(\'NATIVE_\'+\'OUTPUT_OK\')"\r' });
  let output = '';
  for (let attempt = 0; attempt < 40; attempt++) {
    output = (await workspaceTerminal(root, shell.id, { operation: 'read', clientId })).terminalSnapshot.content;
    if (output.includes('NATIVE_OUTPUT_OK')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(output, /NATIVE_OUTPUT_OK/);
  await workspaceTerminal(root, shell.id, { operation: 'rename', clientId, epoch: read.terminalSnapshot.epoch }, undefined, 'Renamed native');
  assert.equal(listWorkspaceTerminals().find(item => item.id === shell.id).name, 'Renamed native');
  await workspaceTerminal(root, shell.id, { operation: 'close', clientId, epoch: read.terminalSnapshot.epoch });
  assert.equal(listWorkspaceTerminals().length, 0);
  console.log('Real Chromium browser, saved feedback, stale revision protection, standalone PTY output/list/rename/close passed.');
} finally {
  await uiBrowser?.close();
  await disposeWorkspaceBrowsers(); disposeSharedTerminals();
  await new Promise(resolve => server.close(resolve));
  configureSqliteStateStore(undefined); store.close();
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
