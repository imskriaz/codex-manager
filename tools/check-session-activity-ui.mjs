import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright';
import {useWorkspaceDashboardAssets} from './workspace-dashboard-assets.mjs';

const origin='http://127.0.0.1:39875',raw=await(await fetch(origin+'/api/state')).json();
const id='12345678-1234-1234-1234-123456789abc';
const output=path.join(os.tmpdir(),'codex-manager-session-activities');await mkdir(output,{recursive:true});
const plan={steps:[{step:'Read requirements',status:'completed'},{step:'Make changes',status:'inProgress'},{step:'Check results',status:'pending'}]};
const messages=[
 {id:'user',role:'user',text:'Show my task progress'},
 {id:'thinking',kind:'reasoning',text:'Requirements reviewed.',status:'completed'},
 {id:'plan',kind:'plan',text:'Task checklist',arguments:JSON.stringify(plan),status:'unknown'},
 {id:'command',kind:'command',command:'npm test',text:'Run checks',output:'One check needs attention.',status:'failed'},
 {id:'tool',kind:'tool-call',title:'Read file',text:'Read the document',arguments:'{"path":"notes.txt"}',result:'Document contents',status:'completed'},
 {id:'save',kind:'tool-call',title:'Update file',text:'Update file',arguments:JSON.stringify({path:'index.html',content:'<html>raw-file-content</html>'.repeat(300)}),result:JSON.stringify({type:'dashboard:action-result',status:'completed',payload:{workspaceFile:{path:'index.html',content:'<html>raw-file-content</html>'.repeat(300),revision:'private-revision',mimeType:'text/html'},notice:{message:'File created.'}}}),status:'completed'},
 {id:'files',kind:'file-change',text:'Edited files',changes:[{path:'notes.txt',kind:'update',diff:'-before\n+after'}],status:'completed'},
 {id:'agent',kind:'collaboration',title:'Helper contribution',text:'Reviewed the draft.',status:'completed'},
 {id:'search',kind:'web-search',text:'Public documentation',result:'A useful reference.',status:'completed'},
 {id:'image',kind:'image',text:'Preview image',images:[{src:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGJcAAAAASUVORK5CYII=',alt:'Activity preview'}],status:'completed'},
 {id:'review',kind:'review',text:'The draft is clear.',status:'completed'},
 {id:'compact',kind:'compaction',text:'Earlier context summarized.',status:'completed'},
 {id:'error',kind:'error',text:'One action could not finish. Please try again.',status:'failed'},
 {id:'question',role:'assistant',text:'I need your preference.',questions:[{title:'Which format?',options:['Document','Checklist']}],timestamp:'2020-01-01T00:00:00.000Z'},
 {id:'answer',role:'assistant',text:'Your progress is saved.\n\n[Open page](index%20page.html) · [Download page](index%20page.html?download=1)'},
];
const browser=await chromium.launch({channel:'msedge',headless:true});
try{for(const user of [true,false])for(const width of [1440,390,360]){
 const office={id:'fixture',username:'alex@example.test',displayName:'Alex',role:user?'user':'unrestricted-admin',features:['generalChat','tasks','files','browser','env'],defaultPrompt:'',workspacePath:'',mcpServers:[]};
 const state={...raw,office,accounts:[],connectedPeers:[{id:'local',name:'This PC',local:true,connected:true}],peerAccounts:{},onboardingCompleted:true,settings:{...raw.settings,dashboardTheme:width<760?'dark':'light',cliIntegrationEnabled:true,teamWorkspaceEnabled:true,systemInfoEnabled:false}};
 const session={id,title:'Activity audit',status:'idle',model:'fast',projectPath:'C:/fixture/alex',updatedAt:new Date().toISOString()};
 const host=`(()=>{${user?"document.documentElement.dataset.dashboardUser='fixture';":"delete document.documentElement.dataset.dashboardUser;"}
 const state=${JSON.stringify(state)},session=${JSON.stringify(session)},messages=${JSON.stringify(messages)};
 const dispatch=data=>window.dispatchEvent(new MessageEvent('message',{data:structuredClone(data)}));window.__auditActions=[];
 window.__auditPush=message=>{if(message)messages.push(message);dispatch({type:'dashboard:codex-session-live',state:{sessionId:session.id,streamId:session.id,sequence:Date.now(),status:'completed',updatedAt:Date.now(),messages}});};
 window.__auditFile=path=>window.__auditPush({id:crypto.randomUUID(),kind:'file-change',text:'File saved.',status:'completed',changes:[{path,kind:'update'}]});
 window.__auditQuestion=()=>window.__auditPush({id:'priority-question',role:'assistant',text:'Choose where to keep the result.',timestamp:new Date().toISOString(),questions:[{title:'Which destination?',options:['Workspace','Download']}]});
 window.__auditPlan=()=>{const item=messages.findLast(message=>message.kind==='plan');const plan=JSON.parse(item.arguments);plan.steps[1].status='completed';item.arguments=JSON.stringify(plan);window.__auditPush();};
 window.acquireVsCodeApi=()=>({getState(){return{};},setState(){},postMessage(message){window.__auditActions.push(message);setTimeout(()=>{
 if(message.type==='dashboard:ready'||message.type==='dashboard:workspace-presence'){dispatch({type:'dashboard:snapshot',state});dispatch({type:'dashboard:connection',connected:true});return;}if(message.type!=='dashboard:action')return;
 let payload={};if(message.action==='listCodexCliSessions')payload={cliSessions:[session],cliComposerConfig:{defaultModel:'fast',models:[{id:'fast',label:'Fast',reasoningEfforts:[]}],projects:[{id:'personal',label:'My workspace',path:session.projectPath}],terminalSupported:false}};
 if(message.action==='getCodexCliSessionMessages')payload={cliSession:session,cliSessionMessages:messages};
 if(message.action==='workspaceBrowser')payload={workspaceBrowser:{pages:[],feedback:[]}};
 if(message.action==='listWorkspaceFiles')payload={workspaceFiles:[]};
 if(message.action==='readWorkspaceFile'){
  const path=message.payload.filePath,content='<h1>Workspace preview</h1><p>Saved deliverable</p>';
  payload=message.payload.fileDownloadOffset!==undefined?{workspaceFileDownload:{path,revision:'r1',offset:0,size:content.length,data:btoa(content)}}:{workspaceFile:{path,kind:path.endsWith('.png')?'image':path.endsWith('.docx')?'document':'text',language:'html',content,mimeType:path.endsWith('.png')?'image/png':'text/html',revision:'r1',size:content.length,dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGJcAAAAASUVORK5CYII='}};
 }
 if(message.action==='getWorkspaceEnvironment')payload={workspaceEnvironment:{projectPath:session.projectPath,projectName:'My workspace',isGitRepository:false,changes:0,additions:0,deletions:0,ahead:0,behind:0,hasRemote:false}};
 if(['sendCodexCliSessionMessage','steerCodexCliSessionTurn'].includes(message.action)){messages.push({id:crypto.randomUUID(),role:'user',text:message.payload.text});payload={cliSession:session,cliSessions:[session],cliSessionMessages:messages,notice:{level:'info',message:'Answer accepted.'}};}
 dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'completed',payload});},10);}});})();`;
 // The fixture does not load workers; Playwright's worker blocker throws in sandboxed previews.
 const context=await browser.newContext({viewport:{width,height:width===360?674:960},isMobile:width<760,hasTouch:width<760,deviceScaleFactor:width<760?2:1}),page=await context.newPage();page.setDefaultTimeout(15000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 await useWorkspaceDashboardAssets(page,origin,context);await context.route('**/assets/browserHost.js*',route=>route.fulfill({contentType:'text/javascript',body:host}));
 await context.route('**/api/workspace/preview?*',route=>route.fulfill({contentType:'text/html',headers:{'X-Frame-Options':'SAMEORIGIN','Content-Security-Policy':"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors 'self'"},body:`<h1>Workspace preview</h1><button onclick="this.textContent='Clicked'">Test interaction</button>`}));
 const start=performance.now();await page.goto(origin+'/workspace/'+id);await page.getByText('Your progress is saved.',{exact:false}).waitFor();
 await page.locator('.session-plan-count').filter({hasText:'1 of 3 complete · Paused'}).waitFor();
 assert.equal(await page.locator('.cli-session-messages details[open], .cli-composer-plan details[open]').count(),0,'Activity blocks and plans start collapsed in both areas');
 await page.evaluate(()=>document.querySelectorAll('.cli-session-messages details').forEach(node=>{node.open=true;}));
 await page.evaluate(()=>window.__auditPush());await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.locator('.cli-activity.is-reasoning').evaluate(node=>node.open),true,'A live update preserves manual expansion');
 for(const kind of ['reasoning','command','tool-call','collaboration','web-search','image','review','compaction'])assert.ok(await page.locator('.cli-activity.is-'+kind).count(),kind+' is rendered');
 assert.ok(await page.locator('.cli-file-change-list').count());assert.ok(await page.locator('.cli-error-notice').count());
 assert.ok(await page.locator('.cli-activity-group-details > summary .is-failed').count(),'A failed command cannot produce a success group badge');
 await page.locator('.cli-question-message').getByRole('button',{name:'Answer',exact:true}).click();
 await page.getByRole('radio',{name:'Document',exact:true}).check();await page.getByRole('button',{name:'Send answer',exact:true}).waitFor({state:'visible'});
 assert.equal(await page.getByRole('button',{name:'Send answer',exact:true}).isEnabled(),true);
 if(user){const text=await page.evaluate(()=>[document.body.innerText,...[...document.querySelectorAll('[aria-label]')].filter(node=>node.getClientRects().length).map(node=>node.getAttribute('aria-label'))].join('\n'));assert.doesNotMatch(text,/Codex|C:[\\/]|sandbox|provider|raw-file-content|private-revision|mimeType|Debug details/);const tools=(await page.locator('.cli-activity.is-tool-call').allTextContents()).join('\n');assert.match(tools,/File created\./);assert.doesNotMatch(tools,/raw-file-content|private-revision|mimeType/);}
 else assert.match((await page.locator('.cli-activity.is-tool-call').allTextContents()).join('\n'),/private-revision/);
 if(user){
  const layout=await page.evaluate(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect();const c=rect('.cli-composer'),m=rect('.user-model-picker'),s=rect('.cli-send-button');return {gap:innerHeight-c.bottom,alignment:Math.abs((m.top+m.bottom-s.top-s.bottom)/2),modelHeight:m.height,sendHeight:s.height};});
  assert.ok(layout.gap>=0&&layout.gap<=10,JSON.stringify(layout));assert.ok(layout.alignment<=1,JSON.stringify(layout));assert.equal(layout.modelHeight,layout.sendHeight);
 }
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));assert.deepEqual(errors,[]);
 await page.screenshot({path:path.join(output,`${user?'user':'master'}-${width}.png`),fullPage:true});
 await page.getByRole('button',{name:'Send answer',exact:true}).click();await page.waitForFunction(()=>window.__auditActions.some(message=>['sendCodexCliSessionMessage','steerCodexCliSessionTurn'].includes(message.action)&&message.payload.text.includes('Document')));
 if(user){
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Download page',exact:true}).click()]);assert.equal(download.suggestedFilename(),'index page.html');
  await page.evaluate(()=>window.__auditFile('preview.html'));
  await page.locator('iframe[title="Website preview.html"]').waitFor({state:'visible'});
  assert.equal(await page.locator('iframe[title="Website preview.html"]').getAttribute('sandbox'),'allow-scripts');
  assert.equal(await page.getByRole('tab',{name:'Browser',exact:true}).getAttribute('aria-selected'),'true');
  try { await page.frameLocator('iframe[title="Website preview.html"]').getByRole('button',{name:'Test interaction'}).click(); } catch(error) { console.log(JSON.stringify({errors,frames:page.frames().map(frame=>frame.url())})); throw error; }
  await page.frameLocator('iframe[title="Website preview.html"]').getByRole('button',{name:'Clicked'}).waitFor();
  const preview=await(await page.locator('iframe[title="Website preview.html"]').elementHandle()).contentFrame();
  assert.equal(await preview.evaluate(()=>{try{return !!parent.document.body;}catch{return false;}}),false,'Website scripts cannot access the dashboard');
  await preview.evaluate(()=>parent.postMessage({type:'dashboard:notice',level:'error',message:'Preview impersonation sentinel'},'*'));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.getByText('Preview impersonation sentinel',{exact:true}).count(),0);
  await page.screenshot({path:path.join(output,`user-preview-${width}.png`),fullPage:true});
  await page.evaluate(()=>window.__auditFile('picture.png'));await page.locator('.cli-file-image-preview img').waitFor({state:'visible'});
  await page.evaluate(()=>window.__auditFile('report.docx'));await page.locator('iframe[title="Preview report.docx"]').waitFor({state:'visible'});
  await page.locator('.cli-context-tab-scroll').getByRole('tab',{name:'preview.html',exact:true}).click();
  await page.getByRole('button',{name:'Edit HTML',exact:true}).click();
  await page.locator('.cm-content[contenteditable="true"]').fill('My unsaved draft');
  await page.evaluate(()=>window.__auditFile('later.html'));
  await page.getByText('Updated files are available in Files. Your unsaved edits are still open.',{exact:true}).waitFor();
  assert.equal(await page.locator('.cm-content[contenteditable="true"]').innerText(),'My unsaved draft');
  await page.getByRole('button',{name:'Hide workspace tools',exact:true}).click();
  await page.evaluate(()=>window.__auditPush({id:'active-plan',kind:'plan',text:'Task checklist',status:'inProgress',arguments:JSON.stringify({steps:[{step:'Read requirements',status:'completed'},{step:'Make changes',status:'inProgress'},{step:'Check results',status:'pending'}]})}));
  const plan=page.locator('.cli-composer-plan .session-plan');
  if(!await plan.evaluate(node=>node.open))await plan.locator('summary').click();
  const row=await plan.locator('li').first().boundingBox();assert.ok(row.height<=24,'Plan rows stay compact');
  assert.equal(await plan.locator('.session-plan-marker > svg').count(),3);
  await page.evaluate(()=>window.__auditQuestion());
  const question=page.getByRole('region',{name:'Current question',exact:true});
  await question.getByRole('radio',{name:'Workspace',exact:true}).check();
  await question.getByText('Choose where to keep the result.',{exact:true}).waitFor();
  assert.equal(await plan.evaluate(node=>node.open),false);
  const layout=await page.evaluate(()=>({question:document.querySelector('.cli-composer-question').getBoundingClientRect().bottom,plan:document.querySelector('.cli-composer-plan').getBoundingClientRect().top,height:document.querySelector('.cli-composer-plan').getBoundingClientRect().height}));
  assert.ok(layout.question<=layout.plan&&layout.height<=40,JSON.stringify(layout));
  const button=await question.getByRole('button',{name:'Send answer',exact:true}).boundingBox();assert.ok(button.y+button.height<=layout.question+1,'Answer action stays above the plan');
  assert.doesNotMatch(await page.locator('.cli-session-messages').innerText(),/Which destination\?/);
  await page.evaluate(()=>window.__auditPlan());
  await page.locator('.session-plan-count').filter({hasText:'2 of 3 complete'}).waitFor();
  assert.equal(await question.getByRole('radio',{name:'Workspace',exact:true}).isChecked(),true);
  await page.screenshot({path:path.join(output,`user-question-${width}.png`),fullPage:true});
  await question.getByRole('button',{name:'Send answer',exact:true}).click();await question.waitFor({state:'detached'});
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({user,width,activityFamilies:13,questionAnswer:true,elapsedMs:Math.round(performance.now()-start),errors:0}));await context.close();
}}finally{await browser.close();}
console.log('Screenshots: '+output);
