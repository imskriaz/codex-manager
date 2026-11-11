import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';

// Explicit end-to-end check: only disposable folders and their exact registry row are removed.
const origin = 'http://127.0.0.1:39875';
assert.ok(process.env.CODEX_MANAGER_E2E_STATE_FILE, 'Set the local host state database for exact test-row cleanup');
const stateFile = path.resolve(process.env.CODEX_MANAGER_E2E_STATE_FILE);
const temporary = await mkdtemp(path.join(tmpdir(), 'codex-manager-e2e-'));
const projectPath = path.join(temporary, 'created-project');
await mkdir(path.join(temporary, 'existing-project'));
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
  const modal = page.getByRole('dialog', { name: 'Create new project', exact: true });
  await modal.getByRole('textbox', { name: 'Project name', exact: true }).fill('existing-project');
  await modal.getByRole('button', { name: 'Browse folders…', exact: true }).click();
  const folders = page.getByRole('dialog', { name: 'Select parent folder', exact: true });
  const folderPath = folders.getByRole('textbox', { name: 'Folder path', exact: true });
  await folderPath.waitFor();
  await page.waitForFunction(() => !document.querySelector('.folder-picker-path input')?.disabled);
  await folderPath.fill(temporary);
  await folders.getByRole('button', { name: 'Go to folder', exact: true }).click();
  await folders.getByRole('button', { name: 'Open existing-project', exact: true }).waitFor();
  await folders.getByRole('button', { name: 'Select folder', exact: true }).click();
  assert.equal(await modal.getByRole('textbox', { name: 'Parent folder', exact: true }).inputValue(), temporary);
  await modal.getByRole('button', { name: 'Create project', exact: true }).click();
  const failure = page.locator('.dashboard-notice.is-error').filter({ hasText: 'already exists' });
  await failure.waitFor();
  assert.equal(await failure.isVisible(), true, 'Duplicate name failure uses visible mobile toast');
  assert.equal(await modal.getByRole('textbox', { name: 'Project name', exact: true }).inputValue(), 'existing-project');
  await failure.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
  await modal.getByRole('textbox', { name: 'Project name', exact: true }).fill('created-project');
  await modal.getByRole('button', { name: 'Create project', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  assert.equal(await picker.inputValue(), projectPath);
  assert.equal((await stat(projectPath)).isDirectory(), true);
  assert.equal(await page.locator('.dashboard-notice.is-info').count(), 0);
  assert.equal(await page.getByText('Created created-project.', { exact: true }).count(), 0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await picker.waitFor();
  await picker.locator('option').filter({ hasText: 'created-project' }).waitFor({ state: 'attached' });
  assert.deepEqual(errors, []);
  assert.equal(sent.some(action => /^(startCodexCliSession|sendCodexCliSessionMessage|resumeCodexSessions)$/.test(action)), false, 'Project workflow never starts a turn');
  await mkdir('output/release-179-e2e', { recursive: true });
  await page.screenshot({ path: 'output/release-179-e2e/project-created-mobile.png' });
  console.log(JSON.stringify({ durationMs: Date.now() - started, checks: 'Real folder navigation, duplicate-name error toast, silent creation, selection, persisted project after reload', consoleErrors: errors.length, creationRequests: sent.filter(action => action === 'createWorkspaceProject').length }));
} finally {
  await browser.close();
  const db = new DatabaseSync(stateFile);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const key = process.platform === 'win32' ? projectPath.toLowerCase() : projectPath;
    const row = db.prepare('SELECT value FROM state WHERE namespace = ? AND key = ?').get('workspace-projects', key);
    if (row) {
      assert.equal(JSON.parse(row.value).path, projectPath);
      db.prepare('DELETE FROM state WHERE namespace = ? AND key = ?').run('workspace-projects', key);
    }
  } finally { db.close(); }
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(temporary));
  assert.ok(relative.startsWith('codex-manager-e2e-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
  await rm(temporary, { recursive: true, force: true });
}
