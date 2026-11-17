import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

// All writes and action responses belong to this fixture, never the local host.
const origin = 'http://127.0.0.1:39875';
const output = path.join(tmpdir(), 'codex-manager-project-sidebar');
await mkdir(output, { recursive: true });
const compiled = await build({ stdin: { contents: `
  import { render } from 'preact';
  import { useState } from 'preact/hooks';
  import { CliSessionsPage } from './webview-src/dashboard/cliSessionsModal';
  const first={id:'first',title:'First session',status:'idle',projectPath:'D:/one'};
  const second={id:'second',title:'Second session',status:'idle',projectPath:'D:/one'};
  const projects=[{id:'one',label:'One',path:'D:/one'},{id:'two',label:'Two',path:'D:/two'}];
  const noop=()=>{};
  function App(){
    const [sessions,setSessions]=useState([first,second]);
    const [selected,onSelect]=useState(first);
    return <CliSessionsPage {...Object.fromEntries(['onDashboard','onSettings','onSwitchAccount','onRefresh','onStart','onBackToList','onRefreshMessages','onRefreshEnvironment','onRunTerminal','onListTerminals','onCreateTerminal','onFocusTerminal','onCloseTerminal','onCancelTerminal','onCommitWorkspace','onPushWorkspace','onClearTerminal','onListFiles','onReadFile','onClearFile','onDeleteFile','onSaveFile','onSend','onStop','onResume','onAutoResume','onQueue','onRename','onFork','onCopyLink','onShare','onArchive','onOpenInCodex','onUnarchive','onDelete'].map(key=>[key,noop]))}
      privacyMode={false} autoResumeEnabled={false} browser connected selectedPeerId="local"
      peers={[{id:'local',local:true,name:'This PC',connected:true}]} sessions={sessions} selectedSession={selected} onSelect={onSelect}
      composerConfig={{models:[],projects,defaultSandboxMode:'read-only'}} messages={[]} terminalResults={[]} terminalLiveOutputs={[]} workspaceTerminals={[]}
      workspaceFiles={[]} workspaceFilesByPath={{}} onActionFeedback={value=>window.feedback=value}
      onMoveSession={(source,destination)=>{window.moved={source:source.id,destination};setSessions(rows=>rows.map(row=>row.id===source.id?{...row,projectPath:destination}:row));}}
    />;
  }
  localStorage.setItem('codexManager.workspaceLayout.v2',JSON.stringify({sessionView:'projects',railWidth:300,terminalWidth:320,composerHeight:136}));
  render(<App/>,document.querySelector('#app'));
`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, loader: { '.css': 'text' }, format: 'esm', jsx: 'automatic', jsxImportSource: 'preact' });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => { window.requests = []; window.acquireVsCodeApi = () => ({ postMessage: message => window.requests.push(message) }); });
    await page.route(origin + '/__project-ui', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html data-theme="dark"><body><main id="app"></main><script type="module" src="/__project-ui.js"></script></body></html>' }));
    await page.route(origin + '/__project-ui.js', route => route.fulfill({ contentType: 'text/javascript', body: compiled.outputFiles[0].text }));
    const start = Date.now();
    await page.goto(origin + '/__project-ui');
    await page.addStyleTag({ content: await readFile('media/webview/shared.css', 'utf8') });
    await page.addStyleTag({ content: await readFile('media/webview/quotaSummary.css', 'utf8') });
    const show = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
    if (await show.isVisible()) await show.click();
    await page.getByRole('button', { name: 'Expand One', exact: true }).click();
    assert.equal(await page.locator('.cli-session-drag').count(), 0);
    assert.equal(await page.locator('.cli-session-row[draggable=true]').count(), 2);
    const weights = await page.locator('.cli-session-row-main strong').evaluateAll(rows => rows.map(row => getComputedStyle(row).fontWeight));
    assert.deepEqual(weights, ['700', '600']);
    await page.getByRole('button', { name: 'Expand Two', exact: true }).click();
    assert.equal(await page.locator('.cli-project-empty').innerText(), 'No sessions yet\nNew chat');
    await page.locator('.cli-project-edit').first().focus();
    await page.getByRole('button', { name: 'Edit One', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit One', exact: true });
    await dialog.waitFor();
    assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 2));
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await page.evaluate(() => { const request = window.requests.find(value => value.action === 'renameWorkspaceProject'); window.postMessage({ type:'dashboard:action-result',requestId:request.requestId,action:request.action,status:'failed',error:'Fixture storage unavailable' }, '*'); });
    await dialog.getByRole('alert').filter({ hasText: 'Fixture storage unavailable' }).waitFor();
    await page.screenshot({ path: path.join(output, 'modal-' + width + '.png') });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.screenshot({ path: path.join(output, 'folders-' + width + '.png') });
    await page.locator('.cli-session-row[draggable=true]').first().dragTo(page.getByRole('button', { name: 'Collapse Two', exact: true }));
    assert.deepEqual(await page.evaluate(() => window.moved), { source: 'first', destination: 'D:/two' });
    await page.getByRole('button', { name: 'Show compact session list', exact: true }).click();
    assert.equal(await page.locator('.cli-session-drag').count(), 0);
    assert.equal(await page.locator('[draggable=true]').count(), 0);
    await page.screenshot({ path: path.join(output, 'list-' + width + '.png') });
    assert.deepEqual(errors, []);
    results.push({ width, elapsedMs: Date.now() - start, checks: 'weights, empty rows, modal feedback, folder drag, list without drag' });
    await context.close();
  }
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ output, results }, null, 2));
} finally { await browser.close(); }
