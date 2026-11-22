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
 {id:'files',kind:'file-change',text:'Edited files',changes:[{path:'notes.txt',kind:'update',diff:'-before\n+after'}],status:'completed'},
 {id:'agent',kind:'collaboration',title:'Helper contribution',text:'Reviewed the draft.',status:'completed'},
 {id:'search',kind:'web-search',text:'Public documentation',result:'A useful reference.',status:'completed'},
 {id:'image',kind:'image',text:'Preview image',images:[{src:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGJcAAAAASUVORK5CYII=',alt:'Activity preview'}],status:'completed'},
 {id:'review',kind:'review',text:'The draft is clear.',status:'completed'},
 {id:'compact',kind:'compaction',text:'Earlier context summarized.',status:'completed'},
 {id:'error',kind:'error',text:'One action could not finish. Please try again.',status:'failed'},
 {id:'question',role:'assistant',text:'I need your preference.',questions:[{title:'Which format?',options:['Document','Checklist']}],timestamp:'2020-01-01T00:00:00.000Z'},
 {id:'answer',role:'assistant',text:'Your progress is saved.'},
];
const browser=await chromium.launch({channel:'msedge',headless:true});
try{for(const user of [true,false])for(const width of [1440,390]){
 const office={id:'fixture',username:'alex@example.test',displayName:'Alex',role:user?'user':'unrestricted-admin',features:['generalChat','tasks','files','env'],defaultPrompt:'',workspacePath:'',mcpServers:[]};
 const state={...raw,office,accounts:[],connectedPeers:[{id:'local',name:'This PC',local:true,connected:true}],peerAccounts:{},onboardingCompleted:true,settings:{...raw.settings,dashboardTheme:'light',cliIntegrationEnabled:true,teamWorkspaceEnabled:true,systemInfoEnabled:false}};
 const session={id,title:'Activity audit',status:'idle',model:'fast',projectPath:'C:/fixture/alex',updatedAt:new Date().toISOString()};
 const host=`(()=>{${user?"document.documentElement.dataset.dashboardUser='fixture';":"delete document.documentElement.dataset.dashboardUser;"}
 const state=${JSON.stringify(state)},session=${JSON.stringify(session)},messages=${JSON.stringify(messages)};
 const dispatch=data=>window.dispatchEvent(new MessageEvent('message',{data:structuredClone(data)}));window.__auditActions=[];
 window.acquireVsCodeApi=()=>({getState(){return{};},setState(){},postMessage(message){window.__auditActions.push(message);setTimeout(()=>{
 if(message.type==='dashboard:ready'||message.type==='dashboard:workspace-presence'){dispatch({type:'dashboard:snapshot',state});dispatch({type:'dashboard:connection',connected:true});return;}if(message.type!=='dashboard:action')return;
 let payload={};if(message.action==='listCodexCliSessions')payload={cliSessions:[session],cliComposerConfig:{defaultModel:'fast',models:[{id:'fast',label:'Fast',reasoningEfforts:[]}],projects:[{id:'personal',label:'My workspace',path:session.projectPath}],terminalSupported:false}};
 if(message.action==='getCodexCliSessionMessages')payload={cliSession:session,cliSessionMessages:messages};
 if(message.action==='getWorkspaceEnvironment')payload={workspaceEnvironment:{projectPath:session.projectPath,projectName:'My workspace',isGitRepository:false,changes:0,additions:0,deletions:0,ahead:0,behind:0,hasRemote:false}};
 if(['sendCodexCliSessionMessage','steerCodexCliSessionTurn'].includes(message.action))payload={cliSession:session,cliSessions:[session],notice:{level:'info',message:'Answer accepted.'}};
 dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'completed',payload});},10);}});})();`;
 const context=await browser.newContext({viewport:{width,height:960},serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(15000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 await useWorkspaceDashboardAssets(page,origin,context);await context.route('**/assets/browserHost.js*',route=>route.fulfill({contentType:'text/javascript',body:host}));
 const start=performance.now();await page.goto(origin+'/workspace/'+id);await page.getByText('Your progress is saved.',{exact:true}).waitFor();
 await page.locator('.session-plan-count').filter({hasText:'1 of 3 complete · Paused'}).waitFor();
 await page.evaluate(()=>document.querySelectorAll('.cli-session-messages details').forEach(node=>{node.open=true;}));
 for(const kind of ['reasoning','command','tool-call','collaboration','web-search','image','review','compaction'])assert.ok(await page.locator('.cli-activity.is-'+kind).count(),kind+' is rendered');
 assert.ok(await page.locator('.cli-file-change-list').count());assert.ok(await page.locator('.cli-error-notice').count());
 assert.ok(await page.locator('.cli-activity-group-details > summary .is-failed').count(),'A failed command cannot produce a success group badge');
 await page.locator('.cli-question-message').getByRole('button',{name:'Answer',exact:true}).click();
 await page.getByRole('radio',{name:'Document',exact:true}).check();await page.getByRole('button',{name:'Send answer',exact:true}).waitFor({state:'visible'});
 assert.equal(await page.getByRole('button',{name:'Send answer',exact:true}).isEnabled(),true);
 if(user){const text=await page.evaluate(()=>[document.body.innerText,...[...document.querySelectorAll('[aria-label]')].filter(node=>node.getClientRects().length).map(node=>node.getAttribute('aria-label'))].join('\n'));assert.doesNotMatch(text,/Codex|C:[\\/]|sandbox|provider/i);}
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));assert.deepEqual(errors,[]);
 await page.screenshot({path:path.join(output,`${user?'user':'master'}-${width}.png`),fullPage:true});
 await page.getByRole('button',{name:'Send answer',exact:true}).click();await page.waitForFunction(()=>window.__auditActions.some(message=>['sendCodexCliSessionMessage','steerCodexCliSessionTurn'].includes(message.action)&&message.payload.text.includes('Document')));
 console.log(JSON.stringify({user,width,activityFamilies:13,questionAnswer:true,elapsedMs:Math.round(performance.now()-start),errors:0}));await context.close();
}}finally{await browser.close();}
console.log('Screenshots: '+output);
