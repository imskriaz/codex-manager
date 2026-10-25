import { checkListsApiUi, checkFlyoutUi } from './check-lists-api-ui.mjs';
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { checkInspectorUi } from "./check-inspector-ui.mjs";
import { checkMaintenanceUi } from './check-maintenance-ui.mjs';
import { checkTaskUi } from "./check-task-ui.mjs";
import { prepareDocsSnapshot, captureDocsScreenshots } from './capture-docs-ui.mjs';
import { listConversationFiles } from '../out/domain/conversationFiles.js';
import { dashboardCopyResources } from "../out/localization/resources/dashboard.js";

// Only GET the canonical local snapshot. All browser actions are intercepted
// in memory, so this check cannot send a turn or change a real account.
const origin = process.env.CODEX_MANAGER_UI_URL || "http://127.0.0.1:39875";
const response = await fetch(`${origin}/api/state`);
if (!response.ok) throw new Error(`Local dashboard snapshot returned ${response.status}.`);
const snapshot = await response.json();
Object.assign(snapshot.copy, dashboardCopyResources.en);
snapshot.connectedPeers = [{ id: 'fixture-local', name: 'This PC', connected: true, local: true, sessionCount: 2 }];
snapshot.peerAccounts = {};
snapshot.settings.cliIntegrationEnabled = true;
snapshot.settings.webDashboardEnabled = true;
snapshot.settings.codexAppRestartEnabled = true;
snapshot.settings.codexCliPath = "";
snapshot.settings.autoSwitchEnabled = true;
snapshot.settings.autoResetEnabled = true;
snapshot.settings.taskBoardEnabled = true;
snapshot.settings.apiAccessEnabled = true;
snapshot.settings.autoResumeEnabled = true;
snapshot.settings.privacyMode = true;
snapshot.settings.dailyTokenUsageEnabled = false;
snapshot.settings.persistentLoggingEnabled = true;
snapshot.settings.persistentLogLevel = "info";
const parentId = "01a04882-d037-7a42-ad24-9afb61901188";
const runningId = "01a04882-d037-7a42-ad24-9afb61901189";
const agentId = "01a04882-d037-7a42-ad24-9afb61901190";
const sessions = [
  { id: parentId, title: "Evaluate stack beyond expectations", status: "idle", goal: { objective: "Build the compact workspace from native goal metadata", status: "active", elapsedMs: 125000 }, projectPath: "D:/demo", updatedAt: new Date().toISOString() },
  { id: runningId, title: "Running workspace task", model: "gpt-5", reasoningEffort: "high", runningSince: Date.now() - 125000, goal: { objective: "Finish the running task", status: "active", elapsedMs: 125000 }, status: "running", projectPath: "D:/demo", updatedAt: new Date().toISOString(), canStop: true, runningBy: "another Codex process" },
  { id: agentId, title: "Evaluate stack beyond expectations", status: "running", projectPath: "D:/demo", parentSessionId: parentId, agentName: "Reviewer" },
  { id: "01a04882-d037-7a42-ad24-9afb61901191", title: "Archived task", status: "idle", projectPath: "D:/demo", archived: true }
];
sessions.push(sessions[0]);
const previewImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const longArguments = JSON.stringify({ cmd: `rg ${"preserved-whitespace ".repeat(80)}`, workdir: "D:/demo" });
const messages = [
  { id: "user", kind: "message", role: "user", text: "Review the workspace and explain the result.", textAttachments: [{ name: 'brief.txt', text: 'Original uploaded brief' }], images: [{ src: previewImage, alt: "Attachment preview" }] },
  { id: "tool", kind: "tool-call", title: "exec", text: "Script completed", status: "completed", arguments: longArguments, result: `Output:\n${"wide output ".repeat(100)}` },
  { id: "command", kind: "command", text: "node tools/check-ui.mjs", command: "node tools/check-ui.mjs", output: ("Line of shell output " + "wide ".repeat(40) + "\n").repeat(70), cwd: "D:/demo", status: "completed", durationMs: 2500 },
  { id: "changes", kind: "file-change", text: "Updated files", status: "completed", changes: ["one.ts", "two.ts", "three.ts", "four.ts"].map(path => ({ path, kind: "update", diff: "@@ -1 +1 @@\n-old\n+new\n" })) },
  { id: "goal", kind: "tool-call", title: "Used create_goal", text: "Goal started", status: "completed", arguments: JSON.stringify({ objective: "Build the compact workspace" }) },
  { id: "agent-start", kind: "collaboration", title: "Reviewer started working", text: "Review the UI", status: "completed" },
  { id: "assistant", kind: "message", role: "assistant", text: `The workspace is ready.\n\n\`\`\`ts\nconst answer = 42;\n\`\`\`\n\n[Documentation](https://example.com/docs)\n\n| Item | State |\n| --- | --- |\n| Chat | Ready |\n\n![Markdown preview](${previewImage})` }
];
messages.at(-1).text+='\n\nInspect [Source file](src/app.ts:12), [Native source](file:///D:/demo/src/app.ts#L12), or [absolute source](/outside/example.ts).';
if(process.argv.includes('--docs'))prepareDocsSnapshot(snapshot,sessions,messages);
const config = { models: [{ id: "gpt-5", label: "GPT-5", reasoningEfforts: ["medium", "high"] }], projects: [{ id: "demo", path: "D:/demo", label: "demo" }, { id: "empty", path: "D:/empty-project-with-a-long-name", label: "empty-project-with-a-long-name" }], defaultModel: "gpt-5", defaultReasoningEffort: "medium", defaultSandboxMode: "workspace-write" };
const mockHost = `(() => {
  const state = ${JSON.stringify(snapshot)};
  if(window.__historyFixture) state.usageSummary={revision:1,count:3};
  const sessions = ${JSON.stringify(sessions)};
  const messages = ${JSON.stringify(messages)};
  const config = ${JSON.stringify(config)};
  if(location.search.includes('closed-project')) { sessions[0].projectPath = 'D:/closed-worktree'; sessions[0].title = 'Closed worktree task'; }
  const taskSessions = [], taskComments = [{id:'timeline-comment',taskId:'session:'+${JSON.stringify(parentId)},author:'Reviewer',text:'Timeline review comment',createdAt:1792497600000}], projectTasks = [
    {id:'release-group',title:'Release work',prompt:'Prepare the release',stage:'planned',manualStage:'planned',revision:1,createdAt:Date.now()-7200000,updatedAt:Date.now()-600000},
    {id:'idea-fixture',title:'Idea collection',prompt:'A visitor suggestion',stage:'idea',manualStage:'idea',revision:1,createdAt:Date.now()-3600000,updatedAt:Date.now()-300000},
    ...[...new Map(sessions.filter(session=>!session.parentSessionId).map(session=>[session.id,session])).values()].map(session=>({id:'session:'+session.id,title:session.title,prompt:'',stage:session.status==='running'?'running':session.archived?'completed':'planned',revision:1,createdAt:1,updatedAt:1,sessionId:session.id,sourceKey:'fixture:'+session.id,timing:{firstStartedAt:Date.now()-3600000,lastObservedAt:Date.now()-600000,durationMs:1200000,runCount:2},parentTaskId:session.id===${JSON.stringify(parentId)}?'release-group':undefined}))
  ];
  if(window.__docsFixture){
    for(const task of projectTasks){task.createdAt=Date.now()-86400000;task.updatedAt=Date.now()-600000;}
    projectTasks.push(...[{title:'Review release notes',stage:'planned'},{title:'Validate API scopes',stage:'planned'},{title:'Polish the mobile workspace',stage:'completed'},{title:'Confirm reconnect recovery',stage:'completed'}].map((task,index)=>({id:'docs-task-'+index,...task,prompt:'Review the project changes',manualStage:task.stage,revision:1,createdAt:Date.now()-86400000,updatedAt:Date.now()-3600000})));
  }
  const uploadFiles = new Map();
  const uploadMetadata = files => files?.map(({data,...file})=>{uploadFiles.set(file.id,{...file,data});return {...file,hash:'f'.repeat(64)};});
  window.__fillListFixture=()=>{
    const rows=Array.from({length:155},(_,index)=>({id:'bulk-'+index,title:'Bulk work '+String(index).padStart(3,'0'),status:'idle',projectPath:'D:/demo',updatedAt:new Date().toISOString()}));
    sessions.splice(0,sessions.length,...rows);
    projectTasks.splice(0,projectTasks.length,...rows.map(row=>({id:row.id,title:row.title,prompt:'',stage:'completed',manualStage:'completed',revision:1,createdAt:1,updatedAt:1})));
    projectRevision++;
    window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:action-result',action:'listCodexCliSessions',requestId:'dashboard-auto-fixture',status:'completed',payload:{cliSessions:sessions}}}));
  };
  let projectRevision=1; window.__advanceBoard=()=>{projectTasks.find(task=>task.id==='idea-fixture').title='Idea collection updated';projectRevision++;};
  const projectBoard = () => ({projectPath:'D:/demo',homeKey:'fixture',revision:projectRevision,tasks:projectTasks,comments:taskComments,sessions:[...sessions.filter(session=>!session.parentSessionId),...taskSessions],updatedAt:Date.now()});
  const apiTokens=[{id:'token-project',name:'Project reader',projectPath:'D:/demo',permissions:['state','getProjectBoard'],createdAt:1},{id:'token-all',name:'Owner operations',permissions:['*'],createdAt:1}];
  if(window.__docsFixture)for(const token of apiTokens)token.createdAt=Date.now()-86400000;
  let messageReads = 0;
  let logReads = 0;
  let logCleared = false;
  const toolJobs = new Map();
  const dispatch = data => window.dispatchEvent(new MessageEvent('message', {data}));
  window.__uiActions = []; window.__uiSessions = sessions; window.__uiSnapshot = state; window.__uiSettingResults = [];
  if(window.__tagFixture) { if(state.accounts[0]) state.accounts[0].enabled=true; try { const saved=JSON.parse(localStorage.getItem('fixture-account-tags')||'{}'); for(const account of state.accounts) if(saved[account.id]) account.tags=saved[account.id]; } catch {} }
  if(window.__tagTheme) state.settings.dashboardTheme=window.__tagTheme;
  if(window.__usageFixture) {
    const template=state.accounts[0];
    state.accounts=[{...template,id:'usage-a',email:'alpha@example.test',enabled:true},{...template,id:'usage-b',email:'beta@example.test',enabled:false}];
    state.currentAccountId='usage-a';
    localStorage.setItem('codexManager.usageGraphPreferences.v1',JSON.stringify({mode:'tokens',quotaRange:'1h',tokenRange:'30d',windowOffset:0}));
  }

  const environmentFor = projectPath => ({projectPath,projectName:projectPath?.split('/').pop()||'demo',isGitRepository:true,branch:'main',changes:window.__inspectorMode?2:0,additions:1,deletions:0,ahead:0,behind:0,hasRemote:!!window.__inspectorMode,...(window.__inspectorMode?{changedFiles:[{path:'src/app.ts',index:' ',worktree:'M'},{path:'untracked/',index:'?',worktree:'?'}]}:{})});

  window.__setUiPaths = customPath => {
    Object.assign(state.settings, {codexCliPath:customPath,codexAppPath:customPath,resolvedCodexAppPath:customPath});
    dispatch({type:'dashboard:snapshot',state});
  };
  window.acquireVsCodeApi = () => ({postMessage(message) {
    window.__uiActions.push(message);
    setTimeout(() => {
      if(message.type === 'dashboard:ready') {
        dispatch({type:'dashboard:snapshot',state});
        dispatch({type:'dashboard:connection',connected:true});
      } else if(message.type === 'dashboard:workspace-presence' && message.viewing) {
        dispatch({type:'dashboard:snapshot',state});
      } else if(message.type === 'dashboard:setting') {
        state.settings[message.key] = message.value;
        dispatch({type:'dashboard:snapshot',state});
        window.__uiSettingResults.push({key:message.key,value:message.value});
      } else if(message.type === 'dashboard:action') {
        if(message.action === 'switch' && window.__holdNextSwitch) { window.__holdNextSwitch = false; window.__heldSwitch = message; return; }
        let payload = {}, error;
        if(message.action==='refreshToken') {if(window.__failTokenRefresh) error='Refresh token was revoked. Reauthorize this account.';else payload={notice:{level:'info',message:'Account token refreshed.'}};}
        else if(message.action==='setAccountTags') {
          const account=(message.payload.targetDeviceId?state.peerAccounts?.[message.payload.targetDeviceId]:state.accounts)?.find(account=>account.id===message.accountId);
          if(window.__failTagSave) {window.__failTagSave=false;error='Storage full. Your draft is kept.';}
          else if(!account) error='That account no longer exists.';
          else {
            account.tags=message.payload.tags;account.updatedAt=Date.now();payload={accountTags:{accountId:account.id,tags:account.tags,updatedAt:account.updatedAt},notice:{level:'info',message:'Account tags saved.'}};
            if(!message.payload.targetDeviceId) {const saved=JSON.parse(localStorage.getItem('fixture-account-tags')||'{}');saved[account.id]=account.tags;localStorage.setItem('fixture-account-tags',JSON.stringify(saved));}
          }
        }
        else if(message.action==='manageAccountTag') {
          const source=message.payload.targetDeviceId?state.peerAccounts?.[message.payload.targetDeviceId]:state.accounts;
          const accounts=source.filter(account=>message.payload.accountIds.includes(account.id));
          if(window.__failTagManage) {window.__failTagManage=false;error='Tag membership changed. Review the action again.';}
          else {
            const changes=[];
            for(const account of accounts) {
              const operation=message.payload.tagOperation;
              if(operation==='rename'||operation==='remove') account.tags=[...new Set((account.tags||[]).flatMap(tag=>tag.toLowerCase()===message.payload.tagName.toLowerCase()?operation==='rename'?[message.payload.tagReplacement]:[]:[tag]))];
              else account.enabled=operation==='enable';
              account.updatedAt=Date.now();changes.push({accountId:account.id,tags:account.tags,updatedAt:account.updatedAt,...(operation==='enable'||operation==='disable'?{enabled:account.enabled}:{})});
            }
            payload={tagResult:{successCount:changes.length,failedCount:0,errors:[],accounts:changes},notice:{level:'info',message:changes.length+' accounts updated.'}};
          }
        }
        else if(message.action==='clearUsageHistory') {
          if(window.__failHistoryClear) error='Quota storage full. History was kept.';
          else {state.usageSummary={revision:2,count:0};dispatch({type:'dashboard:snapshot',state});payload={notice:{level:'info',message:'Quota graph history cleared. New snapshots continue recording.'}};}
        }
        else if(message.action==='setPrivacyMode') {state.settings.privacyMode=message.payload.privacyMode;}
        else if(message.action==='getProjectBoard') {
          const result={type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'completed',payload:{projectBoard:projectBoard()}};
          if(window.__holdNextBoard) {window.__holdNextBoard=false;window.__heldBoardResult=structuredClone(result);return;}
          payload=result.payload;
        }
        else if(message.action==='getProjectTaskDetails') {
          const older=!!message.payload.taskBefore;
          const details={taskId:message.payload.taskId,initialPrompt:projectTasks.find(task=>task.id===message.payload.taskId)?.prompt||'Original request for this session',messages:older?[]:[...messages,{id:'thinking',kind:'reasoning',text:'Hidden private thinking'},{id:'failed-tool',kind:'tool-call',status:'failed',text:'Hidden failed attempt'},{id:'empty',kind:'message',text:''}],files:message.payload.taskView==='files'?[{path:older?'src/older.ts':'src/app.ts',name:older?'older.ts':'app.ts',type:'file',depth:1},...(older?[]:${JSON.stringify(listConversationFiles(messages).filter(file => file.attachment))})]:[],environment:['changes','overview'].includes(message.payload.taskView)?{projectName:'demo',projectPath:'D:/demo',branch:'main',isGitRepository:true,changes:1,additions:1,deletions:0}:undefined,history:[],warnings:[],olderThan:older?undefined:'200'};
          if(window.__holdNextTaskDetails===message.payload.taskView) {
            window.__holdNextTaskDetails=false; window.__heldTaskDetails=message;
            window.__releaseTaskDetails=()=>dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'completed',payload:{projectTaskDetails:details}});
            return;
          }
          if(window.__partialTaskDetails && message.payload.taskView==='activities') {details.messages=[{id:'partial-live',kind:'message',role:'assistant',text:'Latest live activity despite saved-history warning'}];details.warnings=['Saved history is temporarily unavailable.'];}
          payload={projectTaskDetails:details};
        }
        else if(message.action==='saveProjectTask') {
          if(window.__failTaskSaves) error='This task changed in another browser. Your draft was kept.';
          else {const {uploads,...input}=message.payload.task,index=projectTasks.findIndex(task=>task.id===input.id),task={...projectTasks[index],...input,attachments:uploadMetadata(uploads)??projectTasks[index]?.attachments,manualStage:projectTasks[index]?.sourceKey?projectTasks[index].manualStage:input.stage,parentTaskId:input.parentTaskId===null?undefined:input.parentTaskId??projectTasks[index]?.parentTaskId,revision:input.expectedRevision+1,createdAt:Date.now(),updatedAt:Date.now()};if(index<0)projectTasks.push(task);else projectTasks[index]=task;projectRevision++;payload={projectBoard:projectBoard(),notice:{level:'info',message:input.hidden===true?'Session hidden from boards.':input.hidden===false?'Session restored to boards.':'Task saved.'}};}
        }
        else if(message.action==='moveProjectTask') {
          const task=projectTasks.find(task=>task.id===message.payload.taskId);
          if(!task || task.revision!==message.payload.taskRevision) error='This task changed. Refresh before retrying.';
          else {task.stage=message.payload.taskStage;task.manualStage=task.stage;task.archived=false;task.revision++;if(message.payload.taskToBoard)task.parentTaskId=undefined;projectRevision++;payload={projectBoard:projectBoard()};}
        }
        else if(message.action==='startProjectSubtask') {
          const id='33333333-3333-4333-8333-333333333333';
          taskSessions.push({id,title:message.payload.text,status:'running',canStop:true,projectPath:'D:/demo',updatedAt:new Date().toISOString()});
          projectTasks.push({id:'session:'+id,title:message.payload.text,prompt:message.payload.text,sessionId:id,sourceKey:'fixture:'+id,parentTaskId:message.payload.taskId,stage:'running',revision:1,createdAt:Date.now(),updatedAt:Date.now()});
          projectRevision++;payload={projectBoard:projectBoard()};
        }
        else if(message.action==='addProjectComment') {const {uploads,...input}=message.payload.comment;if(!taskComments.some(item=>item.id===input.id))taskComments.push({...input,attachments:uploadMetadata(uploads),author:'Owner',createdAt:Date.now()});projectRevision++;payload={projectBoard:projectBoard()};}
        else if(message.action==='shareProjectBoard') payload=window.__partialProjectShare ? {} : {projectShare:{token:'b'.repeat(64),expiresAt:message.payload.shareDays===0?0:Date.now()+86400000,permissions:message.payload.sharePermissions}};
        else if(message.action==='revokeProjectShares') { if(window.__failProjectRevoke) error='Revocation was not confirmed.'; else payload={notice:{level:'info',message:'All project links revoked.'}}; }
        else if(message.action==='listApiTokens') payload={apiTokens,apiProjects:[{id:'host',path:'C:/host-project',label:'Host project'}]};
        else if(message.action==='generateApiToken') {apiTokens.push({id:'new-api-token-'+apiTokens.length,name:message.payload.tokenName,projectPath:message.payload.projectPath,permissions:message.payload.tokenPermissions,createdAt:Date.now()});payload={apiTokens,apiToken:'cm_'+'c'.repeat(64)};}
        else if(message.action==='revokeApiToken') {const index=apiTokens.findIndex(token=>token.id===message.payload.tokenId);if(index>=0)apiTokens.splice(index,1);payload={apiTokens};}
        else if(message.action==='setAutoSwitchLock') {if(window.__failUnlock)error='Lock storage unavailable';else{const account=state.accounts.find(account=>account.id===message.accountId);account.autoSwitchLockedUntil=message.payload.lockMinutes?Date.now()+message.payload.lockMinutes*60000:undefined;dispatch({type:'dashboard:snapshot',state:structuredClone(state)});payload={notice:{level:'info',message:'Auto-switch lock removed.'}};}}
        else if(message.action==='setCodexSessionAutoResume'||message.action==='setCodexSessionQueue') {const session=sessions.find(item=>item.id===message.payload.sessionId);if(window.__failQueue && message.action==='setCodexSessionQueue')error='The session queue is full. Remove an entry before adding another.';else if(session){if(message.action==='setCodexSessionAutoResume')session.autoResumeEnabled=message.payload.autoResumeEnabled;else Object.assign(session,{queueEnabled:message.payload.queueEnabled,queuePriority:message.payload.queueEnabled?message.payload.sessionQueuePriority:undefined});payload={cliSession:session};}}
        else if(message.action==='readWorkspaceFile' && message.payload.filePath.startsWith('@manager-attachment/')) {
          const file=uploadFiles.get(decodeURIComponent(message.payload.filePath.split('/').at(-1)));
          if(!file) error='This attachment is unavailable.';
          else payload={workspaceFile:{path:file.name,content:file.kind==='text'?file.data:'',kind:file.kind,language:'plaintext',mimeType:file.mimeType,size:file.size,revision:'upload-fixture',...(file.kind==='image'?{dataUrl:file.data}:{})}};
        }
        else if(message.action==='readWorkspaceFile') payload={workspaceFile:{path:message.payload.filePath,content:message.payload.filePath.endsWith('older.ts')?'const older = 2;':'const task = 1;',kind:'text',language:'typescript',mimeType:'text/plain',size:15,revision:window.__fileRevision||'fixture'}};
        else         if(message.action === 'downloadLogs' || message.action === 'viewLogs') {
          if(message.action === 'viewLogs') logReads++;
          if(window.__failLogReads || window.__failNextLogRead) { window.__failNextLogRead = false; error = 'Simulated log storage failure.'; }
          else payload = {logDownload:{filename:'codex-manager-logs-fixture.json',text:window.__invalidLogReads || window.__invalidNextLogRead ? '{' : JSON.stringify({format:'codex-manager-logs',records:logCleared ? [] : Array.from({length:80},(_,i)=>({timestamp:new Date(1792300000000+i*1000).toISOString(),sequence:i,level:i<2?'error':i<4?'warning':'info',scope:'recovery',message:i===0?'old record':i===79?'live record '+logReads:'Saved record '+i,details:{accepted:i>3}}))})},notice:{level:'info',message:'Logs refreshed.'}};
          window.__invalidNextLogRead = false;
        }
        else if(message.action === 'clearLogs') { logCleared = true; payload={notice:{level:'info',message:'System log cleared.'}}; }
        else if(message.action === 'previewMaintenance') payload={maintenancePreview:{token:message.payload.maintenanceTool+':preview-'+crypto.randomUUID(),tool:message.payload.maintenanceTool,count:63,expiresAt:Date.now()+300000,titles:['Archived task 0']}};
        else if(message.action === 'getMaintenancePage') {
          const query=message.payload.maintenanceQuery||'',offset=message.payload.maintenanceOffset||0;
          const items=Array.from({length:63},(_,i)=>({id:'tool-item-'+i,title:'Archived task '+i,detail:'demo project'})).filter(item=>item.title.toLowerCase().includes(query.toLowerCase()));
          payload={maintenancePage:{token:message.payload.maintenanceToken,query,offset,total:items.length,items:items.slice(offset,offset+50)}};
        }
        else if(message.action === 'runMaintenance') {
          const job={id:'job-'+crypto.randomUUID(),previewToken:message.payload.maintenanceToken,revision:0,tool:message.payload.maintenanceToken.split(':')[0],operation:message.payload.maintenanceOperation||'delete',status:'running',total:message.payload.maintenanceIds?.length||63,processed:0,cleared:0,skipped:0,failed:0,errors:[]};
          toolJobs.set(job.id,job);window.__maintenanceJob=job;payload={maintenanceJob:{...job}};
          if(window.__progressBeforeAck) dispatch({type:'dashboard:maintenance-progress',deviceId:message.payload.targetDeviceId,job:{...job,revision:1}});
          if(window.__loseMaintenanceAck) return;
        }
        else if(message.action === 'getMaintenanceStatus' || message.action === 'cancelMaintenance') {
          const job=toolJobs.get(message.payload.maintenanceJobId)||[...toolJobs.values()].find(job=>job.previewToken===message.payload.maintenanceToken);
          if(window.__maintenanceRestarted) error='This cleanup is no longer available in this window.';
          else if(job) { if(!window.__keepMaintenanceRunning||message.action==='cancelMaintenance') {job.status=message.action==='cancelMaintenance'?'cancelled':'completed';job.processed=job.total;job.cleared=job.total;}job.revision++;payload={maintenanceJob:{...job}}; } else error='This cleanup is no longer available in this window.';
        }
        else if(message.action === 'inspectMaintenanceStorage') payload={maintenanceReport:{title:'Codex report',items:[{label:'Recorded projects checked',value:'12'},{label:'Missing projects',value:'1'},{label:'state_5.sqlite',value:'Healthy · 2 MB'}]}};
        else if(message.action === 'reopenCodexUi') {if(window.__failCodexReopen) error='Codex could not open in this host.';else payload={maintenanceReport:{title:'Codex UI recovery',items:[{label:'Fresh Codex panel',value:'Open request completed. Check that the new panel finishes loading.'}]}};}
        else if(message.action === 'getUsageGraph') {
          const query=message.payload.usageGraph, date=new Date(Math.floor(Date.now()/86400000)*86400000-86400000).toISOString().slice(0,10);
          payload = {usageGraph:{...query,history:window.__usageFixture && query.mode==='quota'?['usage-a','usage-b','usage-removed'].flatMap((accountId,i)=>[{accountId,at:query.from-1,hourly:100},{accountId,at:query.from+60000,hourly:90-i*10}]):[],dailyUsageCache:window.__usageFixture && query.mode==='tokens'?['usage-a','usage-b','usage-removed'].map((accountId,i)=>({accountId,...(i===2?{accountLabel:'former@example.test'}:{}),fetchedAt:Date.now(),usage:{days:30,points:[{date,unit:'tokens',totalTokens:1000,extensionTokens:[40,60,25][i]}]}})):[],truncated:false}};
          if(window.__docsFixture)payload.usageGraph.history=state.accounts.flatMap((account,index)=>Array.from({length:20},(_,point)=>({accountId:account.id,at:query.from+(query.to-query.from)*point/19,hourly:Math.max(0,98-index*8-Math.floor(point/3)*(index%3+1)*1.2-(point%3===2?0.4:0)),weekly:Math.max(0,92-index*8-point*.2)})));
        }
        else if(message.action === 'listCodexCliSessions') {
          if(window.__failNextSessionList) { window.__failNextSessionList = false; error = 'Session inspection failed.'; }
          else if (window.__systemFixture && message.payload?.targetDeviceId === 'fixture-system') payload = {cliSessions:[{id:'44444444-4444-4444-8444-444444444444',title:'Remote system session',status:'idle',projectPath:'E:/remote-project',deviceId:'fixture-system',deviceName:'Remote system',remote:true,updatedAt:new Date().toISOString()}],cliSessionsDeviceId:'fixture-system',cliComposerConfig:{...config,projects:[{id:'remote-project',path:'E:/remote-project',label:'remote-project'}]}};
          else payload = {cliSessions:sessions,cliComposerConfig:config};
        }
        else if(message.action === 'getCodexCliSessionMessages' && window.__systemFixture && message.payload?.targetDeviceId === 'fixture-system') payload={cliSession:{id:'44444444-4444-4444-8444-444444444444',title:'Remote system session',status:'idle',projectPath:'E:/remote-project',deviceId:'fixture-system',remote:true},cliSessionMessages:[{id:'remote-reply',kind:'message',role:'assistant',text:'Remote system conversation'}]};
        else if(message.action === 'startCodexCliSession') {
          const session = {id:'01a04882-d037-7a42-ad24-9afb61901198',title:'New smoke chat',status:'idle',projectPath:message.payload.projectPath};
          if(!sessions.some(row=>row.id===session.id)) sessions.push(session);
          payload = {cliSession:session,cliSessionMessages:[{id:'new-user',kind:'message',role:'user',text:message.payload.text},{id:'new-answer',kind:'message',role:'assistant',text:'New chat first response'}],notice:{level:'info',message:'New Codex chat is ready.'}};
        }
        else if(message.action === 'setCodexSessionGoalStatus') {
          if(window.__failNextGoal) {window.__failNextGoal=false;error='Goal storage unavailable.';}
          else {const session=sessions.find(s=>s.id===message.payload.sessionId);
            session.goal={...session.goal,status:message.payload.goalStatus};
            payload={cliSession:session,notice:{level:'info',message:message.payload.goalStatus==='paused'?'Goal paused.':'Goal resumed.'}};}
        }
        else if(message.action === 'getCodexCliSessionMessages') {
          messageReads++;
          if(location.search.includes('missing-transcript')) error = 'The session transcript was not found on this PC.';
          payload = {cliSession:sessions.find(s => s.id === message.payload.sessionId),cliSessionMessages:messageReads > 1 ? [...messages,{id:'live',kind:'message',role:'assistant',text:'Live transcript update'}] : messages};
        } else if(message.action === 'getCodexSubAgentMessages' && window.__failAgentRead) error='Agent transcript unavailable. Saved messages were kept.';
        else if(message.action === 'getCodexSubAgentMessages') payload = {cliSubAgentSession:sessions.find(s => s.id === message.payload.sessionId),cliSubAgentMessages:[{id:'agent-msg',kind:'message',role:'assistant',text:'Agent reviewer message'}]};
        else if(message.action === 'saveWorkspaceFile') {if(window.__failFileSave)error='Simulated revision conflict. Your draft was kept.';else payload={workspaceFile:{path:message.payload.filePath,content:message.payload.fileContent,kind:'text',language:'typescript',mimeType:'text/plain',size:message.payload.fileContent.length,revision:'saved-revision'},notice:{level:'info',message:'File saved.'}};}
        else if(message.action === 'commitWorkspaceChanges' || message.action === 'pushWorkspaceBranch') {if(window.__failCommit)error='Simulated commit failure';else payload={workspaceEnvironment:environmentFor(message.payload.projectPath),notice:{level:'info',message:message.action==='commitWorkspaceChanges'?'Project committed.':'Branch pushed.'}};}
        else if(message.action === 'runWorkspaceTerminalCommand' && window.__inspectorMode) payload={terminalResult:{id:'fixture-command',terminalId:'fixture-terminal',command:message.payload.command,cwd:message.payload.projectPath,output:'',durationMs:0,status:'running',finishedAt:new Date().toISOString()}};
        else if(message.action === 'createWorkspaceTerminal' && window.__inspectorMode) {window.__terminalCreated=true;payload={workspaceTerminal:{id:'fixture-terminal',name:'Project terminal',state:'idle',isActive:true},workspaceTerminals:[{id:'fixture-terminal',name:'Project terminal',state:'idle',isActive:true}]};}
        else if(message.action === 'closeWorkspaceTerminal' && window.__inspectorMode) {window.__terminalCreated=false;payload={workspaceTerminals:[]};}
        else if(message.action === 'getWorkspaceEnvironment') {
          if(message.payload?.gitHistory && window.__failNextHistory) { window.__failNextHistory=false;error='Simulated history read failure.'; }
          else if(message.payload?.gitHistory) {
            const request=message.payload.gitHistory,offset=request.offset||0;
            payload={workspaceEnvironment:{...environmentFor(message.payload.projectPath),...(request.commit?{gitCommit:{hash:request.commit,diff:'diff --git a/proof.txt b/proof.txt\\n--- a/proof.txt\\n+++ b/proof.txt\\n@@ -1 +1 @@\\n-old history\\n+verified history\\n',truncated:false}}:{gitHistory:{ref:request.ref||'a'.repeat(40),offset,hasMore:offset===0,commits:Array.from({length:offset?13:50},(_,i)=>({hash:(offset+i+1).toString(16).padStart(40,'0'),author:'History Author',date:'2026-10-20T12:00:00Z',subject:'Project commit '+(offset+i)}))}})}};
          } else if(message.payload?.includeBranchDiff && window.__failNextComparison) {
            window.__failNextComparison = false;
            error = 'Simulated Git comparison failure.';
          } else payload = {workspaceEnvironment:{...environmentFor(message.payload?.projectPath),...(message.payload?.includeBranchDiff ? {branchDiff:'diff --git a/compare.ts b/compare.ts\\n--- a/compare.ts\\n+++ b/compare.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n',branchDiffBase:'origin/main'} : {})}};
        }
        else if(message.action === 'workspaceGit') {
          const query=message.payload.gitRequest,operation=query.operation;
          if(operation==='read'&&window.__failNextGitRead) { window.__failNextGitRead=false; error='Simulated Git read failure.'; }
          else if(operation==='commit'&&window.__failCommit) error='Simulated commit failure';
          else {
            if(operation==='stage') window.__gitStaged=true;
            if(operation==='unstage') window.__gitStaged=false;
            if(operation==='commit') window.__gitStaged=false;
            const environment=environmentFor(message.payload.projectPath);
            if(window.__gitStaged) environment.changedFiles[0].index='M';
            payload={workspaceGit:{revision:'fixture-git-revision',branch:'main',head:'a'.repeat(40),branches:[{name:'main',current:true,remote:false},{name:'feature/demo',current:false,remote:false}],stashes:[{name:'stash@{0}',hash:'b'.repeat(40),subject:'Saved fixture work'}],environment,output:operation==='read'?undefined:'Git operation completed.',...(operation==='diff'?{diff:'diff --git a/src/app.ts b/src/app.ts\\n--- a/src/app.ts\\n+++ b/src/app.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n'}:{})}};
          }
        }
        else if(message.action === 'workspaceGitHub') {
          const query=message.payload.githubRequest;
          if(window.__failGitHub) error='GitHub sign-in expired. Connect GitHub and retry.';
          else {
            const item={id:12,number:query.section==='pulls'||query.section==='issues'?12:undefined,title:query.section==='pulls'?'Fixture pull request':query.section==='issues'?'Fixture issue':query.section==='actions'?'Fixture workflow':'Fixture release',state:query.section==='actions'?'success':'open',url:'https://github.com/example/project/pull/12',author:'fixture',updatedAt:'2026-10-22T00:00:00Z',headSha:'a'.repeat(40),head:'feature',base:'main',body:'Fixture description'};
            payload={workspaceGitHub:{repository:'example/project',url:'https://github.com/example/project',authenticated:true,canWrite:true,defaultBranch:'main',items:[item],page:query.page||1,hasMore:false,...(query.operation==='detail'?{detail:item,comments:[{id:1,author:'reviewer',body:'Reviewed fixture',createdAt:'2026-10-22T00:00:00Z'}],files:[{path:'src/app.ts',status:'modified',additions:1,deletions:1,patch:'-old\\n+new'}],checks:[{id:1,name:'CI',status:'success'}]}:{}),workflows:[{id:7,name:'Fixture workflow',state:'active'}]}};
            if(window.__failGithubAfterWrite && !['read','detail','connect'].includes(query.operation)) Object.assign(payload.workspaceGitHub,{items:[],refreshFailed:true,warning:'The action completed, but the updated list could not be read. Refresh before another action.'});
          }
        }
        else if(message.action === 'workspaceTerminal') {
          const query=message.payload.terminalRequest;
          const terminals=window.__fixtureTerminals||(window.__fixtureTerminals=[]);
          let terminal=terminals.find(item=>item.id===message.payload.terminalId);
          if(query.operation==='create') {terminal={id:'pty:'+crypto.randomUUID(),name:'Project terminal',shared:true,cwd:message.payload.projectPath,state:'running',isActive:true,epoch:crypto.randomUUID(),sequence:0,inputSequence:0,cols:80,rows:24,content:'\\x1b[31mFixture error\\x1b[0m\\r\\nPS fixture> '};terminals.push(terminal);}
          if(!terminal) error='Terminal no longer exists.';
          else {
            if(query.operation==='resize') {terminal.cols=query.cols;terminal.rows=query.rows;}
            if(query.operation==='rename') terminal.name=message.payload.terminalName;
            if(query.operation==='input') {
              terminal.inputSequence=query.sequence;terminal.content+=query.data;
              const output={raw:true,id:terminal.epoch,terminalId:terminal.id,command:'',cwd:terminal.cwd,chunk:query.data,stream:'terminal',sequence:++terminal.sequence,cols:terminal.cols,rows:terminal.rows};
              dispatch({type:'dashboard:terminal-output',output});
            }
            payload={workspaceTerminal:{...terminal},workspaceTerminals:terminals.map(item=>({...item})),terminalSnapshot:{id:terminal.id,epoch:terminal.epoch,sequence:terminal.sequence,inputSequence:terminal.inputSequence,cols:terminal.cols,rows:terminal.rows,writable:true,exited:false,...(['create','read','claim'].includes(query.operation)?{content:terminal.content}:{})}};
            if(query.operation==='close') {terminals.splice(terminals.indexOf(terminal),1);payload.workspaceTerminals=terminals.map(item=>({...item}));}
            if(window.__loseTerminalInput&&query.operation==='input') return;
          }
        }
        else if(message.action === 'listWorkspaceTerminals') payload = {workspaceTerminals:window.__fixtureTerminals||[]};
        else if(message.action === 'listWorkspaceFiles') payload = {workspaceFiles:window.__inspectorMode?[{path:'src/app.ts',name:'app.ts',type:'file',depth:0}]:[]};
        else if(['openNewCodexWebview','resumeCodexSessions','openCodexCliSession'].includes(message.action)) payload = {notice:{level:'info',message:'Opened in VS Code.'}};
        else error = 'Simulated action failure. Your draft is preserved.';
        if(message.action==='setCodexSessionQueue' && !error && window.__sessionRefreshNotice) {window.__sessionRefreshNotice=false;payload.notice={level:'warning',message:'The session action completed, but the session list could not refresh: Session discovery is still pending. Refresh the list before retrying the action.'};}
        if(window.__docsFixture && payload){
          const metadata={model:'gpt-5',reasoningEffort:'high',sessionSurface:'vscode',updatedAt:new Date().toISOString()};
          if(payload.cliSessionsDeviceId==='fixture-system')for(const session of payload.cliSessions)Object.assign(session,metadata);
          if(payload.cliSession?.deviceId==='fixture-system'){Object.assign(payload.cliSession,metadata);payload.cliSessionMessages=messages;}
        }
        const result = {type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:error?'failed':'completed',payload,error};
        if(message.action==='setAccountTags' && window.__loseTagAck) {window.__loseTagAck=false;window.__heldTagResult=result;return;}
        if(message.action==='listCodexCliSessions' && window.__holdNextSystemList) {window.__holdNextSystemList=false;window.__heldSystemList=result;return;}
        if(message.action==='previewMaintenance' && window.__holdNextMaintenancePreview) {window.__holdNextMaintenancePreview=false;window.__heldMaintenancePreview=result;return;}
        if(message.action==='getCodexSubAgentMessages' && window.__holdNextAgentRead) {window.__holdNextAgentRead=false;window.__heldAgentResult=result;return;}
        if(message.action==='getWorkspaceEnvironment' && window.__holdNextEnvironment) {window.__holdNextEnvironment=false;window.__heldEnvironmentResult=result;return;}
        if((message.action==='commitWorkspaceChanges'||message.action==='workspaceGit'&&message.payload.gitRequest.operation==='commit') && window.__holdNextCommit) {window.__holdNextCommit=false;window.__heldCommitResult=result;return;}
        if(message.action==='saveWorkspaceFile' && window.__holdNextSave) {window.__holdNextSave=false;window.__heldSaveResult=result;return;}
        if(message.action==='shareProjectBoard' && window.__holdProjectShare) {window.__holdProjectShare=false;window.__heldProjectShareResult=result;return;}
        if(message.action==='readWorkspaceFile' && window.__holdNextWorkspaceFileRead) {window.__holdNextWorkspaceFileRead=false;window.__heldWorkspaceFileResult=result;return;}
        if(message.action === 'archiveCodexCliSession') {
          window.__heldArchiveResult = {...result,status:'completed',error:undefined,payload:{notice:{level:'info',message:'Original chat archived.'}}};
          return;
        }
        if(message.action === 'getCodexCliSessionMessages' && window.__holdNextMessageRead) {
          window.__holdNextMessageRead = false;
          window.__heldMessageResult = result;
          return;
        }
        if(message.action === 'sendCodexCliSessionMessage' && window.__holdNextSend) {
          window.__holdNextSend = false;
          window.__heldSendResult = {...result,status:'completed',error:undefined,payload:{cliSession:sessions.find(s=>s.id===message.payload.sessionId),cliSessions:sessions,cliSessionMessages:[{id:'late-turn',kind:'message',role:'assistant',text:'Completed original conversation'}]}};
          return;
        }
        if(message.action==='listApiTokens'&&window.__holdNextApiList){window.__holdNextApiList=false;window.__heldApiList=structuredClone(result);return;}
        if(message.action==='generateApiToken'&&window.__holdNextApiCreate){window.__holdNextApiCreate=false;window.__heldApiCreate=structuredClone(result);return;}
        dispatch(result);
      }
    }, 50);
  },getState(){},setState(){}});
})();`;
new Script(mockHost, { filename: "dashboard-fixture-host.js" });
const output = path.join(tmpdir(), "codex-manager-ui-check");
await mkdir(output, { recursive: true });
async function selectSidebarSystem(page, width, id) {
  const show = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
  if (await show.isVisible()) await show.click();
  await page.locator('.cli-rail-system select').selectOption(id);
  if (width <= 760) await page.getByRole('button', { name: 'Hide sessions sidebar', exact: true }).click();
}
async function checkClosedProject(page, width, errors) {
    await page.goto(`${origin}/workspace/${parentId}?closed-project`);
    if (width <= 1180) {
      await page.getByRole("button", { name: "Show workspace tools", exact: true }).click();
    }
    await page.waitForFunction(() => window.__uiActions.some(action => action.action === "getWorkspaceEnvironment" && action.payload?.projectPath === "D:/closed-worktree"));
    const closedFiles = page.getByRole("tab", { name: "Files", exact: true });
    if (await closedFiles.count()) await closedFiles.click();
    else {
      await page.getByRole("button", { name: "Add workspace tool", exact: true }).click();
      await page.getByRole("menuitem", { name: "Files", exact: true }).click();
    }
    await page.waitForFunction(() => window.__uiActions.some(action => action.action === "listWorkspaceFiles" && action.payload?.projectPath === "D:/closed-worktree"));
    if (width <= 1180) await page.getByRole("button", { name: "Hide workspace tools", exact: true }).click();
    if (width <= 760 && await page.locator(".cli-rail-toggle").getAttribute("aria-expanded") === "false") await page.locator(".cli-rail-toggle").click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await page.getByRole("button", { name: "Message settings", exact: true }).click();
    assert.equal(await page.getByRole("combobox", { name: "Project", exact: true }).inputValue(), "D:/closed-worktree", "New chat retains the closed session project");
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, [], "Closed-project browser runtime errors");
}

const browser = await chromium.launch({ channel: process.env.CODEX_MANAGER_BROWSER || "msedge", headless: true });
const results = [];
try {
  const selectedWidth = Number(process.argv.find((argument) => argument.startsWith("--width="))?.slice(8));
  for (const [width, height] of (selectedWidth ? [[selectedWidth, Number(process.argv.find(argument => argument.startsWith("--height="))?.slice(9)) || (selectedWidth <= 760 ? 844 : 1000)]] : process.argv.includes('--docs') ? [[1440,900],[390,844]] : process.argv.includes("--landscape") ? [[844, 390]] : [[1440, 1000], [1024, 768], [768, 1024], [390, 844], [320, 667], [844, 390]])) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width <= 760, serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] });
    if (width === 320) await context.addInitScript(() => {
      Object.defineProperty(window, "indexedDB", { configurable: true, value: { open() { throw new DOMException("Browser storage unavailable", "SecurityError"); } } });
    });
    const page = await context.newPage();
    if(process.argv.includes('--systems')) await page.addInitScript(()=>localStorage.setItem('codexManager.workspaceLayout.v2',JSON.stringify({sessionView:'projects'})));
    if(process.argv.includes('--history')) await page.addInitScript(()=>{window.__historyFixture=true;});
    if(process.argv.includes('--usage')) await page.addInitScript(()=>{window.__usageFixture=true;});
    if(process.argv.includes('--tags')) await page.addInitScript(()=>{window.__tagFixture=true;});
    if(process.argv.includes('--dark')) await page.addInitScript(()=>{window.__tagTheme='dark';});
    page.setDefaultTimeout(30_000);
    console.log(`Checking ${width}x${height}: session list`);
    const errors = [];
    page.on("pageerror", (error) => { errors.push(error.message); console.log("Browser error:",error.message); });
    await page.route("**/api/**", (route) => route.abort());
    const shareRequests = [];
    let heldShare, releaseShare, shareResponse;
    await page.route("**/api/share/*", async route => {
      shareRequests.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
      if (heldShare) await heldShare;
      if (shareResponse) return route.fulfill(shareResponse);
      return route.fulfill({ json: new URL(route.request().url()).pathname.endsWith("/create") ? { token: "a".repeat(64) } : { ok: true } });
    });
    await page.route("**/assets/browserHost.js*", (route) => route.fulfill({ contentType: "text/javascript", body: mockHost }));
    for (const [url, file, contentType] of [["dashboard.js", "media/webview/dashboard/dashboard.js", "text/javascript"], ["dashboard.css", "media/webview/quotaSummary.css", "text/css"], ["shared.css", "media/webview/shared.css", "text/css"]]) {
      await page.route(`**/assets/${url}*`, (route) => route.fulfill({ contentType, path: path.resolve(file) }));
    }
    await page.route(`${origin}/workspace/*`, async route => {
      const response = await route.fetch({ url: `${origin}/workspace` });
      await route.fulfill({ response });
    });
    if(process.argv.includes('--session-badge')){
      await page.goto(origin+'/');
      const badge=page.locator('#cliSessionsButton .cli-server-status-badge');
      await page.waitForFunction(()=>document.querySelector('#cliSessionsButton .is-ready')?.textContent==='1');
      assert.equal(await badge.locator('i').count(),0,'Ready badge contains only the count');
      assert.equal(await badge.getAttribute('aria-label'),'1 running sessions');
      assert.equal(await page.locator('#cliSessionsButton .cli-server-status-badge').count(),1);
      await page.locator('#cliSessionsButton').click();
      await page.locator('.cli-sessions-popover').waitFor();
      assert.equal(await page.locator('.cli-sessions-server-card').count(),0,'Popover has no redundant service card');
      const resumeToggle=page.locator('.cli-sessions-popover').getByRole('button',{name:'Auto Resume for Running workspace task',exact:true});
      assert.equal(await resumeToggle.getAttribute('aria-pressed'),'true','Running work has an enabled icon toggle');
      await resumeToggle.click();
      await page.waitForFunction(()=>document.querySelector('.cli-sessions-popover .is-auto-resume')?.getAttribute('aria-pressed')==='false');
      await resumeToggle.click();
      await page.waitForFunction(()=>document.querySelector('.cli-sessions-popover .is-auto-resume')?.getAttribute('aria-pressed')==='true');
      assert.equal(await page.locator('.cli-session-row:not(.is-running) .is-auto-resume').count(),0,'Idle sessions have no resume toggle');
      assert.equal(await page.locator('.cli-session-policy-control').count(),0,'Auto/Manual dropdown is removed');
      await page.evaluate(()=>{window.__holdNextSystemList=true;});
      await page.locator('.cli-sessions-popover').getByRole('button',{name:'Refresh sessions',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('#cliSessionsButton .is-starting')?.textContent==='Starting');
      assert.equal(await badge.locator('i').count(),1,'Starting badge has a spinner');
      await page.screenshot({path:path.join(output,`session-badge-starting-${width}.png`)});
      await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:window.__heldSystemList})));
      await page.waitForFunction(()=>document.querySelector('#cliSessionsButton .is-ready')?.textContent==='1');
      await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:false}})));
      await page.waitForFunction(()=>document.querySelector('#cliSessionsButton .is-offline')?.textContent==='Offline');
      await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:true}})));
      await page.waitForFunction(()=>document.querySelector('#cliSessionsButton .is-ready')?.textContent==='1');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'Badge does not cause page overflow');
      await page.screenshot({path:path.join(output,`session-badge-ready-${width}.png`)});
      await page.evaluate(()=>{
        const session=window.__uiSessions.find(item=>item.title==='Running workspace task');
        session.status='idle';session.interrupted=true;
        window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:action-result',action:'listCodexCliSessions',requestId:'dashboard-auto-fixture',status:'completed',payload:{cliSessions:window.__uiSessions}}}));
      });
      await page.waitForFunction(()=>document.querySelector('#cliSessionsButton .is-ready')?.textContent==='0');
      assert.equal(await page.locator('.cli-sessions-popover .is-auto-resume').count(),0,'Finished work loses the resume toggle');
      const queueToggle=page.locator('.cli-sessions-popover').getByRole('button',{name:'Queue priority for Running workspace task',exact:true});
      assert.equal(await queueToggle.isVisible(),true,'Interrupted work retains queue priority');
      assert.equal(await queueToggle.getAttribute('data-state'),'not-queued');
      await page.evaluate(()=>{
        const session=window.__uiSessions.find(item=>item.title==='Running workspace task');
        Object.assign(session,{queueEnabled:true,queuePriority:2,queueError:'A queued start was not confirmed. Review before retrying.'});
        window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:action-result',action:'listCodexCliSessions',requestId:'dashboard-auto-fixture',status:'completed',payload:{cliSessions:window.__uiSessions}}}));
      });
      await page.waitForFunction(()=>document.querySelector('.cli-sessions-popover [data-state="needs-review"]')!==null);
      assert.equal(await queueToggle.locator('small').textContent(),'!','Queue errors have a visible warning marker');
      await queueToggle.click();
      await page.getByText('Needs review · priority 2',{exact:true}).waitFor();
      await page.screenshot({path:path.join(output,`session-queue-review-${width}.png`)});
      assert.deepEqual(errors,[]);
      results.push({width,height,checks:'Single badge: count-only ready, startup spinner, offline, reconnect, no duplicate card'});
      await context.close();continue;
    }
    if(process.argv.includes('--docs')){
      await captureDocsScreenshots(page,{origin,width,parentId});assert.deepEqual(errors,[]);
      results.push({width,height,checks:'documentation screenshots with fictional data'});await context.close();continue;
    }
    if(process.argv.includes('--flyouts')){
      await checkFlyoutUi(page,{origin,parentId,width,height,output});assert.deepEqual(errors,[]);
      results.push({width,height,checks:'Click-anchored account, More, graph, mobile, running/queue, workspace tools and account-center menus; resize bounds'});await context.close();continue;
    }
    if(process.argv.includes('--locks')){
      await page.goto(origin+'/');await page.locator('.saved-card-container').first().waitFor();
      for(const mode of ['cards','list']){
        if(mode==='list')await page.locator('.dashboard-view-toggle').click();
        await page.evaluate(()=>{const state=window.__uiSnapshot;for(const account of state.accounts)account.autoSwitchLockedUntil=undefined;(state.accounts.find(account=>account.isActive)??state.accounts[0]).autoSwitchLockedUntil=Date.now()+900000;window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:snapshot',state:structuredClone(state)}}));});
        const badge=page.getByRole('button',{name:'Auto Switch locked. Show unlock option',exact:true});await badge.waitFor();
        assert.ok((await badge.boundingBox()).height<=20,'Lock badge stays compact');
        await badge.click();await page.getByRole('button',{name:'Unlock Auto Switch',exact:true}).waitFor();
        await page.keyboard.press('Escape');assert.equal(await page.getByRole('button',{name:'Unlock Auto Switch',exact:true}).count(),0);
        await page.evaluate(()=>{window.__failUnlock=true;});await badge.click();await page.getByRole('button',{name:'Unlock Auto Switch',exact:true}).click();
        await page.getByRole('alert').filter({hasText:'Lock storage unavailable'}).waitFor();assert.equal(await badge.count(),1,'Failed unlock keeps its lock');
        await page.getByRole('button',{name:'Dismiss notification',exact:true}).click();await page.evaluate(()=>{window.__failUnlock=false;window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:false}}));});
        await page.waitForFunction(()=>document.querySelector('button.saved-lock-badge')?.disabled===true);
        await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:true}})));
        await badge.click();await page.getByRole('button',{name:'Unlock Auto Switch',exact:true}).click();await badge.waitFor({state:'hidden'});
        assert.equal(await page.evaluate(()=>window.__uiActions.filter(action=>action.action==='setAutoSwitchLock').at(-1).payload.lockMinutes),0);
      }
      assert.deepEqual(errors,[]);results.push({width,height,checks:'Clickable lock badges in cards/list, Unlock, Escape, failure retention, offline guard and success'});await context.close();continue;
    }
    if (process.argv.includes('--closed-project')) {
      await checkClosedProject(page, width, errors);
      results.push({ width, height, checks: 'closed-project composer context' });
      await context.close();
      continue;
    }
    if(process.argv.includes('--history')) {
      await page.goto(origin+'/');
      if(width<=760) {await page.locator('.dashboard-mobile-actions > summary').click();await page.getByRole('menuitem',{name:'Settings',exact:true}).click();}
      else await page.locator('#settingsOpenButton').click();
      await page.locator('#settings-tab-data').click();
      const settings=page.getByRole('dialog',{name:'Settings',exact:true});
      const usage=settings.getByRole('button',{name:'Usage log',exact:true});await usage.waitFor();
      if(await usage.getAttribute('aria-pressed')==='false') await usage.click();
      const usageBlock=usage.locator('../..');await usageBlock.locator('input[type=range]').waitFor();
      assert.equal(await usageBlock.locator('input[type=range]').count(),1,'Usage log has its automatic check interval');
      await usage.click();await usageBlock.locator('input[type=range]').waitFor({state:'hidden'});
      await usage.click();await usageBlock.locator('input[type=range]').waitFor();
      await usageBlock.locator('input[type=range]').focus();await page.keyboard.press('ArrowRight');
      await page.waitForFunction(()=>window.__uiActions.some(item=>item.type==='dashboard:setting' && item.key==='dailyTokenUsageIntervalMinutes'));

      const quota=settings.locator('.settings-history-block').filter({hasText:'Quota graph history'});
      assert.equal(await quota.locator('input[type=range]').count(),1,'Quota history has retention controls');
      await quota.locator('input[type=range]').focus();await page.keyboard.press('Home');
      await page.waitForFunction(()=>window.__uiActions.some(item=>item.type==='dashboard:setting' && item.key==='usageHistoryRetentionDays' && item.value===1));
      assert.equal(await settings.getByText('Quota history is no longer recorded.',{exact:false}).count(),0);
      const before=await page.evaluate(()=>window.__uiActions.filter(item=>item.action==='clearUsageHistory').length);
      await settings.getByRole('button',{name:'Clear quota graph history',exact:true}).click();
      let confirm=page.getByRole('dialog',{name:'Clear quota graph history?',exact:true});await confirm.waitFor();
      await page.screenshot({path:path.join(output,`history-confirmation-${width}.png`)});
      await page.keyboard.press('Escape');await confirm.waitFor({state:'hidden'});
      assert.equal(await page.evaluate(()=>window.__uiActions.filter(item=>item.action==='clearUsageHistory').length),before,'Cancelling sends no clear');
      await page.evaluate(()=>{window.__failHistoryClear=true;});
      await settings.getByRole('button',{name:'Clear quota graph history',exact:true}).click();await confirm.getByRole('button',{name:'Clear quota history',exact:true}).click();
      await page.getByRole('alert').filter({hasText:'Quota storage full'}).waitFor();
      assert.equal(await settings.getByRole('button',{name:'Clear quota graph history',exact:true}).isEnabled(),true,'Failed clears retain existing history');
      await page.getByRole('button',{name:'Dismiss notification',exact:true}).click();
      await page.evaluate(()=>{window.__failHistoryClear=false;});
      await settings.getByRole('button',{name:'Clear quota graph history',exact:true}).click();await confirm.getByRole('button',{name:'Clear quota history',exact:true}).click();
      await page.getByRole('status').filter({hasText:'Quota graph history cleared'}).waitFor();
      await page.waitForFunction(()=>document.querySelector('.settings-count-badge')?.textContent==='0 samples');
      assert.equal(await settings.getByRole('button',{name:'Clear quota graph history',exact:true}).isDisabled(),true);
      await page.screenshot({path:path.join(output,`history-controls-${width}.png`)});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));assert.deepEqual(errors,[]);
      results.push({width,height,checks:'Usage log interval/toggle, quota retention, confirmed clear, cancellation and storage failure feedback'});
      await context.close();continue;
    }
    if (process.argv.includes('--tasks')) {
      await checkTaskUi(page,{origin,width,height,output});
      assert.deepEqual(errors,[],'Task UI runtime errors');
      results.push({width,height,checks:'Compact context header, four views, Agents, Overview, details and sharing'});
      await context.close(); continue;
    }
    if (process.argv.includes('--feedback')) {
      await page.goto(`${origin}/`);
      await page.locator('.saved-card-container').first().waitFor();
      await page.evaluate(()=>{ const state=window.__uiSnapshot;state.accounts[0].canRefreshToken=true;window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:snapshot',state}})); });
      const refresh=async()=>{await page.locator('.saved-card-container').first().getByRole('button',{name:'More account actions',exact:true}).click();await page.getByRole('button',{name:'Refresh token now',exact:true}).click();};
      await refresh();
      const toast=page.locator('.dashboard-notice').filter({hasText:'Account token refreshed.'});
      await toast.waitFor();
      await page.waitForTimeout(3200);
      assert.equal(await toast.count(),0,'Info toast dismisses after three seconds');
      await page.evaluate(()=>{window.__failTokenRefresh=true;});
      await refresh();
      const failure=page.getByRole('alert').filter({hasText:'Refresh token was revoked. Reauthorize this account.'});
      await failure.waitFor();
      await page.waitForTimeout(3200);
      assert.equal(await failure.count(),1,'Errors remain visible longer than info');
      await page.getByRole('button',{name:'Dismiss notification',exact:true}).click();
      assert.deepEqual(errors,[],'Feedback UI runtime errors');
      results.push({width,height,checks:'Token refresh success, 3s info timeout, preserved actionable failure and dismissal'});
      await context.close();continue;
    }
    if (process.argv.includes('--usage')) {
      await page.goto(`${origin}/`);
      const chart=page.locator('.usage-graph-card');
      await chart.locator('.usage-graph-summary').filter({hasText:'125 total'}).waitFor();
      const readColors=async()=>chart.locator('.usage-graph-bar').evaluateAll(items=>[...new Set(items.map(item=>item.getAttribute('fill')))]);
      const tokenColors=await readColors();
      assert.equal(tokenColors.length,3,'Tokens retain disabled and removed accounts with separate colors');
      assert.equal(await chart.locator('.usage-graph-color-chip').count(),3);
      await chart.getByRole('button',{name:'View account usage stats',exact:true}).click();
      const stats=page.getByRole('tooltip',{name:'Account usage stats',exact:true});
      await stats.getByText('for***est',{exact:true}).waitFor();
      assert.equal(await stats.getByText('former@example.test',{exact:true}).count(),0,'Masking also protects retained account names');
      await page.keyboard.press('Escape');await page.locator('#privacyToggleButton').click();
      await chart.getByRole('button',{name:'View account usage stats',exact:true}).click();
      await stats.getByText('former@example.test',{exact:true}).waitFor();
      assert.equal(await stats.getByText('Removed account 1',{exact:true}).count(),0,'Retained history keeps its account name');
      await stats.getByText('25 tokens',{exact:true}).waitFor();
      await page.keyboard.press('Escape');
      await page.screenshot({path:path.join(output,`usage-tokens-${width}.png`)});
      await chart.getByRole('button',{name:'Graph settings',exact:true}).click();
      await page.getByRole('button',{name:'Quota changes',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('.usage-graph-card')?.dataset.mode==='quota' && document.querySelectorAll('.usage-graph-bar').length>=3);
      assert.deepEqual(await readColors(),tokenColors,'Both graph modes use the same account palette');
      await page.screenshot({path:path.join(output,`usage-quota-${width}.png`)});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      assert.deepEqual(errors,[],'Usage UI runtime errors');
      results.push({width,height,checks:'VS Code-only total, disabled/removed account history, three account colors in both modes and tooltip'});
      await context.close(); continue;
    }
    if (process.argv.includes('--tags')) {
      await page.goto(`${origin}/`);
      await page.locator('#dashboard-main').waitFor();
      const cards=page.locator('.saved-card-container');
      const footerHeight=await cards.first().locator('.saved-card-footer').evaluate(element=>element.getBoundingClientRect().height);
      await page.evaluate(()=>{
        const state=window.__uiSnapshot;
        for(const account of state.accounts) account.tags=[];
        state.accounts[0].tags=['Work','Team','Long client label'];state.accounts[0].updatedAt=Date.now();state.accounts[0].enabled=true;
        state.accounts[1].tags=['Personal'];
        window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:snapshot',state}}));
      });
      const filter=page.getByRole('combobox',{name:'Filter by tag',exact:true});
      await filter.selectOption('work');
      await page.waitForFunction(()=>document.querySelectorAll('.saved-card-container').length===1);
      const row=cards.first();
      await row.locator('.saved-account-tags').waitFor();
      assert.equal((await row.locator('.saved-card-footer').boundingBox()).height,footerHeight,'Tags do not increase card footer height');
      assert.equal(await row.locator('.saved-account-tag-count').innerText(),'+2');
      assert.equal(await row.locator('.saved-account-tags').getAttribute('title'),'Work, Team, Long client label');
      const days=await row.locator('.saved-subscription-remaining').boundingBox(),chips=await row.locator('.saved-account-tags').boundingBox();
      assert.ok(chips.x>=days.x+days.width-1 && Math.abs(chips.y+chips.height/2-days.y-days.height/2)<=2,'Tags follow days left on the same line');
      await page.screenshot({path:path.join(output,`tag-cards-${width}.png`),fullPage:true});
      await row.getByRole('button',{name:'More account actions',exact:true}).click();
      await page.getByRole('button',{name:'Tags',exact:true}).click();
      let modal=page.getByRole('dialog',{name:'Account tags',exact:true});
      const input=modal.getByRole('textbox',{name:'Tags',exact:true});
      await input.fill('x'.repeat(25));
      assert.equal(await modal.getByRole('button',{name:'Save tags',exact:true}).isDisabled(),true);
      await modal.getByRole('alert').waitFor();
      await input.fill('work, Client, Work');
      await page.screenshot({path:path.join(output,`tag-editor-${width}.png`)});
      await page.evaluate(()=>{window.__failTagSave=true;});
      await modal.getByRole('button',{name:'Save tags',exact:true}).click();
      await modal.getByRole('alert').filter({hasText:'Storage full'}).waitFor();
      assert.equal(await input.inputValue(),'work, Client, Work','Failed saves retain the draft');
      await modal.getByRole('button',{name:'Save tags',exact:true}).click();
      await modal.waitFor({state:'hidden'});
      await filter.selectOption('client');
      assert.equal(await cards.count(),1);
      await page.reload();await page.locator('#dashboard-main').waitFor();
      assert.equal(await filter.inputValue(),'client','Tag filter survives reload');
      await page.waitForFunction(()=>document.querySelector('.saved-account-tags')?.title==='Work, Client');
      await cards.first().locator('.saved-account-tags').click();
      modal=page.getByRole('dialog',{name:'Account tags',exact:true});
      await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:false}})));
      await modal.getByRole('alert').filter({hasText:'Offline'}).waitFor();
      assert.equal(await modal.getByRole('button',{name:'Save tags',exact:true}).isDisabled(),true);
      await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:true}})));
      await modal.getByRole('textbox',{name:'Tags',exact:true}).fill('Work, Client, Review');
      await page.clock.install();
      await page.evaluate(()=>{window.__loseTagAck=true;});
      await modal.getByRole('button',{name:'Save tags',exact:true}).click();
      await page.waitForFunction(()=>window.__heldTagResult);
      await page.clock.fastForward(35_000);
      await modal.getByRole('alert').filter({hasText:'timed out'}).waitFor();
      assert.equal(await modal.getByRole('textbox',{name:'Tags',exact:true}).inputValue(),'Work, Client, Review');
      const saves=await page.evaluate(()=>window.__uiActions.filter(message=>message.action==='setAccountTags').length);
      await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:window.__heldTagResult})));
      await modal.waitFor({state:'hidden'});
      assert.equal(await page.evaluate(()=>window.__uiActions.filter(message=>message.action==='setAccountTags').length),saves,'Lost acknowledgements never replay a save automatically');
      await page.getByRole('button',{name:'Table view',exact:true}).click();
      await page.locator('.saved-table-row .saved-account-tags').waitFor();
      await page.locator('#privacyToggleButton').click();
      await page.waitForFunction(()=>window.__uiActions.some(message=>message.action==='setPrivacyMode'));
      const openManager=async()=>{await page.getByRole('button',{name:'More',exact:true}).click();await page.getByRole('menuitem',{name:'Tags',exact:true}).click();};
      await openManager();
      let manager=page.getByRole('dialog',{name:'Tags',exact:true});
      await manager.getByRole('searchbox',{name:'Find tags',exact:true}).fill('no-such-tag');
      await manager.getByText('No matching tags.',{exact:true}).waitFor();
      await manager.getByRole('searchbox',{name:'Find tags',exact:true}).fill('');
      await manager.getByRole('button',{name:'Disable accounts tagged Work',exact:true}).click();
      await page.evaluate(()=>{window.__failTagManage=true;});
      await manager.getByRole('button',{name:'Confirm',exact:true}).click();
      await manager.getByRole('status').filter({hasText:'membership changed'}).waitFor();
      await manager.getByRole('button',{name:'Confirm',exact:true}).click();
      await manager.locator('.tag-manager-entry').filter({has:page.getByText('Work',{exact:true})}).getByText('1 account · 0 enabled',{exact:true}).waitFor();
      await manager.getByRole('button',{name:'Enable accounts tagged Work',exact:true}).click();
      await manager.getByRole('button',{name:'Confirm',exact:true}).click();
      await manager.locator('.tag-manager-entry').filter({has:page.getByText('Work',{exact:true})}).getByText('1 account · 1 enabled',{exact:true}).waitFor();
      await manager.getByRole('button',{name:'Rename Work',exact:true}).click();
      await manager.getByRole('textbox',{name:'New tag name',exact:true}).fill('Client');
      await manager.getByRole('button',{name:'Rename tag',exact:true}).click();
      await manager.getByRole('button',{name:'Rename Work',exact:true}).waitFor({state:'hidden'});
      await manager.getByRole('button',{name:'Remove tag Review',exact:true}).click();
      await manager.getByRole('button',{name:'Cancel',exact:true}).click();
      await manager.getByRole('button',{name:'Remove tag Review',exact:true}).click();
      await manager.getByRole('button',{name:'Remove tag',exact:true}).click();
      await manager.getByRole('button',{name:'Remove tag Review',exact:true}).waitFor({state:'hidden'});
      await page.screenshot({path:path.join(output,`tag-manager-${width}.png`)});
      await manager.getByRole('button',{name:'Filter accounts by Client',exact:true}).click();
      await manager.waitFor({state:'hidden'});
      assert.equal(await filter.inputValue(),'client');
      await page.evaluate(()=>{
        const state=window.__uiSnapshot;
        state.connectedPeers=[{id:'fixture-local',name:'Local system',local:true,connected:true,sessionCount:2},{id:'fixture-system',name:'Remote system',connected:true,sessionCount:1}];
        state.accounts[0].tags=['Local only'];state.accounts[0].enabled=false;state.accounts[0].updatedAt=Date.now();
        state.peerAccounts={'fixture-system':[{...state.accounts[0],tags:['Remote only'],enabled:false,isActive:false,isCurrentWindowAccount:false}]};
        window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:snapshot',state}}));
      });
      const sidebarControl=page.getByRole('button',{name:'Show sessions sidebar',exact:true});
      if(await sidebarControl.isVisible()) await sidebarControl.click();
      await page.getByRole('button',{name:'Open account center',exact:true}).click();
      const center=page.getByRole('dialog',{name:'Account center',exact:true});
      await center.getByRole('combobox',{name:'Account system',exact:true}).selectOption('fixture-system');
      await page.keyboard.press('Escape');
      if(width<=760) { const hide=page.getByRole('button',{name:'Hide sessions sidebar',exact:true}); if(await hide.isVisible()) await hide.click(); }
      await page.locator('#privacyToggleButton').click();
      await openManager();manager=page.getByRole('dialog',{name:'Tags',exact:true});
      await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:false}})));
      await manager.getByRole('status').filter({hasText:'Offline'}).waitFor();
      assert.equal(await manager.getByRole('button',{name:'Enable accounts tagged Remote only',exact:true}).isDisabled(),true);
      await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:true}})));
      await manager.getByRole('button',{name:'Enable accounts tagged Remote only',exact:true}).click();
      await manager.getByRole('button',{name:'Confirm',exact:true}).click();
      await manager.getByText('1 account · 1 enabled',{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>window.__uiSnapshot.accounts[0].enabled),false,'Remote tag actions leave local accounts unchanged');
      assert.equal(await page.evaluate(()=>window.__uiActions.filter(message=>message.action==='manageAccountTag').at(-1).payload.targetDeviceId),'fixture-system');
      assert.equal(await page.evaluate(()=>window.__uiActions.filter(message=>message.action==='setPrivacyMode').at(-1).payload.targetDeviceId),undefined,'Mask changes stay on the browser host while viewing another PC');
      await manager.getByRole('button',{name:'Close tag management',exact:true}).click();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Tag toolbar and list stay within viewport');
      await page.screenshot({path:path.join(output,`tags-${width}.png`),fullPage:true});
      assert.deepEqual(errors,[],'Tag UI runtime errors');
      results.push({width,height,checks:'Header mask, compact editor/chips/filter, validation/reload/lost ack/offline, manager search/rename/merge/delete/enable/disable, frozen system scope'});
      await context.close();continue;
    }
    if (process.argv.includes('--branding')) {
      const positions=[];
      for(const [name,route,header] of [['dashboard','/','.hero'],['board','/tasks','.task-board-header'],['welcome','/workspace','.cli-content-toolbar'],['session',`/workspace/${parentId}`,'.cli-conversation-header']]) {
        await page.goto(origin+route);
        await page.locator(header).waitFor({state:'visible'});
        const hide=page.getByRole('button',{name:'Hide sessions sidebar',exact:true});
        if(await hide.isVisible()) await hide.click();
        const toggle=page.getByRole('button',{name:'Show sessions sidebar',exact:true});
        await toggle.waitFor({state:'visible'});
        const bounds=await toggle.boundingBox(), bar=await page.locator(header).boundingBox(), image=await toggle.locator('img').boundingBox();
        assert.equal(await toggle.evaluate(element=>getComputedStyle(element).position),'static',`${name} logo stays in its header`);
        assert.equal(Math.round(bounds.width),28,`${name} toggle has a consistent width`);
        assert.equal(Math.round(bounds.height),28,`${name} toggle has a consistent height`);
        assert.ok(Math.abs(image.x+image.width/2-bounds.x-bounds.width/2)<=1 && Math.abs(image.y+image.height/2-bounds.y-bounds.height/2)<=1,`${name} logo is centered in its control`);
        assert.ok(bounds.x>=bar.x && bounds.x+bounds.width<=bar.x+bar.width && bounds.y>=bar.y && bounds.y+bounds.height<=bar.y+bar.height,`${name} logo fits inside its header`);
        if(width<=760) positions.push(bounds.x);
        if(name==='dashboard'&&width<=600){const content=await page.locator('.overview-shell').boundingBox();assert.ok(Math.abs(bounds.x-content.x)<=4,'Mobile logo aligns with dashboard content');}
        await page.screenshot({path:path.join(output,`${name}-brand-${width}.png`)});
        await toggle.click();
        await page.getByRole('button',{name:'Hide sessions sidebar',exact:true}).waitFor({state:'visible'});
        await page.getByRole('button',{name:'Hide sessions sidebar',exact:true}).click();
        await toggle.waitFor({state:'visible'});
      }
      assert.ok(!positions.length||Math.max(...positions)-Math.min(...positions)<=2,'Mobile content logos use the same left inset');
      assert.deepEqual(errors,[]);results.push({width,height,checks:'Collapsed logo alignment, centering and open/close across dashboard, board, welcome and session'});await context.close();continue;
    }
    if (process.argv.includes('--api') || process.argv.includes('--lists')) {
      await checkListsApiUi(page,{origin,width,height,output,api:process.argv.includes('--api')});
      assert.deepEqual(errors,[]);results.push({width,height,checks:process.argv.includes('--api')?'API creation, stale list, unknown confirmation, refresh recovery, late result isolation':'Sidebar, board and table loading on scroll; search reaches unloaded rows'});
      await context.close();continue;
    }
    if (process.argv.includes('--systems')) {
      await page.goto(`${origin}/?device=missing-system`);
      await page.locator('#dashboard-main').waitFor();
      await page.locator('.cli-rail-toggle').waitFor();
      const missingRail=page.getByRole('button',{name:'Show sessions sidebar',exact:true});
      if(await missingRail.isVisible()) await missingRail.click();
      await page.waitForFunction(()=>window.__uiActions.some(message=>message.type==='dashboard:workspace-presence'&&message.targetDeviceId==='missing-system'));
      assert.equal(await page.getByRole('combobox',{name:'System',exact:true}).inputValue(),'missing-system','An undiscovered system never falls back to local data');
      await page.goto(`${origin}/`);
      await page.locator('#dashboard-main').waitFor();
      await page.waitForFunction(()=>window.__uiActions.some(message=>message.type==='dashboard:workspace-presence'&&message.viewing===true));
      await page.evaluate(()=>{
        Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForFunction(()=>window.__uiActions.filter(message=>message.type==='dashboard:workspace-presence').at(-1)?.viewing===false);
      await page.evaluate(()=>{
        Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForFunction(()=>window.__uiActions.filter(message=>message.type==='dashboard:workspace-presence').at(-1)?.viewing===true);
      await page.evaluate(() => {
        window.__systemFixture=true;
        const state=window.__uiSnapshot, template=state.accounts[0];
        state.settings.privacyMode=false;
        state.connectedPeers=[{id:'fixture-local',name:'Local system',local:true,connected:true,sessionCount:2},{id:'fixture-system',name:'Remote system',connected:true,sessionCount:1}];
        state.peerAccounts={'fixture-system':[{...template,id:'remote-account',displayName:'Remote identity',email:'remote@example.test',isActive:true,isCurrentWindowAccount:true}]};
        window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:snapshot',state}}));
      });
      const rail=async()=>{const show=page.getByRole('button',{name:'Show sessions sidebar',exact:true});if(await show.isVisible())await show.click();};
      await rail();
      const picker=page.getByRole('combobox',{name:'System',exact:true});
      await picker.selectOption('fixture-system');
      await page.waitForFunction(()=>window.__uiActions.filter(message=>message.type==='dashboard:workspace-presence').at(-1)?.targetDeviceId==='fixture-system');
      await page.waitForFunction(()=>window.__uiActions.some(action=>action.action==='listCodexCliSessions'&&action.payload?.targetDeviceId==='fixture-system'));
      await page.getByRole('button',{name:'Expand remote-project',exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'Expand demo',exact:true}).count(),0,'Local projects stay outside remote context');
      assert.equal(await page.locator('.cli-pc-group-heading').count(),0,'System context is not repeated in the session tree');
      await page.waitForFunction(()=>new URL(location.href).searchParams.get('device')==='fixture-system');
      await page.getByRole('button',{name:'Project task board',exact:true}).click();
      await page.waitForFunction(()=>location.pathname==='/tasks'&&new URL(location.href).searchParams.get('device')==='fixture-system');
      await page.goBack();
      await page.waitForFunction(()=>location.pathname==='/'&&new URL(location.href).searchParams.get('device')==='fixture-system');
      await rail();
      assert.equal(await picker.inputValue(),'fixture-system','Browser history retains the selected system');

      const sidebarControl=page.getByRole('button',{name:'Show sessions sidebar',exact:true});
      if(await sidebarControl.isVisible()) await sidebarControl.click();
      await page.getByRole('button',{name:'Open account center',exact:true}).click();
      const center=page.getByRole('dialog',{name:'Account center',exact:true});
      assert.equal(await center.getByRole('combobox',{name:'Account system',exact:true}).inputValue(),'fixture-system');
      await center.getByText('Remote identity',{exact:true}).waitFor();
      await page.keyboard.press('Escape');
      await picker.selectOption('fixture-local');
      await page.waitForFunction(()=>!window.__uiActions.filter(message=>message.type==='dashboard:workspace-presence').at(-1)?.targetDeviceId);
      await page.getByRole('button',{name:'Expand demo',exact:true}).waitFor();
      if(width!==320) await page.waitForFunction(()=>new Promise(resolve=>{
        const request=indexedDB.open('codex-manager-cache');
        request.onsuccess=()=>{const db=request.result,read=db.transaction('cli-sessions').objectStore('cli-sessions').get('accounts:fixture-system');read.onsuccess=()=>{const saved=read.result?.value;db.close();resolve(Array.isArray(saved)&&saved.some(account=>account.id==='remote-account'));};};
      }));
      await page.evaluate(()=>{
        window.__holdNextSystemList=true;window.__heldSystemList=undefined;window.__scopeFrames=[];window.__recordScopeFrames=true;
        const frame=()=>{if(!window.__recordScopeFrames)return;const selected=document.querySelector('.cli-rail-system select')?.value;
          if(selected==='fixture-system')window.__scopeFrames.push({remote:!!document.querySelector('[aria-label="Expand remote-project"],[aria-label="Collapse remote-project"]'),local:!!document.querySelector('[aria-label="Expand demo"],[aria-label="Collapse demo"]')});requestAnimationFrame(frame);};requestAnimationFrame(frame);
      });
      await picker.selectOption('fixture-system');
      await page.waitForFunction(()=>!!window.__heldSystemList);
      await page.waitForTimeout(80);
      const frames=await page.evaluate(()=>{window.__recordScopeFrames=false;return window.__scopeFrames;});
      assert.ok(frames.length>0);assert.equal(frames.filter(frame=>!frame.remote||frame.local).length,0,'A warm system switch never paints an empty or wrong-system list while its response is held');
      await picker.selectOption('fixture-local');
      await page.getByRole('button',{name:'Expand demo',exact:true}).waitFor();
      await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:window.__heldSystemList})));
      await page.getByRole('button',{name:'New chat',exact:true}).click();
      const projectPicker=page.getByRole('combobox',{name:'Project',exact:true});
      assert.equal(await projectPicker.locator('option[value="E:/remote-project"]').count(),0,'Delayed remote catalogs do not change local new-chat projects');
      await rail();await picker.selectOption('fixture-system');
      await page.getByRole('button',{name:'Expand remote-project',exact:true}).click();
      await page.locator('.cli-session-row-select').filter({hasText:'Remote system session'}).click();
      await page.getByText('Remote system conversation',{exact:true}).waitFor();
      await page.evaluate(()=>{
        window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:action-result',action:'listCodexCliSessions',requestId:'partial-remote',status:'completed',payload:{cliSessionsDeviceId:'fixture-system',cliSessionsPartial:true,cliSessions:[],realtimeRevision:Date.now()}}}));
      });
      await page.getByText('Remote system conversation',{exact:true}).waitFor();
      assert.ok(new URL(page.url()).pathname !== '/workspace','Partial peer pushes retain the current conversation');
      await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:action-result',action:'listCodexCliSessions',requestId:'realtime-peer-legacy-empty',status:'completed',payload:{cliSessionsDeviceId:'fixture-system',cliSessions:[],realtimeRevision:Date.now()+1}}})));
      await page.getByText('Remote system conversation',{exact:true}).waitFor();
      assert.ok(new URL(page.url()).pathname !== '/workspace','Legacy heartbeat pushes cannot delete the route');

      assert.ok(new URL(page.url()).searchParams.get('device')==='fixture-system','Remote conversation retains system in browser URL');
      const showRemoteTools=page.getByRole('button',{name:'Show workspace tools',exact:true});
      if(await showRemoteTools.isVisible()) await showRemoteTools.click();
      await page.waitForFunction(()=>window.__uiActions.some(action=>action.action==='getWorkspaceEnvironment'&&action.payload?.targetDeviceId==='fixture-system'&&action.payload?.projectPath==='E:/remote-project'));
      await page.evaluate(()=>{window.__uiSnapshot.connectedPeers[1].connected=false;window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:snapshot',state:window.__uiSnapshot}}));});
      await page.getByText('Reconnecting',{exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'Send message',exact:true}).count(),0,'Remote disconnect removes execution controls while browser stays online');
      assert.deepEqual(errors,[]);
      results.push({width,height,checks:'Remote accounts, session lists, catalogs, stale replies, browser URL, workspace routing, peer offline'});
      await context.close();continue;
    }
    if (process.argv.includes('--maintenance')) {
      await checkMaintenanceUi(page, {origin,width,height,output});
      assert.deepEqual(errors, [], 'Maintenance browser runtime errors');
      results.push({width,height,checks:'Event-driven progress, no hidden polling, source/revision guards, missing acknowledgement, cancellation, reconnect/restart, explicit search'});
      await context.close(); continue;
    }
    if (process.argv.includes('--inspector')) {
      await checkInspectorUi(page, {origin,parentId,width,height,output});
      assert.deepEqual(errors, [], 'Inspector browser runtime errors');
      assert.deepEqual(errors,[], 'Inspector browser runtime errors');
      results.push({width,height,checks:'Fixed Env, Git, scoped drafts/results, file revision conflicts, pending saves, top-layer tools, terminal lifecycle, offline/reconnect'});
      await context.close(); continue;
    }
    if (process.argv.includes('--queue')) {
      await page.goto(`${origin}/`);
      await page.locator('#cliSessionsButton').waitFor();
      await page.evaluate(() => {
        window.__uiSessions.push({id:'recovery',title:'Interrupted workspace task',status:'idle',interrupted:true,projectPath:'D:/demo'});
        window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:action-result',requestId:'dashboard-auto-fixture',action:'listCodexCliSessions',status:'completed',payload:{cliSessions:window.__uiSessions}}}));
      });
      await page.locator('#cliSessionsButton').click();
      assert.equal(await page.locator(".cli-sessions-manage").count(), 0, "Browser flyouts omit the Session dashboard footer");
      const row = page.locator('.cli-sessions-running-row').filter({hasText:'Interrupted workspace task'});
      const trigger = row.getByRole('button',{name:'Queue priority for Interrupted workspace task',exact:true});
      const panel = page.getByRole('dialog',{name:'Queue Interrupted workspace task',exact:true});
      const field = panel.getByRole('spinbutton',{name:'Queue priority',exact:true});
      const layoutBefore = await row.boundingBox();
      const iconSizes = await page.locator('.cli-sessions-running-row .cli-icon-button svg').evaluateAll(icons=>icons.map(icon=>[icon.getBoundingClientRect().width,icon.getBoundingClientRect().height]));
      assert.ok(iconSizes.length>=2 && iconSizes.every(([w,h])=>w===16&&h===16),'Running and queued session icons have identical dimensions');
      await trigger.click();
      assert.deepEqual(await row.boundingBox(),layoutBefore,'Opening the priority control never shifts session content');
      assert.equal(await panel.evaluate(node=>node.matches(':popover-open')),true,'Queue controls use the top layer');
      await panel.getByRole('button',{name:'Priority 1 First',exact:true}).click();
      assert.equal(await field.inputValue(),'1');
      for(const invalid of ['', '0', '-1', '1.5', '9007199254740992']) {
        await field.fill(invalid); assert.equal(await panel.getByRole('button',{name:'Queue session',exact:true}).isDisabled(),true);
      }
      await field.fill('19');
      let box = await panel.boundingBox();
      assert.ok(box.x>=8&&box.y>=8&&box.x+box.width<=width-7&&box.y+box.height<=height-7,'Priority control fits viewport');
      assert.equal(await panel.evaluate(node=>{const r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.left+10,r.top+10));}),true,'Priority control is above its parent container');
      await page.evaluate(() => {
        window.__queueViewport=window.visualViewport;
        Object.defineProperty(window,'visualViewport',{configurable:true,value:{offsetLeft:innerWidth-Math.min(innerWidth,300),offsetTop:0,width:Math.min(innerWidth,300),height:210}});
        window.dispatchEvent(new Event('resize'));
      });
      await page.waitForFunction(()=>{const node=document.querySelector('.cli-session-queue-menu'),r=node?.getBoundingClientRect(),v=visualViewport;return r&&r.left>=v.offsetLeft+8&&r.right<=v.offsetLeft+v.width-8&&r.top>=8&&r.bottom<=v.height-8;});
      await page.evaluate(()=>{Object.defineProperty(window,'visualViewport',{configurable:true,value:window.__queueViewport});window.dispatchEvent(new Event('resize'));});
      await page.keyboard.press('Escape');
      assert.equal(await panel.count(),0); assert.equal(await trigger.evaluate(node=>node===document.activeElement),true);
      assert.equal(await page.locator('.cli-sessions-popover').count(),1,'Escape only closes the nested flyout');
      await trigger.click(); await field.fill('19'); await field.press('Enter');
      await page.waitForFunction(()=>window.__uiSessions.find(s=>s.id==='recovery')?.queuePriority===19);
      await trigger.click(); assert.equal(await field.inputValue(),'19');
      await field.fill('2'); await panel.getByRole('button',{name:'Save priority',exact:true}).click();
      await page.waitForFunction(()=>window.__uiSessions.find(s=>s.id==='recovery')?.queuePriority===2);
      await trigger.click();
      await page.screenshot({path:path.join(output,`queue-options-${width}x${height}.png`)});
      if (width===1440 || width===390) {
        const previousTheme=await page.evaluate(()=>{const value=document.documentElement.dataset.theme;document.documentElement.dataset.theme='dark';return value;});
        await page.screenshot({path:path.join(output,`queue-options-dark-${width}x${height}.png`),animations:'disabled'});
        await page.evaluate(value=>{document.documentElement.dataset.theme=value;},previousTheme);
      }
      await panel.getByRole('button',{name:'Remove from queue',exact:true}).click();
      await page.waitForFunction(()=>window.__uiSessions.find(s=>s.id==='recovery')?.queueEnabled===false);
      await page.evaluate(()=>{window.__failQueue=true;});
      await trigger.click(); await panel.getByRole('button',{name:'Queue session',exact:true}).click();
      await page.getByText('The session queue is full. Remove an entry before adding another.',{exact:true}).filter({visible:true}).first().waitFor();
      assert.equal(await page.evaluate(()=>window.__uiSessions.find(s=>s.id==='recovery')?.queueEnabled),false,'A failed queue action is never shown as saved');
      if(!await page.locator('.cli-sessions-popover').count()) await page.locator('#cliSessionsButton').click();
      await trigger.click();
      await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:false}})));
      await panel.waitFor({state:'detached'}); assert.equal(await trigger.isDisabled(),true,'Disconnect closes and disables queue controls');
      await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:true}})));
      await page.waitForFunction(()=>!document.querySelector('.cli-sessions-running-row .cli-session-queue-wrap button')?.disabled);
      await trigger.click();
      await page.getByRole('button',{name:'Close queue options',exact:true}).click();
      await page.evaluate(()=>{window.__failQueue=false;window.__sessionRefreshNotice=true;});
      await trigger.click();await panel.getByRole('button',{name:'Queue session',exact:true}).click();
      const refreshWarning=page.locator('.dashboard-notice').filter({hasText:'The session action completed, but the session list could not refresh:'});
      await refreshWarning.waitFor();assert.equal(await page.locator('.dashboard-notice').count(),1,'Manual partial success has one toast');
      assert.equal(await page.locator('.cli-sessions-list-status').count(),0,'A mutation refresh warning never becomes an inline session-list error');
      await page.waitForTimeout(3100);assert.ok(await refreshWarning.isVisible(),'The warning outlasts short informational toasts');
      await page.getByRole('button',{name:'Dismiss notification',exact:true}).click();
      await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:action-result',requestId:'dashboard-auto-refresh-warning',action:'setCodexSessionQueue',status:'completed',payload:{notice:{level:'warning',message:'The session action completed, but the session list could not refresh: automatic inspection pending.'}}}})));
      await page.waitForTimeout(100);assert.equal(await page.locator('.dashboard-notice').count(),0,'Automatic acknowledgements stay quiet');
      if(!await page.locator('.cli-sessions-popover').count()) await page.locator('#cliSessionsButton').click();
      const nativeActionsBefore = await page.evaluate(() => window.__uiActions.filter(item => ['resumeCodexSessions','openCodexCliSession'].includes(item.action)).length);
      await row.locator('.cli-sessions-running-title').click();
      await page.waitForURL('**/workspace/recovery');
      assert.equal(await page.evaluate(() => window.__uiActions.filter(item => ['resumeCodexSessions','openCodexCliSession'].includes(item.action)).length), nativeActionsBefore, 'Opening an interrupted conversation in browsers never resumes it or launches VS Code');
      assert.equal(await page.locator('.cli-session-message').filter({hasText:'The session action completed, but the session list could not refresh:'}).count(),0,'Refresh warnings are never conversation messages');
      assert.deepEqual(errors,[]);
      results.push({width,height,checks:'Top-layer queue, no layout shift, consistent icons, validation, keyboard, custom priority, update/remove, queue full, disconnect/reconnect'});
      await context.close(); continue;
    }
    if (process.argv.includes('--account-warning')) {
      await page.goto(`${origin}/`);
      await page.locator('#dashboard-main').waitFor();
      await page.evaluate(() => {
        const state = window.__uiSnapshot, template = state.accounts[0];
        const active = { ...template, id: 'warning-active', email: 'active@example.com', enabled: true, isActive: true, isCurrentWindowAccount: true, runningOnThisDevice: true, runningDeviceName: undefined, switchQueued: false, hasQuota402: false, healthKind: 'healthy', hasQuotaError: false, hasPendingResetCreditAttempt: false, lastQuotaAt: Date.now()-10000, sessionStartedAt: undefined, subscriptionExpiresAt: Date.now()/1000+30*86400, resetCreditsAvailable: 2, metrics: [{key:'hourly',period:'hourly',visible:true,percentage:90},{key:'weekly',period:'weekly',visible:true,percentage:90}] };
        const ready = { ...active, id: 'warning-ready', email: 'ready@example.com', isActive: false, isCurrentWindowAccount: false, runningOnThisDevice: false };
        state.accounts = [active, ready];
        state.connectedPeers = [{id:'fixture-local',name:'This PC',local:true,connected:true,sessionCount:2},{id:'warning-remote',name:'Remote PC',connected:true,sessionCount:0}];
        state.peerAccounts = { 'warning-remote': [{...ready,id:'remote-ready',email:'remote@example.com'}] };
        window.dispatchEvent(new MessageEvent('message', {data:{type:'dashboard:snapshot',state}}));
      });
      await selectSidebarSystem(page, width, 'warning-remote');
      const warn = async (targetDeviceId = 'local') => page.evaluate(targetDeviceId => {
        window.dispatchEvent(new MessageEvent('message', {data:{type:'dashboard:notice',notificationId:'warning-'+targetDeviceId,level:'warning',message:'Account quota is low.',actions:['Switch account','Select Account','Later'],actionPrompt:{kind:'quotaWarning',targetDeviceId,accountId:'warning-active',message:'Account quota is low.',switchAccountId:targetDeviceId==='local'?'warning-ready':'remote-ready',switchLabel:'Switch account',resetLabel:'Reset usage',selectLabel:'Select Account',laterLabel:'Later'}}}));
      }, targetDeviceId);
      const warning = page.getByRole('dialog', {name:'Quota warning',exact:true});
      await warn();
      await warning.waitFor();
      assert.equal(await page.getByText('Account quota is low.',{exact:true}).count(),1,'The actionable warning is not duplicated in a toast');
      assert.equal(await warning.getByRole('button',{name:'Later',exact:true}).count(),0,'Account warnings have no Later button');
      await warning.getByRole('button',{name:'Select Account',exact:true}).click();
      const picker = page.getByRole('dialog',{name:'Switch account',exact:true});
      await picker.waitFor();
      assert.equal(await picker.getByRole('option').count(),1,'The browser picker lists capable accounts on the warning system');
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:notification-dismissed',notificationId:'warning-local'}})));
      assert.equal(await picker.isVisible(),true,'A native dismissal cannot close the replacement browser picker');
      assert.ok(await page.evaluate(() => window.__uiActions.some(message => message.type==='dashboard:notification-response' && message.notificationId==='warning-local' && message.action===undefined)), 'The browser dismisses the native choice without executing it');
      await page.evaluate(() => { window.__holdNextSwitch=true; window.__heldSwitch=undefined; });
      await picker.getByRole('option').click();
      await page.waitForFunction(() => !!window.__heldSwitch);
      assert.deepEqual(await page.evaluate(() => ({account:window.__heldSwitch.accountId,target:window.__heldSwitch.payload?.targetDeviceId??'local'})),{account:'warning-ready',target:'local'},'A local warning stays local while the dashboard displays another PC');
      const failSwitch = async () => page.evaluate(() => { const request=window.__heldSwitch; window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:action-result',requestId:request.requestId,action:'switch',accountId:request.accountId,status:'failed',error:'Switch was not confirmed. No test account was changed.'}})); });
      await failSwitch();
      await warn('warning-remote');
      await warning.getByRole('button',{name:'Select Account',exact:true}).click();
      await picker.waitFor();
      await page.evaluate(() => { window.__holdNextSwitch=true; window.__heldSwitch=undefined; });
      await picker.getByRole('option').click();
      await page.waitForFunction(() => !!window.__heldSwitch);
      assert.deepEqual(await page.evaluate(() => ({account:window.__heldSwitch.accountId,target:window.__heldSwitch.payload?.targetDeviceId})),{account:'remote-ready',target:'warning-remote'},'Remote warnings retain their originating PC');
      await failSwitch();
      await warn();
      const resetsBefore=await page.evaluate(()=>window.__uiActions.filter(message=>message.action==='consumeResetCredit').length);
      await warning.getByRole('button',{name:'Reset usage',exact:true}).click();
      const reset=page.getByRole('dialog',{name:'Reset your usage?',exact:true});
      await reset.waitFor();
      await reset.getByRole('button',{name:'Cancel',exact:true}).click();
      assert.equal(await page.evaluate(()=>window.__uiActions.filter(message=>message.action==='consumeResetCredit').length),resetsBefore,'Cancelling a reset from the warning consumes no credit');
      await page.evaluate(() => { window.__uiSnapshot.peerAccounts['warning-remote'][0].runningDeviceName='Another PC'; window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:snapshot',state:window.__uiSnapshot}})); });
      await warn('warning-remote');
      await warning.getByRole('button',{name:'Switch account',exact:true}).click();
      const rescue=page.getByRole('dialog',{name:'Switch claimed account',exact:true});
      await rescue.waitFor();
      await rescue.getByLabel('Password',{exact:true}).fill('fixture-only-password');
      await page.evaluate(() => { window.__holdNextSwitch=true; window.__heldSwitch=undefined; });
      await rescue.getByRole('button',{name:'Continue',exact:true}).click();
      await page.waitForFunction(() => !!window.__heldSwitch);
      assert.equal(await page.evaluate(()=>window.__heldSwitch.payload.targetDeviceId),'warning-remote','Rescue stays in the browser and targets the same PC');
      await failSwitch();
      await warn('warning-remote');
      await page.evaluate(() => { window.__uiSnapshot.connectedPeers[1].connected=false; window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:snapshot',state:window.__uiSnapshot}})); });
      const switchesBefore=await page.evaluate(()=>window.__uiActions.filter(message=>message.action==='switch').length);
      await warning.getByRole('button',{name:'Select Account',exact:true}).click();
      await page.getByText('This system is offline. Reconnect it before switching accounts.',{exact:true}).waitFor();
      assert.equal(await picker.count(),0,'Offline systems never open a native or stale picker');
      assert.equal(await page.evaluate(()=>window.__uiActions.filter(message=>message.action==='switch').length),switchesBefore);
      await warn();
      await page.screenshot({path:path.join(output,`account-warning-${width}x${height}.png`)});
      await warning.getByRole('button',{name:snapshot.copy.closeModal,exact:true}).click();
      await page.evaluate(() => { window.__uiSnapshot.accounts[1].enabled=false; window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:snapshot',state:window.__uiSnapshot}})); });
      await warn();
      await warning.getByRole('button',{name:'Select Account',exact:true}).click();
      await page.getByText('No account to switch — no capable account has enough quota remaining.',{exact:true}).waitFor();
      assert.equal(await picker.count(),0,'Missing or unavailable candidates never fall back to a native picker');
      assert.deepEqual(errors,[],'Browser account warning runtime errors');
      results.push({width,height,checks:'No Later, browser picker, local/remote affinity, claimed-account password, reset cancellation, offline target'});
      await context.close(); continue;
    }
    if (process.argv.includes('--share-menu')) {
      await page.goto(`${origin}/tasks`);
      await page.locator('.task-board-card').first().waitFor();
      assert.equal(await page.getByRole('button', { name: 'Share project', exact: true }).count(), 0);
      const boardActions = page.getByRole('button', { name: 'Board actions', exact: true });
      assert.ok(await page.locator('.task-board-toolbar').evaluate(el=>Boolean(el.lastElementChild?.querySelector('[aria-label="Board actions"]') || el.lastElementChild?.matches('[aria-label="Board actions"]'))), 'Board actions are last in the header');
      const contextHeight=await page.locator('.task-context-tabs').evaluate(el=>el.getBoundingClientRect().height);
      const viewHeight=await page.locator('.task-view-tabs').evaluate(el=>el.getBoundingClientRect().height);
      assert.ok(Math.abs(contextHeight-viewHeight)<=2,'Context selectors match the view tab track');
      await boardActions.focus(); await page.keyboard.press('Enter');
      const boardShare = page.getByRole('menuitem', { name: 'Share project', exact: true });
      assert.equal(await boardShare.locator('svg').count(), 1);
      const boardMenu = await page.getByRole('menu', { name: 'Board actions', exact: true }).boundingBox();
      assert.ok(boardMenu.x >= 0 && boardMenu.x + boardMenu.width <= width, 'Board actions stay inside the viewport');
      await page.screenshot({ path: path.join(output, `board-share-menu-${width}x${height}.png`) });
      await boardShare.click();
      const projectDialog = page.getByRole('dialog', { name: 'Share project', exact: true });
      await projectDialog.waitFor();
      assert.equal(await page.getByRole('menu', { name: 'Board actions', exact: true }).count(), 0);
      const checkAll = projectDialog.getByRole('checkbox', { name: 'Check all', exact: true });
      assert.equal(await checkAll.evaluate(input => input.indeterminate), true);
      await checkAll.check();
      await projectDialog.getByRole('checkbox', { name: /Allow embedding/ }).uncheck();
      assert.equal(await checkAll.evaluate(input => input.indeterminate), true, 'Selecting all keeps individual choices editable');
      if (width === 1440) {
        await page.evaluate(() => { window.__partialProjectShare = true; });
        await projectDialog.getByRole('button', { name: 'Create link', exact: true }).click();
        await projectDialog.getByRole('alert').filter({ hasText: 'Link creation was not confirmed' }).waitFor();
        assert.equal(await projectDialog.getByRole('textbox', { name: 'Public link', exact: true }).count(), 0);
        await page.evaluate(() => { window.__partialProjectShare = false; });
      }
      await page.evaluate(() => { window.__holdProjectShare = true; });
      const createsBefore = await page.evaluate(() => window.__uiActions.filter(action => action.action === 'shareProjectBoard').length);
      await projectDialog.getByRole('button', { name: 'Create link', exact: true }).click();
      await page.waitForFunction(() => !!window.__heldProjectShareResult);
      await page.keyboard.press('Escape');
      assert.equal(await projectDialog.isVisible(), true, 'A pending project link keeps its initiating dialog open');
      assert.equal(await projectDialog.getByRole('button', { name: 'Close', exact: true }).isDisabled(), true);
      assert.equal(await checkAll.isDisabled(), true);
      assert.equal(await page.evaluate(() => window.__uiActions.filter(action => action.action === 'shareProjectBoard').length), createsBefore + 1);
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: window.__heldProjectShareResult })));
      await projectDialog.getByRole('textbox', { name: 'Public link', exact: true }).waitFor();
      await projectDialog.getByRole('button', { name: 'Copy shared link', exact: true }).click();
      await projectDialog.getByRole('status').filter({ hasText: 'Shared link copied.' }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${origin}/projects/share/${'b'.repeat(64)}`);
      const revokesBefore = await page.evaluate(() => window.__uiActions.filter(action => action.action === 'revokeProjectShares').length);
      await projectDialog.getByRole('button', { name: 'Revoke all project links', exact: true }).click();
      const projectReview = projectDialog.getByRole('group', { name: 'Confirm link revocation', exact: true });
      assert.equal(await projectReview.getByRole('button', { name: 'Cancel', exact: true }).evaluate(element => document.activeElement === element), true, 'Revocation review focuses the safe action');
      await projectReview.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(await projectDialog.getByRole('button', { name: 'Revoke all project links', exact: true }).evaluate(element => document.activeElement === element), true, 'Cancel restores the initiating control');
      assert.equal(await page.evaluate(() => window.__uiActions.filter(action => action.action === 'revokeProjectShares').length), revokesBefore, 'Cancelling revocation sends no mutation');
      await page.screenshot({ path: path.join(output, `project-share-dialog-${width}x${height}.png`) });
      if (width === 1440 || width === 390) {
        const previousTheme = await page.evaluate(() => { const value = document.documentElement.dataset.theme; document.documentElement.dataset.theme = 'dark'; return value; });
        await page.screenshot({ path: path.join(output, `project-share-dialog-dark-${width}x${height}.png`), animations: 'disabled' });
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, previousTheme);
      }
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:connection', connected: false } })));
      assert.equal(await projectDialog.getByRole('button', { name: 'Create link', exact: true }).isDisabled(), true);
      assert.equal(await projectDialog.getByRole('button', { name: 'Revoke all project links', exact: true }).isDisabled(), true);
      assert.equal(await projectDialog.getByRole('checkbox', { name: /Allow embedding/ }).isChecked(), false, 'Offline transitions preserve permission choices');
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:connection', connected: true } })));
      await projectDialog.getByRole('button', { name: 'Revoke all project links', exact: true }).click();
      if (width === 1440) {
        await page.evaluate(() => { window.__failProjectRevoke = true; });
        await projectReview.getByRole('button', { name: 'Revoke access', exact: true }).click();
        await projectDialog.getByRole('alert').filter({ hasText: 'Revocation was not confirmed.' }).waitFor();
        assert.equal(await projectReview.isVisible(), true, 'An unconfirmed revoke preserves the review and link');
        await page.evaluate(() => { window.__failProjectRevoke = false; });
      }
      if (width === 1440) {
        await page.evaluate(() => { window.__beforePendingCopy = navigator.clipboard; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise(resolve => { window.__resolvePendingCopy = resolve; }) } }); });
        await projectDialog.getByRole('button', { name: 'Link copied', exact: true }).click();
      }
      await projectReview.getByRole('button', { name: 'Revoke access', exact: true }).click();
      await projectDialog.getByRole('status').filter({ hasText: 'All project links revoked.' }).waitFor();
      assert.equal(await projectDialog.getByRole('textbox', { name: 'Public link', exact: true }).count(), 0);
      if (width === 1440) {
        await page.evaluate(async () => { window.__resolvePendingCopy(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: window.__beforePendingCopy }); await new Promise(resolve => requestAnimationFrame(resolve)); });
        assert.ok((await projectDialog.getByRole('status').textContent()).includes('All project links revoked.'), 'A late clipboard result cannot replace the revocation outcome');
      }
      await page.keyboard.press('Escape');
      await page.goto(`${origin}/workspace`);
      if (width <= 760) await page.getByRole('button', { name: 'Show sessions sidebar', exact: true }).click();
      await page.getByRole('button', { name: 'Expand demo', exact: true }).click();
      await page.locator('.cli-session-row-select').filter({ hasText: 'Evaluate stack' }).click();
      await page.getByRole('textbox', { name: 'Message Codex', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Share', exact: true }).count(), 0);
      const sessionActions = page.getByRole('button', { name: 'Session actions', exact: true });
      await sessionActions.focus(); await page.keyboard.press('Enter');
      await page.getByRole('menuitem',{name:'Open in Codex',exact:true}).click();
      await page.waitForFunction(id=>window.__uiActions.some(action=>action.action==='openCodexCliSession'&&action.payload.sessionId===id),parentId);
      await page.locator('.dashboard-notice').filter({hasText:'Opened in VS Code.'}).waitFor();
      await page.getByRole('button',{name:'Dismiss notification',exact:true}).click();
      await sessionActions.click();
      const sessionShare = page.getByRole('menuitem', { name: 'Share', exact: true });
      assert.equal(await sessionShare.locator('svg').count(), 1);
      const sessionMenu = await page.getByRole('menu').boundingBox();
      assert.ok(sessionMenu.x >= 0 && sessionMenu.x + sessionMenu.width <= width, 'Session actions stay inside the viewport');
      await page.screenshot({ path: path.join(output, `session-share-menu-${width}x${height}.png`) });
      await sessionShare.click();
      await page.getByRole('dialog', { name: 'Share session', exact: true }).waitFor();
      assert.equal(await page.getByRole('menu').count(), 0);
      await page.getByRole('button', { name: 'Create read-only link', exact: true }).click();
      await page.getByRole('textbox', { name: 'Session link', exact: true }).waitFor();
      assert.equal(shareRequests.length, 1);
      const sessionDialog = page.getByRole('dialog', { name: 'Share session', exact: true });
      await sessionDialog.getByRole('textbox', { name: 'Session link', exact: true }).focus();
      await page.evaluate(async () => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:snapshot', state: window.__uiSnapshot } })); await new Promise(resolve => requestAnimationFrame(resolve)); });
      assert.equal(await sessionDialog.getByRole('textbox', { name: 'Session link', exact: true }).evaluate(element => document.activeElement === element), true, 'Background snapshots preserve the current share-dialog focus');
      await page.screenshot({ path: path.join(output, `session-share-dialog-${width}x${height}.png`) });
      if (width === 1440 || width === 390) {
        const previousTheme = await page.evaluate(() => { const value = document.documentElement.dataset.theme; document.documentElement.dataset.theme = 'dark'; return value; });
        await page.screenshot({ path: path.join(output, `session-share-dialog-dark-${width}x${height}.png`), animations: 'disabled' });
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, previousTheme);
      }
      await sessionDialog.getByRole('button', { name: 'Copy shared link', exact: true }).click();
      await sessionDialog.getByRole('status').filter({ hasText: 'Shared link copied.' }).waitFor();
      await page.evaluate(() => { window.__savedClipboard = navigator.clipboard; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
      await sessionDialog.getByRole('button', { name: 'Link copied', exact: true }).click();
      await sessionDialog.getByRole('alert').filter({ hasText: 'Copy was blocked.' }).waitFor();
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: window.__savedClipboard }));
      await page.screenshot({ path: path.join(output, `share-menu-${width}x${height}.png`) });
      await sessionDialog.getByRole('button', { name: 'Revoke shared link', exact: true }).click();
      const sessionReview = sessionDialog.getByRole('group', { name: 'Confirm link revocation', exact: true });
      await sessionReview.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(shareRequests.length, 1, 'Cancel does not revoke a session link');
      if (width === 1440) {
        shareResponse = { json: {} };
        await sessionDialog.getByRole('button', { name: 'Create replacement link', exact: true }).click();
        await sessionDialog.getByRole('alert').filter({ hasText: 'Link creation was not confirmed.' }).waitFor();
        assert.equal(await sessionDialog.getByRole('textbox', { name: 'Session link', exact: true }).count(), 0, 'An uncertain replacement cannot present an earlier token as current');
        shareResponse = { status: 401, json: { error: 'Sign in again to share this conversation.' } };
        await sessionDialog.getByRole('button', { name: 'Create read-only link', exact: true }).click();
        await sessionDialog.getByRole('alert').filter({ hasText: 'Sign in again' }).waitFor();
        shareResponse = undefined;
        heldShare = new Promise(resolve => { releaseShare = resolve; });
        await sessionDialog.getByRole('button', { name: 'Create read-only link', exact: true }).click();
        await sessionDialog.getByRole('alert').filter({ hasText: 'Sharing was not confirmed.' }).waitFor({ timeout: 20000 });
        assert.equal(await sessionDialog.getByRole('button', { name: 'Close share dialog', exact: true }).isDisabled(), false, 'Timeout returns control to the user');
        releaseShare(); heldShare = undefined;
        await sessionDialog.getByRole('button', { name: 'Create read-only link', exact: true }).click();
        await sessionDialog.getByRole('textbox', { name: 'Session link', exact: true }).waitFor();
      }
      const sessionRequestsBeforeOffline = shareRequests.length;
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:connection', connected: false } })));
      assert.equal(await sessionDialog.getByRole('button', { name: 'Create replacement link', exact: true }).isDisabled(), true);
      assert.equal(await sessionDialog.getByRole('button', { name: 'Revoke shared link', exact: true }).isDisabled(), true);
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:connection', connected: true } })));
      assert.equal(shareRequests.length, sessionRequestsBeforeOffline, 'Reconnect never creates or revokes public links automatically');
      await sessionDialog.getByRole('button', { name: 'Revoke shared link', exact: true }).click();
      if (width === 1440) {
        shareResponse = { json: {} };
        await sessionReview.getByRole('button', { name: 'Revoke access', exact: true }).click();
        await sessionDialog.getByRole('alert').filter({ hasText: 'Revocation was not confirmed.' }).waitFor();
        assert.equal(await sessionReview.isVisible(), true, 'An incomplete revocation response is recoverable and never claims success');
        shareResponse = undefined;
      }
      await sessionReview.getByRole('button', { name: 'Revoke access', exact: true }).click();
      await sessionDialog.getByRole('status').filter({ hasText: 'Shared link revoked.' }).waitFor();
      assert.equal(await sessionDialog.getByRole('textbox', { name: 'Session link', exact: true }).count(), 0);
      assert.ok(await sessionDialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Sharing has no horizontal overflow');
      await page.keyboard.press('Escape');
      await page.getByRole('textbox', { name: 'Message Codex', exact: true }).fill('Held share-menu test turn');
      await page.evaluate(() => { window.__holdNextSend = true; });
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.waitForFunction(() => !!window.__heldSendResult);
      await sessionActions.click();
      assert.equal(await sessionShare.isDisabled(), true, 'Share cannot bypass the pending-turn guard through the menu');
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: window.__heldSendResult })));
      await page.waitForFunction(() => [...document.querySelectorAll('.cli-session-menu button')].some(button => button.textContent.trim() === 'Share' && !button.disabled));
      assert.equal(await sessionShare.isDisabled(), false, 'Share becomes available after the turn acknowledgement');
      await page.keyboard.press('Escape');
      assert.deepEqual(errors, [], 'Share menu runtime errors');
      results.push({ width, height, checks: 'compact share dialogs, permission choices, copy fallback, revoke/cancel/retry, offline/reconnect, partial/auth/timeout outcomes, keyboard menus' });
      await context.close();
      continue;
    }
    await checkTaskUi(page, {origin,width,height,output});
    await page.goto(`${origin}/workspace`);
    await page.locator(".cli-workspace").waitFor();
    const empty=page.locator('.cli-workspace-empty');
    assert.equal(await page.getByRole('button',{name:'Show workspace tools',exact:true}).count(),0,'Welcome never offers the right sidebar');
    assert.equal(await page.getByRole('complementary',{name:'Workspace tools',exact:true}).count(),0,'Welcome has no right panel');
    const welcome=await empty.boundingBox(), conversation=await page.locator('.cli-conversation').boundingBox();
    assert.ok(welcome && conversation && welcome.height > conversation.height * .7, 'Welcome uses the available workspace instead of an extra grid track');

    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    const folderView=page.locator('.cli-session-view-toggle');
    await folderView.waitFor({state:'visible'});
    if(await folderView.getAttribute('aria-pressed')==='true') await folderView.click();
    await page.getByRole("button", { name: "Expand demo", exact: true }).waitFor();
    const railBounds = await page.locator(".cli-session-rail").boundingBox();
    const footerBounds = await page.locator(".cli-account-footer").boundingBox();
    assert.ok(railBounds && footerBounds && footerBounds.y + footerBounds.height >= railBounds.y + railBounds.height - 16, "Account footer stays at the bottom of the sidebar");
    assert.equal(await page.locator(".cli-session-row-select").count(), 0, "Projects start collapsed");
    assert.equal(await page.locator(".cli-project-new").count(), 0, "Projects have no extra plus button");
    assert.equal(await page.locator(".cli-sidebar-actions > button").count(), 4, "All session controls share one toolbar group");
    await page.locator(".cli-project-running").waitFor();
    assert.equal(await page.locator(".cli-project-running").count(), 1, "Collapsed project shows verified running sessions after the saved view is revalidated");
    assert.equal((await page.locator(".cli-project-running").textContent()).trim(), "1 / 2", "Project shows running / total, excluding child agents and duplicates");
    await page.evaluate(() => {
      window.__projectStatuses = window.__uiSessions.map(session => ({status:session.status, locked:session.locked}));
      window.__uiSessions.forEach(session => {session.status='unknown';session.locked=true;});
      window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:action-result',action:'listCodexCliSessions',requestId:'dashboard-auto-fixture',status:'completed',payload:{cliSessions:window.__uiSessions}}}));
    });
    await page.waitForFunction(() => document.querySelectorAll('.cli-project-running').length === 0);
    assert.equal(await page.locator('.cli-project-select .cli-session-spinner').count(), 0, "Unknown or locked sessions are not evidence of running work");
    await page.evaluate(() => {
      window.__uiSessions.forEach((session,index) => Object.assign(session,window.__projectStatuses[index]));
      window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:action-result',action:'listCodexCliSessions',requestId:'dashboard-auto-fixture',status:'completed',payload:{cliSessions:window.__uiSessions}}}));
    });
    await page.waitForFunction(() => document.querySelectorAll('.cli-project-running').length === 1);
    await page.getByRole('button',{name:'Expand demo',exact:true}).click();
    assert.equal(await page.locator('.cli-project-sessions .cli-session-row-meta').count(), 0, "Folder rows omit repeated project and system metadata");
    assert.ok(await page.locator('.cli-project-sessions .cli-session-row').evaluateAll(rows => rows.every(row => {
      const title=row.querySelector('strong').getBoundingClientRect(), time=row.querySelector('time').getBoundingClientRect();
      return row.getBoundingClientRect().height <= (innerWidth<=760 ? 34 : 28) && Math.abs((title.top+title.height/2)-(time.top+time.height/2)) <= 2;
    })), "Folder rows keep title and elapsed time on one compact line");
    await page.getByRole('button',{name:'Collapse demo',exact:true}).click();
    assert.equal(await page.getByRole("button", { name: "Expand empty-project-with-a-long-name", exact: true }).count(), 0, "Projects without sessions stay hidden");
    const searchBounds = await page.getByRole("searchbox", { name: "Search sessions", exact: true }).boundingBox();
    assert.ok(searchBounds && searchBounds.width >= railBounds.width - 40, "Search keeps full rail width");
    await page.getByRole("searchbox", { name: "Search sessions", exact: true }).fill("Running workspace");
    await page.locator(".cli-compact-session-list").waitFor();
    assert.equal(await page.locator(".cli-session-row-select").count(), 1, "Search shows matching chats without opening projects");
    await page.getByRole("searchbox", { name: "Search sessions", exact: true }).fill("");
    await page.getByRole("button", { name: "Expand demo", exact: true }).waitFor();
    assert.equal(await page.getByRole("tablist", { name: "Session state" }).count(), 0, "No separate state tabs");
    await page.getByRole("button", { name: "Show compact session list", exact: true }).click();
    await page.locator(".cli-compact-session-list").waitFor();
    assert.equal(await page.locator(".cli-session-row-select").count(), 2, "Compact view keeps only distinct parents");
    await page.locator(".cli-compact-session-list .cli-session-row-meta").first().waitFor({ state: "visible" });
    const compactRowHeights = await page.locator('.cli-compact-session-list .cli-session-row').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
    assert.ok(compactRowHeights.every(height => height <= (width <= 760 ? 44 : 34)), 'Session rows keep a compact two-line height');
    if (width <= 760) {
      const titleBounds = await page.locator(".cli-session-row-main > strong").first().boundingBox();
      const metaBounds = await page.locator(".cli-session-row-meta").first().boundingBox();
      assert.ok(metaBounds.y - titleBounds.y - titleBounds.height <= 2, "Mobile title and metadata have no excessive gap");
      assert.ok((await page.locator(".cli-session-row-select").first().boundingBox()).height >= 40, "Compact text keeps the row touch target");
    }
    const runningHoverRow=page.locator('.cli-session-row').filter({hasText:'Running workspace task'});
    await runningHoverRow.hover();
    assert.equal(await runningHoverRow.locator('.cli-session-row-actions button').count(),1,'Running rows have a single automation action');
    assert.equal(await runningHoverRow.locator('.cli-session-queue-wrap').count(),0,'Queue and Auto Resume never compete on a running row');
    const initialOrder = await page.locator(".cli-session-row-main > strong").allTextContents();
    await page.evaluate(() => { window.__uiSessions.reverse(); window.__uiSessions.forEach(session => { session.updatedAt = new Date().toISOString(); }); });
    await page.getByRole("button", { name: "Refresh sessions", exact: true }).click();
    await page.waitForFunction(() => window.__uiActions.filter(message => message.action === "listCodexCliSessions").length > 1);
    await page.getByRole("button", { name: "Refresh sessions", exact: true }).waitFor();
    assert.deepEqual(await page.locator(".cli-session-row-main > strong").allTextContents(), initialOrder, "Refresh does not move existing rows");
    assert.equal(await page.locator(".cli-session-row-meta > span").first().textContent(), "demo", "Compact rows show only project metadata");
    assert.equal((await page.locator(".cli-session-row-meta").first().textContent()).includes("VS Code"), false, "Session metadata omits the system name");
    assert.equal(await page.locator(".cli-project-group").count(), 0, "Compact view has no project nesting");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("codexManager.workspaceLayout.v2") || "{}").sessionView === "compact");
    await page.reload();
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Show projects and sessions", exact: true }).waitFor();
    await page.locator(".cli-compact-session-list").waitFor();
    await page.getByRole("button", { name: "Show projects and sessions", exact: true }).click();
    await page.getByRole("button", { name: "Expand demo", exact: true }).waitFor();
    await page.getByRole("button", { name: "Show archived sessions (1)", exact: true }).click();
    await page.getByRole("button", { name: "Expand demo", exact: true }).click();
    await page.locator(".cli-session-row.is-archived").hover();
    await page.getByRole("button", { name: "Delete Archived task", exact: true }).click();
    const deletion = page.getByRole("alertdialog", { name: "Delete Archived task permanently", exact: true });
    await deletion.waitFor();
    assert.ok((await deletion.locator("svg").boundingBox()).width <= 24, "Delete icon stays small");
    assert.ok(await deletion.evaluate(element => getComputedStyle(element).backgroundColor !== "rgba(0, 0, 0, 0)"), "Delete dialog has an opaque surface");
    assert.ok(await deletion.locator(".cli-delete-confirm-copy > span").evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 13), "Delete text stays readable");
    assert.ok((await deletion.getByRole("button", { name: "Delete", exact: true }).boundingBox()).height >= 36, "Delete control is usable");
    await page.screenshot({ path: path.join(output, "delete-confirm-" + width + ".png") });
    // A backdrop must remain mounted until click, so pointer-up cannot hit a row below it.
    await page.mouse.move(2, 2);
    await page.mouse.down();
    assert.equal(await deletion.isVisible(), true, "Pointer-down never removes the delete backdrop");
    await page.mouse.move(3, 3);
    await page.mouse.up();
    await deletion.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.__uiActions.filter(action => action.action === "deleteCodexCliSession").length), 0, "Dismissing the backdrop cannot delete a session");
    if (await page.getByRole("button", { name: "Dismiss notification", exact: true }).isVisible()) await page.getByRole("button", { name: "Dismiss notification", exact: true }).click();
    await page.locator(".cli-session-row.is-archived").hover();
    await page.getByRole("button", { name: "Delete Archived task", exact: true }).click();
    await deletion.waitFor();
    await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByText("Session deletion cancelled.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Dismiss notification", exact: true }).click();
    await page.getByRole("button", { name: "Collapse demo", exact: true }).click();

    await page.getByRole("button", { name: "Show active sessions (2)", exact: true }).waitFor();
    await page.getByRole("button", { name: "Show active sessions (2)", exact: true }).click();
    await page.getByRole("button", { name: "Expand demo", exact: true }).click();
    assert.equal(await page.locator(".cli-session-row-select").count(), 2, "Only distinct parent sessions should appear");
    const projectHeader = await page.locator('.is-dense-tree .cli-project-row').first().boundingBox();
    assert.ok(projectHeader.height <= (width <= 760 ? 32 : 28), 'Project heading uses one dense row');
    assert.equal(await page.locator('.is-dense-tree .cli-session-row-meta').count(), 0, 'Grouped rows omit a second metadata line');
    assert.equal(await page.locator('.is-dense-tree .cli-session-row-time').count(), 2, 'Each grouped session retains its elapsed time');
    await page.screenshot({ path: path.join(output, `project-sessions-${width}x${height}.png`), animations: 'disabled' });
    assert.equal(await page.locator(".cli-session-row.is-running .cli-session-spinner").count(), 1, "Running parent needs an icon");
    assert.equal(await page.locator(".cli-session-row:not(.is-running) .cli-session-row-status").count(), 0, "Idle rows have no completion ticks");
    const runningRow = page.locator(".cli-session-row.is-running").first();
    const status = runningRow.locator(":scope > .cli-session-row-status");
    const beforeHover = await status.boundingBox();
    const rowBounds = await runningRow.boundingBox();
    assert.ok(beforeHover.x > rowBounds.x + rowBounds.width / 2, "Spinner is on the right");
    await runningRow.hover();
    const afterHover = await status.boundingBox();
    assert.ok(Math.abs(beforeHover.x - afterHover.x) < 1, "Spinner does not move on hover");
    assert.equal(await status.locator(".cli-session-spinner").evaluate(element => getComputedStyle(element).visibility), "hidden", "Visible actions hide the spinner");
    await page.mouse.move(width - 2, height - 2);
    await page.locator(".cli-session-row-select").filter({ hasText: "Running workspace" }).click();
    await page.getByText("Running elsewhere", { exact: true }).waitFor();
    const lockedStatus = page.locator(".cli-conversation > .cli-composer-unavailable.is-running");
    await lockedStatus.getByRole('button',{name:'Pause Auto Resume',exact:true}).click();
    await lockedStatus.getByRole('button',{name:'Enable Auto Resume',exact:true}).waitFor();
    await lockedStatus.getByRole('button',{name:'Enable Auto Resume',exact:true}).click();
    await lockedStatus.getByRole('button',{name:'Pause Auto Resume',exact:true}).waitFor();
    assert.equal(await lockedStatus.getByRole('button',{name:'Stop turn',exact:true}).isEnabled(),true,'An owned remote turn exposes Stop');
    assert.ok((await lockedStatus.boundingBox()).height <= 34, "Session status stays one compact line");
    assert.equal(await lockedStatus.locator(".cli-live-spinner").count(), 1, "External turns show a spinner beside their status");
    await page.evaluate(({ sessionId }) => {
      const live = { sessionId, streamId: "ui-check-stream", sequence: 1, updatedAt: Date.now(), status: "running", messages: [] };
      window.__spinnerLive = live;
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:codex-session-live", state: live } }));
    }, { sessionId: runningId });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:codex-session-live", state: { ...window.__spinnerLive, sequence: 2, status: "completed" } } })));
    await page.waitForFunction(() => !document.querySelector(".cli-session-row.is-running .cli-session-spinner"));
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:codex-session-live", state: { ...window.__spinnerLive, sequence: 3 } } })));
    assert.equal(await page.locator(".cli-session-row.is-running .cli-session-spinner").count(), 0, "A stale running snapshot cannot revive a completed spinner");
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.locator(".cli-session-row-select").filter({ hasText: "Evaluate stack" }).click();
    await page.getByRole("textbox", { name: "Message Codex", exact: true }).waitFor();
    if (width <= 760) {
      assert.equal(await page.locator(".cli-rail-toggle").getAttribute("aria-expanded"), "false", "Selecting a chat closes the mobile drawer");
      const header = await page.locator(".cli-conversation-header").boundingBox();
      assert.ok(header.height <= 44, `Mobile session header fits one row (${header.height}px)`);
      assert.equal(await page.locator(".cli-mobile-back").count(), 0, "Sidebar icon replaces duplicate Sessions button");
      assert.equal(await page.locator(".cli-conversation-actions > button:not(.cli-inspector-toggle):visible").count(), 0, "Secondary actions live in the mobile menu");
      const title = await page.locator(".cli-conversation-title h1").boundingBox();
      const project = await page.locator(".cli-conversation-project").boundingBox();
      assert.ok(project.y > title.y && project.x <= title.x + 2, "Title and project meta stay left-aligned on two compact rows");
    }
    console.log(`Checking ${width}x${height}: realtime messages`);
    await page.getByText("Live transcript update", { exact: true }).waitFor({ timeout: 12_000 });
    const completedWork = page.locator(".cli-completed-work").first();
    assert.equal(await completedWork.evaluate(element => element.open), false, "Completed work starts compact");
    await page.screenshot({ path: path.join(output, "completed-turn-" + width + ".png") });
    await completedWork.locator(":scope > summary").click();
    await page.getByText("Reviewer started working", { exact: true }).waitFor();
    assert.equal(await page.locator(".cli-completed-file").count(), 3, "Completed changes preview three files");
    await page.getByRole("button", { name: "Show 1 more file", exact: true }).click();
    assert.equal(await page.locator(".cli-completed-file").count(), 4);
    await page.getByRole("button", { name: "Show fewer files", exact: true }).click();
    assert.equal(await page.locator(".cli-goal-strip > summary").count(), 1, "Goal stays above composer");
    assert.ok((await page.locator(".cli-goal-strip").textContent()).includes("from native goal metadata"), "Native goal wins over older history");
    await page.getByRole("button", { name: "Pause goal", exact: true }).click();
    await page.getByRole("button", { name: "Resume goal", exact: true }).waitFor();
    assert.ok((await page.getByRole("button", { name: "Resume goal", exact: true }).locator("svg path").getAttribute("d")).includes("11 7"), "Paused goals show Play");
    assert.equal(await page.locator(".cli-goal-strip").evaluate(element=>element.open), false, "Goal control does not toggle its details");
    await page.getByRole("button", { name: "Resume goal", exact: true }).click();
    await page.getByRole("button", { name: "Pause goal", exact: true }).waitFor();
    if(width===390){await page.evaluate(()=>{window.__failNextGoal=true;});await page.getByRole('button',{name:'Pause goal',exact:true}).click();await page.getByText('Goal storage unavailable.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Pause goal',exact:true}).count(),1,'Failed pause retains the confirmed goal state');await page.getByRole('button',{name:'Dismiss notification',exact:true}).click();}
    const goalBounds = await page.locator(".cli-goal-strip").boundingBox();
    assert.ok(goalBounds.height <= (width <= 760 ? 38 : 32), 'Goal strip stays one compact row');
    const pauseBounds = await page.getByRole('button', { name: 'Pause goal', exact: true }).boundingBox();
    assert.ok(pauseBounds.width <= (width <= 760 ? 32 : 24) && pauseBounds.height <= (width <= 760 ? 32 : 24), 'Pause control does not inflate the goal strip');
    const composerBounds = await page.locator(".cli-composer").boundingBox();
    assert.ok(goalBounds.y >= 0 && goalBounds.y + goalBounds.height <= height && goalBounds.y + goalBounds.height <= composerBounds.y + 1, "Goal is visible above composer on every viewport");
    const imageTrigger = page.getByRole("button", { name: "Preview Attachment preview", exact: true });
    await imageTrigger.click();
    await page.getByRole("dialog", { name: "Attachment preview", exact: true }).waitFor().catch(async error => {
      console.log("Image state", await page.locator(".cli-image-lightbox").count(), await imageTrigger.boundingBox());
      await page.screenshot({ path: path.join(output, "image-failure-" + width + ".png") });
      throw error;
    });
    await page.keyboard.press("Escape");
    await page.locator(".cli-image-lightbox").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Preview Attachment preview");
    await page.getByRole("button", { name: "Preview image", exact: true }).first().press("Enter");
    await page.getByRole("dialog", { name: "Markdown preview", exact: true }).waitFor();
    await page.getByRole("button", { name: "Close image preview", exact: true }).click();
    await page.locator(".cli-image-lightbox").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Preview image");
    const tool = page.locator(".cli-activity.is-tool-call").first();
    const toolGroup = page.locator(".cli-activity-group-details").first();
    if (!await toolGroup.evaluate(element => element.open)) await toolGroup.locator(":scope > summary").press("Enter");
    await toolGroup.evaluate(element => ({ open: element.open, text: element.textContent.slice(0,80) })).then(value => console.log("Opened tool group", value));
    await page.waitForFunction(() => document.querySelector(".cli-activity-group-details")?.open).catch(async error => {
      console.log("Group state", await page.locator(".cli-activity-group-details").evaluateAll(elements => elements.map(element => ({ open: element.open, text: element.textContent.slice(0,80) }))));
      await page.screenshot({ path: path.join(output, "group-failure-" + width + ".png") });
      throw error;
    });
    await tool.locator(":scope > summary").click();
    const argumentCode = tool.locator(".cli-code-surface pre").first();
    assert.equal(await argumentCode.evaluate(element => getComputedStyle(element).whiteSpace), "pre", "Tool arguments preserve whitespace");
    assert.ok(await argumentCode.evaluate(element => element.scrollWidth > element.clientWidth), "Long arguments scroll horizontally");
    await tool.getByRole("button", { name: "Copy code", exact: true }).click();
    await tool.getByRole("button", { name: "Copied", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), longArguments, "Tool copy preserves the full payload");
    const command = page.locator(".cli-activity.is-command").first();
    await command.locator(":scope > summary").click();
    const shellOutput = command.locator(".cli-code-surface pre");
    assert.ok(await shellOutput.evaluate(element => element.scrollWidth > element.clientWidth && element.scrollHeight > element.clientHeight), "Shell output scrolls in both directions");
    const fileChange = page.locator(".cli-file-change-list > details").first();
    await fileChange.locator(":scope > summary").click();
    assert.equal(await fileChange.locator(".cli-diff-line.is-added").count(), 1);
    assert.equal(await fileChange.locator(".cli-diff-line.is-removed").count(), 1);
    assert.ok((await fileChange.locator(":scope > summary").boundingBox()).height <= 34, "File changes stay one compact row");

    await page.screenshot({ path: path.join(output, "tool-details-" + width + "x" + height + ".png") });
    await toolGroup.locator(":scope > summary").click();
    assert.equal(await page.getByText("List workspace terminals completed.", { exact: true }).count(), 0, "Routine background refreshes do not show success toasts");
    const copyCode = page.locator(".cli-markdown-code-block .cli-code-copy").first();
    await copyCode.click();
    await page.waitForFunction(() => document.querySelector(".cli-markdown-code-block .cli-code-copy")?.textContent === "Copied").catch(async error => {
      console.log("Copy feedback:", await page.locator(".cli-code-copy-feedback").allTextContents());
      await page.screenshot({ path: path.join(output, "copy-failure-" + width + ".png") });
      throw error;
    });
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"), "const answer = 42;\n");
    await page.waitForFunction(() => document.querySelector(".cli-markdown-code-block .cli-code-copy")?.textContent === "Copy code");
    await page.evaluate(() => { window.__originalClipboardWrite = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = () => Promise.reject(new Error("Clipboard unavailable")); });
    await copyCode.click();
    await page.getByText("Code could not be copied. Select the code and copy it manually.", { exact: true }).waitFor();
    await page.evaluate(() => { navigator.clipboard.writeText = window.__originalClipboardWrite; });
    const documentation = page.getByRole("link", { name: "Documentation", exact: true }).first();
    assert.equal(await documentation.getAttribute("target"), "_blank");
    assert.match(await documentation.getAttribute("rel"), /noopener/);
    assert.equal(await page.locator(".cli-message-markdown table").first().getByRole("cell", { name: "Ready", exact: true }).count(), 1);
    assert.equal(await page.locator('.cli-conversation-actions > button').filter({ hasText: 'Share' }).count(), 0, "Share uses the session menu at every width");
    await page.getByRole("button", { name: "Session actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Share", exact: true }).click();
    await page.getByRole("dialog", { name: "Share session" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Create read-only link", exact: true }).count(), 1, "Public sharing is explicit");
    heldShare = new Promise(resolve => { releaseShare = resolve; });
    await page.getByRole("button", { name: "Create read-only link", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Close share dialog", exact: true }).isDisabled(), true, "Sharing keeps its outcome visible while pending");
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog", { name: "Share session" }).isVisible(), true, "Pending sharing cannot be dismissed by Escape");
    releaseShare(); heldShare = undefined;
    await page.getByRole("textbox", { name: "Session link", exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Session link", exact: true }).inputValue(), `${origin}/share/${"a".repeat(64)}`);
    assert.equal(shareRequests[0].body.includeActivities,true,"New session links explicitly include full activity");
    assert.equal(shareRequests[0].body.messages,undefined,"Local sharing binds the source session without copying a large transcript into the request");
    assert.deepEqual(Object.keys(shareRequests[0].body).sort(),['includeActivities','sessionKey','title'],"Sharing does not include account or dashboard state");
    await page.getByRole("button", { name: "Revoke shared link", exact: true }).click();
    await page.getByRole("group", { name: "Confirm link revocation", exact: true }).getByRole("button", { name: "Revoke access", exact: true }).click();
    await page.getByRole("dialog", { name: "Share session" }).getByRole("status").filter({ hasText: "Shared link revoked" }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Session link", exact: true }).count(), 0);
    await page.keyboard.press("Escape");
    await page.locator(".cli-share-modal").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Session actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Copy link", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".cli-session-menu").waitFor({ state: "detached" });
    if (await page.getByRole('button',{name:'Show workspace tools',exact:true}).count()) await page.getByRole('button',{name:'Show workspace tools',exact:true}).click();
    await page.getByRole('tab',{name:'Env',exact:true}).click();
    assert.equal(await page.locator('.cli-environment-popover').count(),0,'Environment is a fixed tab, not a flyout');
    await page.getByRole('button',{name:'Open Git',exact:true}).click();
    const git = page.getByRole('region', {name:'Git and GitHub',exact:true});
    await git.getByRole('button',{name:'Refresh Git',exact:true}).waitFor();
    await page.evaluate(() => { window.__failNextGitRead = true; });
    await git.getByRole('button',{name:'Refresh Git',exact:true}).click();
    await git.getByText('Simulated Git read failure.',{exact:true}).waitFor();
    await git.getByRole('button',{name:'Refresh Git',exact:true}).click();
    await git.getByText('Simulated Git read failure.',{exact:true}).waitFor({state:'detached'});
    await git.getByRole('tab',{name:'Branches',exact:true}).click();
    await git.getByText('feature/demo',{exact:true}).waitFor();
    await page.getByRole('tab',{name:'Env',exact:true}).click();
    console.log(`Checking ${width}x${height}: Agent tabs`);
    await page.getByRole("button", { name: /^Agents/ }).click();
    await page.getByRole("tab", { name: /^Agents/ }).click();
    await page.locator(".cli-agent-row").filter({ hasText: "Reviewer" }).click();
    await page.locator(".cli-agent-tabs").getByRole("tab", { name: "Reviewer", exact: true }).waitFor();
    await page.getByText("Agent reviewer message", { exact: true }).waitFor();
    assert.equal(await page.getByText("Get codex sub agent messages completed.", { exact: true }).count(), 0, "Agent loading must not cover the composer with redundant success feedback");
    await page.locator(".cli-context-tabbar").getByRole("button", { name: "Close workspace tools", exact: true }).click();
    await page.getByRole("button", { name: "Show workspace tools", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "New VS Code terminal", exact: true }).count(), 0, "Only one panel creation control");
    for (const tool of ["files", "reviews"]) {
      await page.getByRole("button", { name: "Add workspace tool", exact: true }).click();
      const menuItem = page.getByRole("menuitem", { name: new RegExp(`^${tool}$`, "i") });
      if (await menuItem.count()) {
        await menuItem.click();
        await page.getByRole("tab", { name: new RegExp(`^${tool}$`, "i") }).waitFor();
      } else await page.keyboard.press("Escape");
    }
    await page.getByRole("button", { name: "Hide workspace tools", exact: true }).click();
    const userMessage = page.locator(".cli-conversation .cli-session-message.is-user").first();
    const initialMessageHeight = await userMessage.evaluate(element => element.getBoundingClientRect().height);
    await page.mouse.move(width - 2, height - 2);
    await page.getByRole("textbox", { name: "Message Codex", exact: true }).focus();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.cli-conversation .cli-session-message.is-user .cli-message-actions')).opacity === '0');
    assert.equal(await userMessage.locator(".cli-message-actions-toggle").count(), 0, "No ellipsis or extra action toggle");
    await userMessage.hover();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.cli-conversation .cli-session-message.is-user .cli-message-actions')).opacity === '1');
    assert.ok(await userMessage.locator(".cli-message-action-menu").evaluate(element => {
      const buttons = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect());
      return buttons.length >= 2 && buttons.every(button => button.top === buttons[0].top);
    }), "All message actions share one horizontal row");
    await userMessage.focus();
    await userMessage.getByRole("button", { name: "Quote", exact: true }).click();
    assert.equal(await userMessage.evaluate(element => element.getBoundingClientRect().height), initialMessageHeight, "Actions never add message height");
    assert.equal(await userMessage.locator(".cli-message-actions").evaluate(element => getComputedStyle(element).position), "absolute", "Actions float over the message without adding height");
    assert.match(await page.getByRole("textbox", { name: "Message Codex", exact: true }).inputValue(), /^> /);
    await page.locator('input[type="file"][aria-label="Choose attachments"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Review this text attachment") });
    await page.getByRole("button", { name: "Remove notes.txt", exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, `before-send-${width}x${height}.png`) });
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("Simulated action failure. Your draft is preserved.", { exact: true }).first().waitFor();
    assert.match(await page.getByRole("textbox", { name: "Message Codex", exact: true }).inputValue(), /^> /, "Failed sends preserve the draft");
    assert.equal(await page.getByRole("button", { name: "Remove notes.txt", exact: true }).count(), 1, "Failed sends preserve attachments");
    // Hold a real FileReader until after navigating to another composer.
    await page.evaluate(() => {
      const read = FileReader.prototype.readAsText;
      FileReader.prototype.readAsText = function(file) {
        FileReader.prototype.readAsText = read;
        window.__releaseAttachmentRead = () => read.call(this, file);
      };
    });
    await page.locator('input[type="file"][aria-label="Choose attachments"]').setInputFiles({ name: "late.txt", mimeType: "text/plain", buffer: Buffer.from("Original conversation only") });
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    const composer = page.getByRole("textbox", { name: "Message Codex", exact: true });
    assert.equal(await composer.inputValue(), "", "New chats must not inherit another chat's draft");
    assert.equal(await page.getByRole('button',{name:'Show workspace tools',exact:true}).count(),0,'New chat never opens the right sidebar');
    assert.equal(await page.getByRole('complementary',{name:'Workspace tools',exact:true}).count(),0);
    await page.evaluate(() => window.__releaseAttachmentRead());
    await page.getByRole("button", { name: "Attach files", exact: true }).waitFor();
    await page.getByText("Attachments saved in the previous chat draft. Return there to use them.", { exact: true }).waitFor();
    const emptyComposerHeight = (await page.locator(".cli-composer").boundingBox()).height;
    assert.ok(emptyComposerHeight <= 110, `Empty composer is compact at ${width}px (${emptyComposerHeight}px)`);
    await composer.fill("First line\nSecond line\nThird line\nFourth line");
    await page.waitForFunction(height => document.querySelector(".cli-composer").getBoundingClientRect().height > height + 20, emptyComposerHeight);
    await composer.fill(Array.from({ length: 40 }, (_, index) => `Draft line ${index}`).join("\n"));
    await page.waitForFunction(() => {
      const input = document.querySelector('textarea[name="codex-message"]');
      return input.clientHeight <= 240 && input.scrollHeight > input.clientHeight;
    });
    await composer.fill("");
    await page.waitForFunction(height => Math.abs(document.querySelector(".cli-composer").getBoundingClientRect().height - height) <= 2, emptyComposerHeight);
    const projectSelect = page.getByRole("combobox", { name: "Project", exact: true });
    assert.equal(await projectSelect.locator("option").count(), 2, "New chat includes projects with no listed sessions");
    await projectSelect.selectOption("D:/empty-project-with-a-long-name");
    assert.equal(await projectSelect.inputValue(), "D:/empty-project-with-a-long-name", "Project can be changed");
    await projectSelect.selectOption("D:/demo");
    await page.getByRole("button", { name: "Message settings", exact: true }).click();
    const optionsBounds = await page.locator(".cli-composer-options").boundingBox();
    assert.ok(optionsBounds && optionsBounds.x >= 0 && optionsBounds.y >= 0 && optionsBounds.x + optionsBounds.width <= width && optionsBounds.y + optionsBounds.height <= height, "Message settings fit the viewport");
    await page.getByRole("combobox", { name: "Reasoning", exact: true }).selectOption("high");
    await page.getByRole("combobox", { name: "Access mode", exact: true }).selectOption("read-only");
    assert.equal(await page.getByRole("combobox", { name: "Model", exact: true }).inputValue(), "gpt-5");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".cli-composer-options").count(), 0);
    await page.getByRole("button", { name: "Message settings", exact: true }).click();
    assert.equal(await page.getByRole("combobox", { name: "Reasoning", exact: true }).inputValue(), "high");
    assert.equal(await page.getByRole("combobox", { name: "Access mode", exact: true }).inputValue(), "read-only");
    await composer.click();
    assert.equal(await page.locator(".cli-composer-options").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Remove notes.txt", exact: true }).count(), 0);
    await composer.fill("Separate new chat draft");
    assert.equal(await page.getByRole("button", { name: "Remove late.txt", exact: true }).count(), 0, "Late file reads stay with the originating chat");
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.locator(".cli-session-row-select").filter({ hasText: "Evaluate stack" }).click();
    assert.match(await composer.inputValue(), /^> /, "Returning to a chat restores its draft");
    await page.getByRole("button", { name: "Remove late.txt", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Remove notes.txt", exact: true }).count(), 1);
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    assert.equal(await composer.inputValue(), "Separate new chat draft", "Returning to a new-chat project restores its separate draft");
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.locator(".cli-session-row-select").filter({ hasText: "Evaluate stack" }).click();
    await page.evaluate(() => { window.__holdNextMessageRead = true; window.__heldMessageResult = undefined; });
    if (width <= 760) {
      await page.getByRole("button", { name: "Session actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Refresh conversation", exact: true }).click();
    } else await page.getByRole("button", { name: "Refresh conversation", exact: true }).click();
    await page.waitForFunction(() => window.__heldMessageResult);
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: window.__heldMessageResult })));
    assert.equal(new URL(page.url()).pathname, "/workspace", "A late transcript read cannot reopen an old conversation");
    assert.equal(await composer.inputValue(), "Separate new chat draft");
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.locator(".cli-session-row-select").filter({ hasText: "Evaluate stack" }).click();
    await composer.fill("Original long-running turn");
    await page.evaluate(() => { window.__holdNextSend = true; window.__heldSendResult = undefined; });
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.waitForFunction(() => window.__heldSendResult);
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await composer.fill("Keep this new draft");
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: window.__heldSendResult })));
    const completionToast=page.locator('.dashboard-notice').filter({hasText:'Codex completed the turn in the original chat.'});
    await completionToast.waitFor();
    await completionToast.waitFor({state:'hidden',timeout:5000});
    assert.equal(new URL(page.url()).pathname, "/workspace", "A completed turn cannot pull the user back to its conversation");
    assert.equal(await composer.inputValue(), "Keep this new draft");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    assert.equal(await page.locator(".cli-session-message").filter({hasText:"New Codex chat is ready."}).count(), 0, "Action feedback never adds conversation blocks");
    await page.waitForFunction(() => document.querySelector('textarea[name="codex-message"]')?.value === "");
    assert.equal(new URL(page.url()).pathname, "/workspace/01a04882-d037-7a42-ad24-9afb61901198", "A new-session acknowledgement opens the accepted thread without requiring another list/catalog payload");
    assert.equal(await composer.inputValue(), "", "A newly accepted chat clears only its submitted project draft");
    await page.getByRole("button", { name: "Session actions", exact: true }).click();
    const menuBounds = await page.locator(".cli-session-menu").boundingBox();
    assert.ok(menuBounds && menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= width, "Session actions stay inside the viewport when toolbar buttons wrap");
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await page.waitForFunction(() => window.__heldArchiveResult);
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.locator(".cli-session-row-select").filter({ hasText: "Evaluate stack" }).click();
    const activeChatUrl = page.url();
    await composer.fill("Keep the currently selected chat");
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: window.__heldArchiveResult })));
    await page.locator(".dashboard-notice").filter({hasText:"Original chat archived."}).waitFor();
    assert.equal(page.url(), activeChatUrl, "A delayed archive must not navigate away from another selected chat");
    assert.equal(await composer.inputValue(), "Keep the currently selected chat");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 2, `Chat overflows by ${overflow}px at ${width}px`);
    await page.screenshot({ path: path.join(output, `chat-${width}x${height}.png`) });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:host-status", stage: "unreachable" } })));
    await page.getByText("Reconnecting", { exact: true }).waitFor();
    assert.equal(await page.locator(".dashboard-connection-banner").count(), 0, "Chat uses its inline reconnect status without a floating notice");
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:host-status", stage: "live" } })));
    console.log(`Checking ${width}x${height}: dashboard and settings`);
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Open dashboard", exact: true }).click();
    assert.equal(new URL(page.url()).pathname, "/", "Dashboard navigation opens home without /dash");
    await page.locator("#dashboard-main").waitFor({ state: "visible" });
    await page.goBack();
    await page.locator(".cli-conversation.has-session").waitFor({ state: "visible" });
    await page.goForward();
    await page.reload();
    await page.locator("#dashboard-main").waitFor({ state: "visible" });
    assert.equal(new URL(page.url()).pathname, "/", "Reload preserves the home dashboard");
    await page.locator(".hero").waitFor();
    console.log(`Checking ${width}: account center`);
    await page.evaluate(() => {
      const state = window.__uiSnapshot;
      window.__accountCenterSaved = { accounts: state.accounts, connectedPeers: state.connectedPeers, peerAccounts: state.peerAccounts };
      const template = structuredClone(state.accounts.find(account => account.isActive) ?? state.accounts[0]);
      const active = { ...template, id: "center-active", email: "active@example.com", displayName: "Personal", isActive: true, isCurrentWindowAccount: true, runningOnThisDevice: true, runningDeviceName: undefined, enabled: true, switchQueued: false, hasQuota402: false, healthKind: "healthy", metrics: [{ key: "hourly", period: "hourly", label: "5h", visible: true, percentage: 0 }, { key: "weekly", period: "weekly", label: "Weekly", visible: true, percentage: 75 }] };
      const ready = { ...active, id: "center-ready", email: "ready@example.com", displayName: "Ready account", isActive: false, isCurrentWindowAccount: false, runningOnThisDevice: false, metrics: active.metrics.map(metric => ({ ...metric, percentage: 90 })) };
      state.accounts = [active, ready, { ...ready, id: "center-disabled", email: "disabled@example.com", displayName: "Disabled account", enabled: false }];
      state.connectedPeers = [{ id: "fixture-local", name: "This PC", connected: true, local: true, sessionCount: 2 }, { id: "account-remote", name: "Remote workstation", connected: true, sessionCount: 0 }, { id: "account-offline", name: "Offline workstation", connected: false, sessionCount: 0 }, { id: "account-empty", name: "Empty workstation", connected: true, sessionCount: 0 }];
      state.peerAccounts = { "account-remote": [{ ...active, id: "remote-active", displayName: "Remote account", email: "remote-active@example.com" }, { ...ready, id: "remote-ready", email: "remote-ready@example.com" }] };
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:snapshot", state } }));
    });
    await selectSidebarSystem(page, width, 'account-remote');
    if (await page.getByRole("button", { name: "Dismiss notification", exact: true }).count()) await page.getByRole("button", { name: "Dismiss notification", exact: true }).first().click();
    const showAccountRail = async () => { if (width <= 760 && await page.locator(".cli-rail-toggle").getAttribute("aria-expanded") === "false") await page.locator(".cli-rail-toggle").click(); };
    await showAccountRail();
    const accountTrigger = page.getByRole("button", { name: "Open account center", exact: true });
    await accountTrigger.hover();
    assert.equal(await page.locator(".cli-account-center").count(), 0, "The account center opens intentionally instead of on hover");
    await accountTrigger.click();
    const accountCenter = page.getByRole("dialog", { name: "Account center", exact: true });
    await accountCenter.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Search accounts on selected system"), false, "Opening the account center by pointer does not summon the mobile keyboard");
    const systemSelect = accountCenter.getByRole("combobox", { name: "Account system", exact: true });
    assert.equal(await systemSelect.inputValue(), "account-remote", "The account center starts on the selected dashboard system");
    await systemSelect.selectOption("fixture-local");
    assert.ok(await page.evaluate(() => window.__uiActions.some(action => action.action === "listCodexCliSessions" && action.payload?.targetDeviceId === "account-remote")), "Selecting a remote system routes session discovery to that system");
    assert.equal(await accountCenter.locator('.cli-account-choice[aria-current="true"]').isDisabled(), true, "Current accounts are clearly marked without switching again");
    assert.equal(await accountCenter.getByRole("meter").first().getAttribute("aria-valuenow"), "0", "Zero quota stays visible");
    const accountSearch = accountCenter.getByRole("searchbox", { name: "Search accounts on selected system", exact: true });
    await accountSearch.fill("ready");
    assert.equal(await accountCenter.locator(".cli-account-choice").count(), 1);
    await accountSearch.fill("account-that-does-not-exist");
    await accountCenter.getByText("No matching accounts", { exact: true }).waitFor();
    await accountSearch.fill("");
    assert.equal(await accountCenter.getByRole("button", { name: "Switch to dis***com", exact: true }).count(), 0, "Disabled accounts are omitted from switching choices");
    assert.ok(await accountCenter.evaluate(element => { const bounds = element.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight; }), "The account center fits every viewport");
    if (width <= 760) assert.equal(await accountCenter.locator('input[type="search"]').evaluate(element => getComputedStyle(element).fontSize), "16px", "Mobile account search avoids automatic iOS zoom");
    assert.ok(await accountCenter.evaluate(element => element.scrollWidth <= element.clientWidth), "The account center has no horizontal overflow");
    await page.screenshot({ path: path.join(output, `account-center-${width}x${height}.png`) });
    if (width <= 760) {
      await accountSearch.focus();
      await page.setViewportSize({ width, height: Math.max(300, height - 300) });
      await page.waitForFunction(() => { const bounds = document.querySelector('.cli-account-center')?.getBoundingClientRect(); return bounds && bounds.top >= 0 && bounds.bottom <= innerHeight; });
      await page.screenshot({ path: path.join(output, `account-center-keyboard-${width}.png`) });
      await page.setViewportSize({ width, height });
    }
    await page.keyboard.press("Escape");
    await page.locator(".cli-account-center").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Open account center");
    await accountTrigger.press("Enter");
    await systemSelect.selectOption("fixture-local");
    await page.evaluate(() => { window.__holdNextSwitch = true; });
    await accountCenter.getByRole("button", { name: "Switch to rea***com", exact: true }).click();
    const switchPicker = page.getByRole("dialog", { name: "Switch account", exact: true });
    await switchPicker.waitFor();
    assert.equal(await switchPicker.getByRole("option").count(), 1, "A chosen account keeps the existing switching confirmation");
    await switchPicker.getByRole("option").click();
    await page.waitForFunction(() => window.__heldSwitch);
    assert.deepEqual(await page.evaluate(() => ({ accountId: window.__heldSwitch.accountId, target: window.__heldSwitch.payload?.targetDeviceId ?? "local" })), { accountId: "center-ready", target: "local" }, "Choosing a local account stays local even when a remote dashboard is selected");
    await showAccountRail();
    await accountTrigger.click();
    assert.equal(await accountCenter.locator(".cli-account-switch-action").isDisabled(), true, "Duplicate switching is unavailable while its result is pending");
    assert.equal(await accountCenter.getByRole("button", { name: "Settings", exact: true }).isEnabled(), true, "Independent navigation stays available");
    await systemSelect.selectOption("account-offline");
    await accountCenter.getByText("Saved accounts. Reconnect this system to switch.", { exact: true }).waitFor();
    await accountCenter.getByText("No saved accounts", { exact: true }).waitFor();
    await systemSelect.selectOption("account-empty");
    assert.equal(await accountCenter.locator(".cli-account-status").count(), 0);
    await accountCenter.getByText("Quota has not been checked yet.", { exact: true }).waitFor();
    await page.evaluate(() => { const request = window.__heldSwitch; window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:action-result", action: "switch", requestId: request.requestId, accountId: request.accountId, status: "failed", error: "Simulated switch failure. No account was changed." } })); });
    await systemSelect.selectOption("fixture-local");
    await accountCenter.getByRole("button", { name: "Switch to rea***com", exact: true }).waitFor();
    assert.equal(await accountCenter.getByRole("button", { name: "Switch to rea***com", exact: true }).isEnabled(), true, "A failed switch can be retried");
    await systemSelect.selectOption("account-remote");
    await page.evaluate(() => { window.__uiSnapshot.connectedPeers = window.__uiSnapshot.connectedPeers.filter(peer => peer.id !== "account-remote"); window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:snapshot", state: window.__uiSnapshot } })); });
    await page.waitForFunction(() => document.querySelector('#account-center-system')?.value === "account-remote");
    await accountCenter.getByText("Saved accounts. Reconnect this system to switch.", { exact: true }).waitFor();
    await systemSelect.selectOption("fixture-local");
    await page.evaluate(() => {
      const account = window.__uiSnapshot.accounts.find(account => account.id === "center-active");
      account.metrics = [{ key: "invalid", label: "Invalid", visible: true, percentage: NaN }, { key: "bounded", label: "Remaining", visible: true, percentage: 150 }];
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:snapshot", state: window.__uiSnapshot } }));
    });
    assert.equal(await accountCenter.getByRole("meter").count(), 1, "Partial quota records omit invalid values");
    assert.equal(await accountCenter.getByRole("meter").getAttribute("aria-valuenow"), "100", "Quota meters stay within their range");
    await accountCenter.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator(".overlay.open").waitFor();
    await page.keyboard.press("Escape");
    await page.evaluate(() => { Object.assign(window.__uiSnapshot, window.__accountCenterSaved); window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:snapshot", state: window.__uiSnapshot } })); });
    if (await page.getByRole("button", { name: "Dismiss notification", exact: true }).count()) await page.getByRole("button", { name: "Dismiss notification", exact: true }).first().click();
    if (width <= 760 && await page.locator(".cli-rail-toggle").getAttribute("aria-expanded") === "true") await page.locator(".cli-rail-toggle").click();
    if (width > 760) {
      await page.locator("#donateButton").click();
      const donation = page.getByRole("dialog", { name: "Donate to Codex Manager", exact: true });
      const amount = donation.getByRole("spinbutton", { name: "Donation amount (USD)", exact: true });
      assert.equal(await amount.inputValue(), "11", "Donation starts at USD 11");
      await page.evaluate(() => { window.__openedLinks = []; window.open = (url) => { window.__openedLinks.push(String(url)); return {}; }; });
      await donation.getByRole("button", { name: "Open Xoom", exact: true }).click();
      await page.waitForFunction(() => window.__openedLinks.some(url => new URL(url).searchParams.get("sendAmount") === "11.00"));
      await amount.fill("17.50");
      await donation.getByRole("button", { name: "Open Xoom", exact: true }).click();
      await page.waitForFunction(() => window.__openedLinks.some(url => new URL(url).searchParams.get("sendAmount") === "17.50"));
      await page.keyboard.press("Escape");
    }
    const aboutLabel=await page.locator('#aboutOpenButton').getAttribute('aria-label');
    if(width<=760) { await page.locator('.dashboard-mobile-actions>summary').click(); await page.getByRole('menuitem',{name:aboutLabel,exact:true}).click(); }
    else await page.locator('#aboutOpenButton').click();
    const about=page.locator('.about-modal'); await about.waitFor();
    assert.ok(await about.evaluate(element=>element.scrollWidth<=element.clientWidth+1),'About dialog contains its layout at this viewport');
    const modalHeader=await about.locator('.settings-modal-head').boundingBox();
    assert.ok(modalHeader.height<=64,'Shared dialog header stays compact');
    await page.screenshot({path:path.join(output,`about-${width}x${height}.png`)});
    await page.keyboard.press('Escape'); await about.waitFor({state:'hidden'});
    console.log(`Checking ${width}: compact overview and floating controls`);
    const dashboardHero = await page.locator(".hero").boundingBox();
    const overviewDetails = page.locator(".overview-shell > .overview-account:not(.overview-inline-add-panel)");
    if (await overviewDetails.count()) assert.equal(await overviewDetails.isVisible(), width > 760, "Small screens omit desktop overview identity details");
    assert.equal(await page.locator(".overview-main").isVisible(), true, "Usage and quota overview stay visible");
    if (width > 760 && await overviewDetails.count()) {
      const left = await overviewDetails.boundingBox();
      const right = await page.locator(".overview-main").boundingBox();
      assert.ok(Math.abs(left.y - right.y) <= 1 && Math.abs(left.height - right.height) <= 1, "Overview columns have matching heights");
    }
    assert.equal(await page.locator(".cli-workspace.is-dashboard-mode .cli-context-toggle").count(), 0, "Dashboard has only its relevant left floating button");
    const railToggle=page.locator('.cli-rail-toggle');
    if(await railToggle.getAttribute('aria-expanded')==='true') assert.ok(await page.locator('.cli-rail-brand img').isVisible(),'Expanded rail shows its logo in its header');
    else assert.equal(await page.locator('#dashboard-sidebar-toggle-slot .cli-rail-toggle img').count(),1,'Collapsed rail logo sits inside the content header');
    assert.equal(await page.locator(".hero .brand-logo").isVisible(), false, "No duplicate dashboard logo");
    if (width <= 760) {
      assert.ok(await page.locator(".hero").evaluate(element => parseFloat(getComputedStyle(element).paddingTop) <= 4), "Small dashboards have no empty top spacer");
      assert.ok(dashboardHero.y <= 12, "Header starts near the top edge");
      const sidebarToggle = await railToggle.boundingBox();
      const brandBounds = await page.locator(".hero .brand").boundingBox();
      assert.ok(sidebarToggle.x >= brandBounds.x && sidebarToggle.x + sidebarToggle.width <= brandBounds.x + brandBounds.width, "Compact sidebar control belongs inside the header");
    }

    const previousNotice = page.getByRole("button", { name: "Dismiss notification", exact: true });
    if (await previousNotice.count()) await previousNotice.click();
    await page.locator("#cliSessionsButton").click();
    await page.locator(".cli-sessions-popover").waitFor();
    assert.equal(await page.locator("#cliSessionsButton .cli-running-count").textContent(), "1", "Badge excludes running child agents");
    assert.equal(await page.locator(".cli-sessions-running-row").count(), 1);
    await page.locator(".cli-sessions-running-row").filter({ hasText: "Running workspace task" }).waitFor();
    const autoResumeControl = page.getByRole('button',{name:'Auto Resume for Running workspace task',exact:true});
    assert.equal(await autoResumeControl.getAttribute('aria-pressed'),'true');
    const enabledResumeIcon = await autoResumeControl.locator('svg').innerHTML();
    await autoResumeControl.click();
    await page.waitForFunction(()=>window.__uiActions.some(message=>message.action==='setCodexSessionAutoResume'&&message.payload?.autoResumeEnabled===false));
    await page.waitForFunction(()=>document.querySelector('.cli-running-row-actions button[aria-pressed]')?.getAttribute('aria-pressed')==='false');
    assert.notEqual(await autoResumeControl.locator('svg').innerHTML(), enabledResumeIcon, 'Auto Resume on/off use visibly different shapes');
    assert.ok((await autoResumeControl.getAttribute('title')).includes('off'), 'Tooltip matches the effective state');
    const runningMeta = page.locator(".cli-sessions-running-row .cli-session-row-meta");
    assert.equal(await runningMeta.locator("span").nth(2).textContent(), "demo", "Project follows the PC name");
    assert.ok((await runningMeta.textContent()).includes("gpt-5"));
    assert.match(await runningMeta.textContent(), /\d+m \d+s/);
    assert.ok((await page.locator(".cli-sessions-running-row").getAttribute("title")).includes("Thinking: high"));
    assert.ok((await page.locator(".cli-sessions-running-row").getAttribute("title")).includes("Finish the running task"));
    assert.ok((await runningMeta.boundingBox()).height < 20, "Session metadata stays on one compact line");
    assert.ok((await page.locator(".cli-sessions-running-row").boundingBox()).height <= 40, "Session rows use a compact two-line layout");
    assert.equal(await page.getByRole("button", { name: "Session dashboard", exact: true }).count(), 0, "Browser flyouts keep navigation in the browser and omit the footer");
    await page.screenshot({ path: path.join(output, `running-sessions-${width}x${height}.png`) });
    await page.getByRole("button", { name: "View Running workspace task in browser", exact: true }).click();
    await page.waitForURL(`**/workspace/${runningId}`);
    await page.goBack();
    await page.locator("#cliSessionsButton").click();
    await page.locator(".cli-sessions-popover").waitFor();
    await page.evaluate(() => {
      window.__recoveryStart = window.__uiSessions.length;
      window.__uiSessions.push({ id: "recovery", title: "Interrupted workspace task", projectPath: "C:\\work\\interrupted\\", status: "idle", interrupted: true, model: "gpt-5" }, { id: "recovery-long", title: "Long project task", projectPath: "/work/a-very-long-project-name-that-needs-to-truncate/", status: "idle", interrupted: true }, { id: "recovery-missing", title: "Missing project task", status: "idle", interrupted: true });
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:action-result", requestId: "dashboard-auto-fixture", action: "listCodexCliSessions", status: "completed", payload: { cliSessions: window.__uiSessions } } }));
    });
    const interruptedRow = page.locator(".cli-sessions-running-row").filter({ hasText: "Interrupted workspace task" });
    assert.equal(await interruptedRow.locator(".cli-session-row-meta > span").nth(2).textContent(), "interrupted");
    assert.equal(await page.locator(".cli-sessions-running-row").filter({ hasText: "Missing project task" }).locator(".cli-session-row-meta > span").nth(2).textContent(), "Workspace");
    assert.equal(await page.locator(".cli-sessions-running-row").filter({ hasText: "Long project task" }).locator(".cli-session-row-meta > span").nth(2).getAttribute("title"), "a-very-long-project-name-that-needs-to-truncate");
    assert.ok(await page.locator(".cli-sessions-running-row").evaluateAll(rows => rows.every(row => row.scrollWidth <= row.clientWidth)), "Long and missing project names stay within the flyout");
    await interruptedRow.getByRole('button', {name:'Queue priority for Interrupted workspace task',exact:true}).click();
    const queuePanel = page.getByRole('dialog', {name:'Queue Interrupted workspace task',exact:true});
    await queuePanel.getByRole('button', {name:'Priority 1 First',exact:true}).click();
    assert.equal(await queuePanel.getByRole('spinbutton', {name:'Queue priority',exact:true}).inputValue(), '1');
    await queuePanel.getByRole('spinbutton', {name:'Queue priority',exact:true}).fill('2');
    const queueBox = await queuePanel.boundingBox();
    assert.ok(queueBox.x >= 0 && queueBox.y >= 0 && queueBox.x + queueBox.width <= width + 1 && queueBox.y + queueBox.height <= height + 1, 'Queue flyout fits the viewport');
    await page.screenshot({ path: path.join(output, `queue-options-${width}x${height}.png`) });
    await queuePanel.getByRole('button',{name:'Queue session',exact:true}).click();
    await page.waitForFunction(()=>window.__uiActions.some(message=>message.action==='setCodexSessionQueue'&&message.payload?.sessionId==='recovery'&&message.payload?.sessionQueuePriority===2));
    await page.screenshot({ path: path.join(output, `compact-recovery-${width}x${height}.png`) });
    const resumeRequestsBeforeBrowserOpen = await page.evaluate(() => window.__uiActions.filter(message => message.action === "resumeCodexSessions").length);
    await page.getByRole("button", { name: "View Interrupted workspace task in browser", exact: true }).click();
    await page.waitForURL(`**/workspace/recovery`);
    assert.equal(await page.evaluate(() => window.__uiActions.filter(message => message.action === "resumeCodexSessions").length), resumeRequestsBeforeBrowserOpen, "Browser session navigation never resumes an interrupted session");
    await page.goBack();
    await page.locator("#cliSessionsButton").click();
    await page.locator(".cli-sessions-popover").waitFor();
    assert.equal(await page.locator("#cliSessionsButton .cli-running-count").textContent(), "1", "Interrupted sessions do not inflate the running count");
    await page.evaluate(() => {
      window.__uiSessions.splice(window.__recoveryStart);
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:action-result", requestId: "dashboard-auto-fixture", action: "listCodexCliSessions", status: "completed", payload: { cliSessions: window.__uiSessions } } }));
    });
    await page.waitForFunction(() => document.querySelectorAll(".cli-sessions-running-row").length === 1);
    // Dismissing outside a flyout closes it; reopen before checking retry states.
    const openNotice = page.getByRole("button", { name: "Dismiss notification", exact: true });
    if (await openNotice.count()) await openNotice.click();
    if (!await page.locator(".cli-sessions-popover").count()) await page.locator("#cliSessionsButton").click();
    await page.evaluate(() => {
      window.__uiSnapshot.connectedPeers ??= [];
      window.__heldRunningSessions = window.__uiSessions.slice();
      const unknown = { id: "unknown", title: "Unverified session", status: "unknown", locked: true };
      const offline = { id: "offline-session", title: "Offline session", status: "running", remote: true, deviceId: "offline-pc" };
      window.__uiSessions.push(window.__uiSessions.find(session => session.status === "running"), unknown, offline);
      window.__uiSnapshot.connectedPeers.push({ id: "offline-pc", name: "Offline PC", connected: false, sessionCount: 1 });
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:snapshot", state: window.__uiSnapshot } }));
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:action-result", requestId: "dashboard-auto-fixture", action: "listCodexCliSessions", status: "completed", payload: { cliSessions: window.__uiSessions } } }));
    });
    await page.waitForFunction(() => document.querySelectorAll(".cli-sessions-running-row").length === 1);
    assert.equal(await page.locator("#cliSessionsButton .cli-running-count").textContent(), "1", "Unknown, offline, child and duplicate sessions do not inflate the count");
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:action-result", requestId: "dashboard-auto-fixture", action: "listCodexCliSessions", status: "failed", error: "Technical inspection failed" } }));
      window.__uiSessions.splice(0, window.__uiSessions.length, ...window.__heldRunningSessions);
      window.__failNextSessionList = true;
    });
    const retrySessions = page.getByRole("button", { name: "Retry session refresh", exact: true });
    await retrySessions.waitFor();
    assert.equal(await retrySessions.getAttribute('title'), 'Technical inspection failed');
    assert.equal(await page.locator(".dashboard-notice-stack").count(), 0, "Automatic list failures stay on the compact refresh control");
    await retrySessions.click();
    await page.locator('.dashboard-notice').filter({hasText:'Session inspection failed.'}).waitFor();
    assert.equal(await retrySessions.getAttribute('title'), 'Session inspection failed.');
    await page.getByRole('button',{name:'Dismiss notification',exact:true}).click();
    if (!await page.locator('.cli-sessions-popover').count()) await page.locator('#cliSessionsButton').click();
    await retrySessions.click();
    await page.locator('.cli-sessions-popover').getByRole('button',{name:'Refresh sessions',exact:true}).waitFor();
    assert.equal(await page.locator('.cli-sessions-list-status').count(),0,'Refreshing never adds a persistent status row');
    await page.getByRole('button',{name:'Dismiss notification',exact:true}).click();
    if (!await page.locator('.cli-sessions-popover').count()) await page.locator('#cliSessionsButton').click();
    await page.evaluate(() => {
      window.__uiSessions.splice(0, window.__uiSessions.length);
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:action-result", requestId: "dashboard-auto-fixture", action: "listCodexCliSessions", status: "completed", payload: { cliSessions: [] } } }));
    });
    await page.getByText("No running sessions.", { exact: true }).waitFor();
    assert.equal(await page.locator("#cliSessionsButton .cli-running-count").textContent(), "0");
    await page.evaluate(() => {
      window.__uiSessions.splice(0, window.__uiSessions.length, ...window.__heldRunningSessions);
      window.__uiSnapshot.connectedPeers = window.__uiSnapshot.connectedPeers.filter(peer => peer.id !== "offline-pc");
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:action-result", requestId: "dashboard-auto-fixture", action: "listCodexCliSessions", status: "completed", payload: { cliSessions: window.__uiSessions } } }));
    });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".brand .dashboard-pc-picker").count(), 0, "The marked header selector is removed");
    await page.evaluate(() => {
      window.__savedPeers = window.__uiSnapshot.connectedPeers;
      window.__uiSnapshot.connectedPeers = [{ id: "fixture-local", name: "This PC", connected: true, local: true, sessionCount: 2 }];
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:snapshot", state: window.__uiSnapshot } }));
    });
    assert.equal(await page.locator('#codexDashboardButton').count(), 0, 'The dashboard has no duplicate system switcher');
    assert.equal(await page.locator('.cli-system-count').count(),0,'A single PC needs no count badge');
    assert.equal(await page.locator("#cliSessionsButton").isVisible(), true, "Sessions stay visible on a single system");
    await page.evaluate(() => {
      window.__uiSnapshot.connectedPeers.push({ id: "fixture-remote", name: "Other system", connected: false, sessionCount: 0 });
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:snapshot", state: window.__uiSnapshot } }));
    });
    const showSystems = page.getByRole('button',{name:'Show sessions sidebar',exact:true});
    if(await showSystems.isVisible()) await showSystems.click();
    assert.equal(await page.locator('.cli-system-count').textContent(),'2','Multiple PCs have a compact count badge');
    await selectSidebarSystem(page, width, 'fixture-remote');
    await selectSidebarSystem(page, width, 'fixture-local');
    await page.evaluate(() => {
      window.__uiSnapshot.connectedPeers = window.__savedPeers;
      window.__uiSnapshot.encryptedSyncNeedsConfiguration = true;
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:snapshot", state: window.__uiSnapshot } }));
    });
    await page.locator("#settingsOpenButton .settings-alert-badge").waitFor({ state: "attached" });
    if (width <= 760) {
      await page.locator(".dashboard-mobile-actions > summary").click();
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    } else await page.locator("#settingsOpenButton").click();
    const passwordBlock = page.locator('[data-setting="shared-password"].settings-password-required');
    await passwordBlock.waitFor();
    assert.equal(await passwordBlock.evaluate(element => getComputedStyle(element).backgroundImage), "none", "The password highlight overrides the normal card background");
    await page.screenshot({ path: path.join(output, `password-required-${width}x${height}.png`), animations: "disabled" });
    await page.evaluate(() => {
      window.__uiSnapshot.encryptedSyncNeedsConfiguration = false;
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:snapshot", state: window.__uiSnapshot } }));
    });
    await page.waitForFunction(() => !document.querySelector(".settings-password-required") && !document.querySelector(".settings-alert-badge"));
    await page.keyboard.press("Escape");
    await page.goto(`${origin}/workspace/${parentId}?missing-transcript`);
    await page.waitForURL(`${origin}/workspace`);
    assert.equal(await page.locator(".dashboard-notice-stack").count(), 0, "Startup transcript failures do not toast");
    assert.equal(await page.locator('.cli-session-row').filter({ hasText: 'Evaluate stack beyond expectations' }).count(), 0, 'Confirmed missing conversations are retired from the sidebar');
    assert.equal(await page.getByText("This conversation is unavailable. Refresh the session list or choose another conversation.", { exact: true }).count(), 0, 'Retired conversations do not leave an error block');
    await page.goto(`${origin}/`);
    await page.locator(".hero").waitFor();
    assert.equal(await page.locator("#privacyToggleButton").count(), 1);
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.waitForFunction(() => { const bounds = document.querySelector(".overview-more-menu")?.getBoundingClientRect(); return bounds && bounds.top >= 0 && bounds.bottom <= innerHeight; });
    assert.equal(await page.locator(".overview-more-menu").getByRole("menuitem", { name: /Password/ }).count(), 0);
    assert.equal(await page.locator(".overview-more-menu").getByRole("menuitem", { name: snapshot.copy.showSensitive, exact: true }).count(), 0);
    assert.equal(await page.locator(".overview-more-menu").getByRole("menuitem", { name: 'Tags', exact: true }).count(), 1);
    assert.ok(await page.locator('.overview-more-menu').getByRole('menuitem',{name:'Tags',exact:true}).evaluate(button=>{const icon=button.querySelector('svg').getBoundingClientRect(),label=button.querySelector('span').getBoundingClientRect();return Math.abs(icon.y+icon.height/2-label.y-label.height/2)<2;}),'Tags icon and label align');
    await page.keyboard.press("End");
    assert.ok(await page.locator(".overview-more-menu").getByRole("menuitem", { name: /Resume$/ }).evaluate(button => button === document.activeElement), "End focuses the final action");
    await page.locator(".overview-more-menu").getByRole("menuitem", { name: /Codex$/ }).click();
    await page.waitForFunction(() => window.__uiActions.some(message => message.action === "openNewCodexWebview"));
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.locator(".overview-more-menu").getByRole("menuitem", { name: /Resume$/ }).click();
    await page.waitForFunction(() => window.__uiActions.some(message => message.action === "resumeCodexSessions" && !message.payload?.sessionId));
    await page.getByRole("button", { name: "More", exact: true }).click();
    assert.equal(await page.locator(".overview-more-menu").getByRole("menuitem", { name: /Show All Sessions$/ }).count(), 0);
    await page.keyboard.press("Escape");
    await page.goto(`${origin}/`);
    await page.locator(".hero").waitFor();
    console.log(`Checking ${width}: account filters`);
    for (const name of ["Within quota", "Over quota"]) {
      const filter = page.getByRole("button", { name: new RegExp("^" + name + " \\d+$") });
      if (!await filter.count()) continue;
      const count = Number((await filter.textContent()).trim().split(" ").at(-1));
      await filter.click();
      await page.waitForFunction(count => document.querySelectorAll(".saved-card-container").length === count, count);
    }
    await page.locator(".account-count-badges > button").first().click();
    await page.locator('input[name="account-search"]').fill("codex-ui-no-matching-account");
    const searchInput = page.getByRole("searchbox", { name: /Search accounts/i });
    assert.equal(await searchInput.getAttribute("type"), "text", "Search has no native duplicate clear control");
    assert.equal(await page.locator(".account-search-control button").count(), 1, "There is exactly one clear button");
    if (width <= 760) {
      const controlBounds = await page.locator(".dashboard-account-toolbar > :visible").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
      assert.ok(controlBounds.every(bounds => bounds.x >= 0 && bounds.x + bounds.width <= width + 1), "Account controls fit the phone viewport");
      assert.ok((await page.locator(".dashboard-account-toolbar").boundingBox()).height <= 84, "Search and filters use at most two compact rows on phones");
      assert.equal(await searchInput.evaluate(element => getComputedStyle(element).fontSize), "16px", "Mobile search avoids iOS zoom");
    }

    await page.waitForFunction(() => document.querySelectorAll(".saved-card-container").length === 0 && document.querySelector(".account-count-badges > button")?.textContent.trim() === "Total 0");
    await page.locator(".account-search-control button").click();
    assert.equal(await searchInput.inputValue(), "", "The custom clear control clears search");
    if (width <= 760) {
      await page.locator(".dashboard-mobile-actions > summary").click();
      await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    } else await page.locator("#settingsOpenButton").click();
    console.log(`Checking ${width}: settings opened`);
    const settingsStarted = performance.now();
    await page.locator(".overlay.open").waitFor();
    for (const tab of await page.locator(".settings-tab").all()) {
      await tab.click();
      assert.ok(await page.locator('.settings-tab').evaluateAll(tabs => tabs.every(tab => Math.abs(tab.getBoundingClientRect().top - tabs[0].getBoundingClientRect().top) < 2)), 'Settings tabs stay on one row');
      if(width<=650) assert.ok(await page.locator('.settings-tab:not(.active) .settings-tab-copy').evaluateAll(items=>items.every(item=>getComputedStyle(item).display==='none')), 'Narrow inactive tabs show icons only');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 2), "Settings overflow");
      assert.deepEqual(await page.locator(".settings-tab-panel:not([hidden]) .settings-block-sub").evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().height > 0).filter(element => element.getBoundingClientRect().height > parseFloat(getComputedStyle(element).lineHeight) + 1).map(element => element.textContent)), [], "Every setting description occupies at most one line");
      if (await tab.getAttribute("id") === "settings-tab-general") {
        const domain = page.locator('input[name="cloudflared-domain"]');
        await domain.fill('ui-focus.example');
        await domain.evaluate(input => input.setSelectionRange(3, 3));
        await page.evaluate(async () => {
          window.__uiSnapshot.settings.cloudflaredDomain = 'ui-focus.example';
          for (let index = 0; index < 3; index++) {
            window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:snapshot', state: structuredClone(window.__uiSnapshot) } }));
            await new Promise(resolve => requestAnimationFrame(resolve));
          }
        });
        assert.equal(await domain.evaluate(input => input === document.activeElement && input.selectionStart === 3 && input.value === 'ui-focus.example'), true, 'Background snapshots preserve settings input focus and caret');
        const domainCard = domain.locator("..");
        const domainBounds = await domainCard.boundingBox();
        assert.ok(domainBounds.width > 0, "Web Socket Server card is visible");
        const inputBounds = await domain.boundingBox();
        assert.ok(inputBounds.width >= domainBounds.width - 28 && inputBounds.x + inputBounds.width <= domainBounds.x + domainBounds.width, "Cloudflared input fills its card without overflow");
        const general = page.locator("#settings-panel-general > .settings-layout");
        const restart = general.locator(":scope > .settings-block").filter({ has: page.getByRole("button", { name: snapshot.copy.codexAppRestartTitle, exact: true }) });
        const parallel = general.locator(":scope > .settings-block").filter({ has: page.getByRole("button", { name: snapshot.copy.crossWindowAccountModeTitle ?? "Parallel window accounts (Experimental)", exact: true }) });
        assert.equal(await page.getByText("Codex CLI path", { exact: true }).count(), 0, "CLI path setting is removed");
        assert.ok(Math.abs((await restart.boundingBox()).width - (await parallel.boundingBox()).width) <= 2, "Restart and parallel settings use equal-width cards");
        const dashboardToggle = page.getByRole("button", { name: "Web Dashboard", exact: true });
        const workspaceToggle = page.getByRole("button", { name: "Enable workspace", exact: true });
        const dashboardCard = dashboardToggle.locator("../..");
        assert.equal(await dashboardCard.locator(".settings-session-transport").count(), 0, "Retired transport choices are removed");
        const serverCard = dashboardCard.locator(".settings-dashboard-server");
        const serverBounds = await serverCard.boundingBox();
        const workspaceCard = workspaceToggle.locator("../..");
        const workspaceBounds = await workspaceCard.boundingBox();
        assert.ok(Math.abs(serverBounds.width - workspaceBounds.width) <= 2, "Enable workspace and Web Socket Server use equal-width cards");
        if (width > 560) assert.ok(serverBounds.x > workspaceBounds.x && Math.abs(serverBounds.y - workspaceBounds.y) <= 2, "Web Socket Server follows Enable workspace in the same row");
        assert.equal(await page.getByRole("button", { name: "Keep connections online", exact: true }).count(), 0, "Relay ownership is automatic");
        const crossSystemToggle = page.getByRole("button", { name: "WS Cross System", exact: true });
        await crossSystemToggle.click(); await domain.waitFor({ state: "hidden" });
        await crossSystemToggle.click(); await domain.waitFor({ state: "visible" });
        await dashboardToggle.click();
        await workspaceToggle.waitFor({ state: "hidden" });
        await domain.waitFor({ state: "hidden" });
        await page.getByRole("button", { name: "Keep connections online", exact: true }).waitFor({ state: "hidden" });
        assert.equal(await page.locator(".settings-session-transport").count(), 0, "Dashboard off hides both workspace controls");
        await dashboardToggle.click();
        await workspaceToggle.waitFor({ state: "visible" });
        assert.equal(await workspaceToggle.getAttribute("aria-pressed"), "true", "Hiding workspace controls preserves their settings");
        await domain.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, `settings-domain-${width}x${height}.png`) });
      }
      if (await tab.getAttribute("id") === "settings-tab-data") {
        const level = page.getByRole("combobox", { name: "Log level", exact: true });
        await level.selectOption("debug");
        assert.equal(await level.inputValue(), "debug", "Log level can be changed");
        await level.selectOption("info");
        assert.equal(await page.getByRole("button", { name: "Download logs", exact: true }).count(), 0, "Downloads are inside System Log");
        await page.getByRole("button", { name: "Show log", exact: true }).click();
        await page.getByRole("dialog", { name: "System Log", exact: true }).waitFor();
        await page.locator(".log-console-output").filter({ hasText: "old record" }).waitFor();
        const consoleOutput = page.locator(".log-console-output");
        const initialLogs = await consoleOutput.innerText();
        await page.getByRole("dialog", { name: "System Log", exact: true }).getByRole("button", { name: "Refresh", exact: true }).click();
        await page.waitForFunction(text => document.querySelector(".log-console-output")?.textContent !== text, initialLogs);
        const consoleDialog = page.getByRole("dialog", { name: "System Log", exact: true });
        const refreshesBefore = await page.evaluate(() => window.__uiActions.filter(action => action.action === "refreshAll").length);
        await consoleDialog.getByRole("button", { name: "Close", exact: true }).focus();
        await page.keyboard.press("r");
        assert.equal(await page.evaluate(() => window.__uiActions.filter(action => action.action === "refreshAll").length), refreshesBefore, "Modal keys never refresh the dashboard behind them");
        await page.keyboard.press("/");
        assert.equal(await consoleDialog.evaluate(element => element.contains(document.activeElement)), true, "Dashboard search never takes focus out of a dialog");
        const modalBounds = await consoleDialog.boundingBox();
        await page.mouse.move(modalBounds.x + modalBounds.width / 2, modalBounds.y + 16);
        await page.mouse.down();
        await page.mouse.move(2, 2);
        await page.mouse.up();
        assert.equal(await consoleDialog.isVisible(), true, "Dragging out of a modal never dismisses it");
        await page.mouse.move(2, 2);
        await page.mouse.down();
        assert.equal(await consoleDialog.isVisible(), true, "Nested console stays above Settings until click");
        await page.mouse.up();
        await consoleDialog.waitFor({ state: "hidden" });
        assert.equal(await page.locator(".overlay.open").count(), 1, "Backdrop closes only the top dialog");
        if (width <= 760) {
          await page.getByRole("button", { name: "Show log", exact: true }).click();
          await consoleDialog.waitFor();
          await page.touchscreen.tap(2, 2);
          await consoleDialog.waitFor({ state: "hidden" });
          assert.equal(await page.locator(".overlay.open").count(), 1, "Touch closes the top dialog without reaching Settings");
        }

        await page.getByRole("button", { name: "Show log", exact: true }).click();
        await consoleDialog.waitFor();

        const [download] = await Promise.all([page.waitForEvent("download"), consoleDialog.getByRole("button", { name: "Download", exact: true }).click({ noWaitAfter: true })]);
        assert.equal(download.suggestedFilename(), "codex-manager-logs-fixture.json", "Redacted logs download in the browser");
        await consoleDialog.getByRole("combobox", { name: "Filter log entries" }).selectOption("error");
        assert.equal(await consoleDialog.locator(".system-log-entry").count(), 2, "Console filters errors");
        await consoleDialog.getByRole("combobox", { name: "Filter log entries" }).selectOption("all");
        await consoleDialog.locator(".system-log-entry").last().locator("summary").click();
        await consoleDialog.getByText("Auto-scroll paused", { exact: true }).waitFor();
        await consoleDialog.getByRole("button", { name: "Latest ↓", exact: true }).click();
        await consoleDialog.getByText("Following latest entries", { exact: true }).waitFor();
        await page.evaluate(() => { window.__failLogReads = true; });
        await page.waitForFunction(() => !(document.querySelector('.log-console-modal button[aria-busy="true"]')?.disabled));
        await consoleDialog.getByRole("button", { name: "Refresh", exact: true }).click();
        await consoleDialog.getByText("Simulated log storage failure.", { exact: true }).waitFor();
        assert.ok((await consoleOutput.innerText()).includes("old record"), "Storage failures preserve previous logs");
        await page.evaluate(() => { window.__failLogReads = false; });
        await consoleDialog.getByRole("button", { name: "Refresh", exact: true }).click();
        await consoleDialog.getByText("Simulated log storage failure.", { exact: true }).waitFor({ state: "hidden" });
        await page.evaluate(() => { window.__invalidLogReads = true; });
        await page.waitForFunction(() => !(document.querySelector('.log-console-modal button[aria-busy="true"]')?.disabled));
        await consoleDialog.getByRole("button", { name: "Refresh", exact: true }).click();
        await consoleDialog.getByText("The log response was unreadable. Retry refresh.", { exact: true }).waitFor();
        assert.ok((await consoleOutput.innerText()).includes("old record"), "Malformed responses preserve previous logs");
        await page.evaluate(() => { window.__invalidLogReads = false; });
        await consoleDialog.getByRole("button", { name: "Clear", exact: true }).click();
        await consoleDialog.getByText("No saved logs.", { exact: true }).waitFor();
        await consoleDialog.getByRole("button", { name: "Close", exact: true }).click();
        const logReadsAfterClose = await page.evaluate(() => window.__uiActions.filter(action => action.action === "viewLogs").length);
        await page.waitForTimeout(2_100);
        assert.equal(await page.evaluate(() => window.__uiActions.filter(action => action.action === "viewLogs").length), logReadsAfterClose, "Closing the console stops polling");
        assert.equal(await page.getByText("Token history retention", { exact: true }).count(), 0, "Retained verified usage has no automatic deletion control");
      }
      if (await tab.getAttribute("id") === "settings-tab-automation") {
        assert.equal(await page.getByRole("button",{name:"Usage log",exact:true}).count(),0,"Usage controls belong to Data & sync");
        const switchToggle = page.getByRole("button", { name: snapshot.copy.autoSwitchTitle, exact: true });
        const switchCard = switchToggle.locator("../..");
        const options = switchCard.locator(":scope > .settings-stack > .settings-integration-grid > .settings-block");
        assert.equal(await options.count(), 5, "Switching contains reset, wait, resume, refresh, and reload options");
        const bounds = await options.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
        assert.ok(bounds.every(rect => Math.abs(rect.width - bounds[0].width) <= 2), "Switching options use equal-width cards");
        if (width > 560) {
          assert.ok(Math.abs(bounds[0].y - bounds[1].y) <= 2 && Math.abs(bounds[2].y - bounds[3].y) <= 2, "Switching options form two rows of two");
          assert.ok(bounds[4].x > bounds[0].x && bounds[4].y >= bounds[3].bottom && bounds[4].y < bounds[2].bottom, "Reload fills the space below Refresh beside Auto Resume");
        }
        const refreshCard = page.getByRole("button", { name: snapshot.copy.autoSwitchRefreshAllTitle, exact: true }).locator("../..");
        const refreshBounds = await refreshCard.boundingBox();
        const refreshHead = await refreshCard.locator(":scope > .settings-toggle-head").boundingBox();
        assert.ok(refreshBounds.height <= refreshHead.height + 24, "Quota refresh card has no stretched empty space");
        const resumeToggle = page.getByRole("button", { name: snapshot.copy.autoResumeTitle, exact: true });
        const goalOnly = page.getByRole("button", { name: snapshot.copy.autoResumeGoalOnlyTitle, exact: true });
        await resumeToggle.click();
        await goalOnly.waitFor({ state: "hidden" });
        await resumeToggle.click();
        await goalOnly.waitFor({ state: "visible" });
        const previousGoalOnly = await goalOnly.getAttribute("aria-pressed");
        await goalOnly.click();
        assert.equal(await goalOnly.getAttribute("aria-pressed"), previousGoalOnly === "true" ? "false" : "true", "Goal-only preference can be changed");
        await goalOnly.click();
        assert.equal(await goalOnly.getAttribute("aria-pressed"), previousGoalOnly, "Goal-only preference can be restored");
        const settingResultsBeforeOff = await page.evaluate(() => window.__uiSettingResults.length);
        await switchToggle.click();
        await page.waitForFunction(before => window.__uiSettingResults.slice(before).some(result => result.key === "autoSwitchEnabled" && result.value === false), settingResultsBeforeOff);
        await page.waitForFunction(() => document.querySelectorAll("#settings-panel-automation .settings-integration-grid > .settings-block").length === 0);
        assert.equal(await options.count(), 0, "Switching off hides all dependent controls");
        assert.equal(await page.getByRole("button", { name: snapshot.copy.autoSwitchReloadTitle, exact: true }).isVisible(), false, "Reload settings follow their switching parent");
        await switchToggle.click();
        await options.first().waitFor({ state: "visible" });
        assert.equal(await resumeToggle.getAttribute("aria-pressed"), "true", "Hiding switching options preserves auto resume");
        await switchCard.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, `settings-switching-${width}x${height}.png`) });
      }
      if (await tab.getAttribute("id") === "settings-tab-tools") {
        assert.equal(await page.locator(".maintenance-tool").count(), 8, "Tools contain Codex utilities instead of duplicated dashboard shortcuts");
        await page.locator('.maintenance-tool').filter({ hasText: 'Archive manager' }).click();
        const archive = page.getByRole("region", { name: "Archive manager", exact: true });
        assert.equal(await page.getByRole('dialog').count(), 1, 'Maintenance stays in Settings instead of nesting a dialog');
        await archive.getByRole("checkbox").first().waitFor();
        assert.equal(await archive.getByRole("checkbox").count(), 50, "Archive management loads one bounded page");
        await archive.getByRole("button", { name: "Next", exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll(".maintenance-items input[type=checkbox]").length === 13);
        await archive.getByRole("searchbox", { name: "Search tool items" }).fill("task 62");
        await archive.getByRole("searchbox", { name: "Search tool items" }).press('Enter');
        await archive.getByRole("checkbox", { name: "Select Archived task 62", exact: true }).waitFor();
        await archive.getByRole("checkbox", { name: "Select Archived task 62", exact: true }).check();
        await archive.getByRole("button", { name: "Delete selected", exact: true }).click();
        await archive.getByRole("region", { name: "Confirm maintenance" }).waitFor();
        assert.equal(await page.evaluate(() => window.__uiActions.filter(action => action.action === "runMaintenance").length), 0, "Opening deletion confirmation changes no data");
        await archive.getByRole("button", { name: "Cancel", exact: true }).click();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), "Management modal fits the viewport");
        await page.screenshot({ path: path.join(output, `archive-manager-${width}x${height}.png`) });
        await archive.getByRole("button", { name: "Restore selected", exact: true }).click();
        await archive.getByRole("button", { name: "Restore selected", exact: true }).click();
        await archive.getByText("Restore complete", { exact: true }).waitFor();
        assert.ok(await page.evaluate(() => window.__uiActions.some(action => action.action === "runMaintenance" && action.payload.maintenanceOperation === "restore" && action.payload.maintenanceIds.length === 1)), "Restore preserves the reviewed selection");
        await archive.getByRole('button', { name: 'All tools', exact: true }).click();
        assert.equal(await page.locator(".overlay.open").count(), 1, "Returning to the tool navigator keeps Settings open");
        for (const title of ["Conversation cleanup", "Goal manager", "Shell snapshot cleanup"]) {
          await page.locator(".maintenance-tool").filter({ hasText: title }).click();
          const workspace = page.getByRole("region", { name: title, exact: true });
          await workspace.getByRole("checkbox").first().waitFor();
          await workspace.getByRole("button", { name: "All tools", exact: true }).click();
        }
        for (const [card, title] of [["Find missing projects", "Missing projects"], ["Find large conversations", "Largest conversations"], ["Check Codex storage", "Codex storage check"]]) {
          await page.locator(".maintenance-tool").filter({ hasText: card }).click();
          const workspace = page.getByRole("region", { name: title, exact: true });
          await workspace.getByText("Healthy · 2 MB", { exact: true }).waitFor();
          await workspace.getByRole("button", { name: "All tools", exact: true }).click();
        }
      }
      await page.screenshot({ path: path.join(output, `settings-${await tab.getAttribute("id")}-${width}x${height}.png`) });
    }
    console.log(`Settings checks ${width}x${height}: ${Math.round(performance.now() - settingsStarted)}ms`);
    assert.equal(await page.locator('[data-setting-key="backgroundTokenRefreshEnabled"]').count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".overlay.open").count(), 0, "Escape closes Settings");
    await page.waitForFunction(() => !document.querySelector(".overlay.open") && [...document.querySelectorAll(".overlay")].every(element => getComputedStyle(element).visibility === "hidden" || getComputedStyle(element).display === "none" || getComputedStyle(element).opacity === "0"));
    assert.deepEqual(errors, [], "Browser runtime errors");
    await page.screenshot({ path: path.join(output, `dashboard-${width}x${height}.png`) });
    await checkClosedProject(page, width, errors);
    results.push({ width, height, checks: "parent list, running icon, chat, live messages, Agent tabs, share, session menu, Environment, Files, Reviews, quote, attachment, failed send, settings" });
    await context.close();
  }
} catch (error) {
  for (const [index, context] of browser.contexts().entries()) {
    for (const [pageIndex, page] of context.pages().entries()) {
      await page.screenshot({ path: path.join(output, `failure-${index}-${pageIndex}.png`) }).catch(() => undefined);
      console.log("Failure state", await page.evaluate(() => ({ url: location.href, buttons: [...document.querySelectorAll('button')].filter(button => button.getBoundingClientRect().height > 0).map(button => ({ text: button.textContent, disabled: button.disabled })), actions: window.__uiActions?.slice(-8) })).catch(() => undefined));
    }
  }
  throw error;
} finally { await browser.close(); }
console.log(JSON.stringify({ results, screenshots: output }, null, 2));
