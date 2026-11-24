import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

// Read the local host; intercept every fixture action so these checks cannot change host data.
const origin = 'http://127.0.0.1:39875';
const raw = await (await fetch(origin + '/api/state')).json();
const state = { ...raw, office: undefined, connectedPeers: [{ id: 'local', name: 'This PC', local: true, connected: true, sessionCount: 1 }], accounts: [], peerAccounts: {}, onboardingCompleted: true, settings: { ...raw.settings, cliIntegrationEnabled: true } };
const session = { id: '12345678-1234-1234-1234-123456789abc', title: 'Browser link checks', projectPath: 'D:/browser-fixture', status: 'idle' };
const messages = [{ id: 'links', role: 'assistant', text: '[Local app](http://localhost:5173/login)\n\n[External site](https://example.com/help)\n\n[AI preview](https://example.com/preview "workspace-browser")\n\n[Retry website](https://example.com/retry "workspace-browser")' }];
const host = `(() => {
const state=${JSON.stringify(state)}, session=${JSON.stringify(session)}, messages=${JSON.stringify(messages)};
const other={...session,id:'87654321-4321-4321-4321-cba987654321',title:'Other chat'};
const dispatch=data=>window.dispatchEvent(new MessageEvent('message',{data:structuredClone(data)}));
window.__browserRequests=[];window.__externalRequests=[];window.__openedWindows=[];window.__pages=[];window.__pagesBySession={};
window.open=(...args)=>{window.__openedWindows.push(args);return null;};
window.acquireVsCodeApi=()=>({getState(){return{};},setState(){},postMessage(message){setTimeout(()=>{
 if(message.type==='dashboard:ready'){dispatch({type:'dashboard:snapshot',state});dispatch({type:'dashboard:connection',connected:true});return;}
 if(message.type!=='dashboard:action')return;
 let payload={};
 if(message.action==='openExternalUrl'){
  window.__externalRequests.push(message.payload);
  if(window.__blockNextPopup){window.__blockNextPopup=false;dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'failed',error:'Allow pop-ups for this dashboard, then try the link again.'});return;}
  window.open(message.payload.url,'_blank');payload={notice:{level:'info',message:'Opened the link in this browser.'}};
 }
 if(message.action==='listCodexCliSessions')payload={cliSessions:[session,other],cliComposerConfig:{defaultModel:'fixture',models:[{id:'fixture',label:'Fixture',reasoningEfforts:['low']}],projects:[{id:'fixture',path:session.projectPath,label:'Fixture'}],terminalSupported:true}};
 if(message.action==='getCodexCliSessionMessages')payload={cliSession:message.payload.sessionId===other.id?other:session,cliSessionMessages:messages};
 if(message.action==='getWorkspaceEnvironment')payload={workspaceEnvironment:{projectPath:session.projectPath,projectName:'Fixture',isGitRepository:false,changes:0,additions:0,deletions:0,ahead:0,behind:0,hasRemote:false}};
 if(message.action==='workspaceBrowser'){
  const request=message.payload.browserRequest;window.__browserRequests.push(request);
  request.sessionId=message.payload.browserRequest.sessionId;window.__pages=window.__pagesBySession[request.sessionId]??=[];
  if(window.__failNextBrowser&&['open','navigate'].includes(request.operation)){window.__failNextBrowser=false;dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'failed',error:'Connection refused. Start the app and retry this link.'});return;}
  if(['open','navigate'].includes(request.operation)){
   const existing=window.__pages.find(page=>page.id===request.pageId);
   if(request.operation==='navigate'&&!existing)throw new Error('Navigation must use an existing page');
   if(existing&&request.revision!==existing.revision)throw new Error('Navigation must use the current revision');
   const page=existing||{id:'fixture-page',revision:'revision-1'};Object.assign(page,{url:request.url,title:new URL(request.url).hostname});
   if(!existing)window.__pages.push(page);
  }
  const page=window.__pages.find(page=>page.id===request.pageId)||window.__pages[0];
  payload={workspaceBrowser:{pages:window.__pages,feedback:[],...(page&&request.operation!=='list'?{pageId:page.id,revision:page.revision}: {})}};
 }
 dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'completed',payload});
},5);}});
})();`;
await mkdir('output/playwright', { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [1440, 800, 760, 700, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('crash', () => console.log('Browser page crashed'));
    await useWorkspaceDashboardAssets(page, origin, context);
    await context.route('**/assets/browserHost.js*', route => route.fulfill({ contentType: 'text/javascript', body: host }));
    const started = Date.now();
    await page.goto(origin + '/workspace/' + session.id);
    await page.getByRole('link', { name: 'Local app', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Local app', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Workspace tools', exact: true });
    await panel.waitFor();
    await page.waitForFunction(() => window.__pages.length === 1).catch(async error => { console.log(await page.evaluate(() => ({ requests: window.__browserRequests, pages: window.__pages, text: document.querySelector('.cli-context-body')?.innerText })), errors); throw error; });
    await page.getByRole('textbox', { name: 'Browser URL', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Browser URL"]').value === 'http://localhost:5173/login');
    const picker = panel.getByRole('combobox', { name: 'Workspace tool', exact: true });
    const tabs = panel.locator('.cli-context-tab-scroll');
    if (await picker.isVisible() !== (width <= 760)) console.log(await picker.evaluate(element => ({ display: getComputedStyle(element.parentElement.parentElement).display, rules: [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules].filter(rule => rule.selectorText && element.parentElement.parentElement.matches(rule.selectorText)).map(rule => rule.cssText); } catch { return []; } }) })));
    assert.equal(await picker.isVisible(), width <= 760, `${width}: compact picker visibility`);
    assert.equal(await tabs.isVisible(), width > 760, `${width}: tab strip visibility`);
    await page.screenshot({ path: `output/playwright/browser-links-${width}.png` });
    // A narrow device puts Browser over the transcript; closing tools leaves its page available for reuse.
    await panel.getByRole('button', { name: 'Close workspace tools', exact: true }).click();
    await page.getByRole('link', { name: 'External site', exact: true }).click();
    await page.waitForFunction(() => window.__openedWindows.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__externalRequests), [{url:'https://example.com/help',targetDeviceId:'local'}], 'External links always use the initiating PC');
    assert.equal(await page.evaluate(() => window.__browserRequests.filter(request => ['open','navigate'].includes(request.operation)).length), 1, 'External links do not navigate the right panel');
    assert.equal(await panel.isVisible(), false, 'External links leave the right panel closed');
    await page.evaluate(() => { window.__blockNextPopup = true; });
    await page.getByRole('link', { name: 'External site', exact: true }).click();
    await page.getByText('Allow pop-ups for this dashboard, then try the link again.', {exact:true}).waitFor();
    assert.equal(await panel.isVisible(), false, 'Blocked popups never fall back to the right panel');
    await page.getByRole('link', { name: 'AI preview', exact: true }).click();
    await page.waitForFunction(() => window.__browserRequests.some(request => request.operation === 'navigate' && request.url === 'https://example.com/preview'));
    assert.equal(await page.evaluate(() => window.__pages.length), 1, 'AI-marked link reuses the existing Browser page');
    await panel.getByRole('button', { name: 'Close workspace tools', exact: true }).click();
    await page.evaluate(() => { window.__failNextBrowser = true; });
    await page.getByRole('link', { name: 'Retry website', exact: true }).click();
    await panel.getByRole('alert').filter({ hasText: 'Connection refused' }).waitFor();
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => window.__browserRequests.filter(request => request.operation === 'navigate' && request.url === 'https://example.com/retry').length), 1, 'Failed navigation is reported without replay');
    const navigate = async path => page.evaluate(path => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
    await navigate('/workspace');
    await page.locator('.workspace-browser').waitFor({ state: 'detached' });
    const background = await page.evaluate(sessionId => {
      const ai = { id: 'ai-background', title: 'AI background page', url: 'https://example.com/background', revision: 'ai-revision', openedBy: 'ai' };
      window.__pagesBySession[sessionId].push(ai);
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:browser-changed', projectPath: 'D:/browser-fixture', sessionId } }));
      return window.__browserRequests.length;
    }, session.id);
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('.workspace-browser').count(), 0, 'No Browser or AI tabs mount outside a chat');
    assert.equal(await page.evaluate(() => window.__browserRequests.length), background, 'Background chat does not poll or present Browser');
    await navigate('/workspace/87654321-4321-4321-4321-cba987654321');
    await page.waitForFunction(() => window.__browserRequests.some(request => request.sessionId === '87654321-4321-4321-4321-cba987654321'));
    assert.equal(await panel.locator('[role="tab"]').filter({ hasText: 'AI background page' }).count(), 0, 'AI tabs stay with their owning session');
    await navigate('/workspace/' + session.id);
    await panel.locator('[role="tab"]').filter({ hasText: 'AI background page' }).waitFor({ state: 'attached' });
    assert.equal(await page.evaluate(() => window.__browserRequests.filter(request => ['open','navigate'].includes(request.operation)).length), 3, 'Returning restores tabs without replaying navigation');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Dashboard fits viewport');
    assert.deepEqual(errors, [], 'No runtime errors');
    console.log(`PASS ${width}px: external tabs, localhost and AI panel links, popup and navigation failures, session-only Browser; ${Date.now() - started}ms`);
    await context.close();
  }
} finally { await browser.close(); }
