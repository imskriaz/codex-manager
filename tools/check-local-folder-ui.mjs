import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

// The installed host receives reads only. Writes use a temporary browser filesystem and API fixtures.
const origin = 'http://127.0.0.1:39875';
const raw = await (await fetch(origin + '/api/state')).json();
const office = { id: 'local-folder-fixture', username: 'alex@example.test', displayName: 'Alex', role: 'user', features: ['generalChat','files','env','browser'], workspacePath: '', mcpServers: [] };
const state = { ...raw, office, accounts: [], connectedPeers: [], peerAccounts: {}, onboardingCompleted: true, settings: { ...raw.settings, teamWorkspaceEnabled: true, cliIntegrationEnabled: true, dashboardTheme: 'light' } };
const mockHost = `(() => {
  const state = ${JSON.stringify(state)};
  const config = { defaultModel:'fast',models:[{id:'fast',label:'Fast',reasoningEfforts:['low','medium']}],projects:[{id:'root',path:'C:/team/alex',label:'My workspace'}],defaultSandboxMode:'workspace-write',terminalSupported:false };
  const dispatch = data => dispatchEvent(new MessageEvent('message',{data:structuredClone(data)}));
  window.acquireVsCodeApi = () => ({getState(){return{}},setState(){},postMessage(message){setTimeout(() => {
    if (message.type === 'dashboard:ready' || message.type === 'dashboard:workspace-presence') { dispatch({type:'dashboard:snapshot',state});dispatch({type:'dashboard:connection',connected:true}); }
    else if (message.type === 'dashboard:action') dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'completed',payload:message.action === 'listCodexCliSessions' ? {cliSessions:[],cliComposerConfig:config} : {}});
  }, 5)}});
})();`;
const output = path.join(os.tmpdir(), 'codex-manager-local-folder-ui'); await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 850 }, serviceWorkers: 'block' });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = [], queue = [], results = new Map(), registrations = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await useWorkspaceDashboardAssets(page, origin, context);
    await context.route('**/assets/browserHost.js*', route => route.fulfill({ contentType: 'text/javascript', body: mockHost }));
    await context.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/workspace/local-folder') {
        const body = route.request().postDataJSON();
        if (body.operation === 'connect') {
          registrations.push(body);
          return route.fulfill({ json: { project: { id: 'local', label: 'My project', path: 'C:/team/alex/Local-fixture', localFolder: { name: 'My local folder' } } } });
        }
        if (body.operation === 'poll') return route.fulfill({ json: { commands: queue.splice(0) } });
        if (body.operation === 'result') results.set(body.id, body);
        return route.fulfill({ json: { completed: true } });
      }
      return route.fulfill({ json: url.pathname === '/api/state' ? state : { limits: {}, usage: {}, records: [], messages: [] } });
    });
    await page.addInitScript(() => {
      window.showDirectoryPicker = async options => {
        if (options.mode !== 'readwrite') throw Error('Expected folder read/write permission');
        if (window.__cancelFolder) throw new DOMException('Cancelled', 'AbortError');
        const root = await navigator.storage.getDirectory();
        const folder = await root.getDirectoryHandle('My local folder', { create: true });
        const file = await folder.getFileHandle('readme.txt', { create: true });
        const writable = await file.createWritable(); await writable.write('Before'); await writable.close();
        return folder;
      };
    });
    const started = Date.now(); await page.goto(origin + '/workspace');
    await page.locator('.cli-workspace').waitFor();
    await page.getByRole('combobox', { name: 'Project', exact: true }).click();
    await page.getByRole('button', { name: 'Create new', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Add Project', exact: true }); await modal.waitFor();
    const modalMs = Date.now() - started;
    const name = modal.getByRole('textbox', { name: 'Project name', exact: true });
    const folder = modal.getByRole('button', { name: 'Local folder (optional)', exact: true });
    assert.equal(await modal.locator('input[type=file]').count(), 0);
    assert.ok((await folder.boundingBox()).y > (await name.boundingBox()).y);
    await name.fill('My project');
    await page.screenshot({ path: path.join(output, `optional-folder-${width}.png`), animations: 'disabled' });
    await page.evaluate(() => { window.__cancelFolder = true; }); await folder.click();
    await modal.getByRole('status').filter({ hasText: 'Folder selection cancelled.' }).waitFor();
    assert.equal(await name.inputValue(), 'My project');
    await page.evaluate(() => { window.__cancelFolder = false; }); await folder.click();
    await modal.getByText('Selected folder: My local folder', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, `selected-folder-${width}.png`), animations: 'disabled' });
    const bounds = await modal.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await modal.getByRole('button', { name: 'Add project', exact: true }).click(); await modal.waitFor({ state: 'detached' });
    assert.equal(registrations[0].name, 'My project'); assert.equal(registrations[0].folderName, 'My local folder');
    const run = async command => {
      queue.push({ ...command, expiresAt: Date.now() + 10000 });
      const deadline = Date.now() + 12000;
      while (!results.has(command.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(results.has(command.id), `Folder command ${command.id} completed`); return results.get(command.id);
    };
    const read = await run({ id: 'read', operation: 'read', path: 'readme.txt' }); assert.equal(read.error, undefined); assert.equal(atob(read.result.data), 'Before');
    const saved = await run({ id: 'save', operation: 'write', path: 'readme.txt', revision: read.result.revision, data: btoa('After') }); assert.equal(saved.error, undefined);
    const stale = await run({ id: 'stale', operation: 'write', path: 'readme.txt', revision: read.result.revision, data: btoa('Wrong') }); assert.match(stale.error, /exists or changed/);
    const denied = await run({ id: 'escape', operation: 'read', path: '../secret' }); assert.match(denied.error, /relative path/);
    const verify = await run({ id: 'verify', operation: 'read', path: 'readme.txt' }); assert.equal(atob(verify.result.data), 'After');
    await page.reload(); await page.locator('.cli-workspace').waitFor();
    const deadline = Date.now() + 10000;
    while (registrations.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(registrations.length, 2, 'Restores remembered folder permission');
    assert.equal(registrations[1].client, registrations[0].client, 'Reload retains the owning tab connection');
    assert.equal(registrations[1].project, 'C:/team/alex/Local-fixture');
    const restored = await run({ id: 'restored', operation: 'read', path: 'readme.txt' }); assert.equal(atob(restored.result.data), 'After');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, modalMs, elapsedMs: Date.now() - started, folderPicker: true, cancelled: true, localReadWrite: true, conflictPreserved: true, reloadRestored: true, errors: 0 }));
    await context.close();
  }
} finally { await browser.close(); console.log('Screenshots: ' + output); }
