import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

const origin = 'http://127.0.0.1:39875';
const output = path.join(tmpdir(), 'codex-manager-workspace-tabs-ui');
await mkdir(output, { recursive: true });
const css = await readFile('media/webview/quotaSummary.css', 'utf8');
const marker = '/* Reuse the compact Git tab strip throughout workspaces;';
const baseline = css.slice(0, css.indexOf(marker));
assert.ok(baseline.length > 0, 'Locate the tab treatment separately from dashboard styles');
const families = [
  ['Session tools', 'cli-workspace', 'cli-context-tab-scroll', 'wrapped'],
  ['Session agents', 'cli-workspace', 'cli-agent-tabs', 'mixed'],
  ['Task views', 'task-board-section task-board-header', 'task-view-tabs'],
  ['Task details', 'task-detail-panel', 'task-detail-tabs'],
  ['Task agents', 'task-detail-panel cli-workspace', 'cli-agent-tabs', 'mixed'],
  ['Git views', 'workspace-git', 'workspace-tool-tabs'],
  ['GitHub sections and details', 'workspace-github', 'workspace-tool-tabs'],
  ['API views', 'api-workspace-screen', 'api-token-tabs', 'wrapped'],
  ['Proxy clients', 'api-proxy-connection', 'api-token-tabs', 'wrapped'],
  ['Inspector panels', 'workspace-browser', 'workspace-browser-inspector-tabs'],
  ['Inspector styles and request details', 'workspace-browser-inspector', 'workspace-browser-pane-tabs'],
  ['Inspector sources', 'workspace-browser-inspector', 'workspace-browser-source-tabs', 'source'],
  ['Inspector network types', 'workspace-browser-inspector', 'workspace-browser-network-types', 'pressed']
];
const dashboard = '<div class="settings-tab-list"><button class="settings-tab active" role="tab" aria-selected="true">General</button></div><div class="modal-tabs"><button class="modal-tab active">Account</button></div><div class="maintenance-tabs"><button aria-selected="true">Snapshots</button></div>';
const button = (label, active, mode) => `<button type="button" ${mode === 'pressed' ? `aria-pressed="${active}"` : `role="tab" aria-selected="${active}"`} class="${active ? 'is-active' : ''}">${label}</button>`;
const fixture = families.map(([name, parent, tabs, mode], index) => {
  const tab = (label, active, i) => {
    const wrapped = mode === 'wrapped' || mode === 'source' || mode === 'mixed' && i > 0;
    return wrapped ? `<span class="${active && mode !== 'source' ? 'is-active' : ''}">${button(label, active, mode)}<button type="button" aria-label="Close ${label}">&#215;</button></span>` : button(label, active, mode);
  };
  return `<section><h2>${name}</h2><div class="${parent}" style="display:block;position:static;width:100%;height:auto;min-height:0;padding:0"><nav data-family="${index}" class="${tabs}" style="position:relative;top:auto;flex:none;width:100%;max-width:100%;margin:0">${tab('Git', true, 0)}${tab('History', false, 1)}${tab('A very long workspace tab title that must remain scrollable', false, 2)}${tab('Disabled', false, 3).replaceAll('type="button"', 'type="button" disabled')}</nav></div></section>`;
}).join('');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const theme of ['dark', 'light']) for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width <= 760, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(origin + '/__workspace-tabs-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="fixtures">${fixture}</main><aside id="dashboard">${dashboard}</aside></body></html>` }));
    await page.goto(origin + '/__workspace-tabs-fixture');
    await page.addStyleTag({ content: await readFile('media/webview/shared.css', 'utf8') });
    await page.addStyleTag({ content: baseline });
    await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}body{height:auto;overflow:auto;padding:12px}#fixtures{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:18px}section{min-width:0}h2{font:12px Arial;margin:10px 0}#dashboard{margin-top:24px}' });
    const unchanged = async () => page.locator('#dashboard button').evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element);
      return [style.borderRadius, style.backgroundColor, style.color, style.fontSize, style.padding, style.minHeight, style.boxShadow];
    }));
    const dashboardBefore = await unchanged();
    await page.addStyleTag({ content: css.slice(css.indexOf(marker)) });
    assert.deepEqual(await unchanged(), dashboardBefore, 'Dashboard and its settings/account/maintenance tabs retain their appearance');
    const styles = await page.locator('[data-family]').evaluateAll(elements => elements.map(element => {
      const button = element.querySelector('button');
      const cell = button.parentElement === element ? button : button.parentElement;
      const style = getComputedStyle(button), item = getComputedStyle(cell), after = getComputedStyle(cell, '::after');
      return { font: style.font, padding: style.padding, align: style.alignItems, minHeight: style.minHeight, height: button.getBoundingClientRect().height, radius: style.borderRadius, background: item.backgroundColor, shadow: item.boxShadow, underline: [after.height, after.backgroundColor, after.left, after.right], color: style.color, overflow: getComputedStyle(element).overflowX };
    }));
    for (let index = 0; index < styles.length; index++) {
      assert.deepEqual(styles[index], styles[0], `${families[index][0]} matches the reference Git tab (${width}px, ${theme})`);
      assert.equal(styles[index].radius, '0px');
      assert.equal(styles[index].align, 'center', 'Tab labels remain vertically centered');
      assert.equal(styles[index].minHeight, '28px');
      assert.equal(styles[index].overflow, 'auto');
    }
    const centers = await page.locator('[data-family]').evaluateAll(elements => elements.map(element => {
      const button = element.querySelector('button'), range = document.createRange();
      range.selectNodeContents(button);
      const text = range.getBoundingClientRect(), bounds = button.getBoundingClientRect();
      return Math.abs(text.y + text.height / 2 - bounds.y - bounds.height / 2);
    }));
    centers.forEach((difference, index) => assert.ok(difference <= 1, `${families[index][0]} text is centered within one pixel: ${difference}`));
    const inactive = await page.locator('[data-family]').evaluateAll(elements => elements.map(element => {
      const button = element.querySelector('button[aria-selected="false"],button[aria-pressed="false"]');
      const cell = button.parentElement === element ? button : button.parentElement;
      const style = getComputedStyle(button), item = getComputedStyle(cell);
      return [style.font, style.color, style.padding, style.minHeight, style.borderRadius, item.backgroundColor, item.boxShadow];
    }));
    for (let index = 0; index < inactive.length; index++) assert.deepEqual(inactive[index], inactive[0], `${families[index][0]} inactive tabs match the reference`);
    const reference = page.locator('[data-family="0"]');
    const inactiveClose = reference.getByRole('button', { name: 'Close History', exact: true });
    await inactiveClose.focus();
    assert.equal(await inactiveClose.evaluate(element => getComputedStyle(element).opacity), width <= 760 ? '1' : '0.8', 'Keyboard focus exposes tab close controls');
    assert.equal(await inactiveClose.evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
    await reference.locator('span').first().evaluate(element => element.dataset.aiBrowserTab = 'true');
    assert.equal(await reference.locator('span').first().evaluate(element => getComputedStyle(element).borderTopColor), 'rgb(167, 139, 250)', 'AI-opened tabs retain their purple marker');
    await reference.locator('span').first().evaluate(element => delete element.dataset.aiBrowserTab);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Overflow remains inside tab strips');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, `tabs-${theme}-${width}.png`), fullPage: true });
    results.push({ theme, width, families: families.length, status: 'passed' });
    await context.close();
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await useWorkspaceDashboardAssets(page, origin);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const route of ['/tasks', '/api/keys', '/api/explorer', '/api/proxy']) {
    const started = performance.now();
    await page.goto(origin + route, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tablist', { name: route === '/tasks' ? 'Task views' : 'API views', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, `live-${route.slice(1).replaceAll('/', '-')}.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    results.push({ route, readyMs: Math.round(performance.now() - started) });
  }
  assert.deepEqual(errors, [], 'Live read-only navigation has no runtime errors');
  console.log(JSON.stringify({ results, screenshots: output }, null, 2));
} finally { await browser.close(); }
