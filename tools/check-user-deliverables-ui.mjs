import assert from 'node:assert/strict';
import path from 'node:path';

// Uses only the private-workspace fixture; never writes to the live host.
export async function checkUserDeliverablesUi(page, { width, output }) {
  await page.evaluate(() => window.__setDeliverables());
  const card = page.getByRole('region', { name: 'Generated files', exact: true });
  await card.waitFor();
  assert.deepEqual(await card.locator('strong').allTextContents(), ['buyer follow-up.txt', 'order.xlsx', 'all-files.zip', 'a-very-long-client-deliverable-name-with-the-full-extension-preserved.html']);
  assert.equal(await card.locator('li').count(), 4, 'Duplicate links produce one result');
  assert.match(await card.innerText(), /TXT · reports/);
  assert.match(await card.innerText(), /ZIP · exports/);
  assert.equal(await card.getByRole('button', { name: 'Open buyer follow-up.txt', exact: true }).getAttribute('title'), 'reports/buyer follow-up.txt');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    assert.ok(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'File names and controls fit the result card');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    await page.screenshot({ path: path.join(output, `generated-files-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.evaluate(() => document.documentElement.dataset.theme = 'light');
  await card.getByRole('button', { name: 'Open buyer follow-up.txt', exact: true }).click();
  await page.waitForFunction(() => window.__privateActions.some(action => action.action === 'readWorkspaceFile' && action.payload?.filePath === 'reports/buyer follow-up.txt' && action.payload?.fileDownloadOffset === undefined)).catch(async error => {
    console.error(JSON.stringify({ openFileActions: await page.evaluate(() => window.__privateActions.slice(-12)), text: await page.locator('.cli-workspace').innerText() }));
    await page.screenshot({ path: path.join(output, `generated-file-open-failure-${width}.png`), fullPage: true });
    throw error;
  });
  if (width < 760 && await page.getByRole('button', { name: 'Hide workspace tools', exact: true }).isVisible()) await page.getByRole('button', { name: 'Hide workspace tools', exact: true }).click();
  const download = card.getByRole('button', { name: 'Download order.xlsx', exact: true });
  await page.evaluate(() => { window.__holdFileDownload = true; });
  const previousDownloads = await page.evaluate(() => window.__privateActions.filter(action => action.action === 'readWorkspaceFile' && action.payload?.fileDownloadOffset !== undefined).length);
  await download.click();
  await card.getByRole('status').filter({ hasText: 'Preparing order.xlsx' }).waitFor();
  assert.equal(await download.isDisabled(), true);
  await download.evaluate(node => node.click());
  const held = await page.evaluate(() => window.__privateActions.filter(action => action.action === 'readWorkspaceFile' && action.payload?.fileDownloadOffset !== undefined).length);
  assert.equal(held, previousDownloads + 1, 'Repeated clicks do not duplicate a file request');
  const completed = page.waitForEvent('download');
  await page.evaluate(() => window.__releaseFileDownload());
  assert.equal((await completed).suggestedFilename(), 'order.xlsx');
  await card.getByRole('status').filter({ hasText: 'Download started: order.xlsx' }).waitFor();
  await page.evaluate(() => { window.__failFileDownload = true; });
  await card.getByRole('button', { name: 'Download all-files.zip', exact: true }).click();
  await card.getByRole('alert').filter({ hasText: 'Download failed: all-files.zip' }).waitFor();
  await page.getByText('This file changed. Start the download again.', { exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Download all-files.zip', exact: true }).isEnabled(), true);
  const retry = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Download all-files.zip', exact: true }).click();
  assert.equal((await retry).suggestedFilename(), 'all-files.zip');
  await card.getByRole('status').filter({ hasText: 'Download started: all-files.zip' }).waitFor();
  await page.evaluate(() => { window.__fixtureOffline = true; dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:host-status', stage: 'offline' } })); dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:connection', connected: false } })); });
  await card.getByRole('status').filter({ hasText: 'Reconnect to open or download' }).waitFor();
  assert.equal(await card.locator('button:not(:disabled)').count(), 0, 'Offline file actions cannot start');
  await page.evaluate(() => { window.__fixtureOffline = false; dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:host-status', stage: 'live' } })); dispatchEvent(new MessageEvent('message', { data: { type: 'dashboard:connection', connected: true } })); });
  await card.getByRole('button', { name: 'Download order.xlsx', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('.generated-file-download')?.disabled);
  await page.reload();
  await card.waitFor();
  assert.equal(await card.locator('li').count(), 4, 'Results retain real filenames after reload');
  await page.evaluate(() => window.__setDeliverables(false));
  await card.waitFor({ state: 'detached' });
  console.log(JSON.stringify({ width, generatedFiles: true, filenames: true, open: true, originalDownloads: true, failures: true, retry: true, duplicateProtection: true, offline: true }));
}
