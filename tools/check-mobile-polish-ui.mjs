import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkMobilePolishUi(page, { origin, width, height, output, parentId }) {
  const exact = name => ({ name, exact: true });
  const fits = async (locator, name) => {
    const bounds = await locator.boundingBox();
    assert.ok(bounds && bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1, `${name} stays inside the viewport`);
    return bounds;
  };
  const noOverflow = async name => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name} has no page overflow`);
  await page.goto(origin + '/');
  await page.locator('.hero').waitFor();
  await page.locator('.brand-version').waitFor({ state: 'visible' });
  assert.match(await page.locator('.brand-copy').innerText(), /Codex Manager/);
  if (width <= 760) await page.locator('.hero .brand-logo').waitFor({ state: 'visible' });
  await fits(page.locator('.hero'), 'Dashboard header');
  await noOverflow('Dashboard');
  const fontSamples = await page.evaluate(() => {
    const elements = ['.brand h1', '.brand-version', '.header-title', '.saved-title-text'].map(selector => document.querySelector(selector)).filter(Boolean);
    const before = elements.map(element => parseFloat(getComputedStyle(element).fontSize));
    document.documentElement.style.setProperty('--dashboard-text-scale', '1');
    const base = elements.map(element => parseFloat(getComputedStyle(element).fontSize));
    document.documentElement.style.removeProperty('--dashboard-text-scale');
    return before.map((value, index) => value / base[index]);
  });
  assert.ok(fontSamples.length >= 3 && fontSamples.every(ratio => Math.abs(ratio - 1.1) < 0.01), 'Fixed-pixel typography receives the browser 10% increase');
  const show = page.getByRole('button', exact('Show sessions sidebar'));
  if (await show.isVisible()) await show.click();
  await page.waitForFunction(() => document.querySelector('.cli-session-rail')?.getBoundingClientRect().left >= 0);
  const system = page.getByRole('combobox', exact('System'));
  await fits(system, 'Sidebar system selector');
  assert.ok((await system.boundingBox()).width >= 60, 'System name has usable space beside the brand');
  const account = page.locator('.cli-account-footer-account');
  await account.waitFor({ state: 'visible' });
  assert.ok(await account.locator('strong').isVisible(), 'Sidebar retains account identity on mobile');
  if (await account.locator('em').count()) assert.ok(await account.locator('em').isVisible(), 'Sidebar retains the plan badge on mobile');
  await fits(page.locator('.cli-account-footer'), 'Sidebar account footer');
  await page.screenshot({ path: path.join(output, `mobile-polish-sidebar-${width}.png`), animations: 'disabled' });
  await page.goto(origin + '/workspace/' + parentId);
  const draft = page.getByRole('textbox', exact('Message Codex'));
  await draft.waitFor();
  await draft.fill('');
  const composer = page.locator('.cli-composer.is-empty');
  await composer.waitFor();
  const composerBox = await fits(composer, 'Empty composer');
  const inputBox = await draft.boundingBox(), toolbarBox = await page.locator('.cli-composer-toolbar').boundingBox();
  assert.ok(Math.abs(inputBox.y + inputBox.height / 2 - toolbarBox.y - toolbarBox.height / 2) <= 3, 'Empty message and its controls share one row');
  assert.ok(composerBox.height <= 54, `Empty composer stays one line (${composerBox.height}px)`);
  assert.ok(inputBox.width >= 64, 'Empty composer leaves usable typing space');
  if (width <= 760) {
    const sendBox = await page.getByRole('button', exact('Send message')).boundingBox();
    assert.ok(sendBox.width >= 32 && sendBox.width <= 36 && sendBox.height >= 32 && sendBox.height <= 36, 'Send target stays compact and operable');
    assert.ok(await draft.evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 16), 'Mobile editing avoids automatic focus zoom');
  }
  assert.equal(await page.locator('.cli-turn-change-bar').count(), 0, 'Redundant turn-change footer stays removed');
  await page.getByRole('button', exact('View usage')).waitFor();
  await fits(page.locator('.cli-turn-usage-strip'), 'Turn usage row');
  const meter = page.locator('.cli-context-meter');
  await meter.waitFor();
  assert.equal(await meter.locator('circle').count(), 2, 'Context use has one circular meter');
  await page.screenshot({ path: path.join(output, `mobile-polish-composer-${width}.png`), animations: 'disabled' });
  await draft.fill('Keep this draft while opening settings');
  await page.getByRole('button', exact('Message settings')).click();
  await fits(page.locator('.cli-composer-options'), 'Message settings');
  await page.keyboard.press('Escape');
  assert.equal(await draft.inputValue(), 'Keep this draft while opening settings');
  await page.getByRole('button', exact('View usage')).click();
  await page.getByRole('tab', exact('Env')).waitFor();
  const tabs = page.locator('.cli-context-tabbar');
  await fits(tabs, 'Workspace tabs');
  if (width <= 760) {
    const buttons = await tabs.locator('button:visible').all();
    for (const button of buttons) {
      const box = await button.boundingBox();
      assert.ok(box.height >= 24 && box.height <= 36, 'Workspace tabs use compact accessible controls');
    }
  }
  const hideTools = page.getByRole('button', exact('Hide workspace tools'));
  if (await hideTools.isVisible()) await hideTools.click();
  await page.getByRole('link', exact('Source file')).click();
  await page.locator('.cli-file-editor .cm-content').waitFor();
  assert.equal(await page.getByRole('button', exact('Cut')).count(), 0, 'Files header has no redundant Cut action');
  await fits(page.locator('.cli-file-editor > header'), 'Files header');
  if (width <= 760) for (const button of await page.locator('.cli-file-actions > button:visible').all()) {
    const box = await button.boundingBox();
    assert.ok(box.height >= 24 && box.height <= 36, 'File actions remain compact and operable');
  }
  assert.ok(await page.locator('.cli-file-editor > header').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'File header fits the selected path and actions');
  await noOverflow('Workspace');
  await page.screenshot({ path: path.join(output, `mobile-polish-workspace-${width}.png`), animations: 'disabled' });
  await page.goto(origin + '/tasks');
  await page.locator('.task-board-header').waitFor();
  await fits(page.locator('.task-board-header'), 'Task header');
  await noOverflow('Task board');
  await page.goto(origin + '/');
  await page.locator('.hero').waitFor();
  const settings = page.locator('#settingsOpenButton');
  if (await settings.isVisible()) await settings.click();
  else {
    await page.locator('.dashboard-mobile-actions > summary').click();
    await page.getByRole('menuitem', exact('Settings')).click();
  }
  const modal = page.locator('.settings-modal:has(> .settings-tab-list)');
  await modal.waitFor({ state: 'visible' });
  await fits(modal, 'Settings dialog');
  assert.ok(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Dialog content stays within the compact surface');
  const settingsTabs = modal.getByRole('tablist');
  await fits(settingsTabs, 'Settings tabs');
  await page.screenshot({ path: path.join(output, `mobile-polish-settings-${width}.png`), animations: 'disabled' });
  await page.keyboard.press('Escape');
}
