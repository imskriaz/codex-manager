import assert from 'node:assert/strict';
import path from 'node:path';

// The parent harness intercepts every action; no live credentials or sessions change.
export async function checkListsApiUi(page, { origin, width, height, output, api }) {
  await page.goto(origin + '/workspace');
  await page.locator('.cli-workspace').waitFor();
  const show = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
  if (await show.isVisible()) await show.click();
  if (api) {
    await page.evaluate(() => { window.__holdNextApiList = true; });
    await page.getByRole('button', { name: 'Open account center', exact: true }).click();
    await page.getByRole('dialog', { name: 'Account center', exact: true }).getByRole('button', { name: 'API', exact: true }).click();
    let list = page.getByRole('dialog', { name: 'API access', exact: true });
    const main = list;
    await page.waitForFunction(() => !!window.__heldApiList);
    await list.getByRole('button', { name: '+ Create token', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'Create API token', exact: true });
    assert.equal(await page.locator(':popover-open').count(), 0, 'Opening a modal leaves no native flyout above it');
    assert.ok(await form.evaluate(element => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)); }), 'Modal owns pointer input above earlier menus');
    await form.getByLabel('Token name', { exact: true }).fill('First creation');
    await form.getByRole('button', { name: 'Create token', exact: true }).click();
    await form.getByRole('textbox', { name: 'New API token', exact: true }).waitFor();
    assert.equal(await form.getByRole('button', { name: 'Token created', exact: true }).isDisabled(), true);
    await form.getByRole('button', { name: 'Close token form', exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: window.__heldApiList })));
    await main.getByRole('button',{name:'Manage API keys',exact:true}).click();
    list=page.getByRole('dialog',{name:'API keys',exact:true});
    await list.getByRole('cell', { name: 'First creation', exact: true }).waitFor();
    assert.equal(await list.locator('tbody tr').count(), 3, 'Stale listing cannot erase confirmed creation');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'API columns never widen the page');
    if(width<=760) assert.ok(await list.locator('.api-table-scroll').evaluate(element=>element.scrollWidth>element.clientWidth), 'API columns scroll instead of squeezing');
    await list.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForFunction(() => window.__uiActions.filter(action => action.action === 'listApiTokens').length >= 2);
    await list.getByRole('button', { name: '+ Create token', exact: true }).click();
    await form.getByLabel('Additional host project folder', { exact: true }).waitFor();
    await form.getByLabel('Token name', { exact: true }).fill('Unknown confirmation');
    await page.evaluate(() => { window.__holdNextApiCreate = true; });
    await form.getByRole('button', { name: 'Create token', exact: true }).click();
    await page.waitForFunction(() => !!window.__heldApiCreate);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { ...window.__heldApiCreate, status: 'failed', payload: undefined, error: 'The connection closed before confirmation. Outcome unknown.' } })));
    await form.getByRole('alert').waitFor();
    assert.equal(await form.getByRole('button', { name: 'Create token', exact: true }).isDisabled(), true);
    await form.getByRole('button', { name: 'Refresh token list', exact: true }).click();
    await form.getByRole('alert').waitFor({ state: 'detached' });
    await form.getByRole('button', { name: 'Close token form', exact: true }).click();
    await list.getByRole('cell', { name: 'Unknown confirmation', exact: true }).waitFor();
    await list.getByRole('button',{name:'Close key management',exact:true}).click();list=main;
    // Requests are intercepted; permission and presentation checks cannot mutate the live host.
    const sent = []; let failure = false;
    await page.route('**/api/schema', async route => {
      const token = route.request().headers().authorization;
      if (token?.includes('invalid')) return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Token is invalid or revoked.' }) });
      const scoped = token?.includes('project');
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ actions: scoped ? ['getProjectBoard'] : ['refreshAll'], token: { name: scoped ? 'Project reader' : 'Quota refresh', projectPaths: scoped ? ['D:/demo'] : [], permissions: scoped ? ['state'] : ['state','aiProxy'] } }) });
    });
    await page.route('**/api/message', async route => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ status: failure ? 403 : 200, contentType: 'application/json', body: JSON.stringify(failure ? { error: 'Token was revoked after inspection.' } : { messages: [{ status: 'completed', payload: { notice: { level: 'info', message: 'Refresh completed.' } } }] }) });
    });
    assert.equal(await list.getByRole('tab').count(),0,'Key creation and testing share one workspace');
    assert.equal(await list.getByLabel('Endpoint',{exact:true}).inputValue(),origin+'/api/message','Absolute endpoint is visible in a copyable field');
    if(width>900) {const panels=await list.locator('.api-playground-layout').evaluate(element=>[...element.children].map(child=>child.getBoundingClientRect().width));assert.equal(panels.length,3);assert.ok(Math.max(...panels)-Math.min(...panels)<3,'Three balanced panels');}
    const tokenInput = list.getByLabel('Bearer token', { exact: true });
    const operations = list.getByLabel('Operation', { exact: true });
    const send = list.getByRole('button', { name: 'Send request once', exact: true });
    assert.equal(await list.locator('.api-test-form > .api-section-heading').getByRole('button',{name:'Send request once',exact:true}).count(),1,'Send stays in the compact Request header');
    await tokenInput.fill('  cm_quota_fixture  ');
    await page.waitForFunction(() => document.querySelector('.api-test-form select')?.value === 'refreshAll');
    assert.deepEqual(await operations.locator('option').allTextContents(), ['refreshAll'], await operations.evaluate(element=>element.outerHTML));
    await send.click();
    await list.locator('.api-test-result').filter({ hasText: 'HTTP 200' }).waitFor();
    assert.ok((await list.locator('.api-test-result').innerText()).includes('\n  "messages": [\n'), 'JSON responses are readable');
    assert.equal(sent.length, 1); assert.equal(sent[0].action, 'refreshAll');
    failure = true;
    await send.click();
    await list.locator('.api-test-result').filter({ hasText: 'HTTP 403' }).waitFor();
    assert.ok((await list.locator('.api-test-result').innerText()).includes('revoked after inspection'), 'Permission changes preserve the server error');
    await tokenInput.fill('cm_project_fixture');
    assert.equal(await send.isDisabled(), true, 'Changing a token immediately invalidates old grants');
    await page.waitForFunction(() => document.querySelector('.api-test-form select')?.value === 'getProjectBoard');
    assert.deepEqual(await operations.locator('option').allTextContents(), ['getProjectBoard']);
    assert.equal(await list.getByLabel('Host project', { exact: true }).inputValue(), 'D:/demo');
    failure = false; await send.click();
    await list.locator('.api-test-result').filter({ hasText: 'HTTP 200' }).waitFor();
    assert.equal(sent.at(-1).payload.projectPath, 'D:/demo', 'Scoped requests use the verified host project');
    await tokenInput.fill('cm_invalid_fixture');
    await list.getByRole('status').filter({ hasText: 'Token is invalid or revoked' }).waitFor();
    assert.equal(await send.isDisabled(), true);
    assert.equal(await operations.isDisabled(), true);
    assert.equal(sent.length, 3, 'Inspection never sends actions or retries writes');
    const proxy = []; let proxyFailure = false;
    await page.route('**/v1/**',async route=>{
      const request=route.request(); proxy.push({path:new URL(request.url()).pathname,body:request.postDataJSON()});
      await route.fulfill({status:proxyFailure ? 429 : 200,contentType:'application/json',body:JSON.stringify(proxyFailure ? {error:{message:'Quota exhausted'}} : request.url().endsWith('/models') ? {data:[{id:'fixture-model'}]} : {output_text:'OK',choices:[{message:{content:'OK'}}],content:[{type:'text',text:'OK'}]})});
    });
    await tokenInput.fill('cm_project_fixture');
    await operations.locator('option').filter({hasText:'getProjectBoard'}).waitFor({state:'attached'});
    await list.locator('.api-endpoints button').filter({hasText:'/v1/models'}).click();
    assert.equal(await send.isDisabled(),true,'Project-scoped keys cannot test the proxy');
    await tokenInput.fill('cm_quota_fixture');
    await page.waitForFunction(()=>!document.querySelector('.api-send-row .modal-primary-btn')?.disabled);
    await send.click();
    await list.locator('.api-test-result').filter({hasText:'fixture-model'}).waitFor();
    for (const endpoint of ['/v1/chat/completions','/v1/responses','/v1/messages']) {
      await list.locator('.api-endpoints button').filter({hasText:endpoint}).click();
      await list.getByRole('button',{name:'Load example',exact:true}).click();
      assert.equal(await list.getByLabel('Endpoint',{exact:true}).inputValue(),origin+endpoint);
      const modelBounds=await list.getByLabel('Model ID',{exact:true}).boundingBox(),endpointBounds=await list.getByLabel('Endpoint',{exact:true}).boundingBox();assert.ok(endpointBounds.y>=modelBounds.y+modelBounds.height,'Endpoint sits below Model ID');
      await list.getByLabel('Model ID',{exact:true}).fill('other-model');
      assert.equal(JSON.parse(await list.getByLabel('Payload (JSON)',{exact:true}).inputValue()).model,'other-model','Model control updates the outgoing JSON');
      await list.getByLabel('Model ID',{exact:true}).fill('fixture-model');
      await send.click();
      await list.locator('.api-test-result').filter({hasText:'HTTP 200'}).waitFor();
      assert.equal(proxy.at(-1).path,endpoint);assert.equal(proxy.at(-1).body.model,'fixture-model');
    }
    const before=proxy.length;
    await list.getByLabel('Payload (JSON)',{exact:true}).fill('{');await send.click();
    await list.locator('.api-test-result').filter({hasText:'Request not confirmed'}).waitFor();
    assert.equal(proxy.length,before,'Invalid JSON sends no request');
    await list.getByRole('button',{name:'Load example',exact:true}).click();
    proxyFailure=true;await send.click();
    await list.locator('.api-test-result').filter({hasText:'HTTP 429'}).waitFor();
    assert.equal(proxy.length,before+1,'Proxy errors are displayed without UI retries');
    await page.screenshot({path:path.join(output,`api-playground-${width}x${height}.png`)});
    await list.getByRole('button',{name:'Details',exact:true}).click();
    const details=page.getByRole('dialog',{name:'Request details',exact:true});
    await details.waitFor();assert.ok((await details.locator('pre').innerText()).includes('/v1/messages'),'Details contain only the selected endpoint request');
    await details.getByRole('button',{name:'Close request details',exact:true}).click();
    if (width===1440) {
      let waiting;
      let arrived;
      let arrival=new Promise(resolve=>{arrived=resolve;});
      const held=[];
      await page.route('**/v1/messages',async route=>{held.push(route);arrived();await new Promise(resolve=>{waiting=resolve;});await route.abort().catch(()=>{});});
      await send.click();await list.getByRole('button',{name:'Cancel request',exact:true}).waitFor();
      await arrival;
      await list.getByRole('button',{name:'Cancel request',exact:true}).click();
      await list.locator('.api-test-result').filter({hasText:'Cancelled by user'}).waitFor();
      assert.equal(held.length,1,'Cancellation never retries');waiting();
      await page.clock.install();
      arrival=new Promise(resolve=>{arrived=resolve;});
      await send.click();await list.getByRole('button',{name:'Cancel request',exact:true}).waitFor();
      await arrival;
      await page.clock.runFor(60001);
      await list.locator('.api-test-result').filter({hasText:'Request timed out'}).waitFor();
      assert.equal(held.length,2,'Timeout never retries');waiting();await page.clock.resume();
    }
    await list.getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: window.__heldApiCreate })));
    assert.equal(await list.count(), 0, 'Late confirmation never reopens API access');
  } else {
    await page.evaluate(() => window.__fillListFixture());
    await page.locator('.cli-compact-session-list .cli-session-row-select').first().waitFor();
    const rows = page.locator('.cli-compact-session-list .cli-session-row-select');
    assert.equal(await rows.count(), 50, 'Sidebar initially renders a bounded batch');
    await page.locator('.cli-session-list-region').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.waitForFunction(() => document.querySelectorAll('.cli-compact-session-list .cli-session-row-select').length > 50);
    await page.getByRole('searchbox', { name: 'Search sessions', exact: true }).fill('Bulk work 154');
    await page.waitForFunction(() => document.querySelectorAll('.cli-compact-session-list .cli-session-row-select').length === 1);
    await page.getByRole('searchbox', { name: 'Search sessions', exact: true }).fill('');
    await page.getByRole('button', { name: 'Project task board', exact: true }).click();
    const hide = page.getByRole('button', { name: 'Hide sessions sidebar', exact: true });
    if (width <= 760 && await hide.isVisible()) await hide.click();
    const column = page.locator('.task-board-column.is-completed');
    await column.locator('.task-board-card').first().waitFor();
    assert.equal(await column.locator('.task-board-card').count(), 50);
    await column.scrollIntoViewIfNeeded();
    await column.locator('.task-board-card-list').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.waitForFunction(() => document.querySelectorAll('.task-board-column.is-completed .task-board-card').length > 50);
    await page.getByRole('tab', { name: 'List', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.task-list-view tbody tr').length === 50);
    await page.locator('.task-list-view').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.waitForFunction(() => document.querySelectorAll('.task-list-view tbody tr').length > 50);
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
  await page.screenshot({ path: path.join(output, `${api ? 'api-recovery' : 'infinite-lists'}-${width}x${height}.png`) });
}

export async function checkFlyoutUi(page, { origin, parentId, width, height, output }) {
  await page.goto(origin + '/');
  const accountMore = page.locator('.saved-card-container').first().getByRole('button', { name: 'More account actions', exact: true });
  await accountMore.click(); await assertFlyoutNear(page, accountMore, page.locator('.saved-overflow-menu-portal'));
  await page.keyboard.press('Escape');
  const more = page.locator('.overview-more-wrap > button');
  await more.click(); await assertFlyoutNear(page, more, page.locator('.overview-more-menu'));
  await page.setViewportSize({ width, height: Math.max(300, height - 120) });
  await assertFlyoutNear(page, more, page.locator('.overview-more-menu'));
  await page.setViewportSize({ width, height });
  await page.keyboard.press('Escape');
  const graph = page.getByRole('button', { name: 'Graph settings', exact: true });
  await graph.click(); await assertFlyoutNear(page, graph, page.getByRole('dialog', { name: 'Graph settings', exact: true }));
  await page.keyboard.press('Escape');
  if (width <= 760) {
    const mobile = page.locator('.dashboard-mobile-actions > summary');
    await mobile.click(); await assertFlyoutNear(page, mobile, page.locator('.dashboard-mobile-actions-menu'));
    await mobile.click();
  }
  await page.evaluate(() => {
    window.__uiSessions.push({ id: 'flyout-interrupted', title: 'Interrupted flyout task', status: 'idle', interrupted: true, queueEnabled: true, queuePriority: 3, projectPath: 'D:/demo' });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action: 'listCodexCliSessions', requestId: 'dashboard-auto-flyout-fixture', status: 'completed', payload: { cliSessions: window.__uiSessions } } }));
  });
  const running = page.locator('#cliSessionsButton');
  await running.click(); await assertFlyoutNear(page, running, page.locator('.cli-sessions-popover'));
  const queue = page.locator('.cli-sessions-popover').getByRole('button', { name: 'Queue priority for Interrupted flyout task', exact: true });
  await queue.click(); await assertFlyoutNear(page, queue, page.getByRole('dialog', { name: 'Queue Interrupted flyout task', exact: true }));
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.goto(origin + '/workspace/' + parentId);
  const show = page.getByRole('button', { name: 'Show workspace tools', exact: true });
  if (await show.isVisible()) await show.click();
  const add = page.getByRole('button', { name: 'Add workspace tool', exact: true });
  await add.click(); await assertFlyoutNear(page, add, page.getByRole('menu', { name: 'Workspace tools menu', exact: true }));
  await page.keyboard.press('Escape');
  const hide = page.getByRole('button', { name: 'Hide workspace tools', exact: true });
  if (await hide.isVisible()) await hide.click();
  const showSidebar = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  const center = page.getByRole('button', { name: 'Open account center', exact: true });
  await center.click(); await assertFlyoutNear(page, center, page.getByRole('dialog', { name: 'Account center', exact: true }));
  await page.screenshot({ path: path.join(output, `flyouts-${width}x${height}.png`) });
  await page.keyboard.press('Escape');
}

export async function assertFlyoutNear(page, trigger, menu) {
    await menu.waitFor();
    // Layout effects and the native top layer settle before checking measured bounds.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await menu.evaluate(element => Promise.all(element.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined))));
    const anchor = await trigger.boundingBox(), box = await menu.boundingBox();
    assert.ok(box && anchor);
    const hit = await menu.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return target === element || element.contains(target);
    });
    assert.ok(hit, 'Flyout and nested controls are above their container and accept pointer input');
    const screen = page.viewportSize();
    assert.ok(box.x >= 7 && box.y >= 7 && box.x + box.width <= screen.width - 7 && box.y + box.height <= screen.height - 7, `Flyout fits the visible viewport: ${JSON.stringify({box,anchor,screen,html:await menu.evaluate(element=>element.outerHTML.slice(0,750))})}`);
    const xGap = Math.max(anchor.x - box.x - box.width, box.x - anchor.x - anchor.width, 0);
    const yGap = Math.max(anchor.y - box.y - box.height, box.y - anchor.y - anchor.height, 0);
    assert.ok(xGap <= 8 && yGap <= 8, `Flyout stays beside its clicked control (${xGap},${yGap})`);
}
