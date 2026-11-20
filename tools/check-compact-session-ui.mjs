import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

const origin = 'http://127.0.0.1:39875';
const output = path.join(tmpdir(), 'codex-manager-compact-session-ui');
await mkdir(output, { recursive: true });
const response = await fetch(`${origin}/api/state`);
assert.equal(response.status, 200);
const snapshot = await response.json();
const state = structuredClone(snapshot);
Object.assign(state.settings, { cliIntegrationEnabled: true, taskBoardEnabled: true, autoResumeEnabled: true, privacyMode: false });
state.connectedPeers = [{ id: 'fixture-local', name: 'This PC', local: true, connected: true }];
state.peerAccounts = {};
state.accounts = state.accounts.slice(0, 1).map(account => ({ ...account, enabled: true, runningDeviceName: undefined, hasQuotaError: false, hasPendingResetCreditAttempt: false, metrics: account.metrics.map(metric => ({ ...metric, visible: true, percentage: 0 })) }));
const session = { id: '01a04882-d037-7a42-ad24-9afb61901188', title: 'Compact session', status: 'idle', interrupted: true, autoResumeEnabled: true, projectPath: 'D:/demo', model: 'gpt-5', updatedAt: new Date().toISOString() };
const messages = [
  { id: 'user', kind: 'message', role: 'user', text: 'Check compact notices.' },
  { id: 'capacity', kind: 'error', text: 'Selected model is at capacity. Please try a different model.', debug: 'Capacity diagnostics preserved', status: 'failed' },
  { id: 'retry', kind: 'error', title: 'Retry attempt', text: 'Retrying in 2 seconds.', debug: 'Retry diagnostics preserved', status: 'interrupted' },
  { id: 'failure', kind: 'error', text: 'Authentication failed.\nOriginal provider detail.', debug: 'Failure diagnostics preserved', status: 'failed' },
  { id: 'quota', kind: 'error', text: 'You have hit your usage limit. Retry tomorrow.', debug: 'Quota diagnostics preserved', status: 'failed' }
];
const fixtureHost = `(() => {
  const state = ${JSON.stringify(state)}, session = ${JSON.stringify(session)}, messages = ${JSON.stringify(messages)};
  const config = { standalone:true, models: [{id:'gpt-5',label:'GPT-5',reasoningEfforts:['medium','high']}], projects: [{id:'demo',path:'D:/demo',label:'demo'}], defaultModel:'gpt-5', defaultSandboxMode:'danger-full-access' };
  const task = {id:'session:'+session.id,title:session.title,prompt:'Check compact notices',stage:'planned',revision:1,createdAt:1,updatedAt:1,sessionId:session.id};
  const dispatch = data => window.dispatchEvent(new MessageEvent('message',{data}));
  window.acquireVsCodeApi = () => ({ getState(){}, setState(){}, postMessage(message) {
    setTimeout(() => {
      if(message.type === 'dashboard:ready') {dispatch({type:'dashboard:snapshot',state});dispatch({type:'dashboard:connection',connected:true});}
      if(message.type !== 'dashboard:action') return;
      let payload = {};
      if(message.action === 'listCodexCliSessions') payload = {cliSessions:[session],cliComposerConfig:config};
      if(message.action === 'getCodexCliSessionMessages') payload = {cliSession:session,cliSessionMessages:messages};
      if(message.action === 'getProjectBoard') payload = {projectBoard:{projectPath:'D:/demo',homeKey:'fixture',revision:1,tasks:[task],comments:[],sessions:[session],updatedAt:Date.now()}};
      if(message.action === 'getProjectTaskDetails') payload = {projectTaskDetails:{taskId:task.id,initialPrompt:task.prompt,messages,files:[],warnings:[]}};
      if(message.action === 'getWorkspaceEnvironment') payload = {workspaceEnvironment:{projectPath:'D:/demo',projectName:'demo',branch:'main',isGitRepository:true,changes:0}};
      if(message.action === 'listWorkspaceFiles') payload = {workspaceFiles:[]};
      if(message.action === 'listWorkspaceTerminals') payload = {workspaceTerminals:[]};
      dispatch({type:'dashboard:action-result',action:message.action,requestId:message.requestId,status:'completed',payload});
    },0);
  }});
})();`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await useWorkspaceDashboardAssets(page, origin, context);
    // Fixture host intercepts every action; only navigation and assets reach the local host.
    await context.route('**/api/**', route => route.abort());
    await context.route('**/assets/browserHost.js*', route => route.fulfill({ contentType: 'text/javascript', body: fixtureHost }));
    const start = Date.now();
    await page.goto(`${origin}/workspace/${session.id}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.cli-conversation .cli-error-notice').first().waitFor();
    const loadMs = Date.now() - start;
    const recovery = page.locator('.cli-conversation .cli-capacity-notice').filter({ hasText: /Waiting for quota to reset|Checking account quota/ });
    await recovery.waitFor();
    assert.equal(await page.getByText('Account usage limit · saved for recovery', { exact: true }).count(), 0);
    assert.equal(await page.locator('.cli-conversation .cli-quota-recovery-detail').count(), 0);
    const geometry = await page.locator('.cli-conversation .cli-capacity-notice, .cli-conversation .cli-error-notice').evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element), label = element.querySelector(':scope > span');
      return { height: element.getBoundingClientRect().height, labelHeight: label.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight), border: style.borderBottomWidth, width: element.clientWidth, scroll: element.scrollWidth };
    }));
    assert.equal(geometry.length, 4, 'Capacity, retry, failure and one quota recovery notice');
    assert.ok(geometry.every(item => item.height <= Math.max(22, item.lineHeight) + 1 && item.labelHeight <= item.lineHeight + 1 && item.border === '0px' && item.scroll <= item.width + 1), JSON.stringify(geometry));
    const diagnostics = recovery.locator('summary');
    await diagnostics.click();
    await recovery.getByText('Quota diagnostics preserved', { exact: false }).waitFor();
    await diagnostics.click();
    await page.screenshot({ path: path.join(output, `notices-${width}.png`) });

    const showSidebar = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
    if (await showSidebar.isVisible()) await showSidebar.click();
    const menuTrigger = page.getByRole('button', { name: 'Workspace menu', exact: true });
    await menuTrigger.click();
    const menu = page.getByRole('menu', { name: 'Workspace menu', exact: true });
    for (const name of ['Open dashboard', 'Account center', 'Settings', 'Sign out']) await menu.getByRole('menuitem', { name, exact: true }).waitFor();
    assert.equal(await page.locator('.cli-account-footer .cli-account-avatar').count(), 0);
    await page.screenshot({ path: path.join(output, `menu-${width}.png`) });
    await page.keyboard.press('Escape');
    assert.equal(await menuTrigger.evaluate(element => document.activeElement === element), true);
    await page.getByRole('button', { name: 'Project task board', exact: true }).click();
    const hideSidebar = page.getByRole('button', { name: 'Hide sessions sidebar', exact: true });
    if (width <= 760 && await hideSidebar.isVisible()) await hideSidebar.click();
    await page.locator('.task-board-card').filter({ hasText: session.title }).click();
    const task = page.locator('.task-detail-panel');
    await task.waitFor();
    const open = task.getByRole('button', { name: 'Open conversation', exact: true });
    assert.equal(await open.locator('svg').count(), 1);
    assert.equal((await open.innerText()).trim(), '');
    assert.equal(await task.locator('.task-detail-hero').count(), 0);
    assert.equal(await task.locator('.settings-modal-head .task-open-conversation').count(), 1);
    const header = await task.locator('.settings-modal-head').evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, children: [...element.children].map(child => child.getBoundingClientRect().toJSON()) };
    });
    assert.ok(header.children.every(child => child.top >= header.top && child.bottom <= header.bottom && child.left >= header.left && child.right <= header.right), `Title, conversation icon and close button fit the header: ${JSON.stringify(header)}`);
    assert.equal(await task.getByRole('button', { name: 'Close task details', exact: true }).isVisible(), true);
    assert.ok(await task.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await page.screenshot({ path: path.join(output, `task-${width}.png`) });
    assert.deepEqual(errors, []);
    results.push({ width, loadMs, notices: geometry.length, consoleErrors: errors.length });
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await useWorkspaceDashboardAssets(page, origin, context);
  const start = Date.now();
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.locator('#dashboard-main .overview-shell').waitFor();
  await page.getByRole('button', { name: 'Workspace menu', exact: true }).click();
  await page.getByRole('menu', { name: 'Workspace menu', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  results.push({ live: true, width: 1440, loadMs: Date.now() - start, consoleErrors: errors.length });
  await page.screenshot({ path: path.join(output, 'live-menu-1440.png') });
  await context.close();
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ output, results }));
} finally { await browser.close(); }
