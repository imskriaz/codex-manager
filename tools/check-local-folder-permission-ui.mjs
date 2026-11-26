import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

const origin = 'http://127.0.0.1:39875';
const raw = await (await fetch(origin + '/api/state')).json();
const project = { id:'local-fixture',label:'Connected folder',path:'C:/fixture/connected',localFolder:{name:'Connected folder'} };
const session = { id:'12345678-1234-1234-1234-123456789abc',title:'Folder permission check',status:'idle',projectPath:project.path,updatedAt:new Date().toISOString() };
const state = { ...raw,office:{id:'permission-fixture',role:'user',displayName:'Fixture',features:['generalChat','files'],workspacePath:'',mcpServers:[]},accounts:[],connectedPeers:[],peerAccounts:{},settings:{...raw.settings,teamWorkspaceEnabled:true,cliIntegrationEnabled:true,dashboardTheme:'light'} };
const config = { defaultModel:'regular',models:[{id:'regular',label:'Regular',reasoningEfforts:['low','medium']}],projects:[project],defaultSandboxMode:'workspace-write',terminalSupported:false };
const mockHost = `(()=>{
document.documentElement.dataset.dashboardUser='permission-fixture';
const state=${JSON.stringify(state)},session=${JSON.stringify(session)},config=${JSON.stringify(config)};
const dispatch=data=>window.dispatchEvent(new MessageEvent('message',{data}));
window.acquireVsCodeApi=()=>({getState(){return{};},setState(){},postMessage(message){setTimeout(()=>{
if(['dashboard:ready','dashboard:workspace-presence'].includes(message.type)){dispatch({type:'dashboard:snapshot',state});dispatch({type:'dashboard:connection',connected:true});return;}
if(message.type!=='dashboard:action')return;
const payload=message.action==='listCodexCliSessions'?{cliSessions:[session],cliComposerConfig:config}:message.action==='getCodexCliSessionMessages'?{cliSession:session,cliSessionMessages:[]}:message.action==='getWorkspaceEnvironment'?{workspaceEnvironment:{projectPath:session.projectPath,projectName:'Connected folder',changes:0}}:{};
dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'completed',payload});
},0);}});
})();`;
const output = path.join(os.tmpdir(),'codex-folder-permission-ui');
await mkdir(output,{recursive:true});
const browser = await chromium.launch({channel:'msedge',headless:true});
try {
  for (const width of [1440,390]) {
    const context = await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
    const page = await context.newPage(), errors=[];
    page.setDefaultTimeout(15000);
    page.on('pageerror',error=>errors.push(error.message));
    let permission='write',failSave=false;
    await useWorkspaceDashboardAssets(page,origin,context);
    await context.route('**/assets/browserHost.js*',route=>route.fulfill({contentType:'text/javascript',body:mockHost}));
    await context.route('**/api/workspace/local-folder',route=>{
      const body=route.request().postDataJSON();
      if(body.operation!=='permission')return route.fulfill({status:400,json:{error:'Unexpected fixture action.'}});
      if(body.permission&&failSave){failSave=false;return route.fulfill({status:409,json:{error:'A folder action is still in progress. Wait for its result before changing permission.'}});}
      if(body.permission)permission=body.permission;
      return route.fulfill({json:{permission}});
    });
    const start=Date.now();
    await page.goto(origin+'/workspace/'+session.id,{waitUntil:'domcontentloaded'});
    await page.locator('.cli-workspace').waitFor();
    await page.getByRole('button',{name:'Message settings',exact:true}).click();
    const select=page.getByRole('combobox',{name:'Folder permission',exact:true});
    await select.locator('option[value="write"]').waitFor({state:'attached'});
    await page.waitForFunction(()=>document.querySelector('[aria-label="Folder permission"]')?.disabled===false);
    assert.equal(await select.inputValue(),'write');
    assert.equal(await select.locator('option[value="write"]').textContent(),'Write');
    await select.selectOption('full');
    await page.locator('.cli-composer-permission.is-full-access').waitFor();
    assert.equal((await page.locator('.cli-composer-permission').textContent()).trim(),'Full');
    failSave=true;
    await select.selectOption('read-only');
    await page.getByText('A folder action is still in progress. Wait for its result before changing permission.',{exact:true}).first().waitFor();
    await page.waitForFunction(()=>document.querySelector('[aria-label="Folder permission"]')?.disabled===false);
    assert.equal(await select.inputValue(),'full');
    permission='read-only';
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(()=>document.querySelector('[aria-label="Folder permission"]')?.value==='read-only');
    assert.equal((await page.locator('.cli-composer-permission').textContent()).trim(),'Read only');
    await page.screenshot({path:path.join(output,`permission-${width}.png`)});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({width,loadAndCheckMs:Date.now()-start,defaultWrite:true,inlinePermission:true,failedSavePreserved:true,focusRefresh:true,errors}));
    await context.close();
  }
} finally { await browser.close(); }
