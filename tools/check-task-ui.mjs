import assert from 'node:assert/strict';
import path from 'node:path';

// Runs inside the responsive harness: every write is intercepted by its in-memory host.
export async function checkTaskUi(page, { origin, width, height, output }) {
  await page.goto(`${origin}/`);
  await page.locator('#dashboard-main').waitFor();
  if (width <= 760) await page.getByRole('button', { name: 'Show sessions sidebar', exact: true }).click();
  await page.getByRole('button', { name: 'Task view', exact: true }).click();
  await page.locator('.task-board-card').filter({ hasText: 'Release work' }).waitFor();
  assert.deepEqual(await page.locator('.task-board-column-heading strong').allTextContents(), ['Idea','Planned','Running','Completed']);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Task board keeps horizontal scrolling inside its columns');
  assert.equal(await page.locator('.task-board-card').filter({ hasText: 'Evaluate stack beyond expectations' }).count(), 0, 'Grouped session is absent from root cards');
  await page.locator('.task-tree-item').filter({ has: page.locator('.task-board-card', { hasText: 'Release work' }) }).getByRole('button', { name: /subtasks/ }).click();
  const child = page.locator('.task-board-card').filter({ hasText: 'Evaluate stack beyond expectations' });
  assert.equal(await child.count(), 1, 'Expanding the parent shows its session once');
  await child.click();
  const task = page.locator('.task-detail-modal');
  await task.getByText('Review the workspace and explain the result.', { exact: true }).waitFor();
  await task.getByRole('tab', { name: 'Activities', exact: true }).click();
  await task.locator('.cli-activity > summary').first().click();
  await task.getByText('Script completed', { exact: true }).waitFor();
  await task.getByRole('tab', { name: 'Files', exact: true }).click();
  await task.locator('.task-file-row').filter({ hasText: 'src/app.ts' }).click();
  await task.getByText('const task = 1;', { exact: true }).waitFor();
  await task.getByRole('tab', { name: 'Git history', exact: true }).click();
  await task.getByText('Prepare project tasks', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, `task-details-${width}x${height}.png`) });
  await task.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Share project', exact: true }).click();
  const share = page.locator('.project-share-modal');
  assert.equal(await share.getByRole('checkbox', { name: /Allow embedding/ }).isChecked(), false);
  await share.getByRole('checkbox', { name: /Allow embedding/ }).check();
  await share.getByRole('button', { name: 'Create link', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.project-share-modal textarea')?.value.includes('<iframe'));
  assert.ok(await page.locator('.project-share-modal textarea').inputValue().then(value => value.includes('referrerpolicy="no-referrer"')), 'Embed code contains only the granted shared URL');
  await page.screenshot({ path: path.join(output, `project-sharing-${width}x${height}.png`) });
  await share.getByRole('button', { name: 'Close', exact: true }).click();

  const sentBefore = await page.evaluate(() => window.__uiActions.filter(message => message.action === 'saveProjectTask').length);
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:connection', connected: false } })));
  await page.waitForFunction(() => document.querySelector('.task-board-toolbar button:nth-of-type(2)')?.disabled);
  await page.getByRole('button', { name: '＋ Task', exact: true }).click();
  await task.getByLabel('Title', { exact: true }).fill('Offline task draft');
  await task.getByLabel('Prompt / idea', { exact: true }).fill('Keep this work through reconnect.');
  await task.getByRole('button', { name: 'Save task', exact: true }).click();
  if (width === 320) {
    await task.getByText(/Browser storage is full or unavailable/).waitFor();
    assert.equal(await task.getByLabel('Title', { exact: true }).inputValue(), 'Offline task draft', 'Storage failures preserve the open draft');
    await task.getByRole('button', { name: 'Close', exact: true }).click();
  } else {
    await task.waitFor({ state: 'hidden' });
    await page.locator('.task-board-card').filter({ hasText: 'Offline task draft' }).waitFor();
  }
  assert.equal(await page.evaluate(() => window.__uiActions.filter(message => message.action === 'saveProjectTask').length), sentBefore, 'Offline drafts never send a live request');
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:connection', connected: true } })));
  if (width !== 320) await page.waitForFunction(before => window.__uiActions.filter(message => message.action === 'saveProjectTask').length === before + 1, sentBefore);
  await page.screenshot({ path: path.join(output, `project-board-${width}x${height}.png`) });

  if (width > 760) {
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await page.locator('#apiOpenButton').click();
    const api = page.locator('.dashboard-api-modal');
    await api.getByText('Project reader', { exact: true }).waitFor();
    assert.equal(await api.locator('tbody tr').count(), 2, 'Named tokens are displayed in a table');
    await api.getByRole('tab', { name: 'Explorer', exact: true }).click();
    await api.getByText('POST /api/message', { exact: true }).waitFor();
    await api.getByRole('tab', { name: 'Test', exact: true }).click();
    assert.equal(await api.getByRole('button', { name: 'Send request once', exact: true }).isDisabled(), true, 'API tester requires a bearer token');
    await page.screenshot({ path: path.join(output, `api-access-${width}x${height}.png`) });
    await api.getByRole('button', { name: 'Close', exact: true }).click();
  }
}
