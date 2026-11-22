import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {useWorkspaceDashboardAssets} from './workspace-dashboard-assets.mjs';
const origin='http://127.0.0.1:39875';
const raw=await(await fetch(origin+'/api/state')).json();
const office={id:'fixture-alex',username:'alex@example.test',displayName:'Alex Morgan',role:'user',features:['generalChat','tasks','files','browser','env'],defaultPrompt:'',workspacePath:'',mcpServers:[]};
const state={lang:raw.lang,copy:raw.copy,logoUri:raw.logoUri,panelTitle:'Workspace',brandSub:'',onboardingCompleted:true,office,accounts:[],connectedPeers:[],peerAccounts:{},indexHealth:{status:'healthy',availableBackups:0},tokenAutomation:{enabled:false},settings:{...Object.fromEntries(Object.entries(raw.settings).map(([key,value])=>[key,typeof value==='boolean'?false:typeof value==='number'?0:typeof value==='string'?'':[]])),dashboardTheme:'light',cliIntegrationEnabled:true,teamWorkspaceEnabled:true,workspaceTextFileLimitMb:10}};
const activities=[
 {id:'task-plan',kind:'plan',title:'Plan',text:'Task complete',arguments:JSON.stringify({steps:[{step:'Read requirements',status:'completed'},{step:'Make changes',status:'completed'},{step:'Check results',status:'completed'}]}),status:'completed'},
 {id:'read-file',kind:'tool-call',title:'Read file',text:'Read the document',arguments:JSON.stringify({path:'C:/team/alex/notes.txt'}),result:'Complete document contents.',status:'completed'},
 {id:'run-checks',kind:'command',text:'Checking changes',command:'"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command \'$r=1; npm test\'',cwd:'C:/team/alex',output:'All 83 checks passed.\nC:\\Windows\\Temp\\checks.log',status:'completed'},
 {id:'files',kind:'file-change',text:'Updated your files',status:'completed',changes:[{path:'C:/team/alex/output/new.cjs',kind:'add',diff:'+ New file'},{path:'C:/team/alex/output/commit.cjs',kind:'update',diff:'- Before\n+ After'}]},
];
const mockHost=`(()=>{
document.documentElement.dataset.dashboardUser='fixture-alex';
const state=${JSON.stringify(state)},key='private-workspace-fixture';
const saved=JSON.parse(localStorage.getItem(key)||'null');let session=saved?.session,messages=saved?.messages||[];
window.__setAvailability=availability=>{state.office.availability=availability;window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:snapshot',state}}));};
const config={defaultModel:'fast',models:[{id:'fast',label:'Fast',reasoningEfforts:[]},{id:'quality',label:'Quality',reasoningEfforts:[]}],projects:[{id:'personal',path:'C:/team/alex',label:'My workspace'}],defaultSandboxMode:'workspace-write',terminalSupported:false};
const dispatch=data=>window.dispatchEvent(new MessageEvent('message',{data:structuredClone(data)}));
window.__setModelDefault=defaultModel=>{config.defaultModel=defaultModel;dispatch({type:'dashboard:action-result',requestId:'auto-config',action:'listCodexCliSessions',status:'completed',payload:{cliSessions:session?[session]:[],cliComposerConfig:config}});};
window.__setModelWarning=warning=>{config.modelDiscoveryWarning=warning;window.__setModelDefault(config.defaultModel);};
const persist=()=>localStorage.setItem(key,JSON.stringify({session,messages}));
window.__privateActions=[];
window.__updateOfficePlan=(completed=0,status='inProgress')=>{session={...session,status:status==='unknown'?'idle':'running',queueEnabled:false,queueRetryAt:undefined,queueError:undefined};messages=messages.filter(message=>message.id!=='task-plan');messages.push({id:'task-plan',kind:'plan',text:'Task plan',status,arguments:JSON.stringify({steps:['Read requirements','Make changes','Check results'].map((step,index)=>({step,status:index<completed?'completed':index===completed?'inProgress':'pending'}))})});persist();dispatch({type:'dashboard:action-result',requestId:'auto-plan',action:'listCodexCliSessions',status:'completed',payload:{cliSessions:[session]}});dispatch({type:'dashboard:codex-session-live',state:{sessionId:session.id,streamId:session.id,sequence:Date.now(),status:status==='unknown'?'completed':'running',updatedAt:Date.now(),messages}});};
window.__completeOffice=()=>{session={...session,status:'idle',queueEnabled:false,queueRetryAt:undefined,queueError:undefined,updatedAt:new Date().toISOString()};messages=messages.filter(message=>message.id!=='task-plan');messages.push(...${JSON.stringify(activities)},{id:crypto.randomUUID(),role:'assistant',text:'Your private workspace response is ready.'});persist();dispatch({type:'dashboard:action-result',requestId:'auto-team-list',action:'listCodexCliSessions',status:'completed',payload:{cliSessions:[session]}});dispatch({type:'dashboard:codex-session-live',state:{sessionId:session.id,streamId:session.id,sequence:Date.now(),status:'completed',updatedAt:Date.now(),messages}});dispatch({type:'dashboard:notice',level:'info',message:'Your response is ready.'});};
window.acquireVsCodeApi=()=>({postMessage(message){window.__privateActions.push(message);setTimeout(()=>{
if(message.type==='dashboard:ready'||message.type==='dashboard:workspace-presence'){dispatch({type:'dashboard:snapshot',state});dispatch({type:'dashboard:connection',connected:true});return;}
if(message.type==='dashboard:setting'){state.settings[message.key]=message.value;dispatch({type:'dashboard:snapshot',state});dispatch({type:'dashboard:notice',level:'info',message:'Setting saved.'});return;}
if(message.type!=='dashboard:action')return;
let payload={};
if(message.action==='listCodexCliSessions')payload={cliSessions:session?[session]:[],cliComposerConfig:config};
else if(message.action==='getCodexCliSessionMessages')payload={cliSession:session,cliSessionMessages:messages};
else if(['startCodexCliSession','sendCodexCliSessionMessage','steerCodexCliSessionTurn'].includes(message.action)){
session={id:session?.id||'12345678-1234-1234-1234-123456789abc',title:session?.title||message.payload.text,status:'running',queueEnabled:true,queueRetryAt:Date.now()+60000,queueError:'All assistants are busy. You are in the queue.',projectPath:'C:/team/alex',canStop:true,updatedAt:new Date().toISOString()};
messages.push({id:crypto.randomUUID(),role:'user',text:message.payload.text});persist();payload={cliSession:session,cliSessions:[session],cliSessionMessages:messages,notice:{level:'info',message:'Message accepted and queued.'}};
}else if(message.action==='getWorkspaceEnvironment')payload={workspaceEnvironment:{projectPath:'C:/team/alex',projectName:'My workspace',isGitRepository:false,changes:0,additions:0,deletions:0,ahead:0,behind:0,hasRemote:false}};
else if(message.action==='listWorkspaceFiles')payload={workspaceFiles:window.__libraryFiles||[]};
else if(message.action==='readWorkspaceFile'){const content='Saved file contents.';payload=message.payload.fileDownloadOffset!==undefined?{workspaceFileDownload:{path:message.payload.filePath,revision:'r1',offset:0,size:content.length,data:btoa(content)}}:{workspaceFile:{path:message.payload.filePath,content,kind:'text',language:'javascript',mimeType:'text/javascript',revision:'r1',size:content.length}};}
else if(message.action==='deleteWorkspaceFile'){window.__libraryFiles=window.__libraryFiles.filter(file=>file.path!==message.payload.filePath);payload={notice:{level:'info',message:'File deleted.'}};}
else if(message.action==='workspaceBrowser')payload={workspaceBrowser:{projectPath:'C:/team/alex',pages:[],feedback:[]}};
else if(message.action==='getCodexSkills')payload={cliSkills:[]};
else if(!['refreshView','openExternalUrl'].includes(message.action))throw new Error('Unexpected private-workspace action: '+message.action);
dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'completed',payload});
},10);},getState(){return{};},setState(){}});
})();`;
const output=path.join(os.tmpdir(),'codex-manager-private-workspace-ui');await mkdir(output,{recursive:true});
async function assertPlainUserInterface(page){
 const presentation=await page.evaluate(()=>[document.body.innerText,...[...document.querySelectorAll('[title],[aria-label]')].filter(node=>node.getClientRects().length).flatMap(node=>[node.getAttribute('title')||'',node.getAttribute('aria-label')||''])].join('\n'));
 assert.doesNotMatch(presentation,/C:[\\/]|Windows[\\/](?:System32|Temp)|Codex|quota|sandbox|API|model provider|native thread/i);
}
const browser=await chromium.launch({channel:'msedge',headless:true});
try{for(const width of [1440,390,360]){
 const context=await browser.newContext({viewport:{width,height:width===360?674:960},serviceWorkers:'block'});const page=await context.newPage();page.setDefaultTimeout(15_000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 page.on('console',message=>{if(message.type()==='error'&&!/(?:status of (?:409|503))/.test(message.text()))errors.push('Console: '+message.text());});
 await useWorkspaceDashboardAssets(page,origin,context);await context.route('**/assets/browserHost.js*',route=>route.fulfill({contentType:'text/javascript',body:mockHost}));
 const start=Date.now();await page.goto(origin+'/workspace');
 await page.locator('.cli-workspace').waitFor();
 await page.evaluate(() => window.__setAvailability({ status: 'offline', availableAt: Math.floor(Date.now() / 1000) + 3660 }));
 await page.locator('.team-request-state').filter({ hasText: /We're offline\. Back at.*1h/ }).waitFor();
 await assertPlainUserInterface(page);
 await page.screenshot({path:path.join(output,`offline-${width}.png`),fullPage:true,animations:'disabled'});
 await page.evaluate(() => window.__setAvailability({ status: 'available' }));
 await page.locator('.team-request-state').waitFor({ state: 'detached' });
 let instructions='',failSave=true;await context.route('**/api/workspace/preferences',async route=>{if(route.request().method()==='PUT'){if(failSave){failSave=false;await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Instructions changed in another window. Review before saving.'})});return;}instructions=route.request().postDataJSON().instructions;}await route.fulfill({contentType:'application/json',body:JSON.stringify({instructions,limits:{storageMb:100,dailyTokens:100000,dailyRequests:50},usage:{tokens:1200,requests:3,pending:true,storageBytes:1024,resetsAt:Date.now()+3600000}})});});
 let tasks=[],failScheduleRun=true;const scheduleActions=[];
 await context.route('**/api/workspace/schedules**',async route=>{
  const req=route.request(),method=req.method(),id=new URL(req.url()).pathname.split('/')[4];
  let body={schedules:tasks};
  if(method!=='GET'){
   const input=req.postDataJSON();scheduleActions.push({method,id,input});
   if(input.action==='run'&&failScheduleRun){failScheduleRun=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Task could not be queued. Refresh before retrying.'})});return;}
   if(method==='DELETE'){tasks=tasks.filter(task=>task.id!==id);body={message:'Schedule removed. Runs already queued continue.'};}
   else {const task=tasks.find(task=>task.id===id);if(input.action==='pause')task.enabled=false;else if(input.action==='resume')task.enabled=true;task.revision=crypto.randomUUID();body={schedule:task,message:input.action==='run'?'Task added to your conversation queue.':'Schedule updated.'};}
  }
  await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 });
 const nav=async(name)=>{const show=page.getByRole('button',{name:'Show sessions sidebar',exact:true});if(await show.isVisible())await show.click();await page.locator('.user-workspace-nav').getByRole('button',{name,exact:true}).click();};
 await nav('Scheduled');await page.getByRole('heading',{name:'Scheduled',exact:true}).waitFor();
 assert.equal(await page.locator('.user-scheduled form').count(),0);
 assert.equal(await page.locator('.user-schedule-examples').count(),0);
 assert.equal(await page.getByRole('button',{name:'Create with AI',exact:true}).count(),0);
 assert.equal(await page.getByRole('heading',{name:'Your schedules',exact:true}).count(),0);
 await page.screenshot({path:path.join(output,`scheduled-empty-${width}.png`),fullPage:true,animations:'disabled'});
 tasks=[{id:crypto.randomUUID(),revision:crypto.randomUUID(),title:'Buyer lab dip reminder',prompt:'Prepare buyer lab dip reminder drafts.',model:'quality',projectPath:'C:/team/alex',frequency:'daily',timeZone:'Asia/Dhaka',enabled:true,nextRunAt:Date.now()+3600000}];
 await page.getByRole('button',{name:'Refresh schedules',exact:true}).click();await page.getByRole('heading',{name:'Buyer lab dip reminder',exact:true}).waitFor();
 await page.getByRole('button',{name:'Edit with AI',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.cli-composer textarea')?.value.includes('Please update scheduled task'));
 await page.locator('.cli-composer textarea').fill('');await nav('Scheduled');
 await page.getByRole('button',{name:'Run now',exact:true}).click();await page.getByRole('alert').filter({hasText:'Task could not be queued'}).waitFor();assert.equal(tasks.length,1);
 await page.getByRole('button',{name:'Run now',exact:true}).click();await page.getByRole('status').filter({hasText:'Task added to your conversation queue.'}).waitFor();
 await page.getByRole('button',{name:'Pause',exact:true}).click();await page.getByRole('button',{name:'Resume',exact:true}).waitFor();
 await page.screenshot({path:path.join(output,`scheduled-${width}.png`),fullPage:true,animations:'disabled'});
 page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'Remove',exact:true}).click();assert.equal(tasks.length,1);
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Remove',exact:true}).click();await page.getByText('No scheduled tasks yet.',{exact:true}).waitFor();
 assert.equal(scheduleActions.filter(action=>action.method==='DELETE').length,1);
 await page.evaluate(()=>{window.__libraryFiles=[{name:'buyer-po.csv',path:'buyer-po.csv',type:'file',depth:0},{name:'costing.csv',path:'reports/costing.csv',type:'file',depth:1}];});
 await nav('Library');await page.getByRole('button',{name:'Download costing.csv',exact:true}).waitFor();
 await page.getByRole('searchbox',{name:'Search library',exact:true}).fill('reports/');assert.equal(await page.locator('.user-library-files li').count(),1);
 const [libraryDownload]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download costing.csv',exact:true}).click()]);assert.equal(libraryDownload.suggestedFilename(),'costing.csv');
 await page.getByRole('region',{name:'File storage',exact:true}).getByText('1.0 KB',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Grid view',exact:true}).count(),0);
 const fileLayout=await page.locator('.user-library-files li').first().evaluate(node=>{const r=node.getBoundingClientRect(),actions=node.querySelector('.user-page-actions').getBoundingClientRect(),file=node.querySelector('button').getBoundingClientRect();return {height:r.height,aligned:actions.left>=file.right,center:Math.abs((actions.top+actions.bottom-file.top-file.bottom)/2)};});assert.ok(fileLayout.height<=70&&fileLayout.aligned&&fileLayout.center<=1,JSON.stringify(fileLayout));
 page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'Delete costing.csv',exact:true}).click();await page.getByRole('status').filter({hasText:'File deletion cancelled.'}).waitFor();
 await page.screenshot({path:path.join(output,`library-${width}.png`),fullPage:true,animations:'disabled'});
 await page.locator('.user-library-files li > button').first().click();await page.getByRole('tab',{name:'costing.csv',exact:true}).waitFor();await page.getByRole('complementary',{name:'Workspace tools',exact:true}).getByRole('button',{name:'Close workspace tools',exact:true}).click();
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Delete costing.csv',exact:true}).click();await page.getByRole('status').filter({hasText:'File deleted.'}).waitFor();assert.equal(await page.locator('.user-library-files li').count(),0);
 await nav('Chats');
 if(width<760)await page.getByRole('button',{name:'Show sessions sidebar',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Conversation options',exact:true}).count(),0);
 await page.getByRole('button',{name:'Show archived conversations',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Show active conversations',exact:true}).getAttribute('aria-pressed'),'true');
 await page.getByRole('button',{name:'Show active conversations',exact:true}).click();
 if(width<760)await page.getByRole('button',{name:'Hide sessions sidebar',exact:true}).click();
 if(await page.getByRole('button',{name:'Start a new chat',exact:true}).isVisible())await page.getByRole('button',{name:'Start a new chat',exact:true}).click();
 await page.locator('.cli-composer textarea').waitFor();
 if(width<760){const compact=await page.locator('.cli-composer').evaluate(element=>({height:element.getBoundingClientRect().height,control:getComputedStyle(element).getPropertyValue('--cli-control-size')}));assert.equal(compact.control.trim(),'30px');assert.ok(compact.height<=88,'User composer matches the compact master height');}

 await page.waitForFunction(()=>document.querySelector('.user-model-picker select')?.value==='fast');
 assert.equal(await page.getByRole('combobox',{name:'Model',exact:true}).locator('option').filter({hasText:'Automatic'}).count(),0);
 await page.evaluate(()=>window.__setModelWarning('Models could not be loaded. Your selected model is kept.'));
 const beforeRetry=await page.evaluate(()=>window.__privateActions.filter(message=>message.action==='listCodexCliSessions').length);
 await page.getByRole('button',{name:'Retry models',exact:true}).click();
 await page.waitForFunction(before=>window.__privateActions.filter(message=>message.action==='listCodexCliSessions').length>before,beforeRetry);
 assert.equal(await page.getByRole('combobox',{name:'Model',exact:true}).inputValue(),'fast');
 await page.evaluate(()=>window.__setModelWarning(''));
 await assertPlainUserInterface(page);
 await page.evaluate(()=>window.__setModelDefault(''));
 await page.waitForFunction(()=>document.querySelector('.user-model-picker select')?.value==='');
 await page.locator('.cli-composer textarea').fill('Keep this draft until I choose a model');
 assert.equal(await page.getByRole('button',{name:'Send message',exact:true}).isDisabled(),true);
 await page.locator('.cli-composer textarea').press('Control+Enter');
 assert.equal(await page.evaluate(()=>window.__privateActions.filter(item=>item.action==='startCodexCliSession').length),0);
 await page.evaluate(()=>window.__setModelDefault('fast'));
 await page.waitForFunction(()=>document.querySelector('.user-model-picker select')?.value==='fast');
 await page.locator('.cli-composer textarea').fill('/model');
 assert.equal(await page.getByRole('listbox',{name:'Commands and skills'}).count(),0);
 await page.locator('.cli-composer textarea').fill('');
 await page.getByRole('combobox',{name:'Project',exact:true}).click(); await page.getByRole('button', { name: 'Open folder…', exact: true }).click();
 await page.getByRole('textbox',{name:'Project name',exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Project folder',exact:true}).count(),0);
 await assertPlainUserInterface(page);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 if(width<760)await page.getByRole('button',{name:'Show sessions sidebar',exact:true}).click();
 await page.locator('.team-user-footer').getByText('Alex Morgan',{exact:true}).first().waitFor();
 if(width<760)await page.waitForFunction(()=>Math.abs(document.querySelector('.cli-session-rail').getBoundingClientRect().left)<1);
 const accountLayout=await page.evaluate(()=>{const rail=document.querySelector('.cli-session-rail').getBoundingClientRect(),footer=document.querySelector('.team-user-footer').getBoundingClientRect(),list=document.querySelector('.cli-session-list-region').getBoundingClientRect();return{bottomGap:rail.bottom-footer.bottom,height:footer.height,listBottom:list.bottom,footerTop:footer.top};});
 assert.ok(accountLayout.bottomGap>=-1&&accountLayout.bottomGap<=9,'Account footer stays at the sidebar bottom');
 assert.ok(accountLayout.height<=60,'Account footer is compact');
 assert.ok(accountLayout.listBottom<=accountLayout.footerTop+1,'Session list cannot cover the account footer');
 await page.screenshot({path:path.join(output,`account-sidebar-${width}.png`),fullPage:true,animations:'disabled'});

 assert.equal(await page.getByRole('button',{name:'Dashboard',exact:true}).count(),0);
 assert.equal(await page.getByRole('tab',{name:'General',exact:true}).count(),0);
 assert.equal(await page.getByRole('tab',{name:'Task',exact:true}).count(),0);
 assert.equal(await page.getByRole('combobox',{name:'System',exact:true}).count(),0);
 if(width<760)await page.getByRole('button',{name:'Hide sessions sidebar',exact:true}).click();
 await page.getByRole('combobox',{name:'Model',exact:true}).selectOption('quality');
 await page.locator('.cli-composer textarea').fill('Plan my private workspace');
 assert.equal(await page.locator('.cli-workspace').count(),1);
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.__privateActions.find(item=>item.action==='startCodexCliSession').payload.model),'quality');
 await page.locator('.team-request-state').filter({hasText:'All assistants are busy'}).waitFor();
 await page.evaluate(() => window.__setAvailability({ status: 'offline', availableAt: Math.floor(Date.now() / 1000) + 90060 }));
 await page.locator('.team-request-state').filter({ hasText: /We're offline\. Back at.*1d 1h/ }).waitFor();
 await assertPlainUserInterface(page);
 await page.screenshot({path:path.join(output,`offline-queued-${width}.png`),fullPage:true,animations:'disabled'});
 await page.evaluate(() => window.__setAvailability({ status: 'offline' }));
 await page.locator('.team-request-state').filter({ hasText: "We're offline. Checking availability." }).waitFor();
 await page.evaluate(() => window.__setAvailability({ status: 'available' }));
 await page.locator('.team-request-state').filter({hasText:'All assistants are busy'}).waitFor();
 await assertPlainUserInterface(page);
 await page.screenshot({path:path.join(output,`queued-${width}.png`),fullPage:true,animations:'disabled'});
 const first=await page.evaluate(()=>JSON.parse(localStorage.getItem('private-workspace-fixture')).session.id);
 await page.evaluate(()=>window.__updateOfficePlan());
 await page.locator('.session-plan-count').filter({hasText:'0 of 3 complete'}).waitFor();
 assert.equal(await page.locator('.session-plan [aria-current=step]').count(),1);
 await page.evaluate(()=>window.__updateOfficePlan(1));
 await page.locator('.session-plan-count').filter({hasText:'1 of 3 complete'}).waitFor();
 assert.equal(await page.locator('.session-plan .is-completed').count(),1);
 const placement=await page.evaluate(()=>{const plan=document.querySelector('.cli-composer-plan').getBoundingClientRect(),composer=document.querySelector('.cli-composer').getBoundingClientRect();return {bottom:plan.bottom,top:composer.top};});
 assert.ok(placement.bottom<=placement.top+2,'Current plan is directly above the composer');
 assert.equal(await page.locator('.cli-session-messages .session-plan').count(),0);
 await assertPlainUserInterface(page);
 await page.screenshot({path:path.join(output,`plan-running-${width}.png`),fullPage:true,animations:'disabled'});
 await page.evaluate(()=>window.__updateOfficePlan(1,'unknown'));
 await page.locator('.session-plan-count').filter({hasText:'Paused'}).waitFor();
 assert.equal(await page.locator('.session-plan [aria-current=step]').count(),0);
 await page.reload();await page.locator('.session-plan-count').filter({hasText:'1 of 3 complete'}).waitFor();
 await page.evaluate(()=>window.__completeOffice());
 await page.getByText('Your private workspace response is ready.',{exact:true}).waitFor();
 if(width<760){await page.locator('.cli-file-editor').waitFor({state:'visible'});await page.getByRole('button',{name:'Hide workspace tools',exact:true}).click();}
 await page.locator('.session-plan-count').filter({hasText:'3 of 3 complete'}).waitFor();
 assert.equal(await page.locator('.session-plan').count(),1);
 assert.equal(await page.locator('.session-plan .is-completed').count(),3);
 if(!await page.locator('.session-plan').evaluate(node=>node.open))await page.locator('.session-plan > summary').click();
 await page.locator('.session-plan > summary').click();
 assert.equal(await page.getByRole('list',{name:'Task steps'}).isVisible(),false);
 await page.locator('.session-plan > summary').click();
 assert.equal(await page.locator('.cli-conversation-project').innerText(),'My workspace');
 const transcript=await page.locator('.cli-session-messages').textContent();
 assert.match(transcript,/npm test/);assert.match(transcript,/All 83 checks passed/);assert.match(transcript,/File read\. Open Files to view its contents\./);
 assert.match(transcript,/Ran PowerShell: \$r=1; npm test/);assert.match(transcript,/\"PowerShell\" -NoProfile -Command/);
 assert.match(transcript,/alex\/output\/commit.cjs/);assert.match(transcript,/Added|Created/);assert.match(transcript,/Edited/);
 assert.match(transcript,/Read File · alex\/notes.txt/);
 assert.doesNotMatch(transcript,/C:[\\/]|Windows[\\/](?:System32|Temp)/);
 await page.locator('.cli-completed-work > summary').click();
 await page.locator('.cli-activity-group-details > summary').click();
 await page.locator('.cli-activity.is-command > summary').click();
 await page.getByLabel('Command output',{exact:true}).waitFor({state:'visible'});
 await assertPlainUserInterface(page);
 await page.screenshot({path:path.join(output,`activity-${width}.png`),fullPage:true,animations:'disabled'});
 await assertPlainUserInterface(page);
 await page.reload();
 await page.getByText('Your private workspace response is ready.',{exact:true}).waitFor();
 await assertPlainUserInterface(page);
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('private-workspace-fixture')).session.id),first);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
 assert.equal(await page.locator('.team-request-state').count(),0);
 assert.equal(await page.locator('.cli-conversation-header .cli-state-pill').count(),0);
 assert.equal(await page.locator('.team-composer-hint').count(),0);
 if(await page.getByRole('button',{name:'Show workspace tools',exact:true}).count())await page.getByRole('button',{name:'Show workspace tools',exact:true}).click();
 await page.getByRole('tab',{name:'Env',exact:true}).click();
 await page.locator('.cli-environment-view').getByText('Your workspace',{exact:true}).waitFor();
 await assertPlainUserInterface(page);
 if(width<760){await page.getByRole('button',{name:'Hide workspace tools',exact:true}).click();await page.getByRole('button',{name:'Show sessions sidebar',exact:true}).click();}
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.getByRole('region',{name:'Your usage',exact:true}).waitFor();
 await page.getByText('A response is running. Usage will update when it finishes.',{exact:true}).waitFor();
 await page.getByLabel('How should your assistant respond?',{exact:true}).fill('Be clear and ask when requirements are unclear.');
 await page.getByRole('button',{name:'Save instructions',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'Instructions changed in another window'}).waitFor();
 assert.equal(await page.getByLabel('How should your assistant respond?',{exact:true}).inputValue(),'Be clear and ask when requirements are unclear.');
 assert.equal(instructions,'');
 await page.getByRole('button',{name:'Save instructions',exact:true}).click();
 await page.getByText('Workspace instructions saved. They apply to your next message.',{exact:true}).waitFor();
 assert.equal(instructions,'Be clear and ask when requirements are unclear.');
 await page.screenshot({path:path.join(output,`settings-${width}.png`),fullPage:true,animations:'disabled'});
 await page.locator('.office-user-settings .settings-close').click();await page.locator('.overlay.open .office-user-settings').waitFor({state:'hidden'});await page.waitForFunction(()=>![...document.querySelectorAll('.overlay')].some(node=>Number(getComputedStyle(node).opacity)>0));
 assert.equal(await page.locator('.cli-account-footer').count(),0);
 assert.equal(await page.locator('.cli-conversation-header').innerText().then(text=>/Started by|Running by/.test(text)),false);
 assert.deepEqual(errors,[]);await page.screenshot({path:path.join(output,`complete-${width}.png`),fullPage:true,animations:'disabled'});
 console.log(JSON.stringify({width,elapsedMs:Date.now()-start,privateProfile:true,queue:true,reloadPreserved:true,technicalDetailsHidden:true,errors:0}));await context.close();
}
 const context=await browser.newContext({viewport:{width:1440,height:960},serviceWorkers:'block'}),page=await context.newPage();
 const master={...state,office:{...office,id:'master',role:'unrestricted-admin'},connectedPeers:[{id:'local',name:'This PC',connected:true,local:true}],settings:{...raw.settings,cliIntegrationEnabled:true,systemInfoEnabled:false}};
 const masterHost=mockHost.replace("document.documentElement.dataset.dashboardUser='fixture-alex';",'delete document.documentElement.dataset.dashboardUser;').replace(JSON.stringify(state),JSON.stringify(master)).replace("else if(message.action==='getCodexSkills')", "else if(message.action==='listWorkspaceTerminals')payload={workspaceTerminals:[]};else if(message.action==='getCodexSkills')");
 await useWorkspaceDashboardAssets(page,origin,context);await context.route('**/assets/browserHost.js*',route=>route.fulfill({contentType:'text/javascript',body:masterHost}));
 await page.goto(origin+'/workspace');await page.getByRole('button',{name:'Dashboard',exact:true}).waitFor();
 assert.equal(await page.getByRole('combobox',{name:'System',exact:true}).count(),1);assert.equal(await page.locator('.team-user-footer').count(),0);
 assert.equal(await page.locator('.cli-task-nav').count(),1);
 assert.equal(await page.locator('.cli-task-nav').textContent(),'Kanban');
 await page.evaluate(activities=>localStorage.setItem('private-workspace-fixture',JSON.stringify({session:{id:'12345678-1234-1234-1234-123456789abc',title:'Master session',status:'idle',projectPath:'C:/team/alex'},messages:[{id:'user',role:'user',text:'Check files'},...activities,{id:'answer',role:'assistant',text:'Master response ready.'}]})),activities);
 await page.reload();await page.getByRole('button',{name:/^Master session/}).click();await page.getByText('Master response ready.',{exact:true}).waitFor();
 const masterTranscript=await page.locator('.cli-session-messages').textContent();
 await page.locator('.session-plan-count').filter({hasText:'3 of 3 complete'}).waitFor();
 assert.match(masterTranscript,/C:\\Windows\\System32\\WindowsPowerShell/);assert.match(masterTranscript,/C:\/team\/alex\/output\/commit.cjs/);assert.match(masterTranscript,/Update|Edited/);
 console.log(JSON.stringify({masterDashboardControlsPreserved:true}));await context.close();
}finally{await browser.close();}
console.log('Screenshots: '+output);
