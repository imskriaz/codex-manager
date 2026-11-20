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
const marker = '/* Compact workspace tabs; dashboard settings retain their own layout. */';
assert.ok(css.includes(marker), 'Locate shared horizontal tab styles');
const endMarker = '/* End compact workspace tabs. */';
assert.ok(css.includes(endMarker), 'Locate the end of compact tab styles');
const treatmentEnd = css.indexOf(endMarker, css.indexOf(marker)) + endMarker.length;
const baseline = css.slice(0, css.indexOf(marker)) + css.slice(treatmentEnd);
const treatment = css.slice(css.indexOf(marker), treatmentEnd);
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
const dashboard = '<div class="settings-tab-list" role="tablist" aria-orientation="vertical"><button class="settings-tab active" role="tab" aria-selected="true">General</button></div><div class="modal-tabs"><button class="modal-tab active">Account</button></div><div class="maintenance-tabs" role="tablist"><button aria-selected="true">Snapshots</button></div><div class="office-user-tabs"><button class="active">General</button></div>';
const button = (label, active, mode) => `<button type="button" ${mode === 'pressed' ? `aria-pressed="${active}"` : `role="tab" aria-selected="${active}"`} class="${active ? 'is-active' : ''}">${label}</button>`;
const fixture = families.map(([name, parent, tabs, mode], index) => {
  const tab = (label, active, i) => {
    const wrapped = mode === 'wrapped' || mode === 'source' || mode === 'mixed' && i > 0;
    return wrapped ? `<span class="${active && mode !== 'source' ? 'is-active' : ''}">${button(label, active, mode)}<button type="button" aria-label="Close ${label.replace(/<[^>]*>/g, '')}">&#215;</button></span>` : button(label, active, mode);
  };
  return `<section><h2>${name}</h2><div class="${parent}" style="display:block;position:static;width:100%;height:auto;min-height:0;padding:0"><nav data-family="${index}" role="tablist" class="${tabs}" style="position:relative;top:auto;flex:none;width:100%;max-width:100%;margin:0">${tab('Overview', true, 0)}${tab('Agents <small>1</small>', false, 1)}${tab('Activities', false, 2)}${tab('A very long workspace tab title that must remain scrollable', false, 3)}${tab('Disabled', false, 4).replaceAll('type="button"', 'type="button" disabled')}</nav></div></section>`;
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
    await page.addStyleTag({ content: treatment });
    await page.screenshot({ path: path.join(output, `tabs-${theme}-${width}.png`), fullPage: true });
    assert.deepEqual(await unchanged(), dashboardBefore, 'Unrelated controls retain their appearance');
    const styles = await page.locator('[data-family]').evaluateAll(elements => elements.map(element => {
      const button = element.querySelector('button');
      const cell = button.parentElement === element ? button : button.parentElement;
      const style = getComputedStyle(button), item = getComputedStyle(cell), after = getComputedStyle(cell, '::after');
      return { font: style.font, padding: style.padding, align: style.alignItems, minHeight: style.minHeight, height: button.getBoundingClientRect().height, radius: style.borderRadius, background: item.backgroundColor, shadow: item.boxShadow, underline: [after.height, after.backgroundColor, after.left, after.right], color: style.color, overflow: getComputedStyle(element).overflowX };
    }));
    for (let index = 0; index < styles.length; index++) {
      const roomy = [2, 3, 7, 8].includes(index);
      assert.equal(styles[index].radius, '0px');
      assert.equal(styles[index].align, 'center', 'Tab labels remain vertically centered');
      assert.equal(styles[index].minHeight, roomy || width <= 760 ? '32px' : '28px');
      assert.equal(styles[index].padding, roomy ? '5px 10px' : '4px 8px');
      assert.equal(styles[index].shadow, 'none', 'Active tabs avoid a heavy boxed border');
      if ([2, 3].includes(index)) assert.equal(styles[index].background, 'rgba(0, 0, 0, 0)', 'Task selection uses a clean underline');
      assert.equal(styles[index].overflow, 'auto');
    }
    const spacing = await page.locator('[data-family]').evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element);
      return { gap: style.columnGap, padding: style.padding, width: element.clientWidth, scroll: element.scrollWidth };
    }));
    for (const [index, strip] of spacing.entries()) {
      assert.equal(strip.gap, [2, 3, 7, 8].includes(index) ? '4px' : '2px', 'Spacing suits the tab context');
      assert.equal(strip.padding, index === 3 ? '0px 14px' : '0px 2px', 'Tab strips retain an outer inset');
      if (width <= 390) assert.ok(strip.scroll > strip.width, `${families[index][0]}: long tab rows remain horizontally scrollable`);
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
    for (let index = 0; index < inactive.length; index++) {
      const reference = [2, 3, 7, 8].includes(index) ? 2 : 0;
      assert.deepEqual(inactive[index], inactive[reference], `${families[index][0]} inactive tabs match their density group`);
    }
    const reference = page.locator('[data-family="0"]');
    const inactiveClose = reference.getByRole('button', { name: 'Close Agents 1', exact: true });
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
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  for (const width of [1440, 390, 320]) for (const route of ['/tasks', '/api/keys', '/api/explorer', '/api/proxy']) {
    await page.setViewportSize({ width, height: 1000 });
    const started = performance.now();
    await page.goto(origin + route, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tablist', { name: route === '/tasks' ? 'Task views' : 'API views', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, `live-${route.slice(1).replaceAll('/', '-')}-${width}.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    results.push({ route, width, readyMs: Math.round(performance.now() - started) });
    if (route === '/tasks' && await page.locator('.task-board-card').count()) {
      await page.locator('.task-board-card').first().click();
      const tabs = page.getByRole('tablist', { name: 'Task details', exact: true });
      await tabs.waitFor();
      for (const name of ['Overview', 'Agents', 'Activities', 'Files', 'Changes']) {
        const tab = tabs.getByRole('tab', { name: new RegExp(`^${name}(?:\\s|$)`) });
        if (!await tab.count()) continue;
        await tab.click();
        assert.equal(await tab.getAttribute('aria-selected'), 'true');
      }
      await page.screenshot({ path: path.join(output, `live-task-details-${width}.png`) });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
  }
  assert.deepEqual(errors, [], 'Live read-only navigation has no runtime errors');
  console.log(JSON.stringify({ results, screenshots: output }, null, 2));
} finally { await browser.close(); }
