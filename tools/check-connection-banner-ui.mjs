import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkConnectionBannerUi(page, { origin, parentId, width, output }) {
  const started = performance.now();
  await page.goto(`${origin}/workspace/${parentId}`);
  await page.getByRole('textbox', { name: 'Message Codex', exact: true }).waitFor();
  for (const stage of ['unreachable', 'offline']) {
    await page.evaluate(stage => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'dashboard:host-status', stage }
    })), stage);
    const banner = page.locator('.dashboard-connection-banner');
    await banner.waitFor();
    assert.equal(await banner.locator(".dashboard-connection-indicator").count(), 0);
    const box = await banner.boundingBox();
    assert.ok(box.width <= 300, `Connection warning uses content width: ${box.width}px`);
    assert.ok(box.x >= 0 && box.x + box.width <= width, 'Connection warning fits the viewport');
    assert.equal(await banner.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await banner.getByRole('button', { name: 'Reload', exact: true }).isEnabled(), true);
    await page.screenshot({ path: path.join(output, `connection-${stage}-${width}.png`) });
  }
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'dashboard:host-status', stage: 'live' }
  })));
  await page.locator('.dashboard-connection-banner').waitFor({ state: 'hidden' });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'dashboard:host-reload', phase: 'reloading', startedAt: Date.now() }
  })));
  const reload = page.locator('.dashboard-connection-banner');
  await reload.getByText('Reloading…', { exact: true }).waitFor();
  assert.equal(await reload.locator('.dashboard-connection-indicator').count(), 0);
  assert.equal(await reload.getByLabel('Reload in progress').count(), 1);
  assert.ok((await reload.boundingBox()).width <= 300, 'Reload progress also uses content width');
  await page.screenshot({ path: path.join(output, `connection-reloading-${width}.png`) });
  console.log(JSON.stringify({ width, connectionCheckMs: Math.round(performance.now() - started) }));
}
