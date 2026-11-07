import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkImagesUi(page, { origin, parentId, width, height, output }) {
  await page.goto(`${origin}/workspace/${parentId}`);
  const trigger = page.getByRole('button', { name: 'Preview Attachment preview', exact: true });
  const box = page.locator('.cli-image-lightbox');
  const stage = box.locator('.cli-image-stage');
  const image = box.locator('img');
  const original = box.getByRole('link', { name: 'Download image', exact: true });
  const close = box.getByRole('button', { name: 'Close image preview', exact: true });
  await trigger.click(); await image.evaluate(img => img.decode());
  assert.equal(await original.innerText(), '', 'Download is an accessible icon');
  assert.equal(await original.locator('svg').count(), 1);
  assert.ok(await original.getAttribute('download'));
  assert.equal(await box.locator('button,a').count(), 2, 'Only download and close remain');
  assert.equal(await box.locator('strong,small').count(), 0, 'No title or counter consumes image space');
  const first = await original.getAttribute('href');
  await image.click(); assert.equal(await box.isVisible(), true);
  const beforeZoom = await image.boundingBox(), toolbar = await box.locator('.cli-image-lightbox-toolbar').boundingBox();
  const region = await stage.boundingBox();
  assert.ok(region.width >= width - 1 && region.height >= height - 1, 'The image stage fills the viewport');
  assert.ok(toolbar.width < 110 && toolbar.height < 55, 'Two compact icons float above the image');
  const pageScale = await page.evaluate(() => ({ width: innerWidth, scale: visualViewport.scale }));
  if (width >= 1000) { await stage.hover(); await page.mouse.wheel(0, -350); }
  else await stage.evaluate(element => {
    const dispatch = (type, points) => element.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: points.map(([clientX, clientY], identifier) => new Touch({ identifier, target: element, clientX, clientY })) }));
    dispatch('touchstart', [[80, 200], [180, 200]]); dispatch('touchmove', [[30, 200], [230, 200]]); dispatch('touchend', []);
  });
  await page.waitForFunction(() => document.querySelector('.cli-image-stage').classList.contains('is-zoomed'));
  const zoom = await image.boundingBox();
  assert.ok(zoom.width >= beforeZoom.width * 1.9, 'Wheel or pinch enlarges the image');
  assert.deepEqual(await box.locator('.cli-image-lightbox-toolbar').boundingBox(), toolbar, 'Zoom leaves controls fixed');
  assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, scale: visualViewport.scale })), pageScale);
  if (width >= 1000) {
    const start = { x: region.width / 2, y: region.height / 2 };
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 75, start.y + 45, { steps: 5 }); await page.mouse.up();
    const panned = await image.boundingBox(); assert.ok(Math.abs(panned.x - zoom.x - 75) < 2 && Math.abs(panned.y - zoom.y - 45) < 2); assert.equal(await box.isVisible(), true);
    await page.mouse.wheel(0, 5000); await page.waitForFunction(() => !document.querySelector('.cli-image-stage').classList.contains('is-zoomed'));
    const fitted = await image.boundingBox(); assert.ok(Math.abs(fitted.width - beforeZoom.width) < 2 && Math.abs(fitted.x - beforeZoom.x) < 2);
  }
  await original.focus();
  await page.keyboard.press('ArrowRight');
  const second = await original.getAttribute('href'); assert.notEqual(second, first);
  await page.keyboard.press('ArrowRight');
  const third = await original.getAttribute('href'); assert.notEqual(third, second); assert.notEqual(third, first);
  await page.keyboard.press('ArrowRight'); assert.equal(await original.getAttribute('href'), first);
  await page.keyboard.press('ArrowLeft'); assert.equal(await original.getAttribute('href'), third);
  await page.screenshot({ path: path.join(output, `images-${width}x${height}.png`), animations: 'disabled' });
  await close.click(); await box.waitFor({ state: 'detached' }); await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Preview Attachment preview');
  await trigger.click(); await image.evaluate(img => img.dispatchEvent(new Event('error'))); await box.getByRole('alert').waitFor(); assert.equal(await original.getAttribute('href'), first);
  await page.keyboard.press('Escape'); await box.waitFor({ state: 'detached' });
  await page.locator('.cli-message-markdown img').first().press('Enter'); await box.waitFor(); await page.keyboard.press('Escape'); await box.waitFor({ state: 'detached' });
  await page.getByRole('link', { name: 'Image file', exact: true }).press('Enter'); await page.getByRole('button', { name: 'Preview preview.png', exact: true }).click(); await close.click(); await box.waitFor({ state: 'detached' });
  const closeTools = page.getByRole('complementary', { name: 'Workspace tools', exact: true }).getByRole('button', { name: 'Close workspace tools', exact: true });
  if (await closeTools.isVisible()) await closeTools.click();
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 960; const context = canvas.getContext('2d'); context.fillStyle = 'steelblue'; context.fillRect(0, 0, 640, 960); return canvas.toDataURL('image/png').split(',')[1]; });
  await page.locator('input[aria-label="Choose attachments"]').setInputFiles([{ name: 'composer.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep the attachment') }]);
  const thumbnail = page.getByRole('button', { name: 'Preview composer.png', exact: true }); await thumbnail.waitFor(); const thumbSize = await thumbnail.locator('img').boundingBox(); assert.ok(thumbSize.width >= 30 && thumbSize.height >= 30, 'Composer has a visible thumbnail');
  await thumbnail.press('Enter'); await image.evaluate(img => img.decode()); assert.equal(await image.getAttribute('alt'), 'composer.png');
  const download = page.waitForEvent('download'); await original.click(); assert.ok((await download).suggestedFilename().startsWith('codex-image-'));
  await page.screenshot({ path: path.join(output, `composer-image-${width}x${height}.png`), animations: 'disabled' });
  await page.keyboard.press('Escape'); await box.waitFor({ state: 'detached' }); await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Preview composer.png');
  await page.getByRole('button', { name: 'Remove composer.png', exact: true }).click(); await thumbnail.waitFor({ state: 'detached' }); await page.getByRole('button', { name: 'Remove notes.txt', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__uiActions.filter(item => /sendCodex|startCodex/.test(item.action)).length), 0, 'Preview, download and removal never submit the composer');
}
