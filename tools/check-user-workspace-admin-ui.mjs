import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {useWorkspaceDashboardAssets} from './workspace-dashboard-assets.mjs';

// Every mutation is fulfilled by a fixture; the local host receives only reads.
const origin='http://127.0.0.1:39875';
const raw=await(await fetch(origin+'/api/state')).json();
const state={...raw,accounts:[],connectedPeers:[],peerAccounts:{},office:{id:'master',role:'unrestricted-admin',enabled:true,features:[],displayName:'Administrator'},settings:{...raw.settings,webDashboardEnabled:true,teamWorkspaceEnabled:true,cliIntegrationEnabled:true}};
const host=`(()=>{const state=${JSON.stringify(state)};const dispatch=data=>dispatchEvent(new MessageEvent('message',{data:structuredClone(data)}));window.acquireVsCodeApi=()=>({getState(){return{}},setState(){},postMessage(message){setTimeout(()=>{if(message.type==='dashboard:ready'||message.type==='dashboard:workspace-presence'){dispatch({type:'dashboard:snapshot',state});dispatch({type:'dashboard:connection',connected:true});}else if(message.type==='dashboard:action')dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'completed',payload:message.action==='listCodexCliSessions'?{cliSessions:[],cliComposerConfig:{models:[],projects:[],defaultSandboxMode:'workspace-write',terminalSupported:false}}:{}});},10)}})})();`;
const browser=await chromium.launch({channel:'msedge',headless:true});
const output=path.join(os.tmpdir(),'codex-manager-user-workspace-admin');await mkdir(output,{recursive:true});
try {for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:960},serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  let settings={workspaceRoot:'C:/workspaces',databaseProvider:'sqlite',postgresConfigured:false,maxActiveRequests:2,defaultModel:'fast',globalPrompt:'Help users get work done.'},saved,fail=true;
  await useWorkspaceDashboardAssets(page,origin,context);
  await context.route('**/assets/browserHost.js*',route=>route.fulfill({contentType:'text/javascript',body:host}));
  await context.route('**/api/office/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/api/office/models')return route.fulfill({json:{models:[{id:'fast',label:'Fast'},{id:'quality',label:'Quality'}]}});
    if(url.pathname==='/api/office/settings'){
      if(route.request().method()==='PUT'){
        saved=route.request().postDataJSON();
        if(fail){fail=false;return route.fulfill({status:409,json:{error:'Settings changed in another window. Review before saving.'}});}
        settings={...settings,...saved};
      }
      return route.fulfill({json:settings});
    }
    return route.fulfill({json:url.pathname.endsWith('/users')?{users:[]}:{servers:[],entries:[]}});
  });
  const start=Date.now();await page.goto(origin+'/?settings=workspace');
  const prompt=page.getByRole('textbox',{name:'Global User Workspace Prompt',exact:true});await prompt.waitFor();
  assert.equal(await prompt.inputValue(),'Help users get work done.');
  const model=page.getByRole('combobox',{name:'Default User Workspace model',exact:true});await model.selectOption('quality');
  await prompt.fill('Use clear language and ask when requirements are unclear.');
  const slider=page.getByRole('slider',{name:'Maximum active workspace requests',exact:true});
  await slider.evaluate(input=>{input.value='4';input.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.getByRole('button',{name:'Save workspace settings',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Settings changed in another window.'}).waitFor();
  assert.equal(await prompt.inputValue(),'Use clear language and ask when requirements are unclear.');
  await page.getByRole('button',{name:'Save workspace settings',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Team settings saved.'}).waitFor();
  assert.equal(saved.defaultModel,'quality');assert.equal(await model.inputValue(),'quality');
  assert.equal(saved.maxActiveRequests,4);assert.equal(saved.globalPrompt,await prompt.inputValue());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(output,`workspace-${width}.png`),fullPage:true});
  console.log(JSON.stringify({width,elapsedMs:Date.now()-start,globalPrompt:true,queueSlider:true,failedSavePreserved:true,errors:0}));
  await context.close();
}}finally{await browser.close();}
console.log('Screenshots: '+output);
