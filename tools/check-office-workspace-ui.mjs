import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {useWorkspaceDashboardAssets} from './workspace-dashboard-assets.mjs';
import {emailUiFixture} from './email-ui-fixture.mjs';
import {checkUserDeliverablesUi} from './check-user-deliverables-ui.mjs';
import {checkUserWorkspaceRecoveryUi} from './check-user-workspace-recovery-ui.mjs';
import {checkUserMessageRenderingUi,checkUserFileRenderingUi} from './check-user-message-rendering-ui.mjs';
import {checkToolFailureUi} from './check-tool-failure-ui.mjs';
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
const config={defaultModel:'fast',models:[{id:'fast',label:'Fast',reasoningEfforts:['low','medium','high']},{id:'quality',label:'Quality',reasoningEfforts:['low','medium','high']}],projects:[{id:'personal',path:'C:/team/alex',label:'My workspace'}],defaultSandboxMode:'workspace-write',terminalSupported:false};
const dispatch=data=>window.dispatchEvent(new MessageEvent('message',{data:structuredClone(data)}));
window.__setModelDefault=defaultModel=>{config.defaultModel=defaultModel;dispatch({type:'dashboard:action-result',requestId:'auto-config',action:'listCodexCliSessions',status:'completed',payload:{cliSessions:session?[session]:[],cliComposerConfig:config}});};
let questionSequence=0;window.__setQuestion=active=>{session={...session,status:'idle',queueEnabled:false,queueError:undefined};messages=messages.filter(message=>!message.id.startsWith('question-check-'));if(active)messages.push({id:'question-check-'+(++questionSequence),role:'assistant',text:'Please choose.',timestamp:new Date().toISOString(),questions:active==='visual'?[{title:'Choose a slide direction',view:'grid',options:['Minimal','Editorial'],previews:['Minimal','Editorial'].map(option=>({option,image:'/api/workspace/image?filePath=project%2Fpreview.png&mimeType=image%2Fpng',description:option+' preview'}))}]:[0,1,2].map(index=>({title:'Question '+(index+1)+' about how to prepare this work',options:Array.from({length:8},(_,option)=>'Option '+(option+1)+' for this work')}))});persist();dispatch({type:'dashboard:action-result',requestId:'auto-question',action:'listCodexCliSessions',status:'completed',payload:{cliSessions:[session]}});dispatch({type:'dashboard:codex-session-live',state:{sessionId:session.id,streamId:session.id,sequence:Date.now(),status:'completed',updatedAt:Date.now(),messages}});};
window.__setModelMode=(mode,picker=true)=>{config.modelMode=mode;config.profilePicker=picker;config.models=mode==='auto'?[{id:'auto',label:'Auto',reasoningEfforts:[]},...['regular','professional','expert'].map(id=>({id,label:id.charAt(0).toUpperCase()+id.slice(1),reasoningEfforts:['low','medium','high']}))]:[{id:'fast',label:'Fast',reasoningEfforts:['low','medium','high']},{id:'quality',label:'Quality',reasoningEfforts:['low','medium','high']}];window.__setModelDefault(mode==='auto'?'auto':'fast');};
window.__olderProject=()=>{config.projects.push({id:'earlier',label:'Earlier project',path:'C:/team/alex/earlier'});session.projectPath='C:/team/alex/earlier';persist();window.__setModelDefault(config.defaultModel);};
window.__setModelWarning=warning=>{config.modelDiscoveryWarning=warning;window.__setModelDefault(config.defaultModel);};
const persist=()=>localStorage.setItem(key,JSON.stringify({session,messages}));
window.__setDeliverables=(active=true)=>{messages=messages.filter(message=>message.id!=='deliverables');if(active)messages.push({id:'deliverables',role:'assistant',text:'Your files are ready.\\n\\n[Download file](reports/buyer%20follow-up.txt?download=1)\\n[Download file](costing/order.xlsx?download=1)\\n[Download ZIP](exports/all-files.zip?download=1)\\n[Download file](a-very-long-client-deliverable-name-with-the-full-extension-preserved.html?download=1)\\n[Download duplicate](costing/order.xlsx?download=1)'});persist();dispatch({type:'dashboard:codex-session-live',state:{sessionId:session.id,streamId:session.id,sequence:Date.now(),status:'completed',updatedAt:Date.now(),messages}});};
window.__privateActions=[];
window.__updateOfficePlan=(completed=0,status='inProgress')=>{session={...session,status:status==='unknown'?'idle':'running',queueEnabled:false,queueRetryAt:undefined,queueError:undefined};messages=messages.filter(message=>message.id!=='task-plan');messages.push({id:'task-plan',kind:'plan',text:'Task plan',status,arguments:JSON.stringify({steps:['Read requirements','Make changes','Check results'].map((step,index)=>({step,status:index<completed?'completed':index===completed?'inProgress':'pending'}))})});persist();dispatch({type:'dashboard:action-result',requestId:'auto-plan',action:'listCodexCliSessions',status:'completed',payload:{cliSessions:[session]}});dispatch({type:'dashboard:codex-session-live',state:{sessionId:session.id,streamId:session.id,sequence:Date.now(),status:status==='unknown'?'completed':'running',updatedAt:Date.now(),messages}});};
window.__completeOffice=()=>{session={...session,status:'idle',queueEnabled:false,queueRetryAt:undefined,queueError:undefined,updatedAt:new Date().toISOString()};messages=messages.filter(message=>message.id!=='task-plan');messages.push(...${JSON.stringify(activities)},{id:crypto.randomUUID(),role:'assistant',text:'Your private workspace response is ready.'});persist();dispatch({type:'dashboard:action-result',requestId:'auto-team-list',action:'listCodexCliSessions',status:'completed',payload:{cliSessions:[session]}});dispatch({type:'dashboard:codex-session-live',state:{sessionId:session.id,streamId:session.id,sequence:Date.now(),status:'completed',updatedAt:Date.now(),messages}});dispatch({type:'dashboard:notice',level:'info',message:'Your response is ready.'});};
window.acquireVsCodeApi=()=>({postMessage(message){window.__privateActions.push(message);setTimeout(()=>{
if(message.type==='dashboard:ready'||message.type==='dashboard:workspace-presence'){dispatch({type:'dashboard:snapshot',state});dispatch({type:'dashboard:connection',connected:!window.__fixtureOffline});return;}
if(message.type==='dashboard:setting'){state.settings[message.key]=message.value;dispatch({type:'dashboard:snapshot',state});dispatch({type:'dashboard:notice',level:'info',message:'Setting saved.'});return;}
if(message.type!=='dashboard:action')return;
if(message.action==='listWorkspaceFiles'&&window.__failLibraryList){window.__failLibraryList=false;dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'failed',error:'This view is temporarily unavailable. Please retry.'});return;}
if(message.action==='readWorkspaceFile'&&message.payload.fileDownloadOffset!==undefined){
 if(window.__failFileDownload){window.__failFileDownload=false;dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'failed',error:'This file changed. Start the download again.'});return;}
 if(window.__holdFileDownload){window.__holdFileDownload=false;window.__releaseFileDownload=()=>dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'completed',payload:{workspaceFileDownload:{path:message.payload.filePath,revision:'r1',offset:0,size:3,data:'AQID'}}});return;}
}
let payload={};
if(message.action==='listCodexCliSessions')payload={cliSessions:session?[session]:[],cliComposerConfig:config};
else if(message.action==='getCodexCliSessionMessages')payload={cliSession:session,cliSessionMessages:messages};
else if(['startCodexCliSession','sendCodexCliSessionMessage','steerCodexCliSessionTurn'].includes(message.action)){
session={id:session?.id||'12345678-1234-1234-1234-123456789abc',title:session?.title||message.payload.text,status:'running',queueEnabled:true,queueRetryAt:Date.now()+60000,queueError:'All assistants are busy. You are in the queue.',projectPath:'C:/team/alex',canStop:true,updatedAt:new Date().toISOString()};
messages.push({id:crypto.randomUUID(),role:'user',text:message.payload.text});persist();payload={cliSession:session,cliSessions:[session],cliSessionMessages:messages,notice:{level:'info',message:'Message accepted and queued.'}};
}else if(message.action==='getWorkspaceEnvironment')payload={workspaceEnvironment:{projectPath:'C:/team/alex',projectName:'My workspace',isGitRepository:false,changes:0,additions:0,deletions:0,ahead:0,behind:0,hasRemote:false}};
else if(message.action==='listWorkspaceFiles')payload={workspaceFiles:window.__libraryFiles||[]};
else if(message.action==='readWorkspaceFile'&&window.__previewFiles?.[message.payload.filePath]&&message.payload.fileDownloadOffset===undefined)payload={workspaceFile:window.__previewFiles[message.payload.filePath]};
else if(message.action==='readWorkspaceFile'){if(message.payload.filePath==='missing.html'){dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'failed',error:'File could not be opened. Choose another file.'});return;}const content='Saved file contents.';payload=message.payload.fileDownloadOffset!==undefined?{workspaceFileDownload:{path:message.payload.filePath,revision:'r1',offset:0,size:content.length,data:btoa(content)}}:{workspaceFile:{path:message.payload.filePath,content,kind:'text',language:'javascript',mimeType:'text/javascript',revision:'r1',size:content.length}};}
else if(message.action==='deleteWorkspaceFile'){window.__libraryFiles=window.__libraryFiles.filter(file=>file.path!==message.payload.filePath);payload={notice:{level:'info',message:'File deleted.'}};}
else if(message.action==='workspaceBrowser'){
 const r=message.payload.browserRequest;window.__browserPages??=[];
 if(['open','navigate'].includes(r.operation)) {const url=r.url.includes('://')?r.url:'https://workspace.invalid/'+encodeURIComponent(r.url);const next={id:r.pageId||crypto.randomUUID(),title:'Workspace website',url,revision:crypto.randomUUID()};window.__browserPages=[next];}
 const current=window.__browserPages.find(page=>page.id===r.pageId)||window.__browserPages[0];
 payload={workspaceBrowser:{pages:window.__browserPages,feedback:[],...(current?{pageId:current.id,revision:current.revision,image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5WQAAAAASUVORK5CYII='}:{})}};
}
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
try{for(const width of [1440,390,360,320].filter(value=>!process.argv.includes('--phone-only')||value===360)){
 // Playwright's service-worker blocking script throws inside opaque sandbox previews.
 const context=await browser.newContext({viewport:{width,height:width===360?674:960}});const page=await context.newPage();page.setDefaultTimeout(15_000);
 const errors=[];page.on('pageerror',error=>errors.push(error.stack||error.message));
 page.on('console',message=>{if(message.type()==='error'&&!/(?:status of (?:409|503))/.test(message.text()))errors.push('Console: '+message.text());});
 await useWorkspaceDashboardAssets(page,origin,context);await context.route('**/assets/browserHost.js*',route=>route.fulfill({contentType:'text/javascript',body:mockHost}));
 const emailFixture=await emailUiFixture(context,office.username);
 await context.route('**/assets/codex.svg',route=>route.fulfill({contentType:'image/svg+xml',path:path.resolve('media/product-icons/codex-openai.svg')}));
 await page.addInitScript(()=>{window.SpeechRecognition=class{start(){window.__dictation=this;}stop(){this.onend?.();}abort(){}};});
 await context.route('**/api/workspace/image?*',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5WQAAAAASUVORK5CYII=','base64')}));
 const start=Date.now();await page.goto(origin+'/workspace');
 await page.locator('.cli-workspace').waitFor();
 if(process.argv.includes('--tool-failure')){
  await checkToolFailureUi(page,{width,output});assert.deepEqual(errors,[]);await context.close();continue;
 }
 if(process.argv.includes('--composer-changes')){
  await page.getByRole('combobox',{name:'Project',exact:true}).click();
  await page.getByRole('button',{name:'Create new',exact:true}).click();
  await page.getByRole('textbox',{name:'Project name',exact:true}).waitFor();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  const id='12345678-1234-1234-1234-123456789abc';
  await page.evaluate(({id,activities})=>localStorage.setItem('private-workspace-fixture',JSON.stringify({session:{id,title:'Changed files',status:'idle',projectPath:'C:/team/alex'},messages:activities})),{id,activities});
  await context.route('**/api/workspace/preferences',route=>route.fulfill({json:{limits:{storageMb:100},usage:{storageBytes:0}}}));
  await page.goto(origin+'/workspace/'+id);
  const changes=page.getByRole('button',{name:'View 2 changed files',exact:true});
  await changes.waitFor();
  assert.match(await changes.innerText(),/2 files changed/);
  assert.match(await changes.innerText(),/\+2/);
  await page.evaluate(()=>window.__setAvailability({status:'offline',availableAt:Math.floor(Date.now()/1000)+3660}));
  const strip=page.locator('.cli-turn-usage-strip').filter({has:changes});
  await strip.getByRole('status').filter({hasText:/Temporarily unavailable/}).waitFor();
  const layout=await strip.evaluate(node=>{const status=node.querySelector('[role=status]').getBoundingClientRect(),button=node.querySelector('button').getBoundingClientRect();return {overlap:status.right>button.left,overflow:node.scrollWidth>node.clientWidth+1};});
  assert.deepEqual(layout,{overlap:false,overflow:false});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  await page.screenshot({path:path.join(output,`composer-changes-${width}.png`),fullPage:true,animations:'disabled'});
  await changes.click();await page.locator('.cli-file-tree').waitFor();
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({width,elapsedMs:Date.now()-start,createNew:true,changedFiles:true,offlineStatus:true,opensFiles:true,errors:0}));
  await context.close();continue;
 }
 await page.evaluate(() => window.__setAvailability({ status: 'offline', availableAt: Math.floor(Date.now() / 1000) + 3660 }));
 await page.locator('.team-request-state').filter({ hasText: /Temporarily unavailable\. Expected back at.*1h/ }).waitFor();
 await assertPlainUserInterface(page);
 const welcomeLayout=await page.locator('.cli-new-chat-copy').evaluate(node=>{const title=node.querySelector('h2').getBoundingClientRect(),status=node.querySelector('[role=status]').getBoundingClientRect();return {below:status.top>=title.bottom,centered:Math.abs((status.left+status.right-title.left-title.right)/2)<2,overflow:node.scrollWidth>node.clientWidth+1};});
 assert.deepEqual(welcomeLayout,{below:true,centered:true,overflow:false});
 await page.screenshot({path:path.join(output,`offline-${width}.png`),fullPage:true,animations:'disabled'});
 await page.evaluate(() => window.__setAvailability({ status: 'available' }));
 await page.locator('.team-request-state').waitFor({ state: 'detached' });
 let profile={displayName:'Alex Morgan',username:'alex@example.test'};let signedIn=[{id:'current',expiresAt:Date.now()+3600000,current:true},{id:'other',expiresAt:Date.now()+3600000,current:false}];
 await context.route('**/api/workspace/account',async route=>{const input=route.request().postDataJSON();let message='';if(input?.action==='profile'){profile={...profile,displayName:input.displayName};message='Profile saved.';}if(input?.action==='password')message='Password changed. Other devices have been signed out.';if(input?.action==='revoke'){signedIn=signedIn.filter(session=>session.current);message='Other devices signed out.';}await route.fulfill({contentType:'application/json',body:JSON.stringify({profile,plan:{name:'Workspace',status:'active',models:[]},sessions:signedIn,message})});});
 let savedCopies=[];await context.route('**/api/workspace/file-history',route=>{const input=route.request().postDataJSON();if(input){assert.equal(input.confirmed,true);savedCopies=savedCopies.filter(record=>record.id!==input.id);}return route.fulfill({contentType:'application/json',body:JSON.stringify(input?{message:'Saved copy removed.'}:{records:savedCopies})});});
 await context.route('**/api/workspace/preview?**',route=>route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'"},body:'<button onclick="this.textContent=\'Clicked\'">Test website</button>'}));
 let memory={enabled:true,revision:'m0',entries:[]},failMemorySave=true,failMemoryConfigure=true;
 await context.route('**/api/workspace/memory',async route=>{
  let message='';const input=route.request().postDataJSON();
  if(input){
   if(input.operation==='configure'&&failMemoryConfigure){failMemoryConfigure=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Memory could not be updated. Try again.'})});return;}
   if(input.operation==='save'&&failMemorySave){failMemorySave=false;memory={...memory,revision:'m1',entries:[{id:'earlier',text:'Keep earlier buyer context.',updatedAt:Date.now()}]};await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Memory changed in another window. Reload memories and review before saving.'})});return;}
   if(input.expected!==memory.revision)throw Error('Unexpected stale memory write');
   if(input.operation==='configure'){memory.enabled=input.enabled;message=memory.enabled?'Memory is on for new messages.':'Memory is off. Saved memories are kept.';}
   if(input.operation==='save'){const entry=memory.entries.find(entry=>entry.id===input.id);if(entry){entry.text=input.text;message='Memory updated.';}else{memory.entries.push({id:crypto.randomUUID(),text:input.text,updatedAt:Date.now()});message='Memory saved.';}}
   if(input.operation==='remove'){memory.entries=memory.entries.filter(entry=>entry.id!==input.id);message='Memory removed.';}
   if(input.operation==='clear'){assert.equal(input.confirmed,true);memory.entries=[];message='All saved memories cleared.';}
   memory.revision=crypto.randomUUID();
  }
  await route.fulfill({contentType:'application/json',body:JSON.stringify({memory,message})});
 });
 let instructions='',failSave=true;await context.route('**/api/workspace/preferences',async route=>{if(route.request().method()==='PUT'){if(failSave){failSave=false;instructions='Updated from another window.';await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Instructions changed in another window. Review before saving.'})});return;}assert.equal(route.request().postDataJSON().expected,instructions);instructions=route.request().postDataJSON().instructions;}await route.fulfill({contentType:'application/json',body:JSON.stringify({instructions,limits:{storageMb:100,dailyTokens:100000,dailyRequests:50},usage:{tokens:1200,requests:3,pending:true,storageBytes:1024,resetsAt:Date.now()+3600000}})});});
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
 const openSettings=async()=>{if(await page.locator('.overlay.open .office-user-settings').count())return;const show=page.getByRole('button',{name:'Show sessions sidebar',exact:true});if(await show.isVisible())await show.click();await page.getByRole('button',{name:'Open settings',exact:true}).click();await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();assert.equal(await page.locator('.user-settings-footer form[action="/logout"]').count(),1);};
 const nav=async(name)=>{if(name==='Chats'){if(await page.locator('.overlay.open .office-user-settings').count())await page.locator('.overlay.open .office-user-settings .settings-close').click();return;}await openSettings();if(width<=760)await page.getByRole('combobox',{name:'Settings section',exact:true}).selectOption({label:name});else await page.getByRole('tab',{name,exact:true}).click();};
 if(process.argv.includes('--loading-recovery')){
  await checkUserWorkspaceRecoveryUi(page,context,{width,output,nav});
  assert.deepEqual(errors,[]);await context.close();continue;
 }
 if(process.argv.includes('--rendering')){
  await checkUserMessageRenderingUi(page,{width,output});assert.deepEqual(errors,[]);await context.close();continue;
 }
 if(process.argv.includes('--file-rendering')){
  await checkUserFileRenderingUi(page,{width,output,nav});assert.deepEqual(errors,[]);await context.close();continue;
 }
 if(process.argv.includes('--browsing')){
  const id='12345678-1234-1234-1234-123456789abc';
  await page.evaluate(id=>localStorage.setItem('private-workspace-fixture',JSON.stringify({session:{id,title:'Website research',status:'idle'},messages:[{id:'read-web',kind:'tool-call',title:'Read website',text:'Source read.',status:'completed',arguments:JSON.stringify({url:'https://example.test/reports/wages-2026'})},{id:'read-file',kind:'tool-call',title:'Read file',text:'File read.',status:'completed',arguments:JSON.stringify({path:'reports/notes.md'})}]})),id);
  await page.goto(origin+'/workspace/'+id);
  const group=page.locator('.cli-activity-group-details > summary');if(await group.count())await group.first().click();
  const website=page.locator('.cli-activity > summary').filter({hasText:'Browse website · https://example.test/reports/wages-2026'});await website.waitFor();await website.click();
  await page.getByText('Website read.',{exact:true}).waitFor();assert.equal(await page.getByText('Read File · website',{exact:true}).count(),0);
  await page.locator('.cli-activity > summary').filter({hasText:'Read File · reports/notes.md'}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  await page.screenshot({path:path.join(output,'website-label-'+width+'.png'),fullPage:true});
  assert.deepEqual(errors,[]);console.log(JSON.stringify({width,elapsedMs:Date.now()-start,websiteUrlVisible:true,fileLabelPreserved:true,errors:0}));await context.close();continue;
 }
 if(process.argv.includes('--email')){
  await openSettings();const email=page.getByRole('region',{name:'Email notifications',exact:true});
  await email.getByText('Notifications are sent to your account email.',{exact:true}).waitFor();
  assert.equal(await email.getByLabel('Email address',{exact:true}).count(),0);
  await email.getByRole('checkbox',{name:'Notify me when ready',exact:true}).check();
  await email.getByRole('button',{name:'Save email preferences',exact:true}).click();await email.getByRole('status').filter({hasText:'Email preferences saved.'}).waitFor();
  assert.equal(emailFixture.state.preferences.address,'alex@example.test');assert.equal(emailFixture.state.preferences.includeResult,false);
  await email.getByRole('button',{name:'Send test email',exact:true}).click();await email.getByRole('alert').filter({hasText:'SMTP authentication failed.'}).waitFor();
  assert.equal(await email.getByLabel('Email address',{exact:true}).count(),0);
  await email.getByRole('button',{name:'Send test email',exact:true}).click();await email.getByRole('status').filter({hasText:'Test email accepted'}).waitFor();
  await page.screenshot({path:path.join(output,'email-settings-'+width+'.png'),fullPage:true});
  await page.getByRole('dialog',{name:'Settings',exact:true}).press('Escape');
  const id='12345678-1234-1234-1234-123456789abc';await page.evaluate(id=>localStorage.setItem('private-workspace-fixture',JSON.stringify({session:{id,title:'Email check',status:'idle'},messages:[{id:'answer',role:'assistant',text:'Done.'}]})),id);await page.goto(origin+'/workspace/'+id);
  assert.equal(await page.getByRole('button',{name:'Email me when ready',exact:true}).count(),0);
  await page.getByRole('button',{name:'Session actions',exact:true}).click();
  const watch=page.getByRole('menuitemcheckbox',{name:/^Email me when ready/});await watch.waitFor();
  const header=page.locator('.cli-conversation-header');const before=await header.boundingBox();await watch.click();await page.getByRole('status').filter({hasText:'You’ll receive an email'}).waitFor();
  const after=await header.boundingBox();assert.equal(after.height,before.height,'Email feedback adds no header height');
  await page.getByRole('button',{name:'Session actions',exact:true}).click();assert.equal(await watch.getAttribute('aria-checked'),'true');assert.ok(emailFixture.state.watches.includes('local:'+id));await page.getByRole('button',{name:'Session actions',exact:true}).click();
  await page.screenshot({path:path.join(output,'email-session-'+width+'.png'),fullPage:true});await page.getByRole('button',{name:'Dismiss email notice',exact:true}).click();await page.getByRole('button',{name:'Session actions',exact:true}).click();await watch.click();await page.getByRole('status').filter({hasText:'Session email turned off.'}).waitFor();
  assert.equal(emailFixture.state.watches.length,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({width,elapsedMs:Date.now()-start,emailPreferences:true,testFailureVisible:true,emailInMenu:true,noExtraHeight:true,errors:0}));await context.close();continue;
 }
 if(process.argv.includes('--clear')){
  const calls=[];let fail=true,storageBytes=4096;
  await page.evaluate(()=>{window.__libraryFiles=[{name:'report.txt',path:'report.txt',type:'file',depth:0},{name:'input.txt',path:'uploads/input.txt',type:'file',depth:1}];});
  await context.route('**/api/workspace/preferences',route=>route.fulfill({json:{instructions:'Keep my saved instructions.',usage:{tokens:12,requests:1,storageBytes,resetsAt:Date.now()+3600000}}}));
  await context.route('**/api/workspace/clear**',async route=>{
   const method=route.request().method(),kind=method==='GET'?new URL(route.request().url()).searchParams.get('kind'):route.request().postDataJSON().kind;
   calls.push({method,kind});
   if(method==='GET')return route.fulfill({json:{kind,count:kind==='files'?2:1,revision:'clear-r1'}});
   assert.equal(route.request().postDataJSON().confirmed,true);assert.equal(route.request().postDataJSON().revision,'clear-r1');
   if(fail){fail=false;return route.fulfill({status:400,json:{error:'Your workspace changed. Review the clear action again before deleting.'}});}
   if(kind==='files'){await page.evaluate(()=>{window.__libraryFiles=[];});storageBytes=0;}
   return route.fulfill({json:{message:kind==='files'?'2 files permanently deleted.':'1 chat permanently deleted.'}});
  });
  await openSettings();
  await page.getByRole('button',{name:'Clear all chats',exact:true}).click();
  let confirm=page.getByRole('dialog',{name:'Clear all chats',exact:true});await confirm.getByText('Permanently delete 1 chat? This cannot be undone.',{exact:true}).waitFor();
  await confirm.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(calls.filter(call=>call.method==='POST').length,0);
  await page.getByRole('status').filter({hasText:'Clear action cancelled.'}).waitFor();
  await page.getByRole('button',{name:'Clear all files',exact:true}).click();confirm=page.getByRole('dialog',{name:'Clear all files',exact:true});await confirm.getByRole('button',{name:'Delete permanently',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Your workspace changed.'}).waitFor();
  await page.getByRole('button',{name:'Clear all chats',exact:true}).click();confirm=page.getByRole('dialog',{name:'Clear all chats',exact:true});await confirm.getByRole('button',{name:'Delete permanently',exact:true}).click();
  await page.getByRole('status').filter({hasText:'1 chat permanently deleted.'}).waitFor();
  await nav('Library');await page.locator('.user-library-files li').first().waitFor();
  await page.getByRole('button',{name:'Clear all files',exact:true}).click();confirm=page.getByRole('dialog',{name:'Clear all files',exact:true});await confirm.getByRole('button',{name:'Delete permanently',exact:true}).click();
  await page.getByRole('status').filter({hasText:'2 files permanently deleted.'}).waitFor();await page.waitForFunction(()=>document.querySelectorAll('.user-library-files li').length===0);
  await page.getByText('0 files',{exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'clear-library-'+width+'.png'),fullPage:true});
  await nav('Usage');await page.getByText('0 / Unlimited',{exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  await page.screenshot({path:path.join(output,'clear-usage-'+width+'.png'),fullPage:true});
  assert.deepEqual(errors.filter(error=>!error.includes('status of 400')),[]);
  console.log(JSON.stringify({width,elapsedMs:Date.now()-start,clearCancellation:true,clearConflictVisible:true,chatsAndFilesSeparate:true,libraryRefresh:true,usageRefresh:true}));await context.close();continue;
 }
 if(process.argv.includes('--appearance')){
  await openSettings();
  const settings=page.getByRole('dialog',{name:'Settings',exact:true});
  const logout=settings.getByRole('button',{name:'Sign out',exact:true});await logout.waitFor();
  assert.equal(await logout.evaluate(node=>node.closest('form').method),'post');
  await page.screenshot({path:path.join(output,'settings-'+width+'.png'),fullPage:true});
  await settings.press('Escape');await settings.waitFor({state:'hidden'});
  const show=page.getByRole('button',{name:'Show sessions sidebar',exact:true});if(await show.isVisible())await show.click();
  await page.getByRole('button',{name:'Open settings',exact:true}).focus();await page.keyboard.press('Enter');await settings.waitFor();await settings.press('Escape');await settings.waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);console.log(JSON.stringify({width,elapsedMs:Date.now()-start,centeredAvailability:true,directSettings:true,logoutInModal:true,keyboard:true,errors:0}));await context.close();continue;
 }
 await nav('Scheduled');await page.getByRole('heading',{name:'Scheduled',exact:true}).waitFor();
 assert.equal(await page.locator('.user-scheduled form').count(),0);
 assert.equal(await page.locator('.user-schedule-examples').count(),0);
 assert.equal(await page.getByRole('button',{name:'Create with AI',exact:true}).count(),0);
 assert.equal(await page.getByRole('heading',{name:'Your schedules',exact:true}).count(),0);
 await page.screenshot({path:path.join(output,`scheduled-empty-${width}.png`),fullPage:true,animations:'disabled'});
 tasks=[{id:crypto.randomUUID(),revision:crypto.randomUUID(),title:'Buyer lab dip reminder',prompt:'Prepare buyer lab dip reminder drafts.',model:'quality',projectPath:'C:/team/alex',frequency:'daily',timeZone:'Asia/Dhaka',enabled:true,nextRunAt:Date.now()+3600000}];
 await page.getByRole('button',{name:'Refresh schedules',exact:true}).click();await page.getByRole('heading',{name:'Buyer lab dip reminder',exact:true}).waitFor();
 await page.getByRole('button',{name:'Actions for Buyer lab dip reminder',exact:true}).click();await page.getByRole('menuitem',{name:'Edit with AI',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.cli-composer textarea')?.value.includes('Please update scheduled task'));
 await page.locator('.cli-composer textarea').fill('');await nav('Scheduled');
 await page.getByRole('button',{name:'Run now',exact:true}).click();await page.getByRole('alert').filter({hasText:'Task could not be queued'}).waitFor();assert.equal(tasks.length,1);
 await page.getByRole('button',{name:'Run now',exact:true}).click();await page.getByRole('status').filter({hasText:'Task added to your conversation queue.'}).waitFor();
 await page.getByRole('button',{name:'Actions for Buyer lab dip reminder',exact:true}).click();await page.getByRole('menuitem',{name:'Pause',exact:true}).click();await page.getByText('Paused',{exact:true}).waitFor();
 await page.screenshot({path:path.join(output,`scheduled-${width}.png`),fullPage:true,animations:'disabled'});
 await page.getByRole('button',{name:'Actions for Buyer lab dip reminder',exact:true}).click();await page.getByRole('menuitem',{name:'Remove schedule',exact:true}).click();await page.getByRole('dialog',{name:'Remove schedule',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(tasks.length,1);
 await page.getByRole('button',{name:'Actions for Buyer lab dip reminder',exact:true}).click();await page.getByRole('menuitem',{name:'Remove schedule',exact:true}).click();await page.getByRole('dialog',{name:'Remove schedule',exact:true}).getByRole('button',{name:'Remove schedule',exact:true}).click();await page.getByText('No scheduled tasks yet.',{exact:true}).waitFor();
 assert.equal(scheduleActions.filter(action=>action.method==='DELETE').length,1);
 await page.evaluate(()=>{window.__libraryFiles=[{name:'buyer-po.csv',path:'buyer-po.csv',type:'file',depth:0},{name:'costing.csv',path:'reports/costing.csv',type:'file',depth:1}];});
 await nav('Library');await page.getByRole('button',{name:'Download costing.csv',exact:true}).waitFor();
 await page.getByRole('searchbox',{name:'Search library',exact:true}).fill('reports/');assert.equal(await page.locator('.user-library-files li').count(),1);
 const [libraryDownload]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download costing.csv',exact:true}).click()]);assert.equal(libraryDownload.suggestedFilename(),'costing.csv');
 await page.getByRole('region',{name:'File storage',exact:true}).getByText('1.0 KB',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Grid view',exact:true}).count(),0);
 const fileLayout=await page.locator('.user-library-files li').first().evaluate(node=>{const r=node.getBoundingClientRect(),actions=node.querySelector('.user-page-actions').getBoundingClientRect(),file=node.querySelector('button').getBoundingClientRect();return {height:r.height,aligned:actions.left>=file.right,center:Math.abs((actions.top+actions.bottom-file.top-file.bottom)/2),parts:[node,...node.querySelectorAll('button,strong,small')].map(element=>({tag:element.tagName,height:element.getBoundingClientRect().height,padding:getComputedStyle(element).padding,line:getComputedStyle(element).lineHeight,font:getComputedStyle(element).fontSize,gap:getComputedStyle(element).gap}))};});assert.ok(fileLayout.height<=70&&fileLayout.aligned&&fileLayout.center<=1,JSON.stringify(fileLayout));
 await page.getByRole('button',{name:'Actions for costing.csv',exact:true}).click();await page.getByRole('menuitem',{name:'Move to Trash',exact:true}).click();await page.getByRole('dialog',{name:'Move file to Trash',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
 await page.screenshot({path:path.join(output,`library-${width}.png`),fullPage:true,animations:'disabled'});
 await page.locator('.user-library-files li > button').first().click();if(width<=760)await page.getByRole('combobox',{name:'Workspace tool',exact:true}).waitFor();else await page.getByRole('tab',{name:'costing.csv',exact:true}).waitFor();await page.getByRole('complementary',{name:'Workspace tools',exact:true}).getByRole('button',{name:'Close workspace tools',exact:true}).click();await nav('Library');
 await page.getByRole('button',{name:'Actions for costing.csv',exact:true}).click();await page.getByRole('menuitem',{name:'Move to Trash',exact:true}).click();await page.getByRole('dialog',{name:'Move file to Trash',exact:true}).getByRole('button',{name:'Move to Trash',exact:true}).click();await page.getByRole('status').filter({hasText:'File moved to Trash.'}).waitFor();assert.equal(await page.getByRole('button',{name:'Download costing.csv',exact:true}).count(),0);
 savedCopies=[{id:'copy-1',kind:'trash',path:'buyer-po.csv',at:Date.now(),bytes:24}];await page.getByRole('button',{name:'File recovery',exact:true}).click();const recoveryDialog=page.getByRole('dialog',{name:'File recovery',exact:true}),recoveryConfirm=page.getByRole('dialog',{name:'Remove saved copy',exact:true});await recoveryDialog.getByRole('button',{name:'Remove saved copy of buyer-po.csv',exact:true}).click();await recoveryConfirm.getByRole('button',{name:'Cancel',exact:true}).click();await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Remove saved copy of buyer-po.csv');assert.equal(savedCopies.length,1);await recoveryDialog.getByRole('button',{name:'Remove saved copy of buyer-po.csv',exact:true}).click();await page.screenshot({path:path.join(output,`recovery-confirm-${width}.png`),fullPage:true,animations:'disabled'});await recoveryConfirm.getByRole('button',{name:'Remove permanently',exact:true}).click();await recoveryConfirm.waitFor({state:'hidden'});await recoveryDialog.getByRole('status').filter({hasText:'Saved copy removed.'}).waitFor();assert.equal(savedCopies.length,0);await recoveryDialog.getByRole('button',{name:'Close file recovery',exact:true}).click();
 await nav('Chats');
 if(width<760)await page.getByRole('button',{name:'Show sessions sidebar',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Conversation options',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'Show archived conversations',exact:true}).count(),0);
 if(width<760)await page.getByRole('button',{name:'Hide sessions sidebar',exact:true}).click();
 if(await page.getByRole('button',{name:'Start a new chat',exact:true}).isVisible())await page.getByRole('button',{name:'Start a new chat',exact:true}).click();
 await page.locator('.cli-composer textarea').waitFor();
 if(width<760){const compact=await page.locator('.cli-composer').evaluate(element=>({height:element.getBoundingClientRect().height,control:getComputedStyle(element).getPropertyValue('--cli-control-size')}));assert.equal(compact.control.trim(),'30px');assert.ok(compact.height<=88,'User composer matches the compact master height');}

 await page.getByRole('button',{name:'Message settings',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.cli-composer-options select[name=model]')?.value==='fast');
 assert.equal(await page.getByRole('combobox',{name:'Model',exact:true}).locator('option').filter({hasText:'Automatic'}).count(),0);
 await page.evaluate(()=>window.__setModelWarning('Models could not be loaded. Your selected model is kept.'));
 assert.equal(await page.locator('.user-model-warning').count(),0);
 assert.equal(await page.getByRole('combobox',{name:'Model',exact:true}).inputValue(),'fast');
 await page.evaluate(()=>window.__setModelWarning(''));
 await assertPlainUserInterface(page);
 await page.evaluate(()=>window.__setModelDefault(''));
 await page.waitForFunction(()=>document.querySelector('.cli-composer-options select[name=model]')?.value==='');
 await page.locator('.cli-composer textarea').fill('Keep this draft until I choose a model');
 assert.equal(await page.getByRole('button',{name:'Send message',exact:true}).isDisabled(),true);
 await page.locator('.cli-composer textarea').press('Control+Enter');
 assert.equal(await page.evaluate(()=>window.__privateActions.filter(item=>item.action==='startCodexCliSession').length),0);
 await page.evaluate(()=>window.__setModelDefault('fast'));
 await page.waitForFunction(()=>document.querySelector('.cli-composer-options select[name=model]')?.value==='fast');
 await page.locator('.cli-composer textarea').fill('/model');
 assert.equal(await page.getByRole('listbox',{name:'Commands and skills'}).count(),0);
 await page.locator('.cli-composer textarea').fill('');
 await page.getByRole('button',{name:'Close message settings',exact:true}).click();
 await page.getByRole('combobox',{name:'Project',exact:true}).click(); await page.getByRole('button', { name: 'Create new', exact: true }).click();
 await page.getByRole('textbox',{name:'Project name',exact:true}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'Project folder',exact:true}).count(),0);
 await assertPlainUserInterface(page);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 if(width<760)await page.getByRole('button',{name:'Show sessions sidebar',exact:true}).click();
 await page.locator('.team-user-footer').getByText('Alex Morgan',{exact:true}).first().waitFor();
 if(width<760)await page.waitForFunction(()=>Math.abs(document.querySelector('.cli-session-rail').getBoundingClientRect().left)<1);
 const accountLayout=await page.evaluate(()=>{const rail=document.querySelector('.cli-session-rail').getBoundingClientRect(),footer=document.querySelector('.team-user-footer').getBoundingClientRect(),list=document.querySelector('.cli-session-list-region').getBoundingClientRect();return{bottomGap:rail.bottom-footer.bottom,viewportGap:innerHeight-footer.bottom,height:footer.height,listBottom:list.bottom,footerTop:footer.top};});
 assert.ok(accountLayout.bottomGap>=-1&&accountLayout.bottomGap<=9,'Account footer stays at the sidebar bottom');
 if(width<760)assert.ok(accountLayout.viewportGap>=-1&&accountLayout.viewportGap<=9,JSON.stringify(accountLayout));
 assert.equal(await page.locator('.user-workspace-nav').count(),0);
 assert.ok(accountLayout.height<=60,'Account footer is compact');
 assert.ok(accountLayout.listBottom<=accountLayout.footerTop+1,'Session list cannot cover the account footer');
 await page.screenshot({path:path.join(output,`account-sidebar-${width}.png`),fullPage:true,animations:'disabled'});

 assert.equal(await page.getByRole('button',{name:'Dashboard',exact:true}).count(),0);
 assert.equal(await page.getByRole('tab',{name:'General',exact:true}).count(),0);
 assert.equal(await page.getByRole('tab',{name:'Task',exact:true}).count(),0);
 assert.equal(await page.getByRole('combobox',{name:'System',exact:true}).count(),0);
 if(width<760)await page.getByRole('button',{name:'Hide sessions sidebar',exact:true}).click();
 if(!await page.getByRole('combobox',{name:'Model',exact:true}).isVisible())await page.getByRole('button',{name:'Message settings',exact:true}).click();
 await page.getByRole('combobox',{name:'Model',exact:true}).selectOption('quality');await page.getByRole('combobox',{name:'Thinking',exact:true}).selectOption('high');await page.getByRole('button',{name:'Close message settings',exact:true}).click();
 await page.locator('.cli-composer textarea').fill('Plan my private workspace');
 assert.equal(await page.locator('.cli-workspace').count(),1);
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.__privateActions.find(item=>item.action==='startCodexCliSession').payload.model),'quality');
 await page.locator('.team-request-state').filter({hasText:'All assistants are busy'}).waitFor();
 await page.evaluate(() => window.__setAvailability({ status: 'offline', availableAt: Math.floor(Date.now() / 1000) + 90060 }));
 await page.locator('.team-request-state').filter({ hasText: /Temporarily unavailable\. Expected back at.*1d 1h/ }).waitFor();
 await assertPlainUserInterface(page);
 await page.screenshot({path:path.join(output,`offline-queued-${width}.png`),fullPage:true,animations:'disabled'});
 await page.evaluate(() => window.__setAvailability({ status: 'offline' }));
 await page.locator('.team-request-state').filter({ hasText: "Temporarily unavailable. Checking when you can chat again." }).waitFor();
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
 await checkUserDeliverablesUi(page,{width,output});
 if(width<760&&await page.getByRole('button',{name:'Hide workspace tools',exact:true}).isVisible())await page.getByRole('button',{name:'Hide workspace tools',exact:true}).click();
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
 await page.getByRole('button',{name:'Session actions',exact:true}).click();await page.getByRole('menuitem',{name:'Rename',exact:true}).click();const renameDialog=page.getByRole('dialog',{name:'Rename chat',exact:true});await renameDialog.getByRole('textbox',{name:'Session name',exact:true}).fill('Cancelled rename');await renameDialog.getByRole('button',{name:'Cancel',exact:true}).click();await renameDialog.waitFor({state:'hidden'});assert.equal(await page.locator('.cli-conversation-header .cli-rename-form').count(),0);
 if(await page.getByRole('button',{name:'Show workspace tools',exact:true}).count())await page.getByRole('button',{name:'Show workspace tools',exact:true}).click();
 if(width<760&&await page.getByRole('button',{name:'Hide workspace tools',exact:true}).isVisible())await page.getByRole('button',{name:'Hide workspace tools',exact:true}).click();
 await page.evaluate(()=>window.__setModelMode('auto'));
 await page.getByRole('button',{name:'Message settings',exact:true}).click();
 assert.deepEqual(await page.getByRole('combobox',{name:'Model',exact:true}).locator('option').allTextContents(),['Auto','Regular','Professional','Expert']);
 assert.equal(await page.getByRole('combobox',{name:'Thinking',exact:true}).isDisabled(),true);
 await page.getByRole('combobox',{name:'Model',exact:true}).selectOption('expert');await page.getByRole('combobox',{name:'Thinking',exact:true}).selectOption('high');await page.getByRole('button',{name:'Close message settings',exact:true}).click();
 await page.evaluate(()=>window.__setModelMode('auto',false));await page.getByRole('status',{name:'Automatic assistant',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Message settings',exact:true}).count(),0);
 await page.evaluate(()=>window.__setModelMode('manual'));await page.getByRole('button',{name:'Message settings',exact:true}).waitFor();
 if(await page.getByRole('button',{name:'Hide workspace tools',exact:true}).isVisible())await page.getByRole('button',{name:'Hide workspace tools',exact:true}).click();
 await page.getByRole('button',{name:'Dictate message',exact:true}).click();const voice=page.getByRole('dialog',{name:'Voice dictation',exact:true});await voice.getByRole('button',{name:'Start dictation',exact:true}).click();
 await page.evaluate(()=>{window.__dictation.onstart?.();window.__dictation.onresult({resultIndex:0,results:[{isFinal:true,0:{transcript:'Prepare the buyer report'}}]});});await page.waitForTimeout(50);
 await voice.getByRole('button',{name:'Stop',exact:true}).click();assert.equal(await voice.getByRole('textbox',{name:'Captured text',exact:true}).inputValue(),'Prepare the buyer report');await voice.getByRole('button',{name:'Use text',exact:true}).click();assert.match(await page.getByRole('textbox',{name:'Message',exact:true}).inputValue(),/Prepare the buyer report/);await page.getByRole('textbox',{name:'Message',exact:true}).fill('');
 await page.evaluate(()=>window.__setQuestion('visual'));const visual=page.getByRole('dialog',{name:/has a question/});assert.equal(await visual.locator('.cli-visual-options').count(),1);await visual.getByRole('button',{name:'Enlarge Minimal',exact:true}).click();const enlarged=page.getByRole('dialog',{name:'Minimal',exact:true});await enlarged.waitFor();await enlarged.getByRole('button',{name:'Close visual preview',exact:true}).click();await visual.getByRole('radio',{name:'Editorial',exact:true}).check();const visualSend=await visual.getByRole('button',{name:'Send answer',exact:true}).boundingBox();assert.ok(visualSend&&visualSend.y>=0&&visualSend.y+visualSend.height<=await page.evaluate(()=>innerHeight)+1);await page.screenshot({path:path.join(output,`visual-options-${width}.png`),fullPage:true,animations:'disabled'});await visual.getByRole('button',{name:'Send answer',exact:true}).click();await page.evaluate(()=>window.__setQuestion(false));await page.waitForTimeout(100);
 await page.evaluate(()=>window.__setQuestion('visual'));await visual.waitFor();await visual.locator('.cli-visual-options img').first().evaluate(image=>image.dispatchEvent(new Event('error')));await visual.locator('.cli-visual-options').waitFor({state:'detached'});assert.equal(await visual.getByRole('radio').count(),2,'Failed thumbnails fall back to readable choices');await visual.getByRole('button',{name:'Close question',exact:true}).click();await page.evaluate(()=>window.__setQuestion(false));
 await page.evaluate(()=>window.__setQuestion(true));const question=page.getByRole('dialog',{name:/has a question/});await question.waitFor();assert.equal(await page.locator('.session-question-modal').count(),1);
 for(const field of await question.locator('fieldset').all())await field.getByRole('radio').first().check();
 if(width===360)await page.setViewportSize({width,height:390});
 const sendAnswer=question.getByRole('button',{name:'Send answer',exact:true});await sendAnswer.waitFor();
 const bounds=await sendAnswer.boundingBox();assert.ok(bounds&&bounds.y>=0&&bounds.y+bounds.height<=await page.evaluate(()=>innerHeight)+1,JSON.stringify(bounds));
 await page.screenshot({path:path.join(output,`question-${width}.png`),fullPage:true,animations:'disabled'});
 await sendAnswer.click();await question.waitFor({state:'detached'});await page.evaluate(()=>window.__setQuestion(false));
 if(width===360)await page.setViewportSize({width,height:674});
 await page.evaluate(()=>window.__olderProject());
 await page.getByRole('button',{name:'Show workspace tools',exact:true}).waitFor();await page.getByRole('button',{name:'Show workspace tools',exact:true}).click();
 if(width<=760)await page.getByRole('combobox',{name:'Workspace tool',exact:true}).selectOption({label:'Env'});else await page.getByRole('tab',{name:'Env',exact:true}).click();
 const overview=page.getByRole('region',{name:'Environment',exact:true});await overview.getByRole('navigation',{name:'Workspace tools',exact:true}).waitFor();
 assert.equal(await overview.locator('.cli-environment-section[open]').count(),0);assert.equal(await overview.getByRole('navigation').getByRole('button').count(),2);assert.equal(await overview.getByRole('button',{name:/Git/}).count(),0);assert.doesNotMatch(await overview.innerText(),/System information|Repository|System tools|host|Windows/);
 await page.screenshot({path:path.join(output,`environment-${width}.png`),fullPage:true,animations:'disabled'});
 await assertPlainUserInterface(page);
 if(width<=760)await page.getByRole('combobox',{name:'Workspace tool',exact:true}).selectOption({label:'Browser'});else await page.getByRole('tab',{name:'Browser',exact:true}).click();
 const preview=page.getByRole('region',{name:'Browser',exact:true}),website=preview.getByRole('textbox',{name:'Browser URL',exact:true});
 assert.equal(await website.getAttribute('placeholder'),'Enter a URL or workspace file');
 for(const name of ['Go back','Go forward','Go to URL','Browser menu'])assert.equal(await preview.getByRole('button',{name,exact:true}).count(),1);
 await preview.getByRole('button',{name:'Browser menu',exact:true}).click();await preview.getByRole('menuitemcheckbox',{name:'Browser inspector',exact:true}).waitFor();await preview.getByRole('menuitem',{name:'Comments',exact:true}).focus();await page.keyboard.press('Escape');
 for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);const layout=await preview.locator('form.workspace-browser-address').evaluate(node=>{const input=node.querySelector('input'),rect=node.getBoundingClientRect();return {height:rect.height,inputWidth:input.getBoundingClientRect().width,right:input.getBoundingClientRect().right,max:rect.right,bg:getComputedStyle(input).backgroundColor};});assert.ok(layout.inputWidth>20&&layout.right<=layout.max+1,JSON.stringify(layout));if(theme==='dark')assert.notEqual(layout.bg,'rgb(255, 255, 255)');await page.screenshot({path:path.join(output,`browser-${theme}-${width}.png`),fullPage:true,animations:'disabled'});}
 await website.fill('report draft.html');await website.press('Enter');await page.waitForFunction(()=>window.__privateActions.some(message=>message.payload?.browserRequest?.url==='report draft.html'));
 await page.waitForFunction(()=>!document.querySelector('[aria-label="Go to URL"]')?.disabled);
 await website.fill('https://example.com');await website.press('Enter');await page.waitForFunction(()=>window.__privateActions.some(message=>message.payload?.browserRequest?.url==='https://example.com'));
 await page.evaluate(()=>document.documentElement.dataset.theme='light');
 if(width<760){await page.getByRole('button',{name:'Hide workspace tools',exact:true}).click();await page.getByRole('button',{name:'Show sessions sidebar',exact:true}).click();}
 await openSettings();
 const settingsTabs=page.getByRole('tablist',{name:'Settings sections',exact:true,includeHidden:true});
 assert.equal(await settingsTabs.getByRole('tab',{includeHidden:true}).count(),6);assert.ok(await settingsTabs.isVisible() || await page.getByRole('combobox',{name:'Settings section',exact:true}).isVisible());
 await page.screenshot({path:path.join(output,`settings-general-${width}.png`),fullPage:true,animations:'disabled'});
 if(await page.getByRole('combobox',{name:'Settings section',exact:true}).isVisible())await page.getByRole('combobox',{name:'Settings section',exact:true}).selectOption('usage');else {await settingsTabs.getByRole('tab',{includeHidden:true,name:'General',exact:true}).focus();await settingsTabs.getByRole('tab',{includeHidden:true,name:'General',exact:true}).press('ArrowDown');await settingsTabs.getByRole('tab',{includeHidden:true,name:'Personalization',exact:true}).press('ArrowDown');await settingsTabs.getByRole('tab',{includeHidden:true,name:'Account',exact:true}).press('ArrowDown');assert.equal(await settingsTabs.getByRole('tab',{includeHidden:true,name:'Usage',exact:true}).getAttribute('aria-selected'),'true');}
 await page.getByRole('region',{name:'Your usage',exact:true}).waitFor();
 assert.equal(await page.getByRole('progressbar').count(),3);
 await page.getByText('A response is running. Usage will update when it finishes.',{exact:true}).waitFor();
 await page.screenshot({path:path.join(output,`settings-usage-${width}.png`),fullPage:true,animations:'disabled'});
 await nav('Personalization');
 const selectedTab=await settingsTabs.getByRole('tab',{includeHidden:true,name:'Personalization',exact:true}).evaluate(node=>({border:getComputedStyle(node).borderBottomWidth,radius:parseFloat(getComputedStyle(node).borderRadius),after:getComputedStyle(node,'::after').content}));assert.equal(selectedTab.border,'0px');assert.ok(selectedTab.radius>=6);assert.ok(['none','normal','""'].includes(selectedTab.after),'Settings selection has no underline');
 const instructionDialog=page.getByRole('dialog',{name:'Custom instructions',exact:true});
 assert.equal(await page.locator('.user-workspace-instructions textarea').count(),0,'Instructions use a separate editor');
 await page.getByRole('button',{name:'Edit instructions',exact:true}).click();await instructionDialog.getByLabel('How should your assistant respond?',{exact:true}).fill('Cancelled draft');await instructionDialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(instructions,'');
 await page.getByRole('button',{name:'Edit instructions',exact:true}).click();await instructionDialog.getByLabel('How should your assistant respond?',{exact:true}).fill('Be clear and ask when requirements are unclear.');await instructionDialog.getByRole('button',{name:'Save instructions',exact:true}).click();
 await instructionDialog.getByRole('alert').filter({hasText:'Instructions changed in another window'}).waitFor();assert.equal(await instructionDialog.getByLabel('How should your assistant respond?',{exact:true}).inputValue(),'Be clear and ask when requirements are unclear.');assert.equal(instructions,'Updated from another window.');
 await instructionDialog.getByRole('button',{name:'Reload instructions',exact:true}).click();await instructionDialog.getByRole('status').filter({hasText:'Instructions reloaded.'}).waitFor();assert.equal(await instructionDialog.getByLabel('How should your assistant respond?',{exact:true}).inputValue(),'Be clear and ask when requirements are unclear.');
 await instructionDialog.getByRole('button',{name:'Save instructions',exact:true}).click();await instructionDialog.waitFor({state:'hidden'});await page.getByText('Instructions saved.',{exact:true}).waitFor();assert.equal(instructions,'Be clear and ask when requirements are unclear.');
 const memorySection=page.getByRole('region',{name:'Memory settings',exact:true}),memoryDialog=page.getByRole('dialog',{name:'Saved memories',exact:true}),addDialog=page.getByRole('dialog',{name:'Add memory',exact:true}),editDialog=page.getByRole('dialog',{name:'Edit memory',exact:true}),removeDialog=page.getByRole('dialog',{name:'Remove memory',exact:true}),clearDialog=page.getByRole('dialog',{name:'Clear saved memories',exact:true});
 await memorySection.getByRole('checkbox',{name:'Use saved memory',exact:true}).waitFor();assert.equal(await memoryDialog.count(),0);
 await page.screenshot({path:path.join(output,`settings-personalization-${width}.png`),fullPage:true,animations:'disabled'});
 await memorySection.getByRole('button',{name:'Manage memories',exact:true}).click();assert.equal(await memoryDialog.locator('form,textarea').count(),0,'The memory list has no inline editors');
 await memoryDialog.getByRole('button',{name:'Add memory',exact:true}).click();await addDialog.getByLabel('Add a memory',{exact:true}).fill('Use USD for costings.');await addDialog.getByRole('button',{name:'Add memory',exact:true}).click();
 await addDialog.getByRole('alert').filter({hasText:'Memory changed in another window'}).waitFor();assert.equal(await addDialog.getByLabel('Add a memory',{exact:true}).inputValue(),'Use USD for costings.');await addDialog.getByRole('button',{name:'Reload memories',exact:true}).click();await addDialog.getByRole('status').filter({hasText:'Memories reloaded.'}).waitFor();assert.equal(await addDialog.getByLabel('Add a memory',{exact:true}).inputValue(),'Use USD for costings.');
 await addDialog.getByRole('button',{name:'Add memory',exact:true}).click();await addDialog.waitFor({state:'hidden'});await memoryDialog.getByRole('status').filter({hasText:'Memory saved.'}).waitFor();
 await memoryDialog.locator('li').filter({hasText:'Use USD for costings.'}).getByRole('button',{name:/^Edit memory:/}).click();await editDialog.getByLabel('Edit memory',{exact:true}).fill('Use BDT for costings.');await page.screenshot({path:path.join(output,`memory-editor-${width}.png`),fullPage:true,animations:'disabled'});await editDialog.getByRole('button',{name:'Save memory',exact:true}).click();await editDialog.waitFor({state:'hidden'});await memoryDialog.getByRole('status').filter({hasText:'Memory updated.'}).waitFor();
 await memoryDialog.getByRole('searchbox',{name:'Search memories',exact:true}).fill('BDT');assert.equal(await memoryDialog.locator('li').count(),1);await memoryDialog.getByRole('searchbox',{name:'Search memories',exact:true}).fill('No match');await memoryDialog.getByText('No matching memories.',{exact:true}).waitFor();await memoryDialog.getByRole('searchbox',{name:'Search memories',exact:true}).fill('');
 await memoryDialog.getByRole('button',{name:'Add memory',exact:true}).click();await addDialog.getByLabel('Add a memory',{exact:true}).fill('Cancelled memory');await addDialog.press('Escape');await addDialog.waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.textContent.trim()==='Add memory');assert.equal(memory.entries.length,2);assert.equal(await memoryDialog.isVisible(),true);
 await memoryDialog.getByRole('button',{name:'Close saved memories',exact:true}).click();await memorySection.getByRole('checkbox',{name:'Use saved memory',exact:true}).click();await memorySection.getByRole('alert').filter({hasText:'Memory could not be updated.'}).waitFor();assert.equal(await memorySection.getByRole('checkbox',{name:'Use saved memory',exact:true}).isChecked(),true);
 await memorySection.getByRole('checkbox',{name:'Use saved memory',exact:true}).uncheck();await memorySection.getByRole('status').filter({hasText:'Memory is off.'}).waitFor();assert.equal(memory.entries.length,2);await memorySection.getByRole('button',{name:'Manage memories',exact:true}).click();assert.equal(await memoryDialog.getByRole('button',{name:'Add memory',exact:true}).isDisabled(),true);await memoryDialog.getByRole('button',{name:'Close saved memories',exact:true}).click();
 await memorySection.getByRole('checkbox',{name:'Use saved memory',exact:true}).check();await memorySection.getByRole('status').filter({hasText:'Memory is on'}).waitFor();await memorySection.getByRole('button',{name:'Manage memories',exact:true}).click();
 const removeMemory=memoryDialog.locator('li').filter({hasText:'Use BDT for costings.'}).getByRole('button',{name:/^Remove memory:/});await removeMemory.click();await removeDialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(memory.entries.length,2);await removeMemory.click();await removeDialog.getByRole('button',{name:'Remove memory',exact:true}).click();await removeDialog.waitFor({state:'hidden'});await memoryDialog.getByRole('status').filter({hasText:'Memory removed.'}).waitFor();
 await memoryDialog.getByRole('button',{name:'Clear all memories',exact:true}).click();await clearDialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(memory.entries.length,1);await page.screenshot({path:path.join(output,`memory-${width}.png`),fullPage:true,animations:'disabled'});
 await memoryDialog.getByRole('button',{name:'Clear all memories',exact:true}).click();await clearDialog.getByRole('button',{name:'Clear memories',exact:true}).click();await clearDialog.waitFor({state:'hidden'});await memoryDialog.getByRole('status').filter({hasText:'All saved memories cleared.'}).waitFor();assert.equal(memory.entries.length,0);await memoryDialog.press('Escape');await memoryDialog.waitFor({state:'hidden'});assert.equal(await page.locator('.office-user-settings #user-settings-panel').isVisible(),true);
 await nav('Account');const accountSection=page.getByRole('region',{name:'Account settings',exact:true}),nameDialog=page.getByRole('dialog',{name:'Edit name',exact:true});assert.equal(await accountSection.locator('form,input').count(),0,'Account editors are separate dialogs');
 await accountSection.getByRole('button',{name:'Edit name',exact:true}).click();await nameDialog.getByLabel('Name',{exact:true}).fill('Cancelled name');await nameDialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(profile.displayName,'Alex Morgan');
 await accountSection.getByRole('button',{name:'Edit name',exact:true}).click();await nameDialog.getByLabel('Name',{exact:true}).fill('Alex Review');await nameDialog.getByRole('button',{name:'Save name',exact:true}).click();await nameDialog.waitFor({state:'hidden'});await accountSection.getByRole('status').filter({hasText:'Profile saved.'}).waitFor();
 await accountSection.getByRole('button',{name:'Manage devices',exact:true}).click();const devicesDialog=page.getByRole('dialog',{name:'Signed-in devices',exact:true}),signOutDialog=page.getByRole('dialog',{name:'Sign out devices',exact:true});await devicesDialog.getByRole('button',{name:'Sign out other devices',exact:true}).click();await signOutDialog.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(signedIn.length,2);await devicesDialog.getByRole('button',{name:'Sign out other devices',exact:true}).click();await signOutDialog.getByRole('button',{name:'Sign out',exact:true}).click();await signOutDialog.waitFor({state:'hidden'});await devicesDialog.getByRole('status').filter({hasText:'Other devices signed out.'}).waitFor();await devicesDialog.getByRole('button',{name:'Close devices',exact:true}).click();
 await accountSection.getByRole('button',{name:'Change password',exact:true}).click();const passwordDialog=page.getByRole('dialog',{name:'Change password',exact:true});await passwordDialog.getByLabel('Current password',{exact:true}).fill('Cancelled password');await passwordDialog.getByRole('button',{name:'Cancel',exact:true}).click();await accountSection.getByRole('button',{name:'Change password',exact:true}).click();assert.equal(await passwordDialog.getByLabel('Current password',{exact:true}).inputValue(),'');await passwordDialog.getByLabel('Current password',{exact:true}).fill('old-password');await passwordDialog.getByLabel('New password',{exact:true}).fill('new-password');await passwordDialog.getByLabel('Confirm new password',{exact:true}).fill('mismatch-pass');await passwordDialog.getByRole('button',{name:'Change password',exact:true}).click();await passwordDialog.getByRole('alert').filter({hasText:'do not match'}).waitFor();await passwordDialog.getByLabel('Confirm new password',{exact:true}).fill('new-password');await passwordDialog.getByRole('button',{name:'Change password',exact:true}).click();await passwordDialog.waitFor({state:'hidden'});await accountSection.getByRole('status').filter({hasText:'Password changed.'}).waitFor();
 await page.screenshot({path:path.join(output,`settings-${width}.png`),fullPage:true,animations:'disabled'});
 await page.locator('.office-user-settings .settings-close').click();await page.locator('.overlay.open .office-user-settings').waitFor({state:'hidden'});await page.waitForFunction(()=>![...document.querySelectorAll('.overlay')].some(node=>Number(getComputedStyle(node).opacity)>0));
 assert.equal(await page.locator('.cli-account-footer').count(),0);
 assert.equal(await page.locator('.cli-conversation-header').innerText().then(text=>/Started by|Running by/.test(text)),false);
 assert.deepEqual(errors,[]);await page.screenshot({path:path.join(output,`complete-${width}.png`),fullPage:true,animations:'disabled'});
 await page.evaluate(()=>window.__olderProject());
 if(width<760&&await page.getByRole('button',{name:'Show sessions sidebar',exact:true}).isVisible())await page.getByRole('button',{name:'Show sessions sidebar',exact:true}).click();
 await page.getByRole('button',{name:'New chat',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="Project"]')?.getAttribute('data-value')==='');
 assert.equal(await page.locator('.cli-session-messages').count(),0,'A new general chat has no older transcript');assert.equal(await page.getByRole('button',{name:'Show workspace tools',exact:true}).count(),0);assert.equal(await page.locator('.corporate-home-card').count(),0);await page.screenshot({path:path.join(output,`home-${width}.png`),fullPage:true,animations:'disabled'});
 console.log(JSON.stringify({width,elapsedMs:Date.now()-start,privateProfile:true,queue:true,reloadPreserved:true,technicalDetailsHidden:true,errors:0}));await context.close();
}
 if(!process.argv.includes('--composer-changes')){
 const context=await browser.newContext({viewport:{width:1440,height:960},serviceWorkers:'block'}),page=await context.newPage();
 const master={...state,office:{...office,id:'master',role:'unrestricted-admin'},connectedPeers:[{id:'local',name:'This PC',connected:true,local:true}],settings:{...raw.settings,cliIntegrationEnabled:true,systemInfoEnabled:false}};
 const masterHost=mockHost.replace("document.documentElement.dataset.dashboardUser='fixture-alex';",'delete document.documentElement.dataset.dashboardUser;').replace(JSON.stringify(state),JSON.stringify(master)).replace("else if(message.action==='getCodexSkills')", "else if(message.action==='listWorkspaceTerminals')payload={workspaceTerminals:[]};else if(message.action==='getCodexSkills')");
 await useWorkspaceDashboardAssets(page,origin,context);await context.route('**/assets/browserHost.js*',route=>route.fulfill({contentType:'text/javascript',body:masterHost}));
 await emailUiFixture(context);
 await page.goto(origin+'/workspace');await page.getByRole('button',{name:'Dashboard',exact:true}).waitFor();
 assert.equal(await page.getByRole('combobox',{name:'System',exact:true}).count(),1);assert.equal(await page.locator('.team-user-footer').count(),0);
 assert.equal(await page.locator('.cli-task-nav').count(),1);
 assert.equal(await page.locator('.cli-task-nav').textContent(),'Kanban');
 if(process.argv.includes('--email')){
  await page.getByRole('button',{name:'Account menu',exact:true}).click();await page.getByRole('menuitem',{name:'Settings',exact:true}).click();
  const email=page.getByRole('region',{name:'Email notifications',exact:true});await email.locator('summary').filter({hasText:'SMTP configuration'}).click();
  await email.getByLabel('SMTP host',{exact:true}).fill('smtp.changed.example.test');await email.getByLabel('Sender email',{exact:true}).fill('alerts@example.test');await email.getByRole('button',{name:'Save SMTP settings',exact:true}).click();await email.getByRole('status').filter({hasText:'SMTP settings saved.'}).waitFor();
  assert.equal(await email.getByLabel('SMTP password or app password',{exact:true}).inputValue(),'');
  await page.screenshot({path:path.join(output,'email-smtp-master.png'),fullPage:true});
  await page.setViewportSize({width:360,height:740});await email.getByLabel('SMTP host',{exact:true}).scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));await page.screenshot({path:path.join(output,'email-smtp-master-mobile.png'),fullPage:true});
  await page.getByRole('dialog',{name:'Settings',exact:true}).getByRole('button',{name:raw.copy.closeModal,exact:true}).click();await page.setViewportSize({width:1440,height:960});
  console.log(JSON.stringify({masterSmtpForm:true,savedPasswordMasked:true,mobileSettingsFit:true}));
 }
 await page.evaluate(activities=>localStorage.setItem('private-workspace-fixture',JSON.stringify({session:{id:'12345678-1234-1234-1234-123456789abc',title:'Master session',status:'idle',projectPath:'C:/team/alex'},messages:[{id:'user',role:'user',text:'Check files'},...activities,{id:'answer',role:'assistant',text:'Master response ready.'}]})),activities);
 await page.reload();await page.getByRole('button',{name:/^Master session/}).click();await page.getByText('Master response ready.',{exact:true}).waitFor();
 if(process.argv.includes('--email')){
  assert.equal(await page.locator('.cli-conversation-header').getByRole('button',{name:'Email me when ready',exact:true}).count(),0);
  await page.getByRole('button',{name:'Session actions',exact:true}).click();await page.getByRole('menuitemcheckbox',{name:/^Email me when ready/}).waitFor();
  await page.screenshot({path:path.join(output,'email-menu-master.png'),fullPage:true});await page.getByRole('button',{name:'Session actions',exact:true}).click();
 }
 const masterTranscript=await page.locator('.cli-session-messages').textContent();
 await page.locator('.session-plan-count').filter({hasText:'3 of 3 complete'}).waitFor();
 assert.match(masterTranscript,/C:\\Windows\\System32\\WindowsPowerShell/);assert.match(masterTranscript,/C:\/team\/alex\/output\/commit.cjs/);assert.match(masterTranscript,/Update|Edited/);
 await page.setViewportSize({width:360,height:640});await page.evaluate(()=>window.__setQuestion(true));
 const masterQuestion=page.getByRole('dialog',{name:'Codex has a question',exact:true});await masterQuestion.waitFor();
 const masterSend=await masterQuestion.getByRole('button',{name:'Send answer',exact:true}).boundingBox();assert.ok(masterSend&&masterSend.y>=0&&masterSend.y+masterSend.height<=640);
 await page.screenshot({path:path.join(output,'master-question-mobile.png'),fullPage:true,animations:'disabled'});await masterQuestion.getByRole('button',{name:'Cancel',exact:true}).click();
 console.log(JSON.stringify({masterDashboardControlsPreserved:true,masterQuestionMobile:true}));await context.close();
 }
}finally{await browser.close();}
console.log('Screenshots: '+output);
