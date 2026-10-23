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
    const list = page.getByRole('dialog', { name: 'API access', exact: true });
    await page.waitForFunction(() => !!window.__heldApiList);
    await list.getByRole('button', { name: '+ Create token', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'Create API token', exact: true });
    await form.getByLabel('Token name', { exact: true }).fill('First creation');
    await form.getByRole('button', { name: 'Create token', exact: true }).click();
    await form.getByRole('textbox', { name: 'New API token', exact: true }).waitFor();
    assert.equal(await form.getByRole('button', { name: 'Token created', exact: true }).isDisabled(), true);
    await form.getByRole('button', { name: 'Close token form', exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: window.__heldApiList })));
    await list.getByRole('cell', { name: 'First creation', exact: true }).waitFor();
    assert.equal(await list.locator('tbody tr').count(), 3, 'Stale listing cannot erase confirmed creation');
    await list.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForFunction(() => window.__uiActions.filter(action => action.action === 'listApiTokens').length >= 2);
    await list.getByRole('button', { name: '+ Create token', exact: true }).click();
    await form.getByLabel('Host project', { exact: true }).waitFor();
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
