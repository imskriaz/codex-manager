import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

// The host receives reads only. Setting changes and administration use fixtures.
const origin = 'http://127.0.0.1:39875';
const raw = await (await fetch(origin + '/api/state')).json();
const keys = ['webDashboardEnabled','cliIntegrationEnabled','teamWorkspaceEnabled','apiAccessEnabled','webSocketServerEnabled','encryptedSyncEnabled','codexAppRestartEnabled','dailyTokenUsageEnabled','persistentLoggingEnabled'];
const output = path.join(os.tmpdir(), 'codex-manager-settings-modules-ui');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const [width,height,mode] of [[1440,900,'browser'],[900,390,'browser'],[390,844,'browser'],[320,667,'browser'],[1440,900,'webview']]) {
    const context = await browser.newContext({ viewport:{width,height}, serviceWorkers:'block' });
    const page = await context.newPage();page.setDefaultTimeout(15000);
    const errors = [];page.on('pageerror',error=>errors.push(error.message));
    await useWorkspaceDashboardAssets(page,origin,context);
    const state = {...raw,onboardingCompleted:true,accounts:[],connectedPeers:[],peerAccounts:{},office:{id:'master',role:'unrestricted-admin',enabled:true,features:[]},settings:{...raw.settings,...Object.fromEntries(keys.map(key=>[key,false]))}};
    const host = `(()=>{const state=${JSON.stringify(state)};const emit=()=>dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:snapshot',state:structuredClone(state)}}));window.__modules=(enabled)=>{for(const key of ${JSON.stringify(keys)})state.settings[key]=enabled;emit();};window.acquireVsCodeApi=()=>({getState(){return{}},setState(){},postMessage(message){if(message.type==='dashboard:ready')setTimeout(()=>{emit();dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:true}}));},0);else if(message.type==='dashboard:setting'){state.settings[message.key]=message.value;emit();}}});})();`;
    await context.route('**/assets/browserHost.js*',route=>route.fulfill({contentType:'text/javascript',body:host}));
    await context.route('**/api/office/**',route=>route.fulfill({json:{users:[],servers:[],entries:[],workspaceRoot:'',databaseProvider:'sqlite',postgresConfigured:false}}));
    if(mode==='webview')await page.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>document.documentElement.dataset.dashboardHost='vscode'));
    const start=Date.now();await page.goto(origin+'/?settings=modules');
    const modal=page.locator('.settings-master-modal');await modal.waitFor();
    const picker=modal.locator('.settings-mobile-picker select');
    const sections=()=>picker.locator('option').evaluateAll(options=>options.map(option=>option.value));
    assert.deepEqual(await sections(),['general','modules','automation','data','tools']);
    assert.equal(await modal.locator('#settings-panel-modules [role=switch][aria-checked=true]').count(),0);
    await page.evaluate(()=>window.__modules(true));
    await modal.locator('#settings-tab-connections').waitFor({state:'attached'});
    assert.deepEqual(await sections(),['general','modules','automation','data','connections','sessions','users','tools']);
    const select=async id=>{if(await picker.isVisible())await picker.selectOption(id);else await modal.locator('#settings-tab-'+id).click();};
    for(const group of ['connections','sessions','data','users']) {
      await select(group);await modal.locator('.settings-tab-panel:not([hidden])').first().waitFor();
      const expected=group==='connections'?['dashboard','connections','sync']:group==='sessions'?['sessions','desktop']:group==='data'?['usage','system-log','data']:['users'];
      for(const id of expected)assert.ok(await modal.locator('#settings-panel-'+id).isVisible(),id+' is in '+group);
      assert.ok(await modal.locator('.settings-modal-body').evaluate(node=>node.scrollWidth<=node.clientWidth+2));
    }
    const groupPicker=modal.getByRole('combobox',{name:'Workspace section',exact:true});
    assert.equal(await groupPicker.locator('option').count(),6);
    await select('sessions');
    await page.evaluate(()=>window.acquireVsCodeApi().postMessage({type:'dashboard:setting',key:'cliIntegrationEnabled',value:false}));
    await modal.locator('#settings-panel-sessions').waitFor({state:'hidden'});
    assert.ok(await modal.locator('#settings-panel-sessions').isHidden(),'Disabled session options stay hidden while Desktop is enabled');
    assert.ok(await modal.locator('#settings-panel-desktop').isVisible());
    if(width>760){
      const nav=modal.locator('.settings-tab-list');
      assert.equal(await nav.evaluate(node=>getComputedStyle(node).overflowY),'scroll');
      await nav.evaluate(node=>node.scrollTop=node.scrollHeight);
      assert.ok(await modal.locator('#settings-tab-tools').isVisible());
    }
    await page.screenshot({path:path.join(output,`grouped-${width}-${height}-${mode}.png`)});
    await select('connections');await page.evaluate(()=>window.__modules(false));
    await modal.locator('#settings-panel-general').waitFor();
    assert.deepEqual(await sections(),['general','modules','automation','data','tools']);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
    assert.deepEqual(errors,[]);console.log(JSON.stringify({width,height,mode,loadMs:Date.now()-start,groups:true,moduleOptionsConditional:true,disabledFallback:true,scrollbar:true,errors:0}));
    await context.close();
  }
} finally { await browser.close(); }
console.log('Screenshots: '+output);
