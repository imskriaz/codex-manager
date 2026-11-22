import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, realpath, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

if (!process.argv.includes('--live')) throw Error('Use --live to test saved memory with isolated temporary subscriber accounts and real model responses.');
const origin = 'http://127.0.0.1:39875', output = await mkdtemp(path.join(os.tmpdir(), 'codex-manager-memory-qa-'));
const report = { checks: [], errors: [], output }, accounts = [];
const record = name => { report.checks.push(name); console.log(name); };
const admin = async (url, method, body) => {
  const response = await fetch(origin + url, { method, headers: { Origin: origin, 'X-Codex-Dashboard': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const result = await response.json(); assert.ok(response.ok, result.error); return result;
};
const browser = await chromium.launch({ channel: 'msedge', headless: true });
let primary, secondary, page;
try {
  for (let index = 0; index < 2; index++) {
    const username = 'qa-memory-' + randomUUID().slice(0, 8) + '@example.test', password = randomBytes(24).toString('base64url');
    const account = (await admin('/api/office/users', 'POST', { username, password, displayName: 'Memory QA', role: 'user', features: ['generalChat', 'tasks', 'files', 'browser', 'env'], limits: { storageMb: 10, dailyTokens: 250000, dailyRequests: 20 } })).user;
    accounts.push(account);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'X-Forwarded-For':'127.0.0.1' } });
    const login = await context.newPage(); login.setDefaultTimeout(20000); login.on('pageerror', error => report.errors.push(error.message));
    await login.goto(origin + '/login?returnTo=/workspace'); await login.locator('[name=username]').fill(username); await login.locator('[name=password]').fill(password); await login.locator('button[type=submit]').click(); await login.waitForURL(/\/workspace/);
    if (!index) { primary = context; page = login; } else { secondary = context; await login.close(); }
  }
  const get = async context => { const response = await context.request.get(origin + '/api/workspace/memory'); assert.ok(response.ok()); return (await response.json()).memory; };
  const change = (context, input) => context.request.post(origin + '/api/workspace/memory', { headers: { Origin: origin }, data: input });
  let memory = await get(primary); assert.equal(memory.enabled, true); assert.equal(memory.entries.length, 0);
  assert.ok((await change(primary, { operation: 'save', expected: memory.revision, text: 'Primary private preference', owner: accounts[1].id })).ok());
  assert.equal((await get(secondary)).entries.length, 0);
  memory = await get(primary); assert.equal(memory.entries.length, 1);
  const other = (await (await change(secondary, { operation: 'save', expected: '0', text: 'Secondary private preference' })).json()).memory;
  const denied = await change(primary, { operation: 'remove', expected: memory.revision, id: other.entries[0].id }); assert.equal(denied.status(), 400); assert.equal((await get(secondary)).entries.length, 1);
  assert.ok((await change(primary, { operation: 'clear', confirmed: true, expected: memory.revision })).ok());
  const csrf = await primary.request.post(origin + '/api/workspace/memory', { headers: { Origin: 'https://untrusted.invalid' }, data: { operation: 'clear', confirmed: true, expected: (await get(primary)).revision } }); assert.equal(csrf.status(), 403);
  record('Normal subscriber sign-in, owner isolation, foreign-ID rejection and same-origin checks');
  const action = async (action, payload) => {
    const response = await primary.request.post(origin + '/api/message', { headers: { Origin: origin, 'X-Codex-Dashboard': '1' }, data: { type: 'dashboard:action', action, requestId: randomUUID(), payload } }); assert.ok(response.ok());
    const result = (await response.json()).messages.find(item => item.type === 'dashboard:action-result'); assert.equal(result.status, 'completed', result.error); return result.payload;
  };
  const chat = async text => {
    const previous = page.url().split('/').at(-1);
    const start = page.locator('.user-rail-actions').getByRole('button', { name: 'New chat', exact: true });
    if (!await start.isVisible()) await page.getByRole('button', { name: 'Show sessions sidebar', exact: true }).click();
    await start.click(); await page.locator('.cli-composer textarea').fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await page.waitForURL(/\/workspace\/[a-f0-9-]{36}$/); await page.waitForFunction(previous => location.pathname.split('/').at(-1) !== previous, previous);
    const id = page.url().split('/').at(-1), end = Date.now() + 150000;
    while (Date.now() < end) {
      const result = await action('getCodexCliSessionMessages', { sessionId: id });
      if (result.cliSession.status === 'idle' && result.cliSessionMessages.length > 1) {
        assert.equal(result.cliSessionMessages.filter(message => message.kind === 'error').length, 0, result.cliSessionMessages.find(message => message.kind === 'error')?.text ?? 'Conversation has an error');
        return result.cliSessionMessages.filter(message => message.role === 'assistant').at(-1).text;
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw Error('Memory conversation did not complete within the test deadline.');
  };
  const browserCheck = async () => {
    await action('saveWorkspaceFile',{filePath:'browser-check.html',fileContent:'<!doctype html><title>Workspace browser check</title><link rel="stylesheet" href="browser-check.css"><button id="counter" onclick="this.textContent=Number(this.textContent)+1">0</button>'});
    await action('saveWorkspaceFile',{filePath:'browser-check.css',fileContent:'body{background:rgb(240, 245, 250)}'});
    const sessionId=page.url().split('/').at(-1);
    const browse=async request=>(await action('workspaceBrowser',{browserRequest:{operationId:randomUUID(),sessionId,...request}})).workspaceBrowser;
    const show=page.getByRole('button',{name:'Show workspace tools',exact:true});if(await show.isVisible())await show.click();await page.getByRole('tab',{name:'Browser',exact:true}).click();
    const panel=page.getByRole('region',{name:'Browser',exact:true}),address=panel.getByRole('textbox',{name:'Browser URL',exact:true});
    assert.equal(await address.getAttribute('placeholder'),'Enter a URL or workspace file');await address.fill('browser-check.html');await address.press('Enter');
    let opened;const deadline=Date.now()+30000;while(Date.now()<deadline){opened=await browse({operation:'list'});if(opened.pages.some(page=>page.title==='Workspace browser check'))break;await new Promise(resolve=>setTimeout(resolve,500));}
    const tab=opened.pages.find(page=>page.title==='Workspace browser check');assert.ok(tab,'Saved website opened through the visible Browser');
    await page.waitForFunction(()=>document.querySelector('[aria-label="Browser"]')?.getAttribute('aria-busy')==='false');
    let state=await browse({operation:'snapshot',pageId:tab.id});assert.match(state.text,/button "0"/);
    state=await browse({operation:'click',pageId:tab.id,revision:state.revision,selector:'#counter'});state=await browse({operation:'snapshot',pageId:tab.id});assert.match(state.text,/button "1"/);
    let checked=await browse({operation:'evaluate',pageId:tab.id,revision:state.revision,confirmed:true,text:'({color:getComputedStyle(document.body).backgroundColor,privateSession:document.cookie})'});assert.equal(checked.value.color,'rgb(240, 245, 250)');assert.equal(checked.value.privateSession,'');
    const forbidden=await primary.request.post(origin+'/api/message',{headers:{Origin:origin,'X-Codex-Dashboard':'1'},data:{type:'dashboard:action',action:'workspaceBrowser',requestId:randomUUID(),payload:{browserRequest:{operation:'open',operationId:randomUUID(),url:origin+'/api/state',sessionId}}}});assert.equal((await forbidden.json()).messages[0].status,'failed');
    const foreign=await secondary.request.post(origin+'/api/message',{headers:{Origin:origin,'X-Codex-Dashboard':'1'},data:{type:'dashboard:action',action:'workspaceBrowser',requestId:randomUUID(),payload:{browserRequest:{operation:'snapshot',pageId:tab.id}}}});assert.equal((await foreign.json()).messages[0].status,'failed');
    await page.screenshot({path:path.join(output,'browser-mobile.png')});
    const web=await browse({operation:'open',url:'https://example.com'});assert.ok(web.pages.some(page=>page.title==='Example Domain'));const snapshot=await browse({operation:'snapshot',pageId:web.pageId});assert.ok(snapshot.text.length>40,'Public website returned readable page content');
    for(const tab of (await browse({operation:'list'})).pages)await browse({operation:'close',pageId:tab.id,revision:tab.revision});
    await page.getByRole('button',{name:'Hide workspace tools',exact:true}).click();
    record('Real Browser opens public websites and saved pages with assets; interaction works and host/other-user access is blocked');
  };
  const marker = 'MEM-' + randomUUID().slice(0, 8);
  await chat(`Remember this for future chats: my standard buyer-report reference is ${marker}. Save it in memory.`);
  assert.ok((await get(primary)).entries.some(entry => entry.text.includes(marker))); record('Real assistant saves a requested memory');
  const recalled = await chat('What is my standard buyer-report reference? Reply with the reference only.'); assert.ok(recalled.includes(marker)); record('A new chat recalls the saved preference');
  await browserCheck();
  const settings = async () => { const show = page.getByRole('button', { name: 'Show sessions sidebar', exact: true }); if (await show.isVisible()) await show.click(); await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name:'Personalization', exact:true }).click(); return page.getByRole('region', { name: 'Memory settings', exact: true }); };
  let section = await settings(); await section.getByRole('checkbox', { name: 'Use saved memory', exact: true }).uncheck(); await section.getByRole('status').filter({ hasText: 'Memory is off.' }).waitFor();
  memory = await get(primary); assert.ok(memory.entries.some(entry => entry.text.includes(marker))); assert.equal(memory.enabled, false);
  assert.equal((await change(primary, { operation: 'save', expected: memory.revision, text: 'Cannot save while off' })).status(), 400);
  await page.locator('.office-user-settings .settings-close').click();
  const unknown = await chat('What is my standard buyer-report reference? If I have not provided it here, reply Unknown. Reply with the reference or Unknown only.'); assert.ok(!unknown.includes(marker)); assert.match(unknown, /unknown/i);
  record('Mobile setting disables recall and saves while retaining existing entries');
  section = await settings(); await section.getByRole('checkbox', { name: 'Use saved memory', exact: true }).check(); await section.getByRole('status').filter({ hasText: 'Memory is on' }).waitFor(); await section.getByRole('button', {name:'Manage memories',exact:true}).click(); const saved = page.getByRole('dialog',{name:'Saved memories',exact:true}); await saved.getByText(new RegExp(marker)).waitFor(); await page.screenshot({ path: path.join(output, 'memory-mobile.png') }); await saved.getByRole('button',{name:'Close saved memories',exact:true}).click(); await page.locator('.office-user-settings .settings-close').click();
  await chat('Forget my saved standard buyer-report reference. Remove that memory now.'); assert.ok(!(await get(primary)).entries.some(entry => entry.text.includes(marker)));
  assert.equal((await get(secondary)).entries.length, 1); record('Real assistant forgets the requested memory without affecting another user');
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.failure = error.message; console.error(error.stack); if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); process.exitCode = 1; }
finally {
  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index], context = index ? secondary : primary;
    try {
      if (context) { const response = await context.request.get(origin + '/api/workspace/memory'); if (response.ok()) { const {memory} = await response.json(); await context.request.post(origin + '/api/workspace/memory', { headers: {Origin:origin}, data: {operation:'clear',expected:memory.revision,confirmed:true} }); } }
      if (!index && context && page?.url().match(/\/workspace\/[a-f0-9-]{36}$/)) {
        const sessionId=page.url().split('/').at(-1);
        const call=async browserRequest=>{const response=await context.request.post(origin+'/api/message',{headers:{Origin:origin,'X-Codex-Dashboard':'1'},data:{type:'dashboard:action',action:'workspaceBrowser',requestId:randomUUID(),payload:{browserRequest:{operationId:randomUUID(),sessionId,...browserRequest}}}});return (await response.json()).messages.find(item=>item.type==='dashboard:action-result')?.payload?.workspaceBrowser;};
        for(const tab of (await call({operation:'list'}))?.pages??[])await call({operation:'close',pageId:tab.id,revision:tab.revision});
      }
      await admin('/api/office/users/' + account.id, 'DELETE');
      const base = await realpath(path.dirname(account.workspacePath)), target = path.resolve(account.workspacePath);
      if (path.dirname(target).toLowerCase() !== base.toLowerCase() || !/^qa-memory-[a-f0-9]{8}-example\.test$/.test(path.basename(target)) || (await lstat(target)).isSymbolicLink() || (await realpath(target)).toLowerCase() !== target.toLowerCase()) throw Error('Unexpected QA workspace path; left in place.');
      await rm(target, { recursive: true });
    } catch (error) { report.cleanupError = error.message; process.exitCode = 1; }
  }
  await browser.close(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log('QA report: ' + path.join(output, 'report.json'));
}
