import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

// Public responses are fixtures; no real links or tasks are created.
const origin = 'http://127.0.0.1:39875';
const output = path.join(tmpdir(), 'codex-manager-public-board');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await useWorkspaceDashboardAssets(page, origin);
    await page.addInitScript(() => { window.EventSource = undefined; });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let config = { view: 'board', columns: ['idea'], showArchive: false, stageFilter: 'all' };
    await page.route('**/projects/share/ui-check', route => route.fulfill({ contentType: 'text/html', body: '<html><head><meta charset="utf-8"><link rel="stylesheet" href="/assets/shared.css"><link rel="stylesheet" href="/assets/dashboard.css"></head><body><main id="project-share" class="public-project"></main><script type="module" src="/assets/dashboard.js"></script><script type="module" src="/assets/projectShare.js"></script></body></html>' }));
    await page.route('**/assets/projectShare.js*', route => route.fulfill({ contentType: 'text/javascript', path: path.resolve('media/webview/projectShare.js') }));
    await page.route('**/api/projects/share/ui-check', route => route.fulfill({ json: { title: 'Example project', permissions: [], expiresAt: 0, tasks: [{ id: 'idea', title: 'Public idea', stage: 'idea' }, { id: 'archived', title: 'Archived idea', stage: 'idea', archived: true }], boardConfig: config } }));
    await page.goto(`${origin}/projects/share/ui-check`);
    await page.getByText('Public idea', { exact: true }).waitFor();
    assert.equal(await page.title(), 'Example project · Codex Manager');
    assert.equal(await page.locator('.task-board-shared-heading').innerText(), 'Example project');
    assert.equal(await page.getByLabel('Task project', { exact: true }).count(), 0);
    assert.equal(await page.locator('.task-board-column').count(), 1);
    assert.equal(await page.getByText('Archived idea', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('tab', { name: 'List', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Board actions', exact: true }).click();
    assert.equal(await page.getByRole('menuitemcheckbox').count(), 0);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(output, `shared-board-${width}.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    config = { ...config, view: 'list', showArchive: true };
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('tab', { name: 'List', exact: true, selected: true }).waitFor();
    await page.locator('.task-list-view').waitFor();
    await page.getByText('Archived idea', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(`${width}px: public title, fixed display, live reshare and console passed`);
    await page.close();
  }
  console.log(`Screenshots: ${output}`);
} finally { await browser.close(); }
