import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';

// Explicit end-to-end check: only disposable folders and their exact registry row are removed.
const origin = 'http://127.0.0.1:39875';
assert.ok(process.env.CODEX_MANAGER_E2E_STATE_FILE, 'Set the local host state database for exact test-row cleanup');
const stateFile = path.resolve(process.env.CODEX_MANAGER_E2E_STATE_FILE);
const temporary = await mkdtemp(path.join(tmpdir(), 'codex-manager-e2e-'));
const existingPath = path.join(temporary, 'existing-project');
await mkdir(existingPath);
await writeFile(path.join(existingPath, 'keep.txt'), 'kept');
await writeFile(path.join(temporary, 'existing-file'), 'kept');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const errors = [], sent = [];
const started = Date.now();
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 850 }, serviceWorkers: 'block', hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const capture = text => { try { const value = JSON.parse(text); if (value.type === 'dashboard:action') sent.push(value.action); } catch { /* Non-action frames. */ } };
  page.on('websocket', socket => socket.on('framesent', frame => capture(frame.payload.toString())));
  page.on('request', request => { if (request.url() === origin + '/api/message') capture(request.postData() || ''); });
  await page.goto(origin + '/tasks', { waitUntil: 'domcontentloaded' });
  const hideSidebar = page.getByRole('button', { name: 'Hide sessions sidebar', exact: true });
  if (await hideSidebar.isVisible()) await hideSidebar.click();
  const picker = page.getByRole('combobox', { name: 'Task project', exact: true });
  await picker.waitFor({ timeout: 45000 });
  await picker.selectOption('__create_workspace_project__');
  const modal = page.getByRole('dialog', { name: 'Add Project', exact: true });
  await modal.waitFor();
  assert.equal(await modal.getByRole('textbox').count(), 1);
  const projectFolder = modal.getByRole('textbox', { name: 'Project folder', exact: true });
  await projectFolder.fill(path.join(temporary, 'existing-file'));
  await modal.getByRole('button', { name: 'Add project', exact: true }).click();
  const failure = page.locator('.dashboard-notice.is-error').filter({ hasText: 'existing folder' });
  await failure.waitFor();
  assert.equal(await projectFolder.inputValue(), path.join(temporary, 'existing-file'));
  assert.equal(await readFile(path.join(temporary, 'existing-file'), 'utf8'), 'kept');
  await failure.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await modal.getByRole('button', { name: 'Browse folders…', exact: true }).click();
  const folders = page.getByRole('dialog', { name: 'Select project folder', exact: true });
  const folderPath = folders.getByRole('textbox', { name: 'Folder path', exact: true });
  await folderPath.waitFor();
  await page.waitForFunction(() => !document.querySelector('.folder-picker-path input')?.disabled);
  await folderPath.fill(temporary);
  await folders.getByRole('button', { name: 'Go to folder', exact: true }).click();
  await folders.getByRole('button', { name: 'Open existing-project', exact: true }).click();
  await folders.locator('.folder-picker-selection code').filter({ hasText: existingPath }).waitFor();
  await folders.getByRole('button', { name: 'Select folder', exact: true }).click();
  assert.equal(await projectFolder.inputValue(), existingPath);
  await modal.getByRole('button', { name: 'Add project', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  assert.equal(await picker.inputValue(), existingPath);
  assert.equal(await readFile(path.join(existingPath, 'keep.txt'), 'utf8'), 'kept');
  await picker.selectOption('__create_workspace_project__');
  await projectFolder.fill(existingPath);
  await modal.getByRole('button', { name: 'Add project', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  assert.equal(await picker.inputValue(), existingPath);
  assert.equal(await page.locator('.dashboard-notice.is-info').count(), 0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await picker.waitFor();
  await picker.locator('option').filter({ hasText: 'existing-project' }).waitFor({ state: 'attached' });
  assert.deepEqual(errors, []);
  assert.equal(sent.some(action => /^(startCodexCliSession|sendCodexCliSessionMessage|resumeCodexSessions)$/.test(action)), false, 'Project workflow never starts a turn');
  await mkdir('output/release-200-e2e', { recursive: true });
  await page.screenshot({ path: 'output/release-200-e2e/project-added-mobile.png' });
  console.log(JSON.stringify({ durationMs: Date.now() - started, checks: 'Real folder navigation, file collision error, existing folder adoption, no name field, retry, selection, persisted project after reload', consoleErrors: errors.length, creationRequests: sent.filter(action => action === 'createWorkspaceProject').length }));
} finally {
  await browser.close();
  const db = new DatabaseSync(stateFile);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    for (const registeredPath of [existingPath]) {
      const key = process.platform === 'win32' ? registeredPath.toLowerCase() : registeredPath;
      const row = db.prepare('SELECT value FROM state WHERE namespace = ? AND key = ?').get('workspace-projects', key);
      if (row) {
        assert.equal(JSON.parse(row.value).path, registeredPath);
        db.prepare('DELETE FROM state WHERE namespace = ? AND key = ?').run('workspace-projects', key);
      }
    }
  } finally { db.close(); }
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(temporary));
  assert.ok(relative.startsWith('codex-manager-e2e-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
  await rm(temporary, { recursive: true, force: true });
}
