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
  const config = { defaultModel:'fast',models:[{id:'fast',label:'Fast',reasoningEfforts:['low','medium']}],projects:[{id:'root',path:'C:/team/alex',label:'My workspace'},{id:'local',path:'C:/team/alex/Local-fixture',label:'My project',localFolder:{name:'My local folder'}}],defaultSandboxMode:'workspace-write',terminalSupported:false };
  const session={id:'12345678-1234-1234-1234-123456789abc',title:'Local folder session',status:'idle',projectPath:'C:/team/alex/Local-fixture',updatedAt:new Date().toISOString()};
  const dispatch = data => dispatchEvent(new MessageEvent('message',{data:structuredClone(data)}));
  window.__sentMessages=[];
  window.__withoutProject=()=>{session.projectPath='';config.projects=config.projects.filter(project=>!project.localFolder);dispatch({type:'dashboard:action-result',requestId:'auto-project',action:'listCodexCliSessions',status:'completed',payload:{cliSessions:[session],cliComposerConfig:config}});};
  window.acquireVsCodeApi = () => ({getState(){return{}},setState(){},postMessage(message){setTimeout(() => {
    if (message.type === 'dashboard:ready' || message.type === 'dashboard:workspace-presence') { dispatch({type:'dashboard:snapshot',state});dispatch({type:'dashboard:connection',connected:true}); }
    else if (message.type === 'dashboard:action') {
      if(['startCodexCliSession','sendCodexCliSessionMessage'].includes(message.action))window.__sentMessages.push(message);
      dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'completed',payload:message.action === 'listCodexCliSessions' ? {cliSessions:[session],cliComposerConfig:config} : message.action==='getCodexCliSessionMessages'?{cliSession:session,cliSessionMessages:[]}:['startCodexCliSession','sendCodexCliSessionMessage'].includes(message.action)?{cliSession:session,cliSessions:[session],cliSessionMessages:[{id:message.requestId,role:'user',text:message.payload.text}]}:{}});
    }
  }, 5)}});
})();`;
const output = path.join(os.tmpdir(), 'codex-manager-local-folder-ui'); await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 850 }, serviceWorkers: 'block' });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = [], queue = [], results = new Map(), registrations = [];
    let failPolls = 0;
    page.on('pageerror', error => errors.push(error.stack || error.message));
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
        if (body.operation === 'poll') {
          if (failPolls > 0) { failPolls--; return route.fulfill({ contentType:'application/json', body:'interrupted' }); }
          return route.fulfill({ json: { commands: queue.splice(0) } });
        }
        if (body.operation === 'result') results.set(body.id, body);
        return route.fulfill({ json: { completed: true } });
      }
      return route.fulfill({ json: url.pathname === '/api/state' ? state : url.pathname==='/api/email/preferences'?{watches:[],available:false}:{ limits: {}, usage: {}, records: [], messages: [] } });
    });
    await page.addInitScript(() => {
      Object.defineProperty(FileSystemHandle.prototype,'queryPermission',{value(){return window.__blockFolderPermission ? new Promise(()=>{}) : Promise.resolve(window.__folderPermission || 'granted');}});
      window.showDirectoryPicker = async options => {
        window.__folderPicks = (window.__folderPicks || 0) + 1;
        if (options.mode !== 'readwrite') throw Error('Expected folder read/write permission');
        if (window.__cancelFolder) throw new DOMException('Cancelled', 'AbortError');
        window.__folderPermission='granted';
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
    await page.evaluate(() => { window.__folderRestored = 0; window.addEventListener('codex-manager:local-folder-connected', () => window.__folderRestored++); });
    failPolls = 1;
    const recovered = await run({ id:'recovered',operation:'read',path:'readme.txt' });assert.equal(atob(recovered.result.data),'After');
    await page.waitForFunction(() => window.__folderRestored > 0);
    assert.equal(await page.evaluate(() => window.__folderPicks), 2, 'An interrupted connection reuses approval without showing the picker again');
    await page.reload(); await page.locator('.cli-workspace').waitFor();
    await page.waitForTimeout(500);
    assert.equal(registrations.length,1,'Workspace startup does not reconnect unrelated saved projects');
    await page.goto(origin+'/workspace/12345678-1234-1234-1234-123456789abc');await page.locator('.cli-workspace').waitFor();
    const deadline = Date.now() + 10000;
    while (registrations.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(registrations.length, 2, 'Restores remembered folder permission only when its session opens');
    assert.equal(registrations[1].client, registrations[0].client, 'Reload retains the owning tab connection');
    assert.equal(registrations[1].project, 'C:/team/alex/Local-fixture');
    const restored = await run({ id: 'restored', operation: 'read', path: 'readme.txt' }); assert.equal(atob(restored.result.data), 'After');
    if(width===1440){
      await page.clock.install();await page.evaluate(()=>{window.__blockFolderPermission=true;});
      await page.locator('.cli-composer textarea').fill('Keep a draft after an access timeout');await page.getByRole('button',{name:'Send message',exact:true}).click();
      await page.clock.fastForward(13_000);await page.clock.runFor(100);
      const timeoutModal=page.getByRole('dialog',{name:'Reconnect My local folder',exact:true});await timeoutModal.getByText('Folder access could not be confirmed. Your message has not been sent. Reconnect the folder to continue.',{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>window.__sentMessages.length),0);await timeoutModal.getByRole('button',{name:'Cancel',exact:true}).click();
      assert.equal(await page.locator('.cli-composer textarea').inputValue(),'Keep a draft after an access timeout');
      await page.evaluate(()=>{window.__blockFolderPermission=false;});await page.clock.resume();
    }
    await page.evaluate(()=>{window.__folderPermission='prompt';});
    assert.equal(await page.getByRole('dialog',{name:'Reconnect My local folder',exact:true}).count(),0,'Opening a session does not prompt for folder permission');
    assert.equal(await page.locator('.dashboard-notice').count(),0,'No reconnect toast');
    const composer=page.locator('.cli-composer textarea');await composer.fill('Review the files in my folder');
    await page.getByRole('button',{name:'Send message',exact:true}).click();
    const reconnect=page.getByRole('dialog',{name:'Reconnect My local folder',exact:true});await reconnect.waitFor();
    assert.equal(await page.evaluate(()=>window.__sentMessages.length),0,'No message is sent before folder access is approved');
    await page.screenshot({path:path.join(output,`send-folder-permission-${width}.png`),animations:'disabled'});
    await reconnect.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(await composer.inputValue(),'Review the files in my folder','Cancelling keeps the draft');
    await page.getByRole('button',{name:'Send message',exact:true}).click();await reconnect.waitFor();
    await page.evaluate(()=>{window.__cancelFolder=true;});await reconnect.getByRole('button',{name:'Reconnect folder…',exact:true}).click();
    await reconnect.getByText('Folder selection cancelled.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__sentMessages.length),0);
    await page.evaluate(()=>{window.__cancelFolder=false;});await reconnect.getByRole('button',{name:'Reconnect folder…',exact:true}).click();
    await reconnect.waitFor({state:'detached'});await page.waitForFunction(()=>window.__sentMessages.length===1);
    assert.equal(await page.evaluate(()=>window.__sentMessages[0].payload.text),'Review the files in my folder');
    await page.evaluate(()=>{window.__folderPermission='prompt';window.__withoutProject();});
    await composer.fill('A message without a project');await page.getByRole('button',{name:'Send message',exact:true}).click();
    await page.waitForFunction(()=>window.__sentMessages.length===2);assert.equal(await reconnect.count(),0,'No project needs no folder modal');
    assert.equal(await page.locator('.dashboard-notice').count(),0,'Folder cancellation and reconnection stay in the modal');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, modalMs, elapsedMs: Date.now() - started, folderPicker: true, cancelled: true, localReadWrite: true, conflictPreserved: true, interruptionRecovered:true, reloadRestored: true, sendOpensPermissionModal:true,cancelKeepsDraft:true,reconnectSendsOnce:true,noProjectNoPrompt:true,noReconnectToast:true,errors: 0 }));
    await context.close();
  }
} finally { await browser.close(); console.log('Screenshots: ' + output); }
