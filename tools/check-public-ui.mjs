import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Uses the canonical local host for assets; all shared data is an in-memory fixture.
const origin = 'http://127.0.0.1:39875';
const output = path.join(tmpdir(), 'codex-manager-public-ui');
await mkdir(output, { recursive: true });
const messages = [{ id: 'user', role: 'user', kind: 'message', text: 'Review this task.' }, { id: 'reply', role: 'assistant', kind: 'message', text: '## Result\n\n| Item | State |\n| --- | --- |\n| UI | Ready |\n\n```ts\nconst ready = true;\n```\n\n<script>window.bad = true</script>' }];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [1440,390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    await page.addInitScript(() => {
      window.__projectStreams = [];
      window.EventSource = class extends EventTarget {
        static CLOSED = 2;
        readyState = 1;
        constructor(url) { super(); this.url = url; window.__projectStreams.push(this); queueMicrotask(() => { if (this.readyState !== 2) this.dispatchEvent(new Event('ready')); }); }
        close() { this.readyState = 2; }
      };
    });
    const errors = [], privateRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/\/api\/(?:state|message|events)(?:[?]|$)/.test(request.url())) privateRequests.push(request.url()); });
    for (const [asset, file, contentType] of [['dashboard.js','media/webview/dashboard/dashboard.js','text/javascript'],['dashboard.css','media/webview/quotaSummary.css','text/css'],['projectShare.js','media/webview/projectShare.js','text/javascript'],['sharedConversation.js','media/webview/sharedConversation.js','text/javascript']]) await page.route(`**/assets/${asset}*`, route => route.fulfill({ contentType, path: path.resolve(file) }));
    await page.route('**/share/fixture', route => route.fulfill({ contentType:'text/html', body:'<!doctype html><html data-theme="auto"><head><meta charset="utf-8"><link rel="stylesheet" href="/assets/shared.css"><link rel="stylesheet" href="/assets/dashboard.css"></head><body class="public-conversation"><main class="cli-workspace cli-public-session"><div id="shared-header"></div><span id="live-state"></span><div class="cli-message-region"><section id="conversation" class="cli-message-viewport"></section></div></main><script src="/assets/dashboard.js" defer></script><script src="/assets/sharedConversation.js" defer></script></body></html>' }));
    let sharedMessages = [...messages,{id:'command',kind:'command',text:'Ran a command',command:'echo public',output:'Complete command output',status:'completed'},{id:'tool',kind:'tool-call',text:'Used a tool',title:'Search tool',arguments:'{"query":"public activity"}',result:'Complete tool result',status:'completed'}];
    await page.route('**/api/share/fixture', route => route.fulfill({ json:{ title:'Shared conversation', messages:sharedMessages } }));
    await page.goto(`${origin}/share/fixture`);
    await page.locator('#conversation .cli-session-message').nth(1).waitFor();
    assert.equal(await page.locator('#conversation table').count(), 1, 'Public conversation uses rich workspace markdown');
    assert.equal(await page.evaluate(() => window.bad), undefined, 'Shared markdown cannot execute HTML');
    await page.locator('#conversation .cli-activity-group-details>summary').click();
    assert.ok(await page.locator('#conversation').textContent().then(text=>text.includes('Complete command output')&&text.includes('Complete tool result')&&text.includes('public activity')),'Public transcripts retain command output, tool arguments and results');
    assert.equal(await page.getByRole('button',{name:'Show workspace tools',exact:true}).count(),0,'Public sessions cannot open the right sidebar');
    assert.equal(await page.getByRole('button',{name:'Session actions',exact:true}).count(),0,'Public sessions cannot use private mutations');
    await page.screenshot({ path:path.join(output,`conversation-${width}.png`) });
    sharedMessages = [...messages, { id:'live-share',role:'assistant',kind:'message',text:'Event-based shared update' }];
    await page.evaluate(() => window.__projectStreams.at(-1).dispatchEvent(new Event('change')));
    await page.getByText('Event-based shared update',{exact:true}).waitFor();
    await page.evaluate(() => window.__projectStreams.at(-1).dispatchEvent(new Event('revoked')));
    await page.getByText('This link expired or was revoked.',{exact:true}).waitFor();
    assert.equal(await page.locator('#conversation .cli-session-message').count(),0,'Legacy share revocation removes the rendered conversation');
    let revoked = false, failWrites = false, holdWrite = false, releaseWrite, failFile = false, historyWarningsOnly = false;
    let permissions = ['messages','activities','files'];
    let taskMessages = [...messages,{id:'thinking',kind:'reasoning',text:'Private reasoning noise'},{id:'failed-tool',kind:'tool-call',status:'failed',text:'Failed attempt noise'}], holdRead = false, releaseRead;
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    taskMessages[0] = { ...taskMessages[0], images: [{ src: image, alt: 'Shared attachment' }] };
    const comments = [], uploaded = new Map();
    const uploadMetadata=files=>files?.map(({data,...file})=>{uploaded.set(file.id,{...file,data});return {...file,hash:'a'.repeat(64)};});
    const writes = [];
    async function waitForHeldWrite() {
      for (let attempt = 0; !releaseWrite && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(typeof releaseWrite, 'function', 'The test request reached the pending-write fixture');
    }
    const tasks = [{ id:'task', title:'Release work', prompt:'Review the release', stage:'planned',createdAt:Date.now(),updatedAt:Date.now(),timing:{firstStartedAt:Date.now()-3600000,lastObservedAt:Date.now(),durationMs:1800000,runCount:2} },{id:'archive',title:'Archived work',prompt:'',stage:'completed',sessionArchived:true,parentTaskId:'task'}];
    await page.route('**/projects/share/fixture', route => route.fulfill({ contentType:'text/html', body:'<!doctype html><html data-theme="auto"><head><meta charset="utf-8"><link rel="stylesheet" href="/assets/shared.css"><link rel="stylesheet" href="/assets/dashboard.css"></head><body><main id="project-share" class="public-project"></main><script src="/assets/dashboard.js"></script><script src="/assets/projectShare.js"></script></body></html>' }));
    await page.route('**/api/projects/share/fixture*', async route => {
      if (route.request().method() === 'POST') {
        writes.push(route.request().postDataJSON());
        if (holdWrite) await new Promise(resolve => { releaseWrite = resolve; });
        if(!failWrites) {const body=writes.at(-1);if(body.kind==='task'&&!tasks.some(task=>task.id===body.id))tasks.push({id:body.id,title:body.title,prompt:body.prompt,stage:'idea',createdAt:Date.now(),updatedAt:Date.now(),attachments:uploadMetadata(body.uploads)});else if(body.kind==='comment'&&!comments.some(comment=>comment.id===body.id))comments.push({id:body.id,taskId:body.taskId,text:body.text,author:'Visitor',createdAt:Date.now(),attachments:uploadMetadata(body.uploads)});}
        await route.fulfill(failWrites ? { status:503,json:{ error:'Temporarily unavailable' } } : { json:{ ok:true } });
        return;
      }
      const query = new URL(route.request().url()).searchParams, isTask = query.has('task'), wasRevoked = revoked;
      if (query.has('file') && failFile) { await route.fulfill({status:503,json:{error:'Attachment is temporarily unavailable.'}}); return; }
      const files = [{ path:'@attachment/upload/text/0',name:'brief.txt',type:'file',attachment:true },{path:'@attachment/upload/image/0',name:'Screenshot',type:'file',attachment:true}];
      const savedUpload=uploaded.get(decodeURIComponent(query.get('file')?.split('/').at(-1)||''));
      const file = savedUpload ? {path:savedUpload.name,kind:savedUpload.kind,content:savedUpload.kind==='text'?savedUpload.data:'',dataUrl:savedUpload.kind==='image'?savedUpload.data:undefined,mimeType:savedUpload.mimeType,size:savedUpload.size,revision:'public-upload'} : query.get('file')?.includes('/image/') ? {path:'Screenshot',kind:'image',dataUrl:image,content:''} : {path:'brief.txt',kind:'text',content:'Shared uploaded snapshot'};
      const warningOnly = historyWarningsOnly && query.get('view') === 'activities';
      const snapshot = JSON.parse(JSON.stringify(isTask ? query.has('file') ? {file} : { messages:query.get('view')==='files'||warningOnly?[]:taskMessages, files:query.get('view')==='files'?files:[],history:[],warnings:warningOnly?['Saved history is temporarily unavailable.']:[] } : {title:'Project work',tasks,comments,permissions,expiresAt:0}));
      if (!isTask && holdRead) { holdRead = false; await new Promise(resolve => { releaseRead = resolve; }); }
      await route.fulfill(wasRevoked ? { status:404,json:{ error:'Revoked' } } : { json:snapshot });
    });
    await page.goto(`${origin}/projects/share/fixture`);
    await page.getByRole('button',{name:'Board actions',exact:true}).click();
    const ideaColumn=page.getByRole('menuitemcheckbox',{name:'Idea',exact:true});
    assert.equal(await ideaColumn.getAttribute('aria-checked'),'false','Public board follows the same hidden-Idea default');
    await ideaColumn.click();await page.keyboard.press('Escape');
    await page.locator('.task-board-card').filter({hasText:'Release work'}).click();
    await page.getByRole('tab',{name:'Activities',exact:true}).click();
    await page.locator('.task-detail-panel .cli-session-message').nth(1).waitFor();
    assert.equal(await page.locator('.task-timeline').count(),1,'Public board uses the same task timeline');
    assert.equal(await page.getByText('Private reasoning noise',{exact:true}).count(),0);
    assert.equal(await page.getByText('Failed attempt noise',{exact:true}).count(),0);
    assert.equal(await page.getByRole('tab', {name:'Messages',exact:true}).count(), 0, 'Task history has a combined Activities tab');
    assert.equal(await page.locator('.task-detail-panel table').count(), 1);
    await page.getByRole('button',{name:'Preview Shared attachment',exact:true}).click();
    taskMessages = [...taskMessages,{id:'live',role:'assistant',kind:'message',text:'Live public activity without focus changes'}];
    await page.evaluate(() => window.__projectStreams.at(-1).dispatchEvent(new Event('change')));
    await page.getByText('Live public activity without focus changes',{exact:true}).waitFor();
    assert.equal(await page.locator('.cli-image-lightbox').count(),1,'A live activity update preserves the open image viewer');
    historyWarningsOnly = true;
    await page.evaluate(() => window.__projectStreams.at(-1).dispatchEvent(new Event('change')));
    await page.getByRole('status').filter({hasText:'Saved history is temporarily unavailable.'}).waitFor();
    assert.equal(await page.getByText('Live public activity without focus changes',{exact:true}).count(),1,'A partial history failure preserves saved messages');
    assert.equal(await page.locator('.cli-image-lightbox').count(),1,'A partial history failure preserves the active image viewer');
    historyWarningsOnly = false;
    await page.getByRole('button',{name:'Close image preview',exact:true}).click();
    await page.screenshot({ path:path.join(output,`task-${width}.png`) });
    await page.getByRole('tab',{name:'Files',exact:true}).click();
    failFile = true;
    await page.locator('.task-file-row').filter({hasText:'brief.txt'}).click();
    await page.getByRole('status').filter({hasText:'Attachment is temporarily unavailable.'}).waitFor();
    failFile = false;
    await page.locator('.task-file-row').filter({hasText:'brief.txt'}).click();
    await page.getByText('Shared uploaded snapshot',{exact:true}).waitFor();
    await page.locator('.task-file-row').filter({hasText:'Screenshot'}).click();
    await page.getByRole('button',{name:'Preview Screenshot',exact:true}).click();
    await page.getByRole('button',{name:'Close image preview',exact:true}).click();
    assert.equal(await page.locator('.task-detail-panel .task-activity').count(),1,'File previews replace the previous preview');
    await page.getByRole('button',{name:'Preview Screenshot',exact:true}).click();
    await page.getByRole('button',{name:'Close task details',exact:true}).evaluate(button=>button.click());
    assert.equal(await page.locator('.cli-image-lightbox').count(),0,'Closing a shared task unmounts its image viewer');
    holdRead = true;
    await page.evaluate(() => window.__projectStreams.at(-1).dispatchEvent(new Event('change')));
    for (let attempt = 0; !releaseRead && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve,20));
    assert.equal(typeof releaseRead,'function','The pending read reached its fixture');
    tasks.push({id:'live-board',title:'Task added during refresh',prompt:'',stage:'idea'});
    await page.evaluate(() => window.__projectStreams.at(-1).dispatchEvent(new Event('change')));
    releaseRead(); releaseRead = undefined;
    await page.getByText('Task added during refresh',{exact:true}).waitFor();
    for (const name of ['List','Gantt','Calendar']) {
      await page.getByRole('tab',{name,exact:true}).click();
      if(name==='List') await page.locator('.task-list-title').filter({hasText:'Release work'}).waitFor();
      if(name==='Gantt') await page.locator('.task-gantt-bar').first().waitFor();
      if(name==='Calendar') assert.equal(await page.locator('.task-calendar-day').count(),42);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),name+' contains wide content');
    }
    await page.getByRole('tab',{name:'Board',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Share project',exact:true}).count(),0,'Public permission gates remove private sharing controls');
    await page.getByRole('button',{name:'Board actions',exact:true}).click();
    assert.equal(await page.getByRole('menuitem',{name:'Share project',exact:true}).count(),0,'Public board menus also omit private sharing');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button',{name:'Add Planned task',exact:true}).count(),0,'Public readers cannot create work in execution columns');
    permissions = [...permissions,'submissions','comments'];
    const refreshBoard = async () => { await page.getByRole('button',{name:'Board actions',exact:true}).click(); await page.getByRole('menuitem',{name:'Refresh board',exact:true}).click(); };
    await refreshBoard();
    const newTask = async () => { await page.getByRole('button',{name:'＋ Task',exact:true}).click(); };
    await newTask();
    const panel = page.getByRole('dialog',{name:'New task',exact:true}), ideaTitle = panel.getByLabel('Title',{exact:true}), ideaPrompt = panel.getByLabel('Prompt / idea',{exact:true}), submitIdea = panel.locator('button[type=submit]');
    await ideaTitle.fill('Preserve my draft'); await ideaPrompt.fill('Uncertain request');
    await panel.locator('input[type=file]').setInputFiles({name:'guest.txt',mimeType:'text/plain',buffer:Buffer.from('Guest file survives retries')});
    await panel.getByRole('button',{name:'Remove guest.txt',exact:true}).waitFor();
    failWrites=true; await submitIdea.click();
    await page.getByRole('status').filter({hasText:'Submission not confirmed'}).waitFor();
    const originalId=writes.at(-1).id;
    await page.reload(); await page.getByRole('button',{name:'＋ Task',exact:true}).waitFor(); await newTask();
    assert.equal(await ideaTitle.inputValue(),'Preserve my draft','Failed requests retain their draft through reload');
    assert.equal(await panel.getByRole('button',{name:'Remove guest.txt',exact:true}).count(),1,'The attachment survives an uncertain request and reload');
    await submitIdea.click(); await page.getByRole('status').filter({hasText:'Submission not confirmed'}).waitFor();
    assert.equal(writes.at(-1).id,originalId,'An unchanged retry reuses its request identity after reload');
    await ideaPrompt.fill('Edited request');await page.reload();await page.getByRole('button',{name:'＋ Task',exact:true}).waitFor();await newTask();
    assert.equal(await ideaPrompt.inputValue(),'Edited request','An edited uncertain draft survives another reload');
    failWrites=false;holdWrite=true;await submitIdea.click();await waitForHeldWrite();
    assert.equal(await ideaTitle.evaluate(input=>input.readOnly),true,'Pending writes freeze their input');
    assert.equal(await panel.getByRole('button',{name:'Close new task',exact:true}).isDisabled(),true,'Pending submissions cannot be closed');
    await page.evaluate(()=>window.__projectStreams.at(-1).dispatchEvent(new Event('change')));
    assert.equal(await submitIdea.isDisabled(),true,'A background refresh preserves pending submission state');
    assert.equal(await ideaPrompt.inputValue(),'Edited request');
    const writeCount=writes.length;await submitIdea.evaluate(button=>button.click());assert.equal(writes.length,writeCount,'Pending submission cannot be duplicated');
    releaseWrite();releaseWrite=undefined;holdWrite=false;await panel.waitFor({state:'hidden'});
    assert.notEqual(writes.at(-1).id,originalId,'An edited retry creates a distinct request identity');
    await page.locator('.task-board-card').filter({hasText:'Release work'}).click();
    const detailPanel=page.locator('.task-detail-panel'), comment=detailPanel.getByRole('textbox',{name:'Add a comment',exact:true}), postComment=detailPanel.getByRole('button',{name:'Add comment',exact:true});
    await detailPanel.locator('input[type=file]').setInputFiles({name:'guest-comment.txt',mimeType:'text/plain',buffer:Buffer.from('Public comment attachment')});
    await detailPanel.getByRole('button',{name:'Remove guest-comment.txt',exact:true}).waitFor();
    await comment.fill('Keep my pending comment');holdWrite=true;await postComment.click();await waitForHeldWrite();
    await page.evaluate(()=>window.__projectStreams.at(-1).dispatchEvent(new Event('change')));
    assert.equal(await postComment.isDisabled(),true,'Refresh cannot re-enable a pending comment');
    releaseWrite();releaseWrite=undefined;holdWrite=false;await page.getByRole('status').filter({hasText:'Comment added.'}).waitFor();
    await detailPanel.getByRole('button',{name:'guest-comment.txt',exact:true}).click();
    const attachmentPreview=page.locator('.task-attachment-modal');
    await attachmentPreview.getByText('Public comment attachment',{exact:true}).waitFor();
    await attachmentPreview.getByRole('button',{name:'Close attachment',exact:true}).click();
    await page.context().setOffline(true);await page.waitForFunction(()=>!navigator.onLine);
    assert.equal(await postComment.isDisabled(),true,'Offline comments disable immediately');
    // navigator.onLine changes before the browser dispatches the offline event.
    await page.waitForFunction(()=>window.__projectStreams.every(stream=>stream.readyState===2));
    assert.equal(await page.evaluate(()=>window.__projectStreams.every(stream=>stream.readyState===2)),true,'Offline pages release their live connections');
    await detailPanel.getByRole('button',{name:'Close task details',exact:true}).click();await newTask();await ideaTitle.fill('Offline idea');
    assert.equal(await submitIdea.isDisabled(),true,'Public submissions are never queued offline');
    await page.context().setOffline(false);await page.waitForFunction(()=>navigator.onLine);
    await page.evaluate(()=>{window.__setItem=Storage.prototype.setItem;Storage.prototype.setItem=()=>{throw new DOMException('Full','QuotaExceededError');};});
    await ideaTitle.fill('Storage-full draft');await page.getByRole('status').filter({hasText:'Draft is kept in this tab only'}).waitFor();
    assert.equal(await ideaTitle.inputValue(),'Storage-full draft','Storage failures preserve the editable draft');
    await page.evaluate(()=>{Storage.prototype.setItem=window.__setItem;});await panel.getByRole('button',{name:'Close new task',exact:true}).click();
    assert.equal(await page.getByText('Archived work',{exact:true}).count(), 1, 'Archived sessions stay in Completed');
    await page.getByRole('button',{name:'Board actions',exact:true}).click(); await page.getByRole('menuitem',{name:/Archive ·/}).click();
    await page.getByText('Archived work',{exact:true}).waitFor();
    holdRead = true;
    await page.evaluate(() => window.__projectStreams.at(-1).dispatchEvent(new Event('change')));
    for (let attempt = 0; !releaseRead && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve,20));
    assert.equal(typeof releaseRead,'function','Revocation races a pending read');
    revoked = true;
    await page.evaluate(() => window.__projectStreams.at(-1).dispatchEvent(new Event('revoked')));
    releaseRead(); releaseRead = undefined;
    await page.getByRole('status').filter({hasText:'This project link expired or was revoked.'}).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.task-board-card').length === 0);
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    assert.equal(await page.locator('.task-board-card').count(),0,'Search cannot restore a revoked board from memory');
    assert.equal(await page.evaluate(() => window.__projectStreams.every(stream => stream.readyState === 2)),true,'Revocation closes every stream');
    assert.deepEqual(privateRequests, [], 'Public views never start authenticated dashboard requests');
    assert.deepEqual(errors, [], 'Public views have no runtime errors');
    console.log(`${width}px public rich history, draft/retry/reload, duplicate submit, offline, archive, and revocation passed`);
    await page.close();
  }
  console.log(`Screenshots: ${output}`);
} finally { await browser.close(); }
