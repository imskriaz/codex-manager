import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

// Real components with in-memory responses; the local host receives no mutations.
const origin='http://127.0.0.1:39875',output=path.join(tmpdir(),'codex-manager-workspace-tabs-ui');await mkdir(output,{recursive:true});
const bundle=await build({stdin:{loader:'tsx',resolveDir:process.cwd(),contents:`
import {render} from 'preact';import {useState} from 'preact/hooks';
import {WorkspaceGit} from './webview-src/dashboard/workspaceGit';
import {BrowserInspectorContent} from './webview-src/dashboard/workspaceBrowserInspector';
import {TaskBoard} from './webview-src/dashboard/taskBoard';
const noop=()=>{}, task={id:'fixture-task',title:'Fixture task',prompt:'Read only',stage:'planned',revision:1,createdAt:1,updatedAt:1};
const board={projectPath:'C:/fixture',tasks:[task],comments:[],sessions:[],updatedAt:1};
const environment={projectPath:'C:/fixture',projectName:'Fixture',isGitRepository:true,branch:'main',changedFiles:[],changes:0,additions:0,deletions:0,hasRemote:false,hasOriginRemote:false,gitHistory:{commits:[],hasMore:false,offset:0}};
window.__gitFixture={blocked:true, actions:[], authStatus:'waiting'};
window.__fixturePostMessage=(message)=>{
  setTimeout(()=>{
    const fixture=window.__gitFixture;
    const result={type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'completed',payload:{}};
    if(message.action==='workspaceGit'){
      const {operation,remote}=message.payload.gitRequest;
      fixture.actions.push(operation);
      let auth,output;
      if(operation==='read'&&fixture.blocked){
        result.status='failed';
        result.error="fatal: detected dubious ownership in repository at 'C:/fixture'";
      } else if(operation==='addRemote'&&remote==='https://github.com/example/repo.git'){
        environment.hasRemote=environment.hasOriginRemote=true;
        output='GitHub remote added.';
      } else if(operation==='authStart'){
        auth={status:'waiting',code:'TEST-CODE'};
      } else if(operation==='authStatus'){
        auth=fixture.authStatus==='completed'?{status:'completed',message:'GitHub HTTPS is authorized on the selected system.'}:{status:'waiting',code:'TEST-CODE'};
      } else if(operation==='authCancel'){
        auth={status:'cancelled',message:'GitHub authorization cancelled.'};
      }
      result.payload={workspaceGit:{revision:'r1',branch:'main',head:'abc',branches:[],stashes:[],environment,output,auth}};
    }
    if(message.action==='getWorkspaceEnvironment')result.payload={workspaceEnvironment:environment};
    if(message.action==='workspaceGitHub'){
      fixture.actions.push('github');
      const item={id:1,number:1,title:'Fixture item',state:'open',url:'https://example.test/item',author:'Fixture',body:'Description'};
      result.payload={workspaceGitHub:{repository:'example/repo',authenticated:false,canWrite:false,items:[item],page:1,hasMore:false,...(message.payload.githubRequest.operation==='detail'?{detail:item,comments:[],files:[],checks:[]}:{}),workflows:[]}};
    }
    dispatchEvent(new MessageEvent('message',{data:result}));
  },5);
};
const events=[{method:'Network.requestWillBeSent',sequence:1,params:{requestId:'r',type:'Fetch',request:{url:'https://example.test/report',method:'GET',headers:{}}}},{method:'Network.responseReceived',sequence:2,params:{requestId:'r',response:{status:200,mimeType:'application/json',headers:{}}}}];
async function inspect(_action,payload){const op=payload.browserRequest.operation;return {workspaceBrowser:{pages:[],feedback:[],resources:[{url:'https://example.test/app.js',type:'Script'}],events,eventSequence:2,value:op==='storage'?{origin:'https://example.test',cookies:[],localStorage:{demo:'value'},sessionStorage:{},indexedDB:[],cacheStorage:[],serviceWorkers:[]}:op==='styles'?{rules:[],computed:[],listeners:[]}:op==='html'?{body:'{}'}:{}}};}
function App(){const [surface,setSurface]=useState('git'),[panel,setPanel]=useState('elements');return <><select aria-label="Fixture surface" value={surface} onChange={event=>setSurface(event.currentTarget.value)}><option value="git">Git</option><option value="inspector">Inspector</option><option value="tasks">Tasks</option></select>{surface==='git'?<WorkspaceGit projectPath="C:/fixture" connected draft="" onDraft={noop} onPending={noop} onFeedback={noop} onOpenFile={noop} renderDiff={text=><pre>{text}</pre>}/>:surface==='tasks'?<TaskBoard sessions={[]} projects={[{path:'C:/fixture',label:'Fixture'}]} connected shared={{draftKey:'mobile-fixture',board,permissions:['activities','files','changes'],request:async(action)=>action==='getProjectBoard'?{projectBoard:board}:{projectTaskDetails:{task,taskId:task.id,messages:[],files:[],history:[],warnings:[]}}}} sendAction={noop} onOpenSession={noop}/>:<><select aria-label="Fixture inspector panel" value={panel} onChange={event=>setPanel(event.currentTarget.value)}>{['elements','sources','network','application'].map(value=><option>{value}</option>)}</select><div class="workspace-browser-inspector is-open" style={{position:'static',width:'100%',height:'650px'}}><BrowserInspectorContent key={panel} panel={panel} pageId="fixture" connected busy={false} request={inspect} onCommand={noop} onClearConsole={noop} onEvaluate={noop}/></div></>}</>;}render(<App/>,document.getElementById('app'));
`},bundle:true,write:false,format:'esm',loader:{'.css':'text'},jsx:'automatic',jsxImportSource:'preact'});
const browser=await chromium.launch({channel:process.env.CODEX_MANAGER_UI_BROWSER==='bundled'?undefined:'msedge',headless:true});
try{for(const width of [1440,390,320]){
 const page=await browser.newPage({viewport:{width,height:1000},serviceWorkers:'block'});await page.addInitScript(()=>{window.acquireVsCodeApi=()=>({postMessage:message=>window.__fixturePostMessage(message)});});page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route(origin+'/__section-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html data-theme="dark"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="/__section-fixture.js"></script></html>'}));
 await page.route(origin+'/__section-fixture.js',route=>route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text}));
 await page.goto(origin+'/__section-fixture');for(const name of ['shared.css','quotaSummary.css'])await page.addStyleTag({content:await readFile('media/webview/'+name,'utf8')});
 await page.addStyleTag({content:'body{height:auto;overflow:auto;margin:0;padding:8px}#app{height:900px;min-width:0}.workspace-git{height:850px}'});
 const choose=async(label,value,tab)=>{const picker=page.getByRole('combobox',{name:label,exact:true});assert.equal(await picker.isVisible(),width<=760);if(width<=760){await picker.selectOption(value);assert.equal(await picker.inputValue(),value);}else await page.getByRole('tab',{name:tab,exact:true}).click();};
 const gitStarted=performance.now();
 await page.getByText('Git blocked this repository',{exact:true}).waitFor();
 await page.getByRole('alert').filter({hasText:'detected dubious ownership'}).waitFor();
 await page.screenshot({path:path.join(output,'git-ownership-'+width+'.png')});
 await page.evaluate(()=>{window.__gitFixture.blocked=false;});
 await page.getByRole('button',{name:'Refresh Git',exact:true}).click();
 await page.getByRole('textbox',{name:'Commit message'}).waitFor();
 const menu=page.getByRole('button',{name:'Repository actions',exact:true});
 await menu.click();
 await page.getByRole('button',{name:'Add GitHub remote',exact:true}).click();
 const remoteDialog=page.getByRole('dialog',{name:'Add GitHub remote',exact:true});
 await remoteDialog.getByRole('textbox',{name:'GitHub remote URL'}).fill('https://github.com/example/repo.git');
 await remoteDialog.getByRole('button',{name:'Add remote',exact:true}).click();
 await page.getByRole('status',{name:'Git output'}).filter({hasText:'GitHub remote added.'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.__gitFixture.actions),['read','read','addRemote']);
 const startAuth=async()=>{
   await menu.click();
   await page.getByRole('button',{name:'Authorize GitHub HTTPS',exact:true}).click();
   const dialog=page.getByRole('dialog',{name:'Authorize GitHub HTTPS',exact:true});
   await dialog.getByText('TEST-CODE',{exact:true}).waitFor();
   assert.equal(await dialog.getByRole('link',{name:'Open GitHub device verification'}).getAttribute('href'),'https://github.com/login/device');
   return dialog;
 };
 let authDialog=await startAuth();
 await page.screenshot({path:path.join(output,'git-authorization-'+width+'.png')});
 await authDialog.getByRole('button',{name:'Cancel',exact:true}).click();
 await authDialog.getByText('GitHub authorization cancelled.',{exact:true}).waitFor();
 await authDialog.getByRole('button',{name:'Close',exact:true}).click();
 authDialog=await startAuth();
 await page.evaluate(()=>{window.__gitFixture.authStatus='completed';});
 await authDialog.getByText('GitHub HTTPS is authorized on the selected system.',{exact:true}).waitFor();
 await authDialog.getByRole('button',{name:'Close',exact:true}).click();
 console.log(JSON.stringify({width,ownershipGuidance:true,anonymousRemoteSetup:true,deviceAuthorization:true,elapsedMs:Math.round(performance.now()-gitStarted)}));
 await choose('Git view','history','History');await choose('Git view','branches','Branches');await choose('Git view','github','GitHub');
 await choose('GitHub section','issues','Issues');await choose('GitHub section','pulls','Pull requests');await page.getByRole('button',{name:/Fixture item/}).first().click();await choose('GitHub item section','files','Files');await choose('GitHub item section','checks','Checks & jobs');
 await page.screenshot({path:path.join(output,'github-'+width+'.png')});
 await page.getByRole('combobox',{name:'Fixture surface'}).selectOption('tasks');await choose('Task view','list','List');await choose('Task view','board','Board');await page.getByText('Fixture task',{exact:true}).first().click();await choose('Task detail section','activities','Activities');await choose('Task detail section','files','Files');await page.getByRole('button',{name:'Close task details',exact:true}).click();
 await page.getByRole('combobox',{name:'Fixture surface'}).selectOption('inspector');await choose('Element style view','computed','Computed');await choose('Element style view','listeners','Event Listeners');
 await page.getByRole('combobox',{name:'Fixture inspector panel'}).selectOption('network');const type=page.getByRole('combobox',{name:'Network request type',exact:true});if(width<=760)await type.selectOption('Fetch/XHR');else await page.getByRole('button',{name:'Fetch/XHR',exact:true}).click();await page.getByRole('button',{name:'report',exact:true}).click();const detail=page.getByRole('combobox',{name:'Network request detail',exact:true});if(width<=760)await detail.selectOption('Timing');else await page.getByRole('button',{name:'Timing',exact:true}).click();
 await page.getByRole('combobox',{name:'Fixture inspector panel'}).selectOption('application');const storage=page.getByRole('combobox',{name:'Application storage section',exact:true});if(width<=760)await storage.selectOption('localStorage');else await page.getByRole('button',{name:'Local storage',exact:true}).click();await page.getByRole('region',{name:'Local storage',exact:true}).waitFor();
 await page.screenshot({path:path.join(output,'storage-'+width+'.png')});assert.deepEqual(errors,[]);console.log(JSON.stringify({width,git:true,githubDetails:true,taskDetails:true,inspectorSubsections:true,mobileDropdown:width<=760,consoleErrors:0}));await page.close();
}}finally{await browser.close();}console.log('Screenshots: '+output);
