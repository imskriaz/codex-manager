import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

const origin = 'http://127.0.0.1:39875';
const raw = await (await fetch(origin + '/api/state')).json();
const state = { ...raw, accounts: [], connectedPeers: [], peerAccounts: {}, office: { id: 'proxy-fixture', username: 'alex', displayName: 'Alex', role: 'user', enabled: true, features: ['generalChat'], defaultPrompt: '', workspacePath: '', mcpServers: [] }, settings: { ...raw.settings, cliIntegrationEnabled: true, teamWorkspaceEnabled: true } };
const host = `(()=>{const state=${JSON.stringify(state)};const dispatch=data=>dispatchEvent(new MessageEvent('message',{data}));window.acquireVsCodeApi=()=>({getState(){return{}},setState(){},postMessage(message){setTimeout(()=>{if(message.type==='dashboard:ready'||message.type==='dashboard:workspace-presence'){dispatch({type:'dashboard:snapshot',state});dispatch({type:'dashboard:connection',connected:true});}else if(message.type==='dashboard:action')dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'completed',payload:message.action==='listCodexCliSessions'?{cliSessions:[],cliComposerConfig:{models:[{id:'regular',label:'Regular',reasoningEfforts:['low','medium','high']}],projects:[],defaultModel:'regular',defaultSandboxMode:'workspace-write'}}:{}});},5)}})})();`;
const output = path.resolve('output/user-proxy'); await mkdir(output, { recursive: true });
const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL === 'bundled' ? {} : {channel:'msedge'})});
try {
  for (const width of [1440,390,320]) {
    const context = await browser.newContext({viewport:{width,height:960},serviceWorkers:'block'});
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors=[]; page.on('pageerror',error=>errors.push(error.stack));
    page.on('console',message=>{if(message.type()==='error' && !message.text().includes('409 (Conflict)'))errors.push(message.text());});
    let snapshot={enabled:true,keys:[],settings:{revision:'0',mappings:{}},profiles:['regular','professional','expert'].map(profile=>({profile}))};
    let uncertain=true, submitted, mutations=0;
    await useWorkspaceDashboardAssets(page,origin,context);
    await context.route('**/assets/browserHost.js*',route=>route.fulfill({contentType:'text/javascript',body:host}));
    await context.route('**/api/workspace/**',route=>{
      if(!route.request().url().endsWith('/proxy')) return route.fulfill({json:{profile:{displayName:'Alex',username:'alex'},plan:{name:'Workspace',status:'active',models:[]},sessions:[],memory:{enabled:true,revision:'0',entries:[]},usage:{tokens:0,requests:0},limits:{},instructions:''}});
      const method=route.request().method();
      if(method==='GET')return route.fulfill({json:snapshot});
      mutations++;
      const input=route.request().postDataJSON();
      if(method==='POST'){
        assert.equal(input.owner,undefined);assert.ok(input.requestId);
        snapshot={...snapshot,keys:[{id:'fixture-key',name:input.name,createdAt:Date.now()}]};
        return route.fulfill({json:{...snapshot,key:{id:'fixture-key',value:'cm_'+ 'a'.repeat(64)},message:'Key generated. Copy it now; it will not be shown again.'}});
      }
      if(method==='PUT'){
        submitted=input;
        if(uncertain){uncertain=false;return route.fulfill({status:409,json:{error:'Proxy settings changed in another window. Reload before saving.'}});}
        snapshot={...snapshot,settings:{revision:'1',mappings:input.mappings}};
        return route.fulfill({json:{...snapshot,message:'Proxy settings saved.'}});
      }
      assert.equal(input.confirmed,true);snapshot={...snapshot,keys:[]};return route.fulfill({json:{...snapshot,message:'Key revoked.'}});
    });
    const start=Date.now();await page.goto(origin);
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{}}}));
    if(width<600)await page.getByRole('button',{name:'Show sessions sidebar',exact:true}).click();
    await page.getByRole('button',{name:'Open settings',exact:true}).click();
    if(width<600)await page.getByRole('combobox',{name:'Settings section',exact:true}).selectOption('proxy');
    else await page.getByRole('tab',{name:'Proxy',exact:true}).click();
    const proxy=page.getByRole('region',{name:'Proxy',exact:true});await proxy.getByText('No proxy keys yet.',{exact:true}).waitFor();
    await proxy.getByRole('textbox',{name:'Key name',exact:true}).fill('My Codex');
    await proxy.getByRole('button',{name:'Generate key',exact:true}).click();
    await proxy.getByRole('textbox',{name:'New API key',exact:true}).waitFor();
    await proxy.getByRole('button',{name:'Copy key',exact:true}).click();await proxy.getByRole('status').filter({hasText:'Copied to clipboard.'}).waitFor();
    await proxy.getByRole('button',{name:'Hide key',exact:true}).click();
    await proxy.getByRole('tab',{name:'Settings',exact:true}).click();
    assert.equal(await proxy.getByRole('combobox',{name:'Map expert',exact:true}).inputValue(),'');
    await proxy.getByRole('combobox',{name:'Map professional',exact:true}).selectOption('expert');
    await proxy.getByRole('button',{name:'Save mappings',exact:true}).click();
    await proxy.getByRole('alert').filter({hasText:'changed in another window'}).waitFor();
    assert.equal(await proxy.getByRole('combobox',{name:'Map professional',exact:true}).inputValue(),'expert');
    await proxy.getByRole('button',{name:'Refresh proxy',exact:true}).click();
    await proxy.getByRole('status').filter({hasText:'Review your mapping draft'}).waitFor();
    assert.equal(await proxy.getByRole('combobox',{name:'Map professional',exact:true}).inputValue(),'expert');
    await proxy.getByRole('button',{name:'Save mappings',exact:true}).click();
    await proxy.getByRole('status').filter({hasText:'Proxy settings saved.'}).waitFor();assert.equal(submitted.mappings.professional,'expert');
    await page.screenshot({path:path.join(output,`mappings-${width}.png`)});
    for(const client of ['Claude','Codex']){
      await proxy.getByRole('button',{name:`${client} settings`,exact:true}).click();const dialog=page.getByRole('dialog',{name:`${client} settings`,exact:true});await dialog.waitFor();
      const config=await dialog.getByRole('textbox',{name:'Client configuration',exact:true}).inputValue();assert.ok(config.includes(origin));assert.ok(config.includes(client==='Claude'?'claude-sonnet':'wire_api = "responses"'));
      await dialog.getByRole('button',{name:'Copy configuration',exact:true}).click();await dialog.getByRole('status').filter({hasText:'Copied to clipboard.'}).waitFor();
      assert.ok(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+2));await page.screenshot({path:path.join(output,`${client.toLowerCase()}-${width}.png`)});
      await dialog.getByRole('button',{name:'Close client settings',exact:true}).click();
    }
    await proxy.getByRole('tab',{name:'Keys',exact:true}).click();await proxy.getByRole('button',{name:'Revoke My Codex',exact:true}).click();
    let dialog=page.getByRole('dialog',{name:'Revoke proxy key',exact:true});await dialog.getByRole('button',{name:'Cancel key revocation',exact:true}).click();assert.equal(mutations,3);
    await proxy.getByRole('button',{name:'Revoke My Codex',exact:true}).click();dialog=page.getByRole('dialog',{name:'Revoke proxy key',exact:true});await dialog.getByRole('button',{name:'Confirm revoke',exact:true}).click();await proxy.getByText('No proxy keys yet.',{exact:true}).waitFor();
    assert.equal(mutations,4);assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
    await page.screenshot({path:path.join(output,`keys-${width}.png`)});
    console.log(JSON.stringify({width,elapsedMs:Date.now()-start,auto:true,editableMapping:true,keyLifecycle:true,configurationDialogs:true,errors:0}));await context.close();
  }
}finally{await browser.close();}
