import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

const origin = 'http://127.0.0.1:39875';
const output = path.join(tmpdir(), 'codex-manager-account-menu-ui');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
async function checkOverview(scope, label, detailsOnWide = true) {
  const surfaceWidth = await scope.locator('.dashboard-content').evaluate(element => element.clientWidth);
  const details = scope.locator('.overview-account:not(.overview-inline-add-panel)');
  if (detailsOnWide || surfaceWidth <= 760) assert.equal(await details.isVisible(), surfaceWidth > 760, `${label}: account details follow the panel width (${surfaceWidth}px)`);
  assert.ok(await scope.locator('.overview-main').isVisible(), `${label}: chart and quota stay visible`);
}
try {
  for (const width of [1440, 760, 390, 280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage(), errors = [], writes = [];
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await context.route('**/*', route => {
      const request = route.request();
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.fallback();
      const message = request.postDataJSON();
      if (message?.type === 'dashboard:workspace-presence') return route.fulfill({ json: { messages: [] } });
      if (new URL(request.url()).pathname === '/api/message' && (message?.type === 'dashboard:ready' || /^get|^list/.test(message?.action ?? ''))) return route.fallback();
      writes.push(`${request.method()} ${new URL(request.url()).pathname} ${message?.type ?? ''}/${message?.action ?? ''}`);
      return route.abort();
    });
    if (!process.argv.includes('--installed')) await useWorkspaceDashboardAssets(page, origin, context);
    const started = Date.now();
    await page.goto(origin + '/workspace', { waitUntil: 'domcontentloaded' });
    await page.locator('.cli-workspace').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Workspace menu', exact: true }).count(), 0, 'Logo navigates home without opening a menu');
    assert.equal(await page.locator('.cli-rail-brand button').count(), 0);
    const home = page.getByRole('button', { name: 'Dashboard home', exact: true });
    const showSidebar = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
    if (await showSidebar.isVisible()) await showSidebar.click();
    await home.waitFor();
    assert.equal(await home.getAttribute('aria-haspopup'), null);
    const footer = page.locator('.cli-account-footer:not(.is-standalone)');
    const trigger = footer.getByRole('button', { name: 'Account menu', exact: true });
    await trigger.waitFor();
    const loadMs = Date.now() - started;
    assert.equal(await footer.locator('.cli-account-avatar, img').count(), 0, 'Footer has no avatar');
    assert.equal(await trigger.getAttribute('aria-haspopup'), 'menu');
    const geometry = await trigger.evaluate(element => {
      const copy = element.querySelector('.cli-account-footer-copy');
      return { width: element.clientWidth, scroll: element.scrollWidth, copyWidth: copy.clientWidth, copyScroll: copy.scrollWidth };
    });
    assert.ok(geometry.width > 100 && geometry.copyWidth > 60, JSON.stringify(geometry));
    assert.ok(geometry.scroll <= geometry.width + 1 && geometry.copyScroll <= geometry.copyWidth + 1, 'Card fits its rail');
    const start = Date.now();
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Account menu', exact: true });
    await menu.waitFor();
    const menuMs = Date.now() - start;
    for (const name of ['Dashboard', 'Open account center', 'Settings', 'Sign out']) {
      await menu.getByRole('menuitem', { name, exact: true }).waitFor();
    }
    const logout = menu.locator('form');
    assert.equal(await logout.getAttribute('method'), 'post');
    assert.equal(await logout.getAttribute('action'), '/logout');
    const bounds = await menu.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y >= 0 && bounds.y + bounds.height <= 901, JSON.stringify(bounds));
    assert.ok(bounds.height < 48 * await menu.getByRole('menuitem').count() + 20, 'Menu stays compact');
    await menu.getByRole('menuitem', { name: 'Dashboard', exact: true }).focus();
    await page.keyboard.press('End');
    assert.equal(await menu.getByRole('menuitem', { name: 'Sign out', exact: true }).evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    assert.equal(await menu.getByRole('menuitem', { name: 'Open account center', exact: true }).evaluate(element => document.activeElement === element), true);
    await page.screenshot({ path: path.join(output, `menu-${width}.png`) });
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
    await trigger.press('Enter');
    await menu.waitFor();
    await page.mouse.click(width - 4, 4);
    await menu.waitFor({ state: 'hidden' });
    if (await showSidebar.isVisible()) await showSidebar.click();
    await trigger.click();
    await menu.getByRole('menuitem', { name: 'Open account center', exact: true }).click();
    await menu.waitFor({ state: 'hidden' });
    await page.locator('.workspace-dashboard').waitFor();
    const accountCenter = page.locator('.workspace-dashboard');
    await checkOverview(accountCenter, `Account center/${width}`, false);
    await page.screenshot({ path: path.join(output, `account-center-${width}.png`) });
    if (width === 1440) {
      for (const size of [420, 960]) {
        await page.locator('.cli-workspace').evaluate((element, value) => element.style.setProperty('--cli-terminal-width', `${value}px`), size);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await checkOverview(accountCenter, `Account center/${size}px panel`, false);
      }
    }
    await page.getByRole('button', { name: 'Close Dashboard', exact: true }).click();
    if (await showSidebar.isVisible()) await showSidebar.click();
    await trigger.click();
    await menu.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await menu.waitFor({ state: 'hidden' });
    await page.locator('.overlay.open .settings-modal').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.overlay.open .settings-modal').waitFor({ state: 'hidden' });
    if (await showSidebar.isVisible()) await showSidebar.click();
    await trigger.click();
    await menu.getByRole('menuitem', { name: 'Dashboard', exact: true }).click();
    await page.locator('#dashboard-main .overview-shell').waitFor();
    for (const activation of ['click', 'Enter']) {
      await page.goto(origin + '/workspace', { waitUntil: 'domcontentloaded' });
      await page.locator('.cli-workspace').waitFor();
      if (await showSidebar.isVisible()) await showSidebar.click();
      if (activation === 'click') await home.click();
      else await home.press(activation);
      await page.locator('#dashboard-main .overview-shell').waitFor();
      assert.equal(new URL(page.url()).pathname, '/', `Logo opens Dashboard home directly with ${activation}`);
    }
    await checkOverview(page.locator('#dashboard-main'), `Dashboard/${width}`);
    await page.screenshot({ path: path.join(output, `dashboard-${width}.png`) });
    assert.deepEqual(writes, [], 'Smoke check sends no writes');
    assert.deepEqual(errors, [], 'No browser errors');
    results.push({ width, loadMs, menuMs, bounds, consoleErrors: errors.length });
    await context.close();
  }
  await writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ output, results }));
} finally { await browser.close(); }
