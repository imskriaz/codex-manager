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
    const errors = [], privateRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/\/api\/(?:state|message|events)(?:[?]|$)/.test(request.url())) privateRequests.push(request.url()); });
    for (const [asset, file, contentType] of [['dashboard.js','media/webview/dashboard/dashboard.js','text/javascript'],['dashboard.css','media/webview/quotaSummary.css','text/css'],['projectShare.js','media/webview/projectShare.js','text/javascript'],['sharedConversation.js','media/webview/sharedConversation.js','text/javascript']]) await page.route(`**/assets/${asset}*`, route => route.fulfill({ contentType, path: path.resolve(file) }));
    await page.route('**/share/fixture', route => route.fulfill({ contentType:'text/html', body:'<!doctype html><html data-theme="auto"><head><meta charset="utf-8"><link rel="stylesheet" href="/assets/shared.css"><link rel="stylesheet" href="/assets/dashboard.css"></head><body class="public-conversation"><main><h1 id="conversation-title">Shared conversation</h1><span id="live-state"></span><span id="message-count"></span><section id="conversation"></section></main><script src="/assets/dashboard.js" defer></script><script src="/assets/sharedConversation.js" defer></script></body></html>' }));
    await page.route('**/api/share/fixture', route => route.fulfill({ json:{ title:'Shared conversation', messages } }));
    await page.goto(`${origin}/share/fixture`);
    await page.locator('#conversation .cli-session-message').nth(1).waitFor();
    assert.equal(await page.locator('#conversation table').count(), 1, 'Public conversation uses rich workspace markdown');
    assert.equal(await page.evaluate(() => window.bad), undefined, 'Shared markdown cannot execute HTML');
    await page.screenshot({ path:path.join(output,`conversation-${width}.png`) });
    let revoked = false, failWrites = false, holdWrite = false, releaseWrite;
    let permissions = ['messages','activities'];
    const writes = [];
    async function waitForHeldWrite() {
      for (let attempt = 0; !releaseWrite && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(typeof releaseWrite, 'function', 'The test request reached the pending-write fixture');
    }
    const tasks = [{ id:'task', title:'Release work', prompt:'Review the release', stage:'planned' },{id:'archive',title:'Archived work',prompt:'',stage:'completed',sessionArchived:true}];
    await page.route('**/projects/share/fixture', route => route.fulfill({ contentType:'text/html', body:'<!doctype html><html data-theme="auto"><head><meta charset="utf-8"><link rel="stylesheet" href="/assets/shared.css"><link rel="stylesheet" href="/assets/dashboard.css"></head><body><main id="project-share" class="public-project"></main><script src="/assets/dashboard.js"></script><script src="/assets/projectShare.js"></script></body></html>' }));
    await page.route('**/api/projects/share/fixture*', async route => {
      if (route.request().method() === 'POST') {
        writes.push(route.request().postDataJSON());
        if (holdWrite) await new Promise(resolve => { releaseWrite = resolve; });
        await route.fulfill(failWrites ? { status:503,json:{ error:'Temporarily unavailable' } } : { json:{ ok:true } });
        return;
      }
      await route.fulfill(revoked ? { status:404,json:{ error:'Revoked' } } : { json:new URL(route.request().url()).searchParams.has('task') ? { messages, files:[],history:[],warnings:[] } : {title:'Project work',tasks,comments:[],permissions,expiresAt:Date.now()+60000} });
    });
    await page.goto(`${origin}/projects/share/fixture`);
    await page.getByRole('button', {name:'Release work Review the release'}).click();
    await page.locator('.task-detail-panel .cli-session-message').nth(1).waitFor();
    assert.equal(await page.getByRole('tab', {name:'Messages',exact:true}).count(), 0, 'Task history has a combined Activities tab');
    assert.equal(await page.locator('.task-detail-panel table').count(), 1);
    await page.screenshot({ path:path.join(output,`task-${width}.png`) });
    await page.getByRole('button',{name:'Close task details',exact:true}).click();
    permissions = [...permissions,'submissions','comments'];
    await page.getByRole('button',{name:'Refresh',exact:true}).click();
    const ideaTitle = page.getByRole('textbox',{name:'Request title',exact:true});
    const ideaPrompt = page.getByRole('textbox',{name:'Request details',exact:true});
    const submitIdea = page.getByRole('button',{name:'Submit idea',exact:true});
    await ideaTitle.fill('Preserve my draft'); await ideaPrompt.fill('Uncertain request');
    failWrites = true; await submitIdea.click();
    await page.getByRole('status').filter({hasText:'Submission not confirmed'}).waitFor();
    const originalId = writes.at(-1).id;
    await page.reload();
    await ideaTitle.waitFor();
    assert.equal(await ideaTitle.inputValue(),'Preserve my draft','Failed requests retain their draft through reload');
    await submitIdea.click();
    await page.getByRole('status').filter({hasText:'Submission not confirmed'}).waitFor();
    assert.equal(writes.at(-1).id,originalId,'An unchanged retry reuses its request identity after reload');
    await ideaPrompt.fill('Edited request');
    failWrites = false; holdWrite = true; await submitIdea.click();
    await page.waitForFunction(() => document.querySelector('.public-project-form input').readOnly);
    await waitForHeldWrite();
    assert.notEqual(writes.at(-1).id,originalId,'An edited retry uses a new request identity');
    const writeCount = writes.length;
    await page.evaluate(() => document.querySelector('.public-project-form').dispatchEvent(new Event('submit',{cancelable:true})));
    await page.getByRole('button',{name:'Refresh',exact:true}).click();
    assert.equal(await submitIdea.isDisabled(),true,'Refresh cannot re-enable a pending submission');
    assert.equal(writes.length,writeCount,'Duplicate submits do not dispatch another write');
    releaseWrite(); releaseWrite = undefined; holdWrite = false;
    await page.getByRole('status').filter({hasText:'Idea submitted'}).waitFor();
    assert.equal(await ideaTitle.inputValue(),'');
    await page.getByRole('button',{name:'Release work Review the release'}).click();
    const comment = page.getByRole('textbox',{name:'Comment',exact:true});
    const postComment = page.getByRole('button',{name:'Add comment',exact:true});
    await comment.fill('Keep my comment'); holdWrite = true; await postComment.click();
    await waitForHeldWrite();
    assert.equal(await comment.evaluate(input => input.readOnly),true,'Pending comments cannot lose concurrent edits');
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/projects/share/fixture')), page.evaluate(() => window.dispatchEvent(new Event('focus')))]);
    assert.equal(await postComment.isDisabled(),true,'Refresh cannot re-enable a pending comment');
    releaseWrite(); releaseWrite = undefined; holdWrite = false;
    await page.getByRole('status').filter({hasText:'Comment added.'}).waitFor();
    await page.context().setOffline(true);
    await page.waitForFunction(() => !navigator.onLine);
    assert.equal(await postComment.isDisabled(),true,'Offline comment actions disable immediately');
    assert.equal(await submitIdea.isDisabled(),true,'Offline idea actions disable immediately');
    await page.context().setOffline(false);
    await page.getByRole('button',{name:'Close task details',exact:true}).click();
    await page.evaluate(() => { window.__setItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new DOMException('Full','QuotaExceededError'); }; });
    await ideaTitle.fill('Storage-full draft');
    await page.getByRole('status').filter({hasText:'Draft is kept in this tab only'}).waitFor();
    assert.equal(await ideaTitle.inputValue(),'Storage-full draft','Storage failures preserve the editable draft');
    await page.evaluate(() => { Storage.prototype.setItem = window.__setItem; });
    assert.equal(await page.getByText('Archived work',{exact:true}).count(), 1, 'Archived sessions stay in Completed');
    await page.getByRole('button',{name:'Archive',exact:true}).click();
    await page.getByText('Archived work',{exact:true}).waitFor();
    revoked = true;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => document.querySelectorAll('.task-board-card').length === 0);
    await page.getByRole('searchbox',{name:'Search tasks'}).fill('work');
    assert.equal(await page.locator('.task-board-card').count(),0,'Search cannot restore a revoked board from memory');
    assert.deepEqual(privateRequests, [], 'Public views never start authenticated dashboard requests');
    assert.deepEqual(errors, [], 'Public views have no runtime errors');
    console.log(`${width}px public rich history, draft/retry/reload, duplicate submit, offline, archive, and revocation passed`);
    await page.close();
  }
  console.log(`Screenshots: ${output}`);
} finally { await browser.close(); }
