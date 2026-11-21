import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkMessageSettingsUi(page, width, height, output) {
  const started = Date.now();
  await page.getByRole('textbox', { name: 'Message Codex', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Message settings', exact: true }).click();
  const panel = page.locator('.cli-composer-options');
  await panel.waitFor();
  const approval = panel.getByRole('checkbox', { name: 'Auto approve', exact: true });
  assert.equal(await approval.isChecked(), true, 'Sessions without an approval preference default to On');
  await approval.click();
  await page.waitForFunction(() => !document.querySelector('.cli-approval-control input')?.checked);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Message settings', exact: true }).click();
  assert.equal(await approval.isChecked(), false, 'Explicit Off survives reopening settings');
  const openMs = Date.now() - started;
  assert.equal(await page.locator('.cli-usage-banner').count(), 0);
  const layout = await panel.evaluate(element => {
    const body = getComputedStyle(document.body), controls = [...element.querySelectorAll('select, label > span:first-child')];
    return {
      columns: getComputedStyle(element.querySelector('.cli-options-grid')).gridTemplateColumns.split(' ').length,
      fits: element.scrollWidth <= element.clientWidth,
      fonts: { body: [body.fontFamily, body.fontSize], controls: controls.map(control => { const style = getComputedStyle(control); return [control.getAttribute('aria-label') || control.textContent, style.fontFamily, style.fontSize]; }) },
      fontsMatch: controls.every(control => { const style = getComputedStyle(control); return style.fontFamily === body.fontFamily && style.fontSize === body.fontSize; })
    };
  });
  assert.equal(layout.columns, 2);
  assert.equal(layout.fits, true);
  assert.equal(layout.fontsMatch, true, `Settings match the dashboard body font and size: ${JSON.stringify(layout.fonts)}`);
  const bounds = await panel.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1);
  assert.ok(bounds.height <= 360, 'Automation settings retain a compact height');
  const resume = panel.getByRole('checkbox', { name: 'Auto resume session', exact: true });
  const queue = panel.getByRole('combobox', { name: 'Session queue', exact: true });
  await queue.selectOption('2');
  await page.waitForFunction(() => document.querySelector('[aria-label="Session queue"]')?.value === '2');
  assert.equal(await resume.isChecked(), false);
  await resume.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Session queue"]')?.value === 'off');
  assert.equal(await resume.isChecked(), true);
  await page.screenshot({ path: path.join(output, `message-settings-${width}x${height}.png`) });
  await page.evaluate(() => { window.__failQueue = true; });
  await queue.selectOption('1');
  await page.getByText('The session queue is full. Remove an entry before adding another.', { exact: false }).first().waitFor();
  assert.equal(await queue.inputValue(), 'off', 'Failed queue changes preserve the confirmed state');
  await page.evaluate(() => { window.__failQueue = false; window.__failResume = true; });
  await resume.click();
  await page.getByText('Session preference storage is unavailable. The change was not saved.', { exact: false }).first().waitFor();
  assert.equal(await resume.isChecked(), true);
  await page.evaluate(() => { window.__failResume = false; });
  await page.keyboard.press('Escape');
  assert.equal(await panel.count(), 0);
  const sidebar = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('button', { name: 'Message settings', exact: true }).click();
  assert.equal(await approval.isChecked(), true, 'Fresh chat defaults to Auto approve On');
  await approval.click();
  assert.equal(await approval.isChecked(), false, 'New chat allows an explicit Off draft');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Message settings', exact: true }).click();
  assert.equal(await approval.isChecked(), false, 'Explicit Off draft survives reopening');
  await page.keyboard.press('Escape');
  console.log(JSON.stringify({ width, height, openMs, checkMs: Date.now() - started, columns: layout.columns, fontsMatch: layout.fontsMatch, panelHeight: bounds.height }));
}
