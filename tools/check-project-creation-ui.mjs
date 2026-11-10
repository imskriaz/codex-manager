import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkProjectCreationUi(page, { origin, width, output }) {
  const started = Date.now();
  await page.goto(origin + '/workspace');
  await page.locator('.cli-workspace').waitFor();
  const show = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
  if (await show.isVisible()) await show.click();
  const projects = page.getByRole('button', { name: 'Show projects and sessions', exact: true });
  if (await projects.isVisible()) await projects.click();
  await page.getByRole('button', { name: 'Expand empty-project-with-a-long-name', exact: true }).waitFor();
  assert.equal(await page.locator('.cli-create-project').count(), 0, 'Creation stays in the project picker');
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('__create_workspace_project__');
  const modal = page.getByRole('dialog', { name: 'Create new project', exact: true });
  await modal.waitFor();
  await modal.getByRole('textbox', { name: 'Project name', exact: true }).fill('folder-preview');
  await modal.getByRole('button', { name: 'Browse folders…', exact: true }).click();
  const folders = modal.getByRole('region', { name: 'Folders on selected system', exact: true });
  await folders.getByRole('button', { name: 'Projects', exact: true }).click();
  await folders.locator('code').filter({ hasText: 'D:/Projects' }).waitFor();
  await folders.getByRole('button', { name: 'Select this folder', exact: true }).click();
  assert.equal(await modal.getByRole('textbox', { name: 'Parent folder', exact: true }).inputValue(), 'D:/Projects');
  assert.ok(await modal.locator('.create-project-destination').innerText().then(text => text.includes('D:/Projects/folder-preview')));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
  await page.screenshot({ path: path.join(output, `project-browser-${width}.png`) });
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__uiActions.filter(action => action.action === 'createWorkspaceProject').length), 0, 'Folder selection never creates a project');
  const showAgain = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
  if (await showAgain.isVisible()) await showAgain.click();
  await page.evaluate(() => {
    window.__uiSessions.splice(0);
    dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:action-result', action: 'listCodexCliSessions', requestId: 'dashboard-auto-fixture', status: 'completed', payload: { cliSessions: [] } } }));
  });
  await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Expand empty-project-with-a-long-name', exact: true }).waitFor();
  console.log(JSON.stringify({ width, durationMs: Date.now() - started, checks: 'Empty project and zero-session picker, parent folder navigation and selection, cancellation, no real writes' }));
}
