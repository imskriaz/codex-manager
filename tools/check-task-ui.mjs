import assert from 'node:assert/strict';
import path from 'node:path';

// Runs inside the responsive harness: every write is intercepted by its in-memory host.
export async function checkTaskUi(page, { origin, width, height, output }) {
  await page.goto(`${origin}/`);
  await page.locator('#dashboard-main').waitFor();
  if (width <= 760) await page.getByRole('button', { name: 'Show sessions sidebar', exact: true }).click();
  await page.getByRole('button', { name: 'Project task board', exact: true }).click();
  await page.locator('.task-board-card').filter({ hasText: 'Release work' }).waitFor();
  assert.deepEqual(await page.locator('.task-board-column-heading strong').evaluateAll(items=>items.map(item=>item.firstChild.textContent)), ['Idea','Planned','Running','Completed']);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Task board keeps horizontal scrolling inside its columns');
  assert.equal(await page.locator('.task-board-card').filter({ hasText: 'Evaluate stack beyond expectations' }).count(), 0, 'Grouped session is absent from root cards');
  await page.getByRole('button',{name:'Expand 1 subtasks',exact:true}).click();
  await page.evaluate(() => { window.__holdNextBoard = true; window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:project-changed', projectPath: 'D:/demo' } })); });
  await page.waitForFunction(() => !!window.__heldBoardResult);
  const boardReads = await page.evaluate(() => window.__uiActions.filter(message => message.action === 'getProjectBoard').length);
  await page.evaluate(() => {
    window.__advanceBoard();
    for (let n = 0; n < 5; n++) window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:project-changed', projectPath: 'D:/demo' } }));
    window.dispatchEvent(new MessageEvent('message', { data: window.__heldBoardResult }));
  });
  await page.locator('.task-board-card').filter({ hasText: 'Idea collection updated' }).waitFor();
  assert.equal(await page.evaluate(() => window.__uiActions.filter(message => message.action === 'getProjectBoard').length), boardReads + 1, 'Board coalesces events arriving during its active read');
  const child = page.locator('.task-board-card').filter({ hasText: 'Evaluate stack beyond expectations' });
  assert.equal(await child.count(), 1, 'Expanding the parent shows its session once');
  await child.click();
  const task = page.locator('.task-detail-modal');
  assert.ok(await task.evaluate(element=>element.scrollWidth<=element.clientWidth+1),'Task details have no horizontal overflow');
  await task.getByRole('tab',{name:'Overview',exact:true}).waitFor();
  assert.ok(await task.locator('.settings-modal-title').evaluate(element=>{const r=element.getBoundingClientRect();return !!document.elementFromPoint(r.x+2,r.y+4)?.closest('.task-detail-panel');}),'Task title stays above floating workspace controls');
  await page.screenshot({path:path.join(output,`task-details-${width}x${height}.png`)});
  await task.getByRole('tab', { name: 'Activities', exact: true }).click();
  await task.getByText('Review the workspace and explain the result.', {exact:true}).waitFor();
  await task.locator('.cli-activity > summary').first().click();
  await task.getByText('Script completed', { exact: true }).waitFor();
  await task.getByRole('tab', { name: 'Files', exact: true }).click();
  const readsBeforeAttachments = await page.evaluate(() => window.__uiActions.filter(message => message.action === 'readWorkspaceFile').length);
  await task.locator('.task-file-row').filter({ hasText: 'brief.txt' }).click();
  await task.getByText('Original uploaded brief', { exact: true }).waitFor();
  await task.locator('.task-file-row').filter({ hasText: 'Attachment preview' }).click();
  await task.getByRole('button', { name: 'Preview Attachment preview', exact: true }).click();
  await page.getByRole('button', { name: 'Close image preview', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__uiActions.filter(message => message.action === 'readWorkspaceFile').length), readsBeforeAttachments, 'Upload previews use their conversation snapshot without filesystem reads');
  await task.locator('.task-file-row').filter({ hasText: 'src/app.ts' }).click();
  await task.getByText('const task = 1;', { exact: true }).waitFor();
  await page.evaluate(() => { window.__holdNextWorkspaceFileRead = true; });
  await task.locator('.task-file-row').filter({ hasText: 'src/app.ts' }).click();
  await page.waitForFunction(() => !!window.__heldWorkspaceFileResult);
  await task.locator('.task-file-row').filter({ hasText: 'brief.txt' }).click();
  await task.getByText('Original uploaded brief', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', { data: window.__heldWorkspaceFileResult }));
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.equal(await task.getByText('const task = 1;', { exact: true }).count(), 0, 'A late project-file read cannot replace the selected upload snapshot');
  await task.getByRole('button', { name: 'Older history', exact: true }).click();
  await task.locator('.task-file-row').filter({ hasText: 'src/older.ts' }).click();
  await task.getByText('const older = 2;', { exact: true }).waitFor();
  assert.equal(await task.getByRole('button', { name: 'Older history', exact: true }).count(), 0, 'Last Files page has no further cursor');
  await task.getByRole('button', { name: 'Latest activity', exact: true }).click();
  await task.locator('.task-file-row').filter({ hasText: 'src/app.ts' }).waitFor();
  await page.evaluate(() => { window.__holdNextTaskDetails = 'activities'; });
  await task.getByRole('tab', { name: 'Activities', exact: true }).click();
  await page.waitForFunction(() => !!window.__heldTaskDetails);
  const readsBeforeEvents = await page.evaluate(() => window.__uiActions.filter(message => message.action === 'getProjectTaskDetails' && message.payload.taskView === 'activities').length);
  await page.evaluate(() => {
    for (let n = 0; n < 5; n++) window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:project-changed', projectPath: 'D:/demo' } }));
    window.__partialTaskDetails = true;
    window.__releaseTaskDetails();
  });
  await task.getByText('Latest live activity despite saved-history warning', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__uiActions.filter(message => message.action === 'getProjectTaskDetails' && message.payload.taskView === 'activities').length), readsBeforeEvents + 1, 'Burst during a pending activity read produces one final refresh');
  await page.evaluate(() => { window.__partialTaskDetails = false; });
  await task.getByRole('tab', { name: 'Changes', exact: true }).click();
  await task.getByText(/Current project:/).waitFor();
  await page.screenshot({ path: path.join(output, `task-changes-${width}x${height}.png`) });
  await task.getByRole('button', { name: 'Close task details', exact: true }).click();
  const idea = page.locator('.task-board-card').filter({ hasText: 'Idea collection' });
  if (width > 760) {
    await child.dragTo(idea);
    await page.waitForFunction(() => window.__uiActions.some(message => message.action === 'saveProjectTask' && message.payload.task.parentTaskId === 'idea-fixture'));
    await idea.locator('..').getByRole('button',{name:'Expand 1 subtasks',exact:true}).click();
    assert.equal(await child.count(),1,'A session dropped under a custom task is shown once');
    const saves = await page.evaluate(()=>window.__uiActions.filter(message=>message.action==='saveProjectTask').length);
    await page.locator('.task-board-card').filter({hasText:'Release work'}).dragTo(idea);
    await page.getByText('Only session tasks can be subtasks. Custom tasks stay on the top-level board.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.__uiActions.filter(message=>message.action==='saveProjectTask').length),saves,'Custom tasks cannot be nested');
    await idea.dragTo(page.locator('.task-board-column.is-planned .task-board-column-heading'));
    await page.locator('.task-board-column.is-planned .task-board-card').filter({hasText:'Idea collection'}).waitFor();
    await page.getByRole('button',{name:'Show sessions sidebar',exact:true}).click();
    await page.getByRole('button',{name:'Show compact session list',exact:true}).click();
    await page.locator('.cli-session-row-select').filter({hasText:'Evaluate stack'}).locator('..').dragTo(page.locator('.task-board-card').filter({hasText:'Release work'}));
    await page.waitForFunction(()=>window.__uiActions.some(message=>message.action==='saveProjectTask'&&message.payload.task.parentTaskId==='release-group'&&message.payload.task.expectedRevision>1));
    await page.getByRole('button',{name:'Show projects and sessions',exact:true}).click();
    await page.getByRole('button',{name:'Hide sessions sidebar',exact:true}).click();
  }
  await page.locator('.task-board-card').filter({hasText:'Release work'}).click();
  assert.equal(await task.getByLabel('Parent task',{exact:true}).count(),0,'Custom tasks have no nesting selector');
  await task.getByRole('button',{name:'＋ New subtask',exact:true}).click();
  await task.getByRole('textbox',{name:'Subtask initial prompt',exact:true}).fill('Create a focused session subtask');
  await task.getByRole('button',{name:'Create and start session',exact:true}).click();
  await page.waitForFunction(()=>window.__uiActions.some(message=>message.action==='startProjectSubtask'&&message.payload.text==='Create a focused session subtask'));
  await task.locator('.task-subtasks').getByRole('button',{name:/Create a focused session subtask/}).waitFor();
  await task.getByRole('button',{name:'Close task details',exact:true}).click();
  await page.getByRole('button',{name:'Actions for Idea collection updated',exact:true}).click();
  await page.getByRole('menuitem',{name:'Archive task',exact:true}).click();
  await page.locator('.task-board-column.is-completed .task-board-card').filter({hasText:'Idea collection updated'}).waitFor();
  await page.getByRole('button',{name:'Actions for Idea collection updated',exact:true}).click();
  await page.getByRole('menuitem',{name:'Restore task',exact:true}).click();
  await page.locator('.task-board-card').filter({hasText:'Idea collection updated'}).waitFor();
  const info = page.getByRole('button',{name:'Task info for Release work',exact:true});
  await info.click();
  await page.getByRole('dialog',{name:'Task info for Release work',exact:true}).getByText('Model',{exact:true}).waitFor();
  const menuBounds=await page.getByRole('dialog',{name:'Task info for Release work',exact:true}).boundingBox();
  assert.ok(menuBounds.x>=0 && menuBounds.x+menuBounds.width<=width+1 && menuBounds.y+menuBounds.height<=height+1,'Info stays within the viewport');
  await page.keyboard.press('Escape');
  for (const name of ['List','Gantt','Calendar']) {
    await page.getByRole('tab',{name,exact:true}).click();
    if(name==='List') await page.locator('.task-list-title').filter({hasText:'Evaluate stack'}).waitFor();
    if(name==='Gantt') await page.locator('.task-gantt-bar').first().waitFor();
    if(name==='Calendar') { await page.locator('.task-calendar-grid').waitFor(); assert.equal(await page.locator('.task-calendar-day').count(),42); }
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),name+' keeps wide content inside its viewport');
    await page.screenshot({path:path.join(output,`tasks-${name.toLowerCase()}-${width}x${height}.png`)});
  }
  await page.getByRole('tab',{name:'Board',exact:true}).click();
  const header=await page.locator('.task-board-header').boundingBox(), columns=await page.locator('.task-board-columns').boundingBox();
  assert.ok(header.height<=55,'Header stays on one compact row');
  const sidebarToggle=page.locator('.cli-workspace.is-dashboard-mode .cli-rail-toggle');
  if (width<=760 && await sidebarToggle.isVisible()) {
    const toggle=await sidebarToggle.boundingBox(), heading=await page.locator('#task-board-title').boundingBox();
    assert.ok(heading.x>=toggle.x+toggle.width+3,'Workspace title clears the floating sidebar logo');
  }
  assert.ok(columns.height>=height*.58,'Board uses the available height');
  assert.ok(await page.locator('.task-card-row').first().boundingBox().then(rect=>rect.height<=46),'Cards keep two compact lines');
  assert.equal(await page.getByText('0 subs',{exact:true}).count(),0,'Cards omit empty subtask labels');
  const row=page.locator('.task-card-row').filter({has:page.locator('.task-tree-expand')}).first(), meta=await row.locator('.task-card-meta').boundingBox(), counts=await row.locator('.task-card-counts').boundingBox();
  assert.ok(Math.abs(meta.y+meta.height/2-counts.y-counts.height/2)<=3,'Metadata and subtask count share a baseline');
  assert.equal(await page.getByRole('button', { name: 'Share project', exact: true }).count(), 0, 'Board sharing uses its three-dot menu');
  await page.getByRole('button', { name: 'Board actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Share project', exact: true }).click();
  const share = page.locator('.project-share-modal');
  const feature=share.locator('.project-share-permissions label').first(), checkbox=await feature.locator('input').boundingBox(), featureText=await feature.locator('span').boundingBox();
  assert.ok(checkbox.width<=16 && featureText.x-checkbox.x-checkbox.width<=12,'Sharing checkboxes stay beside their labels');
  assert.equal(await share.getByRole('checkbox', { name: /Allow embedding/ }).isChecked(), false);
  await share.getByRole('checkbox', { name: /Allow embedding/ }).check();
  await share.getByRole('button', { name: 'Create link', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.project-share-modal textarea')?.value.includes('<iframe'));
  assert.ok(await page.locator('.project-share-modal textarea').inputValue().then(value => value.includes('referrerpolicy="no-referrer"')), 'Embed code contains only the granted shared URL');
  await page.screenshot({ path: path.join(output, `project-sharing-${width}x${height}.png`) });
  await share.getByRole('button', { name: 'Close', exact: true }).click();

  const sentBefore = await page.evaluate(() => window.__uiActions.filter(message => message.action === 'saveProjectTask').length);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:connection', connected: false } })));
  await page.getByRole('button', { name: 'Board actions', exact: true }).click();
  assert.equal(await page.getByRole('menuitem',{name:'Share project',exact:true}).isDisabled(),true,'Sharing disables offline');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '＋ Task', exact: true }).click();
  await task.getByLabel('Title', { exact: true }).fill('Offline task draft');
  await task.getByLabel('Prompt / idea', { exact: true }).fill('Keep this work through reconnect.');
  await task.getByRole('button', { name: 'Save task', exact: true }).click();
  if (width === 320) {
    await page.locator('.task-feedback').getByText(/Browser storage is full or unavailable/).waitFor();
    assert.equal(await task.getByLabel('Title', { exact: true }).inputValue(), 'Offline task draft', 'Storage failures preserve the open draft');
    await task.getByRole('button', { name: 'Close task details', exact: true }).click();
  } else {
    await task.waitFor({ state: 'hidden' });
    await page.locator('.task-board-card').filter({ hasText: 'Offline task draft' }).waitFor();
    await page.locator('.task-feedback').getByText('Saved offline.',{exact:true}).waitFor();
  }
  assert.equal(await page.locator('.task-board-status').count(),0,'Action feedback never inserts a board row');
  await page.getByRole('button',{name:'Dismiss task notification',exact:true}).click();
  assert.equal(await page.locator('.task-feedback').count(),0,'Task feedback is dismissible');
  assert.equal(await page.evaluate(() => window.__uiActions.filter(message => message.action === 'saveProjectTask').length), sentBefore, 'Offline drafts never send a live request');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:connection', connected: true } })));
  if (width !== 320) await page.waitForFunction(before => window.__uiActions.filter(message => message.action === 'saveProjectTask').length === before + 1, sentBefore);
  await page.screenshot({ path: path.join(output, `project-board-${width}x${height}.png`) });

  if (width > 760) {
    await page.getByRole('button', { name: 'Show sessions sidebar', exact: true }).click();
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await page.locator('#apiOpenButton').click();
  } else {
    await page.getByRole('button',{name:'Show sessions sidebar',exact:true}).click();
    await page.evaluate(() => { const offer = document.createElement('aside'); offer.className = 'browser-notification-offer'; offer.id = 'notification-overlap-check'; offer.textContent = 'Optional notification offer'; document.body.append(offer); });
    assert.equal(await page.locator('#notification-overlap-check').isVisible(), false, 'Optional notification offers cannot cover the active sidebar');
    await page.evaluate(() => document.getElementById('notification-overlap-check').remove());
    await page.getByRole('button',{name:'Open account center',exact:true}).click();
    await page.locator('.cli-account-center').getByRole('button',{name:'API',exact:true}).click();
  }
    const api = page.locator('.dashboard-api-modal');
    await api.getByText('Project reader', { exact: true }).waitFor();
    assert.equal(await api.locator('tbody tr').count(), 2, 'Named tokens are displayed in a table');
    await api.getByRole('button', { name: '+ Create token', exact: true }).click();
    const create = page.locator('.api-create-modal');
    const identity=await create.locator('.api-token-identity').boundingBox(), permissionColumn=await create.locator('.api-token-permission-column').boundingBox();
    assert.ok(width>650 ? permissionColumn.x>=identity.x+identity.width && Math.abs(identity.y-permissionColumn.y)<=2 : permissionColumn.y>=identity.y+identity.height,'Token form uses aligned columns or a narrow-screen stack');
    assert.ok(await create.evaluate(element=>element.scrollWidth<=element.clientWidth+1),'Token form has no horizontal overflow');
    await create.getByRole('checkbox', { name: 'Check all permissions', exact: true }).check();
    const operation = create.getByRole('checkbox', { name: 'getProjectBoard', exact: true });
    assert.equal(await operation.isChecked(), true);
    await operation.uncheck();
    assert.equal(await create.getByRole('checkbox', { name: 'Check all permissions', exact: true }).isChecked(), false, 'Check all keeps individual permissions editable');
    await create.getByRole('checkbox', { name: 'All projects', exact: true }).uncheck();
    await create.getByRole('checkbox', { name: 'demo', exact: true }).check();
    await create.getByRole('checkbox', { name: 'getProjectBoard', exact: true }).check();
    await create.getByRole('textbox', { name: 'Token name', exact: true }).fill('Scoped automation');
    await page.screenshot({ path: path.join(output, `api-create-${width}x${height}.png`) });
    await create.getByRole('button', { name: 'Create token', exact: true }).click();
    await create.getByRole('textbox', { name: 'New API token', exact: true }).waitFor();
    assert.ok(await page.evaluate(() => window.__uiActions.some(message => message.action === 'generateApiToken' && message.payload?.tokenProjectPaths?.includes('D:/demo'))), 'Token creation sends the selected project checkbox scope');
    await page.evaluate(() => { window.__savedClipboard = navigator.clipboard; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
    await create.getByRole('button', { name: 'Copy token', exact: true }).click();
    await create.getByText('Copy blocked. Select the token and copy it manually.', { exact: true }).waitFor();
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: window.__savedClipboard }));
    await create.getByRole('button', { name: 'Close token form', exact: true }).click();
    await api.getByRole('tab', { name: 'Explorer', exact: true }).click();
    await api.getByText('POST /api/message', { exact: true }).waitFor();
    await api.getByRole('tab', { name: 'Test', exact: true }).click();
    assert.equal(await api.getByRole('button', { name: 'Send request once', exact: true }).isDisabled(), false, 'API tester can use the newly created token');
    await page.screenshot({ path: path.join(output, `api-access-${width}x${height}.png`) });
    await api.getByRole('button', { name: 'Close', exact: true }).click();
    if (width<=760 && await page.locator('.cli-rail-toggle').getAttribute('aria-expanded')==='true') await page.locator('.cli-rail-toggle').click();
}
