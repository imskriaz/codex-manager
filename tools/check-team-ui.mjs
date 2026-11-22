import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright';
import {useWorkspaceDashboardAssets} from './workspace-dashboard-assets.mjs';

// Every mutation is fulfilled by a fixture; the local host receives only reads.
const origin='http://127.0.0.1:39875';
const raw=await(await fetch(origin+'/api/state')).json();
const state={...raw,onboardingCompleted:true,accounts:[],connectedPeers:[],peerAccounts:{},office:{id:'master',role:'unrestricted-admin',enabled:true,features:[],displayName:'Administrator'},settings:{...raw.settings,webDashboardEnabled:true,teamWorkspaceEnabled:true,cliIntegrationEnabled:true}};
const output=path.join(os.tmpdir(),'codex-manager-team-ui');await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
try { for(const [width,mode] of [[1440,'browser'],[768,'browser'],[390,'browser'],[320,'browser'],[1440,'webview'],[390,'webview']]) {
  const context=await browser.newContext({viewport:{width,height:960},serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('console',entry=>{if(entry.type()==='error'&&!entry.text().includes('Failed to load resource'))errors.push(entry.text());});
  await useWorkspaceDashboardAssets(page,origin,context);
  const host=`(()=>{const state=${JSON.stringify(state)};const dispatch=data=>dispatchEvent(new MessageEvent('message',{data:structuredClone(data)}));window.acquireVsCodeApi=()=>({getState(){return{}},setState(){},postMessage(message){setTimeout(async()=>{if(message.type==='dashboard:ready'||message.type==='dashboard:workspace-presence'){dispatch({type:'dashboard:snapshot',state});dispatch({type:'dashboard:connection',connected:true});}else if(message.type==='dashboard:action'){let payload=message.action==='listCodexCliSessions'?{cliSessions:[],cliComposerConfig:{models:[],projects:[],defaultSandboxMode:'workspace-write',terminalSupported:false}}:{};let error;if(message.action==='teamSettingsRequest'){const request=message.payload.teamSettingsRequest;const response=await fetch(request.path,{method:request.method,headers:{'Content-Type':'application/json'},...(request.body===undefined?{}:{body:JSON.stringify(request.body)})});const result=await response.json();if(response.ok)payload={teamSettingsResponse:result};else error=result.error;}dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:error?'failed':'completed',payload,error});}},10)}})})();`;
  await context.route('**/assets/browserHost.js*',route=>route.fulfill({contentType:'text/javascript',body:host}));
  if(mode==='webview')await page.addInitScript(()=>{document.addEventListener('DOMContentLoaded',()=>{document.documentElement.dataset.dashboardHost='vscode';});});
  let user={id:'fixture-user',username:'alex@example.test',displayName:'Alex Morgan',role:'user',enabled:true,features:['generalChat','tasks','files','browser'],defaultPrompt:'',workspacePath:'C:/team/alex',mcpServers:[],createdAt:0};
  let saved,failSave=true,failDelete=true,deleted=false,patches=0,deletes=0;
  await context.route('**/api/office/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.pathname==='/api/office/users')return route.fulfill({json:{users:deleted?[]:[user]}});
    if(url.pathname==='/api/office/mcp')return route.fulfill({json:{servers:[{id:'smartoffice',label:'SmartOffice',endpoint:'http://127.0.0.1:3004/',transport:'smartoffice',enabled:true,allowedRoles:['user']}]}});
    if(url.pathname==='/api/office/settings')return route.fulfill({json:{workspaceRoot:'C:/team',databaseProvider:'sqlite',postgresConfigured:false}});
    if(url.pathname==='/api/office/usage/fixture-user')return route.fulfill({json:{revision:'fixture',usage:{tokens:123}}});
    if(url.pathname==='/api/office/users/fixture-user'&&request.method()==='PATCH'){
      patches++;saved=request.postDataJSON();if(failSave){failSave=false;return route.fulfill({status:409,json:{error:'User changed in another window. Refresh and retry.'}});}
      user={...user,...saved};return route.fulfill({json:{user}});
    }
    if(url.pathname==='/api/office/users/fixture-user'&&request.method()==='DELETE'){
      deletes++;if(failDelete){failDelete=false;return route.fulfill({status:409,json:{error:'Keep at least one enabled admin.'}});}
      deleted=true;return route.fulfill({json:{ok:true}});
    }
    throw new Error(`Unexpected Team request: ${request.method()} ${url.pathname}`);
  });
  const start=Date.now();await page.goto(origin+'/?settings=users');
  const settings=page.locator('.settings-master-modal');
  await settings.getByRole('button',{name:'Edit Alex Morgan',exact:true}).waitFor();const loadMs=Date.now()-start;
  const fits=async()=>{const box=await settings.locator('.settings-modal-body').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));assert.ok(box.scroll<=box.width+2,JSON.stringify({width,mode,box}));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));};
  await fits();await page.screenshot({path:path.join(output,`users-${width}-${mode}.png`)});
  await settings.getByRole('cell',{name:'alex@example.test',exact:true}).click();
  const editor=settings.getByRole('region',{name:'Edit alex@example.test',exact:true});await editor.waitFor();
  assert.equal(await page.getByRole('dialog').count(),1,'A row opens the editor directly');
  const tabs=editor.getByRole('tablist',{name:'User settings'}),picker=editor.getByRole('combobox',{name:'User settings section',exact:true});
  const selectTab=async label=>{if(width<=760){const value=await picker.locator('option').evaluateAll((options,label)=>options.find(option=>option.textContent===label)?.value,label);assert.ok(value);await picker.selectOption(value);}else await tabs.getByRole('tab',{name:label,exact:true}).click();};
  const selectedTab=async label=>width<=760?(await picker.locator('option:checked').textContent())===label:await tabs.getByRole('tab',{name:label,exact:true}).getAttribute('aria-selected')==='true';
  assert.equal(await tabs.isVisible(),width>760);assert.equal(await picker.isVisible(),width<=760);
  if(width>760)assert.equal(await tabs.getAttribute('aria-orientation'),'vertical');
  const deleteButton=editor.getByRole('button',{name:'Delete user',exact:true});assert.ok(await deleteButton.isVisible());
  if(width>760){const tabBox=await tabs.boundingBox(),panelBox=await editor.getByRole('tabpanel',{name:'Profile',exact:true}).boundingBox();assert.ok(tabBox.x+tabBox.width<=panelBox.x,'Desktop tabs are left of the form');}
  await editor.getByRole('textbox',{name:'Display name',exact:true}).fill('Alex Updated');
  if(width>760){await tabs.getByRole('tab',{name:'Profile',exact:true}).focus();await page.keyboard.press('ArrowDown');}else await selectTab('Plan & limits');
  assert.ok(await selectedTab('Plan & limits'));
  await editor.getByRole('spinbutton',{name:'Requests per day',exact:true}).fill('-1');
  await selectTab('Profile');await editor.getByRole('button',{name:'Save changes',exact:true}).click();
  await editor.getByRole('alert').waitFor();assert.equal(patches,0);assert.ok(await selectedTab('Plan & limits'));
  await editor.getByRole('spinbutton',{name:'Requests per day',exact:true}).fill('15');
  await selectTab('Data access');await editor.getByRole('checkbox',{name:/SmartOffice/}).check();
  await fits();await page.screenshot({path:path.join(output,`data-${width}-${mode}.png`)});
  await selectTab('Permissions');assert.ok(await editor.getByRole('checkbox',{name:/Terminal/}).isDisabled());
  await editor.getByRole('checkbox',{name:/Environment/}).check();
  await selectTab('Profile');assert.equal(await editor.getByRole('textbox',{name:'Display name',exact:true}).inputValue(),'Alex Updated');
  await deleteButton.click();const confirmation=page.getByRole('dialog',{name:'Delete Team user?',exact:true});await confirmation.waitFor();
  await confirmation.getByRole('button',{name:'Cancel',exact:true}).click();await editor.getByRole('status').filter({hasText:'User deletion cancelled.'}).waitFor();
  assert.equal(deletes,0);assert.equal(await editor.getByRole('textbox',{name:'Display name',exact:true}).inputValue(),'Alex Updated');
  await editor.getByRole('button',{name:'Save changes',exact:true}).click();await editor.getByRole('alert').filter({hasText:'User changed in another window'}).waitFor();
  assert.deepEqual(saved.mcpServers,['smartoffice']);assert.ok(saved.features.includes('env'));assert.equal(saved.limits.dailyRequests,15);
  assert.equal(await editor.getByRole('textbox',{name:'Display name',exact:true}).inputValue(),'Alex Updated');
  await editor.getByRole('button',{name:'Save changes',exact:true}).click();await settings.getByRole('status').filter({hasText:'User settings saved.'}).waitFor();assert.equal(patches,2);
  await settings.getByRole('button',{name:'Edit Alex Updated',exact:true}).click();
  await selectTab('Data access');assert.ok(await editor.getByRole('checkbox',{name:/SmartOffice/}).isChecked());
  await selectTab('Usage');await editor.getByText('123 verified tokens today.',{exact:true}).waitFor();
  await deleteButton.click();await confirmation.getByRole('button',{name:'Delete user',exact:true}).click();await confirmation.getByRole('alert').filter({hasText:'Keep at least one enabled admin.'}).waitFor();
  await page.screenshot({path:path.join(output,`delete-${width}-${mode}.png`)});
  await confirmation.getByRole('button',{name:'Delete user',exact:true}).click();await settings.getByRole('status').filter({hasText:'User deleted. Workspace files kept.'}).waitFor();assert.equal(deletes,2);assert.equal(await settings.getByRole('button',{name:'Edit Alex Updated',exact:true}).count(),0);
  await settings.getByRole('button',{name:'Add user',exact:true}).click();const adding=settings.getByRole('region',{name:'Add Team user',exact:true});await adding.waitFor();assert.equal(await adding.getByRole('button',{name:'Delete user',exact:true}).count(),0);assert.equal(await adding.getByRole('tab',{name:'Usage',exact:true}).count(),0);
  if(width<=760)await adding.getByRole('combobox',{name:'User settings section',exact:true}).selectOption('data');else await adding.getByRole('tab',{name:'Data access',exact:true}).click();assert.equal(await adding.getByRole('checkbox',{name:/SmartOffice/}).isChecked(),false,'New users have no SmartOffice access');
  await fits();await adding.getByRole('button',{name:'Back to users',exact:true}).click();await settings.getByRole('status').filter({hasText:'User editing cancelled.'}).waitFor();
  assert.deepEqual(errors,[]);console.log(JSON.stringify({width,mode,loadMs,directEdit:true,desktopLeftTabs:width>760,mobileDropdown:width<=760,selectiveDataAccess:true,saveAndDeleteFailuresRetained:true,consoleErrors:0}));await context.close();
}}finally{await browser.close();}
console.log('Screenshots: '+output);
