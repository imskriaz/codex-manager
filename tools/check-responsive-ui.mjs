import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { checkTaskUi } from "./check-task-ui.mjs";
import { listConversationFiles } from '../out/domain/conversationFiles.js';
import { dashboardCopyResources } from "../out/localization/resources/dashboard.js";

// Only GET the canonical local snapshot. All browser actions are intercepted
// in memory, so this check cannot send a turn or change a real account.
const origin = process.env.CODEX_MANAGER_UI_URL || "http://127.0.0.1:39875";
const response = await fetch(`${origin}/api/state`);
if (!response.ok) throw new Error(`Local dashboard snapshot returned ${response.status}.`);
const snapshot = await response.json();
Object.assign(snapshot.copy, dashboardCopyResources.en);
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
const config = { models: [{ id: "gpt-5", label: "GPT-5", reasoningEfforts: ["medium", "high"] }], projects: [{ id: "demo", path: "D:/demo", label: "demo" }, { id: "empty", path: "D:/empty-project-with-a-long-name", label: "empty-project-with-a-long-name" }], defaultModel: "gpt-5", defaultReasoningEffort: "medium", defaultSandboxMode: "workspace-write" };
const mockHost = `(() => {
  const state = ${JSON.stringify(snapshot)};
  const sessions = ${JSON.stringify(sessions)};
  const messages = ${JSON.stringify(messages)};
  const config = ${JSON.stringify(config)};
  if(location.search.includes('closed-project')) { sessions[0].projectPath = 'D:/closed-worktree'; sessions[0].title = 'Closed worktree task'; }
  const taskSessions = [], taskComments = [], projectTasks = [
    {id:'release-group',title:'Release work',prompt:'Prepare the release',stage:'planned',manualStage:'planned',revision:1,createdAt:Date.now()-7200000,updatedAt:Date.now()-600000},
    {id:'idea-fixture',title:'Idea collection',prompt:'A visitor suggestion',stage:'idea',manualStage:'idea',revision:1,createdAt:Date.now()-3600000,updatedAt:Date.now()-300000},
    ...[...new Map(sessions.filter(session=>!session.parentSessionId).map(session=>[session.id,session])).values()].map(session=>({id:'session:'+session.id,title:session.title,prompt:'',stage:session.status==='running'?'running':session.archived?'completed':'planned',revision:1,createdAt:1,updatedAt:1,sessionId:session.id,sourceKey:'fixture:'+session.id,timing:{firstStartedAt:Date.now()-3600000,lastObservedAt:Date.now()-600000,durationMs:1200000,runCount:2},parentTaskId:session.id===${JSON.stringify(parentId)}?'release-group':undefined}))
  ];
  let projectRevision=1; window.__advanceBoard=()=>{projectTasks.find(task=>task.id==='idea-fixture').title='Idea collection updated';projectRevision++;};
  const projectBoard = () => ({projectPath:'D:/demo',homeKey:'fixture',revision:projectRevision,tasks:projectTasks,comments:taskComments,sessions:[...sessions.filter(session=>!session.parentSessionId),...taskSessions],updatedAt:Date.now()});
  const apiTokens=[{id:'token-project',name:'Project reader',projectPath:'D:/demo',permissions:['state','getProjectBoard'],createdAt:1},{id:'token-all',name:'Owner operations',permissions:['*'],createdAt:1}];
  let messageReads = 0;
  let logReads = 0;
  let logCleared = false;
  const toolJobs = new Map();
  const dispatch = data => window.dispatchEvent(new MessageEvent('message', {data}));
  window.__uiActions = []; window.__uiSessions = sessions; window.__uiSnapshot = state; window.__uiSettingResults = [];
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
      } else if(message.type === 'dashboard:setting') {
        state.settings[message.key] = message.value;
        dispatch({type:'dashboard:snapshot',state});
        window.__uiSettingResults.push({key:message.key,value:message.value});
      } else if(message.type === 'dashboard:action') {
        if(message.action === 'switch' && window.__holdNextSwitch) { window.__holdNextSwitch = false; window.__heldSwitch = message; return; }
        let payload = {}, error;
        if(message.action==='getProjectBoard') {
          const result={type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'completed',payload:{projectBoard:projectBoard()}};
          if(window.__holdNextBoard) {window.__holdNextBoard=false;window.__heldBoardResult=structuredClone(result);return;}
          payload=result.payload;
        }
        else if(message.action==='getProjectTaskDetails') {
          const older=!!message.payload.taskBefore;
          const details={taskId:message.payload.taskId,initialPrompt:projectTasks.find(task=>task.id===message.payload.taskId)?.prompt||'Original request for this session',messages:older?[]:messages,files:message.payload.taskView==='files'?[{path:older?'src/older.ts':'src/app.ts',name:older?'older.ts':'app.ts',type:'file',depth:1},...(older?[]:${JSON.stringify(listConversationFiles(messages).filter(file => file.attachment))})]:[],environment:message.payload.taskView==='changes'?{isGitRepository:true,changes:1,additions:1,deletions:0}:undefined,history:[],warnings:[],olderThan:older?undefined:'200'};
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
          else {const input=message.payload.task,index=projectTasks.findIndex(task=>task.id===input.id),task={...projectTasks[index],...input,manualStage:projectTasks[index]?.sourceKey?projectTasks[index].manualStage:input.stage,parentTaskId:input.parentTaskId||undefined,revision:input.expectedRevision+1,createdAt:Date.now(),updatedAt:Date.now()};if(index<0)projectTasks.push(task);else projectTasks[index]=task;projectRevision++;payload={projectBoard:projectBoard()};}
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
        else if(message.action==='addProjectComment') {if(!taskComments.some(item=>item.id===message.payload.comment.id))taskComments.push({...message.payload.comment,author:'Owner',createdAt:Date.now()});projectRevision++;payload={projectBoard:projectBoard()};}
        else if(message.action==='shareProjectBoard') payload=window.__partialProjectShare ? {} : {projectShare:{token:'b'.repeat(64),expiresAt:Date.now()+86400000,permissions:message.payload.sharePermissions}};
        else if(message.action==='revokeProjectShares') { if(window.__failProjectRevoke) error='Revocation was not confirmed.'; else payload={notice:{level:'info',message:'All project links revoked.'}}; }
        else if(message.action==='listApiTokens') payload={apiTokens};
        else if(message.action==='generateApiToken') {apiTokens.push({id:'new-api-token',name:message.payload.tokenName,projectPath:message.payload.projectPath,permissions:message.payload.tokenPermissions,createdAt:Date.now()});payload={apiTokens,apiToken:'cm_'+'c'.repeat(64)};}
        else if(message.action==='revokeApiToken') {const index=apiTokens.findIndex(token=>token.id===message.payload.tokenId);if(index>=0)apiTokens.splice(index,1);payload={apiTokens};}
        else if(message.action==='setCodexSessionAutoResume'||message.action==='setCodexSessionQueue') {const session=sessions.find(item=>item.id===message.payload.sessionId);if(window.__failQueue && message.action==='setCodexSessionQueue')error='The session queue is full. Remove an entry before adding another.';else if(session){if(message.action==='setCodexSessionAutoResume')session.autoResumeEnabled=message.payload.autoResumeEnabled;else Object.assign(session,{queueEnabled:message.payload.queueEnabled,queuePriority:message.payload.queueEnabled?message.payload.sessionQueuePriority:undefined});payload={cliSession:session};}}
        else if(message.action==='readWorkspaceFile') payload={workspaceFile:{path:message.payload.filePath,content:message.payload.filePath.endsWith('older.ts')?'const older = 2;':'const task = 1;',kind:'text',language:'typescript',mimeType:'text/plain',size:15,revision:'fixture'}};
        else         if(message.action === 'downloadLogs' || message.action === 'viewLogs') {
          if(message.action === 'viewLogs') logReads++;
          if(window.__failLogReads || window.__failNextLogRead) { window.__failNextLogRead = false; error = 'Simulated log storage failure.'; }
          else payload = {logDownload:{filename:'codex-manager-logs-fixture.json',text:window.__invalidLogReads || window.__invalidNextLogRead ? '{' : JSON.stringify({format:'codex-manager-logs',records:logCleared ? [] : Array.from({length:80},(_,i)=>({timestamp:new Date(1792300000000+i*1000).toISOString(),sequence:i,level:i<2?'error':i<4?'warning':'info',scope:'recovery',message:i===0?'old record':i===79?'live record '+logReads:'Saved record '+i,details:{accepted:i>3}}))})},notice:{level:'info',message:'Logs refreshed.'}};
          window.__invalidNextLogRead = false;
        }
        else if(message.action === 'clearLogs') { logCleared = true; payload={notice:{level:'info',message:'System log cleared.'}}; }
        else if(message.action === 'previewMaintenance') payload={maintenancePreview:{token:'preview-'+message.payload.maintenanceTool,tool:message.payload.maintenanceTool,count:63,expiresAt:Date.now()+300000,titles:['Archived task 0']}};
        else if(message.action === 'getMaintenancePage') {
          const query=message.payload.maintenanceQuery||'',offset=message.payload.maintenanceOffset||0;
          const items=Array.from({length:63},(_,i)=>({id:'tool-item-'+i,title:'Archived task '+i,detail:'demo project'})).filter(item=>item.title.toLowerCase().includes(query.toLowerCase()));
          payload={maintenancePage:{token:message.payload.maintenanceToken,query,offset,total:items.length,items:items.slice(offset,offset+50)}};
        }
        else if(message.action === 'runMaintenance') {
          const job={id:'job-'+Date.now(),tool:message.payload.maintenanceToken.replace('preview-',''),operation:message.payload.maintenanceOperation||'delete',status:'running',total:message.payload.maintenanceIds?.length||63,processed:0,cleared:0,skipped:0,failed:0,errors:[]};
          toolJobs.set(job.id,job);payload={maintenanceJob:job};
        }
        else if(message.action === 'getMaintenanceStatus' || message.action === 'cancelMaintenance') {
          const job=toolJobs.get(message.payload.maintenanceJobId);
          if(job) { job.status=message.action==='cancelMaintenance'?'cancelled':'completed';job.processed=job.total;job.cleared=job.total;payload={maintenanceJob:job}; } else error='This cleanup is no longer available in this window.';
        }
        else if(message.action === 'inspectMaintenanceStorage') payload={maintenanceReport:{title:'Codex report',items:[{label:'Recorded projects checked',value:'12'},{label:'Missing projects',value:'1'},{label:'state_5.sqlite',value:'Healthy · 2 MB'}]}};
        else if(message.action === 'getUsageGraph') payload = {usageGraph:{...message.payload.usageGraph,history:[],dailyUsageCache:[],truncated:false}};
        else if(message.action === 'listCodexCliSessions') {
          if(window.__failNextSessionList) { window.__failNextSessionList = false; error = 'Session inspection failed.'; }
          else payload = {cliSessions:sessions,cliComposerConfig:config};
        }
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
        } else if(message.action === 'getCodexSubAgentMessages') payload = {cliSubAgentSession:sessions.find(s => s.id === message.payload.sessionId),cliSubAgentMessages:[{id:'agent-msg',kind:'message',role:'assistant',text:'Agent reviewer message'}]};
        else if(message.action === 'getWorkspaceEnvironment') {
          if(message.payload?.includeBranchDiff && window.__failNextComparison) {
            window.__failNextComparison = false;
            error = 'Simulated Git comparison failure.';
          } else payload = {workspaceEnvironment:{projectPath:message.payload?.projectPath,projectName:'demo',isGitRepository:true,branch:'main',changes:0,additions:0,deletions:0,ahead:0,behind:0,hasRemote:false,...(message.payload?.includeBranchDiff ? {branchDiff:'diff --git a/compare.ts b/compare.ts\\n--- a/compare.ts\\n+++ b/compare.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n',branchDiffBase:'origin/main'} : {})}};
        }
        else if(message.action === 'listWorkspaceTerminals') payload = {workspaceTerminals:[]};
        else if(message.action === 'listWorkspaceFiles') payload = {workspaceFiles:[]};
        else if(['openNewCodexWebview','resumeCodexSessions','openCodexCliSession'].includes(message.action)) payload = {notice:{level:'info',message:'Opened in VS Code.'}};
        else error = 'Simulated action failure. Your draft is preserved.';
        const result = {type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:error?'failed':'completed',payload,error};
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
        dispatch(result);
      }
    }, 50);
  },getState(){},setState(){}});
})();`;
const output = path.join(tmpdir(), "codex-manager-ui-check");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.CODEX_MANAGER_BROWSER || "msedge", headless: true });
const results = [];
try {
  const selectedWidth = Number(process.argv.find((argument) => argument.startsWith("--width="))?.slice(8));
  for (const [width, height] of (selectedWidth ? [[selectedWidth, Number(process.argv.find(argument => argument.startsWith("--height="))?.slice(9)) || (selectedWidth <= 760 ? 844 : 1000)]] : process.argv.includes("--landscape") ? [[844, 390]] : [[1440, 1000], [1024, 768], [768, 1024], [390, 844], [320, 667], [844, 390]])) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width <= 760, serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] });
    if (width === 320) await context.addInitScript(() => {
      Object.defineProperty(window, "indexedDB", { configurable: true, value: { open() { throw new DOMException("Browser storage unavailable", "SecurityError"); } } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    console.log(`Checking ${width}x${height}: session list`);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
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
    if (process.argv.includes('--queue')) {
      await page.goto(`${origin}/`);
      await page.locator('#cliSessionsButton').waitFor();
      await page.evaluate(() => {
        window.__uiSessions.push({id:'recovery',title:'Interrupted workspace task',status:'idle',interrupted:true,projectPath:'D:/demo'});
        window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:action-result',requestId:'dashboard-auto-fixture',action:'listCodexCliSessions',status:'completed',payload:{cliSessions:window.__uiSessions}}}));
      });
      await page.locator('#cliSessionsButton').click();
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
        state.connectedPeers = [{id:'local',name:'This PC',local:true,connected:true,sessionCount:2},{id:'warning-remote',name:'Remote PC',connected:true,sessionCount:0}];
        state.peerAccounts = { 'warning-remote': [{...ready,id:'remote-ready',email:'remote@example.com'}] };
        window.dispatchEvent(new MessageEvent('message', {data:{type:'dashboard:snapshot',state}}));
      });
      await page.locator('#codexDashboardButton').click();
      await page.locator('.dashboard-pc-picker-popover').getByRole('option').nth(1).click();
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
    if (width <= 760) await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Expand demo", exact: true }).waitFor();
    const railBounds = await page.locator(".cli-session-rail").boundingBox();
    const footerBounds = await page.locator(".cli-account-footer").boundingBox();
    assert.ok(railBounds && footerBounds && footerBounds.y + footerBounds.height >= railBounds.y + railBounds.height - 16, "Account footer stays at the bottom of the sidebar");
    assert.equal(await page.locator(".cli-session-row-select").count(), 0, "Projects start collapsed");
    assert.equal(await page.locator(".cli-project-new").count(), 0, "Projects have no extra plus button");
    assert.equal(await page.locator(".cli-sidebar-actions > button").count(), 4, "All session controls share one toolbar group");
    assert.equal(await page.locator(".cli-project-running").count(), 1, "Collapsed project shows running sessions");
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
    if (width <= 760) {
      const titleBounds = await page.locator(".cli-session-row-main > strong").first().boundingBox();
      const metaBounds = await page.locator(".cli-session-row-meta").first().boundingBox();
      assert.ok(metaBounds.y - titleBounds.y - titleBounds.height <= 2, "Mobile title and metadata have no excessive gap");
      assert.ok((await page.locator(".cli-session-row-select").first().boundingBox()).height >= 40, "Compact text keeps the row touch target");
    }
    const initialOrder = await page.locator(".cli-session-row-main > strong").allTextContents();
    await page.evaluate(() => { window.__uiSessions.reverse(); window.__uiSessions.forEach(session => { session.updatedAt = new Date().toISOString(); }); });
    await page.getByRole("button", { name: "Refresh sessions", exact: true }).click();
    await page.waitForFunction(() => window.__uiActions.filter(message => message.action === "listCodexCliSessions").length > 1);
    await page.getByRole("button", { name: "Refresh sessions", exact: true }).waitFor();
    assert.deepEqual(await page.locator(".cli-session-row-main > strong").allTextContents(), initialOrder, "Refresh does not move existing rows");
    assert.ok((await page.locator(".cli-session-row-meta").first().textContent()).includes("demo - "), "Compact rows show project and PC metadata");
    assert.equal((await page.locator(".cli-session-row-meta").first().textContent()).includes("VS Code"), false, "Session metadata uses the PC name");
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
    await page.getByRole("button", { name: "Dismiss session message", exact: true }).click();
    await page.locator(".cli-session-row.is-archived").hover();
    await page.getByRole("button", { name: "Delete Archived task", exact: true }).click();
    await deletion.waitFor();
    await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByText("Session deletion cancelled.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Dismiss session message", exact: true }).click();
    await page.getByRole("button", { name: "Collapse demo", exact: true }).click();

    await page.getByRole("button", { name: "Show active sessions (2)", exact: true }).waitFor();
    await page.getByRole("button", { name: "Show active sessions (2)", exact: true }).click();
    await page.getByRole("button", { name: "Expand demo", exact: true }).click();
    assert.equal(await page.locator(".cli-session-row-select").count(), 2, "Only distinct parent sessions should appear");
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
      assert.equal(await page.locator(".cli-conversation-actions > button:visible").count(), 0, "Secondary actions live in the mobile menu");
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
    assert.equal(await page.locator(".cli-goal-strip").evaluate(element=>element.open), false, "Goal control does not toggle its details");
    await page.getByRole("button", { name: "Resume goal", exact: true }).click();
    await page.getByRole("button", { name: "Pause goal", exact: true }).waitFor();
    if(width===390){await page.evaluate(()=>{window.__failNextGoal=true;});await page.getByRole('button',{name:'Pause goal',exact:true}).click();await page.getByText('Goal storage unavailable.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Pause goal',exact:true}).count(),1,'Failed pause retains the confirmed goal state');await page.getByRole('button',{name:'Dismiss message',exact:true}).click();}
    const goalBounds = await page.locator(".cli-goal-strip").boundingBox();
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
    if (width <= 760) {
      await page.getByRole("button", { name: "Session actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Show Environment", exact: true }).click();
    } else await page.getByRole("button", { name: "Show Environment", exact: true }).click();
    await page.locator(".cli-environment-popover").waitFor();
    await page.getByRole("button", { name: "Compare branch", exact: true }).click();
    await page.locator(".cli-branch-comparison .cli-diff-surface").waitFor();
    await page.evaluate(() => { window.__failNextComparison = true; });
    await page.getByRole("button", { name: "Refresh comparison", exact: true }).click();
    await page.getByText("Simulated Git comparison failure.", { exact: true }).waitFor();
    await page.getByText("Comparison unavailable. Use Refresh comparison to retry.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Refresh comparison", exact: true }).click();
    await page.locator(".cli-branch-comparison .cli-diff-surface").waitFor();
    await page.getByRole("button", { name: "Show turn changes", exact: true }).click();
    assert.equal(await page.locator(".cli-branch-comparison").count(), 0);
    if (width <= 1180) await page.getByRole("button", { name: "Hide workspace tools", exact: true }).click();
    if (width <= 760) {
      await page.getByRole("button", { name: "Session actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Show Environment", exact: true }).click();
    } else await page.getByRole("button", { name: "Show Environment", exact: true }).click();
    console.log(`Checking ${width}x${height}: Agent tabs`);
    await page.getByRole("button", { name: /^Agents/ }).click();
    await page.getByRole("tab", { name: /^Agents/ }).click();
    await page.locator(".cli-agent-row").filter({ hasText: "Reviewer" }).click();
    await page.getByRole("tab", { name: "Agent: Reviewer" }).waitFor();
    await page.getByText("Agent reviewer message", { exact: true }).waitFor();
    assert.equal(await page.getByText("Get codex sub agent messages completed.", { exact: true }).count(), 0, "Agent loading must not cover the composer with redundant success feedback");
    await page.evaluate(() => document.querySelector('.cli-environment-popover button[aria-label="Close Environment"]')?.click());
    await page.locator(".cli-environment-popover").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Hide workspace tools", exact: true }).click();
    if (width <= 760) {
      await page.getByRole("button", { name: "Session actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Show workspace tools", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "Show workspace tools", exact: true }).click();
    }
    assert.equal(await page.getByRole("button", { name: "New VS Code terminal", exact: true }).count(), 0, "Only one panel creation control");
    for (const tool of ["files", "reviews"]) {
      await page.getByRole("button", { name: "Add workspace tool or terminal", exact: true }).click();
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
    assert.equal(await userMessage.locator(".cli-message-actions").evaluate(element => getComputedStyle(element).opacity), "1", "Action toggle remains available");
    await userMessage.getByRole("button", { name: "Show message actions", exact: true }).click();
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
    assert.equal(await page.getByText("Codex completed the turn in the original chat.", { exact: true }).count(), 0, "Routine completion feedback stays out of the toast stack");
    assert.equal(new URL(page.url()).pathname, "/workspace", "A completed turn cannot pull the user back to its conversation");
    assert.equal(await composer.inputValue(), "Keep this new draft");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    assert.equal(await page.getByText("New Codex chat is ready.", { exact: true }).count(), 0, "Routine chat feedback stays out of the toast stack");
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
    assert.equal(await page.getByText("Original chat archived.", { exact: true }).count(), 0, "Routine archive feedback stays out of the toast stack");
    assert.equal(page.url(), activeChatUrl, "A delayed archive must not navigate away from another selected chat");
    assert.equal(await composer.inputValue(), "Keep the currently selected chat");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 2, `Chat overflows by ${overflow}px at ${width}px`);
    await page.screenshot({ path: path.join(output, `chat-${width}x${height}.png`) });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:host-status", stage: "unreachable" } })));
    await page.getByText("Reconnecting · live updates paused", { exact: true }).waitFor();
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
      state.connectedPeers = [{ id: "local", name: "This PC", connected: true, local: true, sessionCount: 2 }, { id: "account-remote", name: "Remote workstation", connected: true, sessionCount: 0 }, { id: "account-offline", name: "Offline workstation", connected: false, sessionCount: 0 }, { id: "account-empty", name: "Empty workstation", connected: true, sessionCount: 0 }];
      state.peerAccounts = { "account-remote": [{ ...active, id: "remote-active", displayName: "Remote account", email: "remote-active@example.com" }, { ...ready, id: "remote-ready", email: "remote-ready@example.com" }] };
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:snapshot", state } }));
    });
    await page.locator("#codexDashboardButton").click();
    await page.locator(".dashboard-pc-picker-popover").getByRole("option").nth(1).click();
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
    await systemSelect.selectOption("local");
    assert.equal(await accountCenter.locator('.cli-account-choice[aria-current="true"]').isDisabled(), true, "Current accounts are clearly marked without switching again");
    assert.equal(await accountCenter.getByRole("meter").first().getAttribute("aria-valuenow"), "0", "Zero quota stays visible");
    const accountSearch = accountCenter.getByRole("searchbox", { name: "Search accounts on selected system", exact: true });
    await accountSearch.fill("ready");
    assert.equal(await accountCenter.locator(".cli-account-choice").count(), 1);
    await accountSearch.fill("account-that-does-not-exist");
    await accountCenter.getByText("No matching accounts", { exact: true }).waitFor();
    await accountSearch.fill("");
    assert.equal(await accountCenter.getByRole("button", { name: "Switch to dis***com", exact: true }).isDisabled(), true);
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
    await systemSelect.selectOption("local");
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
    await systemSelect.selectOption("local");
    await accountCenter.getByRole("button", { name: "Switch to rea***com", exact: true }).waitFor();
    assert.equal(await accountCenter.getByRole("button", { name: "Switch to rea***com", exact: true }).isEnabled(), true, "A failed switch can be retried");
    await systemSelect.selectOption("account-remote");
    await page.evaluate(() => { window.__uiSnapshot.connectedPeers = window.__uiSnapshot.connectedPeers.filter(peer => peer.id !== "account-remote"); window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:snapshot", state: window.__uiSnapshot } })); });
    await page.waitForFunction(() => document.querySelector('#account-center-system')?.value === "local");
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
    assert.equal(await page.locator(".cli-workspace.is-dashboard-mode .cli-rail-toggle img").count(), 1, "Sidebar toggle carries the dashboard logo");
    assert.equal(await page.locator(".hero .brand-logo").isVisible(), false, "No duplicate dashboard logo");
    if (width <= 760) {
      assert.ok(await page.locator(".hero").evaluate(element => parseFloat(getComputedStyle(element).paddingTop) <= 4), "Small dashboards have no empty top spacer");
      assert.ok(dashboardHero.y <= 12, "Header starts near the top edge");
      const sidebarToggle = await page.locator(".cli-workspace.is-dashboard-mode .cli-rail-toggle").boundingBox();
      const brandBounds = await page.locator(".hero .brand").boundingBox();
      assert.ok(brandBounds.x >= sidebarToggle.x + sidebarToggle.width, "Compact header leaves room for the sidebar button");
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
    assert.equal(await page.getByRole("button", { name: "Session dashboard", exact: true }).count(), 1);
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
    await page.getByRole("button", { name: "Resume Interrupted workspace task in VS Code", exact: true }).click();
    await page.waitForFunction(() => window.__uiActions.some(message => message.action === "resumeCodexSessions" && message.payload?.sessionId === "recovery"));
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
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    assert.equal(await page.locator(".dashboard-notice-stack").count(), 0, "Failed automatic list reads remain inline");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".cli-sessions-list-status"));
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
      window.__uiSnapshot.connectedPeers = [{ id: "local", name: "This PC", connected: true, local: true, sessionCount: 2 }];
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:snapshot", state: window.__uiSnapshot } }));
    });
    await page.waitForFunction(() => Boolean(document.querySelector("#codexDashboardButton")));
    assert.equal(await page.locator('#codexDashboardButton').isVisible(), true, 'System selection remains visible for a single system');
    assert.equal(await page.locator("#cliSessionsButton").isVisible(), true, "Sessions stay visible on a single system");
    await page.evaluate(() => {
      window.__uiSnapshot.connectedPeers.push({ id: "fixture-remote", name: "Other system", connected: false, sessionCount: 0 });
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:snapshot", state: window.__uiSnapshot } }));
    });
    await page.locator("#codexDashboardButton").click();
    assert.equal(await page.locator(".dashboard-system-count").textContent(), "2");
    assert.equal(await page.locator(".dashboard-pc-picker-popover").getByRole("option").count(), 2);
    await page.locator(".dashboard-pc-picker-popover").getByRole("option").nth(1).click();
    await page.locator(".dashboard-notice.is-warning").filter({ hasText: "is offline" }).waitFor();
    await page.locator("#codexDashboardButton").click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
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
    assert.equal(await page.locator("#privacyToggleButton").count(), 0);
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.waitForFunction(() => { const bounds = document.querySelector(".overview-more-menu")?.getBoundingClientRect(); return bounds && bounds.top >= 0 && bounds.bottom <= innerHeight; });
    assert.equal(await page.locator(".overview-more-menu").getByRole("menuitem", { name: /Password/ }).count(), 0);
    assert.equal(await page.locator(".overview-more-menu").getByRole("menuitem", { name: snapshot.copy.showSensitive, exact: true }).count(), 1);
    const mask = page.locator(".overview-more-menu").getByRole("menuitem", { name: snapshot.copy.showSensitive, exact: true });
    assert.ok(await mask.evaluate(button => { const icon = button.querySelector("svg").getBoundingClientRect(), text = button.querySelector("span:last-child").getBoundingClientRect(); return Math.abs((icon.top + icon.height / 2) - (text.top + text.height / 2)) < 2; }), "Mask icon and label share a line");
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
      assert.ok(controlBounds.every(bounds => Math.abs(bounds.y - controlBounds[0].y) <= 2), "Search, sort/filter, and view toggle stay on one row");
      assert.ok((await page.locator(".dashboard-account-toolbar").boundingBox()).height <= 50, "Account toolbar has no extra row");
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
        const workspaceToggle = page.getByRole("button", { name: "Enable workspace (Experimental)", exact: true });
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

        const [download] = await Promise.all([page.waitForEvent("download"), consoleDialog.getByRole("button", { name: "Download", exact: true }).click()]);
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
        assert.equal(await page.getByText("Token history retention", { exact: true }).count(), 1);
      }
      if (await tab.getAttribute("id") === "settings-tab-automation") {
        const tokenBlock = page.getByRole("button", { name: "Automatic token history", exact: true }).locator("../..");
        assert.equal(await tokenBlock.evaluate(block => block === block.parentElement.lastElementChild), true, "Automatic token history is last in Automation");
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
        assert.equal(await page.locator(".maintenance-tool").count(), 7, "Tools contain Codex utilities instead of duplicated dashboard shortcuts");
        await page.locator('.maintenance-tool').filter({ hasText: 'Archive manager' }).click();
        const archive = page.getByRole("region", { name: "Archive manager", exact: true });
        assert.equal(await page.getByRole('dialog').count(), 1, 'Maintenance stays in Settings instead of nesting a dialog');
        await archive.getByRole("checkbox").first().waitFor();
        assert.equal(await archive.getByRole("checkbox").count(), 50, "Archive management loads one bounded page");
        await archive.getByRole("button", { name: "Next", exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll(".maintenance-items input[type=checkbox]").length === 13);
        await archive.getByRole("searchbox", { name: "Search tool items" }).fill("task 62");
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
    await page.goto(`${origin}/workspace/${parentId}?closed-project`);
    await page.waitForFunction(() => window.__uiActions.some(action => action.action === "getWorkspaceEnvironment" && action.payload?.projectPath === "D:/closed-worktree"));
    if (width <= 1180) {
      if (width <= 760) {
        await page.getByRole("button", { name: "Session actions", exact: true }).click();
        await page.getByRole("menuitem", { name: "Show workspace tools", exact: true }).click();
      } else await page.getByRole("button", { name: "Show workspace tools", exact: true }).click();
    }
    const closedFiles = page.getByRole("tab", { name: "Files", exact: true });
    if (await closedFiles.count()) await closedFiles.click();
    else {
      await page.getByRole("button", { name: "Add workspace tool or terminal", exact: true }).click();
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
