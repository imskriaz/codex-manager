import { assertFlyoutNear } from './check-lists-api-ui.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkReviewsUi(page, { origin, parentId, width, output }) {
  await page.goto(`${origin}/workspace/${parentId}`);
  await page.getByRole('textbox', {name:'Message Codex',exact:true}).waitFor();
  const change = page.locator('.cli-file-change-list > details').first();
  await change.evaluate(element => { for (let node=element; node; node=node.parentElement) if (node instanceof HTMLDetailsElement) node.open=true; });
  await change.getByRole('button', {name:'Review',exact:true}).click();
  await page.getByRole('table', {name:/Changes in/}).waitFor();
  assert.equal(await page.getByRole('tab', {name:'Reviews',exact:true}).count(),0,'An individual review does not automatically add Reviews');
  const show = page.getByRole('button', {name:'Show workspace tools',exact:true});
  if (await show.isVisible()) await show.click();
  await page.getByRole('button', {name:'Add workspace tool',exact:true}).click();
  await page.getByRole('menuitem', {name:'Reviews',exact:true}).click();
  await page.getByText('Review changes', {exact:true}).waitFor();
  assert.equal(await page.locator('.cli-reviews-view > details').count(), 0, 'Agent activity stays in Agents');
  assert.ok(!(await page.locator('.cli-reviews-view > header').innerText()).includes('agent activities'), 'Reviews counts files only');
  const row = page.locator('.cli-review-file-list > button').first();
  await row.waitFor();
  await page.screenshot({path:path.join(output,`workspace-reviews-${width}.png`),animations:'disabled'});
  await row.focus(); await page.keyboard.press('Enter');
  await page.getByRole('table', {name:/Changes in/}).waitFor();
  await page.getByRole('columnheader', {name:'Before',exact:true}).waitFor();
  await page.getByRole('columnheader', {name:'After',exact:true}).waitFor();
  assert.ok(await page.locator('.cli-review-detail').evaluate(element => element.scrollWidth <= element.clientWidth + 1),'Review content stays inside its panel');
  const header = page.locator('.cli-review-detail > header');
  await header.locator('strong').evaluate(element => element.textContent = 'D:/projects/' + 'very-long-directory/'.repeat(20) + 'main.tsx');
  const headerBox = await header.boundingBox();
  assert.ok(headerBox.x + headerBox.width <= width + 1,'Review header stays inside the viewport after a long path');
  for (const control of [header.locator('small'), header.getByRole('button',{name:'Open in Files',exact:true})]) {
    const box = await control.boundingBox();
    assert.ok(box.x >= headerBox.x && box.x + box.width <= headerBox.x + headerBox.width + 1,'Review counts and action remain visible beside a long path');
  }
  await page.screenshot({path:path.join(output,`workspace-review-detail-${width}.png`),animations:'disabled'});
  await page.getByRole('button', {name:'Open in Files',exact:true}).click();
  await page.locator('.cli-file-editor .cm-content').waitFor();
  assert.equal(await page.getByRole('tab', {name:'Files',exact:true}).count(), 0, 'Opening a file does not automatically add Files');
}

// Called only by the intercepted responsive harness; every mutation stays in its fixture.
export async function checkInspectorUi(page, { origin, parentId, width, output }) {
  const exact = name => ({ name, exact: true });
  const show = async () => { const toggle = page.getByRole('button', exact('Show workspace tools')); if (await toggle.isVisible()) await toggle.click(); };
  const hide = async () => { const toggle = page.getByRole('button', exact('Hide workspace tools')); if (await toggle.isVisible()) await toggle.click(); };
  const tool = async name => {
    await show();
    const tab = page.getByRole('tab', exact(name));
    if (await tab.count()) await tab.click();
    else { await page.getByRole('button', exact('Add workspace tool')).click(); await page.getByRole('menuitem', exact(name)).click(); }
  };
  const selectSession = async (title, project) => {
    await hide();
    const open = page.getByRole('button', exact('Show sessions sidebar'));
    if (await open.isVisible()) { await open.click(); await page.getByRole('button', exact('Hide sessions sidebar')).waitFor(); }
    const row = page.locator('.cli-session-row-select').filter({ hasText: title });
    const expand = page.getByRole('button', exact(`Expand ${project}`));
    await Promise.race([row.waitFor({ state: 'visible' }), expand.waitFor({ state: 'visible' })]);
    if (await expand.isVisible()) await expand.click();
    await row.click();
    await show();
  };
  const edit = async text => { const editor = page.locator('.cli-file-editor .cm-content[contenteditable=true]'); await editor.click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(text); };
  let failedEditor = false;
  await page.route('**/assets/chunks/workspaceCodeEditor-*.js', route => {
    if (!failedEditor) { failedEditor = true; return route.abort(); }
    return route.fallback();
  });
  await page.goto(`${origin}/workspace/${parentId}`);
  await page.getByRole('textbox', exact('Message Codex')).waitFor();
  const sidebarToggle = page.locator('.cli-rail-toggle');
  await sidebarToggle.waitFor({ state: 'visible' });
  if (await sidebarToggle.getAttribute('aria-expanded') === 'false') await sidebarToggle.click();
  const sidebarView = page.locator('.cli-session-view-toggle');
  await sidebarView.waitFor({ state: 'visible' });
  if (await sidebarView.getAttribute('aria-label') === 'Show projects and sessions') await sidebarView.click();
  await page.locator('.cli-project-select strong').first().waitFor({ state: 'attached' });
  if (!await page.locator('.cli-session-row-main strong').count()) {
    const expand = page.getByRole('button', exact('Expand demo'));
    if (await expand.isVisible()) await expand.click();
  }
  await page.locator('.cli-session-row-main strong').first().waitFor({ state: 'attached' });
  const sidebarFonts=await page.evaluate(()=>({session:getComputedStyle(document.querySelector('.cli-session-row-main strong')).fontSize,project:getComputedStyle(document.querySelector('.cli-project-select strong')).fontSize}));
  assert.equal(sidebarFonts.session,sidebarFonts.project,'Project and conversation titles use the same sidebar text size');
  const closeSidebar = page.getByRole('button', exact('Hide sessions sidebar'));
  if (await closeSidebar.isVisible()) await closeSidebar.click();
  await page.evaluate(() => { window.__inspectorMode = true; });
  if (process.argv.includes('--agent-inspector')) { await checkAgentInspector(page, { width, output, tool, hide, show }); return; }
  await show();
  await page.getByRole('tab', exact('Env')).click();
  await page.getByRole('button', exact('Open Git')).waitFor();
  const overview = page.locator('.cli-inspector-body section').filter({ has: page.getByRole('heading', exact('Tools overview')) });
  assert.deepEqual(await overview.locator('button > span').allTextContents(), ['Git', 'Files', 'Terminals', 'Agents', 'Reviews'], 'Env includes every inspector tool in one list');
  assert.match(await overview.getByRole('button', { name: /^Agents/ }).textContent(), /1 recorded · 1 running/, 'Env summarizes recorded agents and running state');
  await page.locator('.cli-inspector-shortcuts button').filter({ hasText: 'Reviewer' }).waitFor();
  assert.equal(await page.locator('.cli-context-tab-scroll [role=tab]').first().textContent(), 'Env');
  assert.equal(await page.getByRole('button', exact('Close Env')).count(), 0);
  assert.equal(await page.locator('.cli-terminal-panel button[aria-label="Hide workspace tools"]').count(), 0, 'Header owns panel visibility');
  assert.equal(await page.locator('.cli-environment-popover').count(), 0);
  const toggle = await page.getByRole('button', exact('Hide workspace tools')).boundingBox();
  const panel = await page.getByRole('complementary', exact('Workspace tools')).boundingBox();
  if (width <= 1180) assert.ok(toggle.y + toggle.height <= panel.y + 1, 'Inspector overlay leaves its header toggle reachable');
  const before = await page.locator('.cli-conversation').boundingBox();
  const add = page.getByRole('button', exact('Add workspace tool'));
  const envTabBounds = await page.getByRole('tab', exact('Env')).boundingBox();
  const addBounds = await add.boundingBox();
  assert.ok(addBounds.x >= envTabBounds.x + envTabBounds.width && addBounds.x + addBounds.width <= panel.x + panel.width + 1, 'Plus remains after the tabs and inside the tool panel');
  if (width > 760) assert.ok(addBounds.x - envTabBounds.x - envTabBounds.width < 18, 'Plus follows the open tabs without an empty gap');
  await add.click();
  const menu = page.getByRole('menu', exact('Workspace tools menu'));
  assert.ok(await menu.evaluate(element => element.matches(':popover-open')), 'Tool flyout uses the top layer');
  const names = await menu.getByRole('menuitem').allTextContents();
  assert.ok(names.includes('Git') && !names.some(name => /PowerShell|BASH|Default terminal/i.test(name)), 'Terminal profiles belong to the Terminal toolbar');
  const after = await page.locator('.cli-conversation').boundingBox(); assert.deepEqual(after, before, 'Opening tool menu never shifts content');
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
  assert.equal(await add.evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Escape');
  await page.getByRole('button', exact('Show workspace tools')).waitFor().catch(async error => {
    console.log('Inspector Escape state', await page.evaluate(() => ({ focused: document.activeElement?.getAttribute('aria-label'), root: document.querySelector('.cli-workspace')?.className, addOpen: document.querySelector('.cli-context-add')?.getAttribute('aria-expanded'), modals: [...document.querySelectorAll('[aria-modal="true"], .overlay.open')].map(element => ({ className: element.className, rects: element.getClientRects().length, display: getComputedStyle(element).display, visibility: getComputedStyle(element).visibility })) })));
    throw error;
  });
  assert.equal(await page.getByRole('button', exact('Show workspace tools')).evaluate(element => element === document.activeElement), true, 'Closing the inspector restores focus to its header toggle');
  await tool('Git');
  const repositoryActions = page.getByRole('button', exact('Repository actions'));
  await repositoryActions.click();
  await assertFlyoutNear(page, repositoryActions, page.getByRole('menu', exact('Repository actions')));
  await page.keyboard.press('Escape');
  await page.getByRole('tab', exact('History')).click();
  await page.waitForFunction(() => document.querySelectorAll('.workspace-history-row').length === 50);
  await page.getByRole('button', exact('Older page')).click();
  await page.waitForFunction(() => document.querySelectorAll('.workspace-history-row').length === 13);
  await page.getByRole('button', exact('Newer page')).click();
  await page.waitForFunction(() => document.querySelectorAll('.workspace-history-row').length === 50);
  await page.locator('.workspace-history-row').first().click();
  await page.getByText('verified history', { exact: false }).waitFor();
  if (width === 1440 || width === 390) await page.screenshot({ path: path.join(output, `inspector-history-${width}.png`), animations: 'disabled' });
  await page.getByRole('dialog').getByRole('button', exact('Close')).click();
  await page.evaluate(() => { window.__failNextHistory=true; });
  await page.getByRole('button', exact('Refresh')).click();
  await page.getByText('Simulated history read failure.', { exact: true }).first().waitFor();
  assert.equal(await page.locator('.workspace-history-row').count(), 50, 'History survives a failed refresh');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {type:'dashboard:connection',connected:false} })));
  await page.waitForFunction(() => [...document.querySelectorAll('.workspace-history-row')].every(button => button.disabled));
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {type:'dashboard:connection',connected:true} })));
  await page.getByRole('tab', exact('Changes')).click();
  await page.locator('.workspace-git-file').filter({ hasText: 'untracked' }).locator('.workspace-file-name').click();
  assert.equal(await page.getByRole('tab', exact('Files')).getAttribute('aria-selected'), 'true', 'Untracked directories open the file explorer rather than a file read');
  assert.equal(await page.evaluate(() => window.__uiActions.some(action => action.action === 'readWorkspaceFile' && action.payload?.filePath === 'untracked/')), false);
  await tool('Git');
  await tool('Files');
  await checkFileTreePolish(page, { width, output });
  const contextFile = page.locator('.cli-file-tree button').filter({ hasText: 'app.ts' });
  await contextFile.click({ button: 'right' });
  await assertFlyoutNear(page, contextFile, page.locator('.cli-file-context-menu'));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.cli-file-context-menu').count(), 0, 'File context menu closes without disturbing the inspector');
  await tool('Git');
  const commit = page.getByRole('textbox', exact('Commit message'));
  await commit.fill('Keep this commit draft');
  await page.evaluate(() => { window.__failCommit = true; });
  await page.getByRole('button', exact('Stage all')).click();
  await page.getByRole('button', { name: /^Commit staged/ }).click();
  await page.locator('.dashboard-notice-stack').filter({hasText:'Simulated commit failure'}).waitFor();
  await page.getByRole('button', exact('Refresh Git')).click();
  assert.equal(await commit.inputValue(), 'Keep this commit draft');
  await page.evaluate(() => { window.__failCommit = false; window.__holdNextCommit = true; });
  await page.getByRole('button', exact('Stage all')).click();
  await page.getByRole('button', { name: /^Commit staged/ }).click();
  await page.waitForFunction(() => !!window.__heldCommitResult);
  await commit.fill('Newer commit draft');
  await page.getByRole('button', exact('Close Git')).click();
  assert.equal(await page.getByRole('tab', exact('Git')).count(), 0, 'Git is closable');
  assert.equal(await page.getByRole('tab', exact('Env')).getAttribute('aria-selected'), 'true');
  await tool('Git');
  assert.equal(await commit.inputValue(), 'Newer commit draft', 'Reopening Git retains its draft');
  await page.waitForFunction(() => document.querySelector('.workspace-commit button[type=submit]')?.disabled);
  const alternate = '01a04882-d037-7a42-ad24-9afb61901234';
  await page.evaluate(id => {
    window.__uiSessions.push({ id, title: 'Inspector alternate project', projectPath: 'D:/other', status: 'idle' });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', requestId: 'dashboard-auto-inspector', action: 'listCodexCliSessions', status: 'completed', payload: { cliSessions: window.__uiSessions } } }));
  }, alternate);
  await selectSession('Inspector alternate project', 'other');
  await tool('Git'); assert.equal(await commit.inputValue(), '', 'Commit draft is scoped to project');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: window.__heldCommitResult })));
  await page.getByRole('tab', exact('Env')).click();
  await page.locator('.cli-inspector-body dt').filter({ hasText: /^Folder$/ }).locator('..').getByText('D:/other', { exact: true }).waitFor();
  await selectSession('Evaluate stack beyond expectations', 'demo');
  await tool('Git'); assert.equal(await commit.inputValue(), 'Newer commit draft', 'Late commit acknowledgement retains newer edits in original context');
  await page.getByRole('tab', exact('Branches')).click();
  await page.getByText('feature/demo', { exact: true }).waitFor();
  await page.getByRole('tab', exact('Stashes')).click();
  await page.getByText('Saved fixture work', { exact: true }).waitFor();
  await page.getByRole('tab', exact('GitHub')).click();
  await page.getByText('Fixture pull request', { exact: true }).waitFor();
  await page.locator('.workspace-github-row').first().click();
  await page.getByRole('dialog').getByText('Reviewed fixture', { exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('tab', exact('Files')).click();
  await page.getByRole('dialog').getByText('src/app.ts', { exact: true }).waitFor();
  await page.getByRole('button', exact('Close Fixture pull request')).click();
  await page.getByRole('tab', exact('Issues')).click();
  await page.getByText('Fixture issue', { exact: true }).waitFor();
  await page.locator('.workspace-github .workspace-list-heading').getByRole('button', exact('New')).click();
  const issueDialog = page.getByRole('dialog');
  await issueDialog.getByLabel('Title', { exact: true }).fill('Fixture issue draft');
  await issueDialog.getByRole('button', exact('Confirm')).click();
  await issueDialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.dashboard-notice-stack.is-info, .dashboard-notice-stack .is-info').count(), 0, 'Confirmed GitHub changes stay quiet');
  await page.evaluate(() => { window.__failGithubAfterWrite=true; });
  await page.locator('.workspace-github .workspace-list-heading').getByRole('button', exact('New')).click();
  await page.getByRole('dialog').getByLabel('Title', {exact:true}).fill('Preserve loaded list after confirmed write');
  await page.getByRole('dialog').getByRole('button', exact('Confirm')).click();
  await page.locator('.dashboard-notice-stack').filter({hasText:'updated list could not be read'}).waitFor();
  assert.equal(await page.locator('.workspace-github-row').count(),1,'An acknowledged write with a failed refresh preserves the previous visible list');
  await page.evaluate(() => { window.__failGithubAfterWrite=false; });
  await page.getByRole('button',exact('Refresh GitHub')).click();

  await page.evaluate(() => { window.__failGitHub=true; });
  await page.getByRole('button', exact('Refresh GitHub')).click();
  await page.getByText('GitHub sign-in expired. Connect GitHub and retry.', { exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-github-row').count(), 1, 'Failed refresh preserves loaded GitHub items');
  await page.evaluate(() => { window.__failGitHub=false; });
  await page.getByRole('tab', exact('Changes')).click();
  await page.evaluate(() => { window.__holdNextGitHubRead = true; });
  await page.getByRole('tab', exact('GitHub')).click();
  await page.waitForFunction(() => !!window.__heldGitHubRead);
  await page.getByText('Fixture pull request', { exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-github .workspace-list-heading').getByRole('button', exact('New')).isDisabled(), true, 'Cached GitHub permissions cannot authorize a write before the live read');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: structuredClone(window.__heldGitHubRead) })));

  await page.getByRole('tab', exact('Env')).click();
  await page.waitForFunction(() => document.querySelector('.cli-inspector-view[aria-label="Environment"]')?.getAttribute('aria-busy') === 'false');
  await page.evaluate(() => { window.__holdNextEnvironment = true; });
  await page.getByRole('tab', exact('Env')).click();
  await page.waitForFunction(() => !!window.__heldEnvironmentResult);
  await selectSession('Inspector alternate project', 'other');
  await page.getByRole('tab', exact('Env')).click();
  await page.locator('.cli-inspector-view[aria-label="Environment"]').waitFor();
  await page.waitForFunction(() => document.querySelector('.cli-inspector-view[aria-label="Environment"]')?.getAttribute('aria-busy') === 'false');
  await page.evaluate(() => { window.__heldEnvironmentResult.payload.workspaceEnvironment.branch = 'Stale other-system response'; window.dispatchEvent(new MessageEvent('message', { data: window.__heldEnvironmentResult })); });
  assert.notEqual(await page.locator('.cli-inspector-body dt').filter({ hasText: /^Branch$/ }).locator('..').locator('dd').textContent(), 'Stale other-system response');
  await selectSession('Evaluate stack beyond expectations', 'demo');
  await tool('Files'); await page.locator('.cli-file-tree button').filter({ hasText: 'app.ts' }).click();
  await page.getByRole('button', exact('Retry editor')).waitFor();
  const beforeRetry = await page.evaluate(() => window.__uiActions.filter(action => action.action === 'saveWorkspaceFile').length);
  const composer = page.getByRole('textbox', exact('Message Codex'));
  const previousDraft = await composer.inputValue();
  await composer.fill('Manual input stays available while the editor module is unavailable.');
  assert.equal(await composer.inputValue(), 'Manual input stays available while the editor module is unavailable.');
  await composer.fill(previousDraft);
  await page.getByRole('button', exact('Retry editor')).click();
  await page.locator('.cli-file-editor .cm-content').waitFor();
  assert.equal(await page.evaluate(() => window.__uiActions.filter(action => action.action === 'saveWorkspaceFile').length), beforeRetry, 'Retrying a failed lazy panel never sends a save');

  const treeReads = await page.evaluate(() => window.__uiActions.filter(action => action.action === 'listWorkspaceFiles').length);
  const fileReads = await page.evaluate(() => window.__uiActions.filter(action => action.action === 'readWorkspaceFile').length);
  await page.evaluate(() => { window.__holdNextWorkspaceFileRead = true; });
  await page.getByRole('tab', exact('app.ts')).click();
  await page.waitForFunction(() => !!window.__heldWorkspaceFileResult);
  await page.getByRole('tab', exact('app.ts')).click();
  assert.equal(await page.evaluate(() => window.__uiActions.filter(action => action.action === 'readWorkspaceFile').length), fileReads + 1, 'Repeated file clicks coalesce one in-flight read');
  assert.equal(await page.evaluate(() => window.__uiActions.filter(action => action.action === 'listWorkspaceFiles').length), treeReads, 'Opening a file never rescans its project tree');
  assert.equal(await page.locator('.cli-file-editor .cm-content').getAttribute('contenteditable'), 'true', 'A cached editor stays usable during background validation');
  await tool('Files');
  await page.evaluate(() => { window.__failNextWorkspaceFileRead = true; });
  await page.locator('.cli-file-tree button').filter({ hasText: 'other.ts' }).click();
  await page.getByText('Simulated file read failure.', { exact: true }).first().waitFor();
  await page.locator('.cli-file-editor').getByRole('button', exact('Retry loading file')).waitFor();
  assert.equal(await page.locator('.cli-file-editor').getByText('Opening file…', { exact: true }).count(), 0, 'An unrelated slow read cannot hide this file’s failure');
  await page.locator('.cli-file-editor').getByRole('button', exact('Retry loading file')).click();
  await page.locator('.cli-file-editor .cm-content').waitFor();
  await page.evaluate(() => { window.dispatchEvent(new MessageEvent('message', { data: structuredClone(window.__heldWorkspaceFileResult) })); });
  await page.getByRole('tab', exact('app.ts')).click();
  await page.locator('.cli-file-editor .cm-content').waitFor();

  await edit('const edited = 1;');
  await page.evaluate(() => { window.__holdNextSave = true; });
  await page.getByRole('button', exact('Save file')).click();
  await page.waitForFunction(() => !!window.__heldSaveResult);
  await edit('const edited = 2;');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: window.__heldSaveResult })));
  await page.waitForFunction(() => document.querySelector('.cli-file-editor button[aria-label="Save file"]')?.disabled === false);
  assert.match(await page.locator('.cli-file-editor .cm-content').textContent(), /edited = 2/);
  await page.getByRole('button', exact('Save file')).click();
  await page.waitForFunction(() => window.__uiActions.filter(action => action.action === 'saveWorkspaceFile').length === 2);
  assert.equal(await page.evaluate(() => window.__uiActions.filter(action => action.action === 'saveWorkspaceFile').at(-1).payload.fileRevision), 'saved-revision', 'Acknowledged save advances the base revision without dropping newer edits');
  await edit('const localDraft = true;');
  await page.evaluate(() => { window.__fileRevision = 'external-revision'; window.__failFileSave = true; });
  await page.getByRole('tab', exact('app.ts')).click();
  await page.getByRole('button', exact('Save file')).click();
  await page.locator('.dashboard-notice-stack').filter({ hasText: 'Simulated revision conflict' }).waitFor();
  assert.equal(await page.evaluate(() => window.__uiActions.filter(action => action.action === 'saveWorkspaceFile').at(-1).payload.fileRevision), 'saved-revision', 'External refresh cannot overwrite the edited base revision');
  await tool('Terminal'); await page.getByRole('tab', exact('app.ts')).click();
  assert.match(await page.locator('.cli-file-editor .cm-content').textContent(), /localDraft/);
  await selectSession('Inspector alternate project', 'other');
  await tool('Files'); await page.locator('.cli-file-tree button').filter({ hasText: 'app.ts' }).click();
  assert.doesNotMatch(await page.locator('.cli-file-editor .cm-content').textContent(), /localDraft/, 'Same filename in another project has a separate draft');
  await selectSession('Evaluate stack beyond expectations', 'demo');
  await tool('app.ts'); assert.match(await page.locator('.cli-file-editor .cm-content').textContent(), /localDraft/);
  await tool('Terminal');
  const terminalPanel = await page.getByRole('complementary', exact('Workspace tools')).boundingBox();
  const terminalToolbar = await page.locator('.workspace-terminal > .workspace-tool-toolbar').boundingBox();
  assert.ok(terminalToolbar.x >= terminalPanel.x && terminalToolbar.x + terminalToolbar.width <= terminalPanel.x + terminalPanel.width + 1, 'Tool content fits the panel track');
  await page.getByRole('button', exact('New terminal')).click();
  await page.locator('.workspace-xterm .xterm-screen').waitFor();
  await page.locator('.workspace-terminal-status').waitFor({state:'detached'});
  await page.locator('.workspace-xterm .xterm-helper-textarea').focus();
  await page.keyboard.type('echo fixture'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__uiActions.filter(action => action.action==='workspaceTerminal' && action.payload?.terminalRequest?.operation==='input').map(action=>action.payload.terminalRequest.data).join('').includes('echo fixture'));
  await page.getByRole('button', exact('Reconnect terminal screen')).click();
  await page.locator('.workspace-terminal-status').waitFor({state:'detached'});
  await page.locator('.workspace-xterm .xterm-helper-textarea').focus();
  await page.keyboard.press('ControlOrMeta+f');
  await page.getByRole('textbox', exact('Find terminal text')).fill('Fixture');
  await page.getByRole('button', exact('Close terminal search')).click();
  if (width === 1440 || width === 390) await page.screenshot({ path: path.join(output, `inspector-terminal-${width}.png`), animations: 'disabled' });
  await page.getByRole('button', exact('Terminal actions')).click();
  await page.getByRole('button', exact('Close terminal')).click();
  await page.getByRole('dialog').getByRole('button', exact('Close terminal')).click();
  await page.getByRole('button', exact('New shared terminal')).waitFor();
  await tool('Env');
  await page.evaluate(() => { window.__holdNextGitRead = true; });
  await tool('Git');
  await page.waitForFunction(() => !!window.__heldGitRead);
  await page.locator('.workspace-git-file').first().waitFor();
  assert.equal(await page.getByRole('button', exact('Stage all')).isDisabled(), true, 'Cached Git state remains read-only until the live revision arrives');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: structuredClone(window.__heldGitRead) })));
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:connection', connected: false } })));
  await page.waitForFunction(() => [...document.querySelectorAll('.workspace-commit button')].every(button => button.disabled));
  assert.equal(await commit.inputValue(), 'Newer commit draft');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:connection', connected: true } })));
  if (width === 1440 || width === 390) await page.screenshot({ path: path.join(output, `inspector-git-${width}.png`), animations: 'disabled' });
  await page.getByRole('tab', exact('Env')).click();
  await page.screenshot({ path: path.join(output, `inspector-${width}.png`), animations: 'disabled' });
  await page.addInitScript(() => { window.__holdNextWorkspaceFileRead = true; });
  await page.goto(`${origin}/workspace/${parentId}`);
  await page.getByRole('link', exact('Source file')).click();
  await page.waitForFunction(() => !!window.__heldWorkspaceFileResult);
  if (width === 320) await page.getByText('Opening file…', {exact:true}).waitFor();
  else {
    await page.locator('.cli-file-editor .cm-content').waitFor();
    assert.equal(await page.locator('.cli-file-editor .cm-content').getAttribute('contenteditable'), 'true', 'A reopened browser hydrates its file cache without waiting for the held host read');
  }
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: structuredClone(window.__heldWorkspaceFileResult) })));
  await page.locator('.cli-file-editor .cm-content').waitFor();
  assert.equal(await page.getByRole('link',exact('Source file')).getAttribute('target'),null);
  await hide();
  await page.getByRole('link',exact('Native source')).click();
  await page.waitForFunction(()=>window.__uiActions.some(action=>action.action==='readWorkspaceFile'&&action.payload.filePath==='src/app.ts'));
  assert.equal(await page.getByRole('tab',exact('app.ts')).count(),1,'File and native URL references share the Files tab');
  assert.equal(new URL(page.url()).pathname,`/workspace/${parentId}`,'File links keep the conversation open');
  assert.equal(await page.getByRole('link',exact('Documentation')).getAttribute('target'),'_blank','Web links retain external navigation');

  if (width === 1440 || width === 390) {
    const previousTheme = await page.evaluate(() => { const previous = document.documentElement.dataset.theme; document.documentElement.dataset.theme = 'dark'; return previous; });
    await page.screenshot({ path: path.join(output, `inspector-dark-${width}.png`), animations: 'disabled' });
    await page.evaluate(previous => { document.documentElement.dataset.theme = previous; }, previousTheme);
  }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Inspector fits viewport');
  await checkAgentInspector(page, { width, output, tool, hide, show });

  if (width === 1440 || width === 390) {
    await hide();
    const openSidebar = page.getByRole('button', exact('Show sessions sidebar'));
    if (await openSidebar.isVisible()) await openSidebar.click();
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({ path: path.join(output, `project-sidebar-dark-${width}.png`), animations: 'disabled' });
  }
}

async function checkFileTreePolish(page, { width, output }) {
  await page.evaluate(() => {
    window.__fileTreeFixture = [
      {path:'src',name:'src',type:'directory',depth:0},
      {path:'src/app.ts',name:'app.ts',type:'file',depth:1},
      {path:'very-long-project-documentation-and-release-notes-for-the-current-workspace.md',name:'very-long-project-documentation-and-release-notes-for-the-current-workspace.md',type:'file',depth:0}
    ];
    window.__fileTreeWarning = 'Some folders are unavailable. Readable files are shown; refresh to retry.';
  });
  const refresh = page.getByRole('button', {name:'Refresh files',exact:true});
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Refresh files"]')?.disabled);
  await refresh.click();
  const folder = page.locator('.cli-file-tree > button[title="src"]');
  await folder.waitFor();
  assert.equal(await folder.getAttribute('aria-expanded'), 'false', 'Folders start collapsed without briefly painting every descendant');
  assert.equal(await page.locator('.cli-file-tree > button[title="src/app.ts"]').count(), 0);
  await page.locator('.cli-inspector-notice.is-warning').filter({hasText:'Some folders are unavailable'}).waitFor();
  await folder.click();
  assert.equal(await folder.getAttribute('aria-expanded'), 'true');
  await page.locator('.cli-file-tree > button[title="src/app.ts"]').waitFor();
  if (width <= 760) assert.ok((await folder.boundingBox()).height >= 44, 'File rows remain easy to tap');
  const before = await folder.boundingBox(); await folder.hover(); const after = await folder.boundingBox();
  assert.ok(Math.abs(before.x-after.x)<1 && Math.abs(before.y-after.y)<1, 'Hover does not displace file rows');
  assert.ok(await page.locator('.cli-file-tree').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Long filenames stay within the explorer');
  await page.screenshot({path:path.join(output,`workspace-files-polish-${width}.png`),animations:'disabled'});
  await page.evaluate(() => { delete window.__fileTreeFixture; delete window.__fileTreeWarning; });
  await refresh.click();
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Refresh files"]')?.disabled);
  assert.equal(await page.locator('.cli-inspector-notice.is-warning').count(),0,'A complete refresh clears the partial-list warning');
}

async function checkAgentInspector(page, { width, output, tool, hide, show }) {
  await page.evaluate(() => {
    const agent = window.__uiSessions.find(session => session.agentName === 'Reviewer');
    if (agent) { agent.model = 'gpt-6.1-Sol'; agent.reasoningEffort = 'high'; }
    dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action: 'listCodexCliSessions', requestId: 'dashboard-auto-agent-tab-label', status: 'completed', payload: { cliSessions: window.__uiSessions } } }));
  });
  await tool('Agents');
  const workspaceTabCount=await page.locator('.cli-context-tabs-v3 [role=tab]').count();
  await page.locator('.cli-agent-row').filter({hasText:'Reviewer'}).click();
  await page.getByText('Agent reviewer message',{exact:true}).waitFor();
  assert.equal(await page.locator('.cli-agent-workspace > header').count(),0,'Agent metadata belongs in its tab, with no separate refresh row');
  await page.getByRole('tab', {name:'Reviewer (6.1-Sol · high)',exact:true}).waitFor();
  await page.evaluate(() => { window.__holdNextAgentRead = true; window.__heldAgentResult = undefined; });
  await hide(); await show();
  await page.waitForFunction(() => !!window.__heldAgentResult);
  assert.ok(await page.getByText('Agent reviewer message',{exact:true}).isVisible(),'A pending background refresh keeps saved messages visible');
  assert.equal(await page.getByText('Refreshing agent messages…',{exact:true}).count(),0,'Background refresh has no inline status row');
  await page.evaluate(() => {
    const result = structuredClone(window.__heldAgentResult);
    result.payload.cliSubAgentMessages.push({id:'workspace-agent-incoming',kind:'message',role:'assistant',text:'Incoming workspace agent message'});
    window.__agentHistory = result.payload.cliSubAgentMessages;
    dispatchEvent(new MessageEvent('message',{data:result}));
  });
  await page.getByText('Incoming workspace agent message',{exact:true}).waitFor();
  await page.getByRole('tab',{name:'Reviewer (6.1-Sol · high)',exact:true}).waitFor();
  await page.getByText('Agent reviewer message',{exact:true}).waitFor();
  await tool('Env'); await tool('Agents');
  await page.getByRole('tab',{name:'Reviewer (6.1-Sol · high)',exact:true}).waitFor();
  await page.getByText('Incoming workspace agent message',{exact:true}).waitFor();
  assert.equal(await page.locator('.cli-agent-workspace .cli-agent-tabs [role=tab]').count(),2,'Hiding tools and switching tools keeps opened agent tabs');
  const stickyNavigation = await page.locator('.cli-agent-workspace').evaluate(async element => {
    const spacer=document.createElement('div');spacer.style.cssText='height:1200px;flex:none';element.append(spacer);
    element.scrollTop=element.scrollHeight;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const nav=element.querySelector('.cli-agent-tabs').getBoundingClientRect(),panel=element.getBoundingClientRect();
    const result={scroll:element.scrollTop,top:nav.top-panel.top,bottom:nav.bottom-panel.top,paddingTop:parseFloat(getComputedStyle(element).paddingTop),height:element.clientHeight,scrollHeight:element.scrollHeight,overflow:getComputedStyle(element).overflow,position:getComputedStyle(element.querySelector('.cli-agent-tabs')).position,parent:{height:element.parentElement.clientHeight,overflow:getComputedStyle(element.parentElement).overflow,display:getComputedStyle(element.parentElement).display}};
    spacer.remove();element.scrollTop=0;return result;
  });
  console.log('Agent navigation geometry', stickyNavigation);
  assert.ok(stickyNavigation.scroll>100 && stickyNavigation.top>=stickyNavigation.paddingTop-1 && stickyNavigation.top<=stickyNavigation.paddingTop+2 && stickyNavigation.bottom>5,'Agent navigation stays pinned while its conversation scrolls: '+JSON.stringify(stickyNavigation));
  assert.equal(await page.locator('.cli-context-tabs-v3 [role=tab]').count(),workspaceTabCount,'Selecting an agent stays in the shared Agents panel');
  await page.screenshot({path:path.join(output,`workspace-agents-${width}.png`)});
  await page.getByRole('tab',{name:/All agents/}).click();
  await page.locator('.cli-agent-row').filter({hasText:'Reviewer'}).waitFor();

}
