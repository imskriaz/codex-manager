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
try {for(const width of [1440,390,320]){
  const context=await browser.newContext({viewport:{width,height:960},serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  let settings={workspaceRoot:'C:/workspaces',databaseProvider:'sqlite',postgresConfigured:false,maxActiveRequests:2,defaultModel:'fast',globalPrompt:'Help users get work done.',services:{revision:'initial',rendererUrl:'',runtimeUrl:'',searchDomains:[],rendererConfigured:false,runtimeConfigured:false,searchConfigured:true,rendererKeyConfigured:false,runtimeKeyConfigured:false}},saved,fail=true,failService=true,serviceSaves=0;
  await useWorkspaceDashboardAssets(page,origin,context);
  await context.route('**/assets/browserHost.js*',route=>route.fulfill({contentType:'text/javascript',body:host}));
  await context.route('**/api/office/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/api/office/models')return route.fulfill({json:{models:[{id:'fast',label:'Fast'},{id:'quality',label:'Quality'}]}});
    if(url.pathname==='/api/office/services')return route.fulfill({json:{services:{renderer:{status:'disabled',message:'Not configured'},runtime:{status:'unavailable',message:'Service did not respond. Saved settings are kept.'}},cleanup:[{remaining:2}]}});
    if(url.pathname==='/api/office/settings'){
      if(route.request().method()==='PUT'){
        saved=route.request().postDataJSON();
        if(fail){fail=false;return route.fulfill({status:409,json:{error:'Settings changed in another window. Review before saving.'}});}
        if(saved.services){serviceSaves++;if(failService){failService=false;return route.fulfill({status:409,json:{error:'Workspace settings changed in another window. Reload settings before saving.'}});}assert.equal(saved.services.searchToken,'');assert.equal(saved.services.rendererToken,undefined);assert.equal(saved.expectedSettings.services.revision,'initial');settings.services={...settings.services,revision:'updated',rendererUrl:saved.services.rendererUrl,searchConfigured:false};return route.fulfill({json:settings});}
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
  await page.getByRole('button',{name:'Configure services',exact:true}).click();const services=page.getByRole('dialog',{name:'Workspace services',exact:true});await services.waitFor();
  await services.getByRole('textbox',{name:'Document renderer URL',exact:true}).fill('http://127.0.0.1:39900');
  await services.getByRole('button',{name:'Check saved services',exact:true}).click();await services.getByRole('status').filter({hasText:'Service did not respond'}).waitFor();assert.equal(serviceSaves,0,'Checking saved services never submits a draft');
  await services.getByRole('button',{name:'Remove saved key',exact:true}).last().click();const clear=page.getByRole('dialog',{name:'Remove saved service key?',exact:true});await clear.waitFor();await clear.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(serviceSaves,0);
  await services.getByRole('button',{name:'Remove saved key',exact:true}).last().click();await clear.getByRole('button',{name:'Remove key',exact:true}).click();
  await services.getByRole('button',{name:'Save services',exact:true}).click();await services.getByRole('alert').filter({hasText:'changed in another window'}).waitFor();assert.equal(await services.getByRole('textbox',{name:'Document renderer URL',exact:true}).inputValue(),'http://127.0.0.1:39900');
  assert.ok(await services.evaluate(el=>el.scrollWidth<=el.clientWidth+2));await services.getByRole('button',{name:'Save services',exact:true}).scrollIntoViewIfNeeded();const submit=await services.getByRole('button',{name:'Save services',exact:true}).boundingBox();assert.ok(submit&&submit.y>=0&&submit.y+submit.height<=960);
  await page.screenshot({path:path.join(output,`services-${width}.png`)});await services.getByRole('button',{name:'Save services',exact:true}).click();await services.waitFor({state:'hidden'});await page.getByRole('status').filter({hasText:'Workspace services saved.'}).waitFor();assert.equal(serviceSaves,2);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(output,`workspace-${width}.png`),fullPage:true});
  console.log(JSON.stringify({width,elapsedMs:Date.now()-start,globalPrompt:true,queueSlider:true,failedSavePreserved:true,serviceChecks:true,separateConfirmation:true,errors:0}));
  await context.close();
}}finally{await browser.close();}
console.log('Screenshots: '+output);
