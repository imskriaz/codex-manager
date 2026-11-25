import assert from 'node:assert/strict';
import path from 'node:path';

// The responsive harness intercepts the host and blocks API writes.
export async function checkSystemStartupUi(page, { origin, width, output }) {
  await page.goto(origin);
  await page.locator('.cli-workspace').waitFor();
  const rail = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
  if (await rail.isVisible()) await rail.click();
  await page.locator('#cli-session-sidebar .cli-settings-shortcut').click();
  await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor();
  const section = page.locator('.settings-mobile-picker select');
  if (await section.isVisible()) await section.selectOption('connections');
  else await page.locator('#settings-tab-connections').click();
  const boot = page.getByRole('button', { name: 'Start with system', exact: true });
  const active = page.getByRole('button', { name: 'Always Active', exact: true });
  await boot.waitFor();
  assert.equal(await active.getAttribute('aria-pressed'), 'false');
  assert.equal(await boot.isEnabled(), true, 'Boot startup works with Always Active off');
  await boot.click();
  const modal = page.getByRole('dialog', { name: 'Set up Windows boot startup', exact: true });
  await modal.waitFor();
  assert.equal(await boot.getAttribute('aria-pressed'), 'false', 'Opening instructions does not enable startup');
  await modal.getByText('Run as administrator', { exact: true }).waitFor();
  await modal.getByText('Running in VS Code', { exact: true }).waitFor();
  await modal.getByText('Running directly with Node.js', { exact: true }).waitFor();
  for (const command of ['Start-Process powershell -Verb RunAs', "Set-Location 'C:\\path\\to\\codex-manager'", 'npm.cmd ci', 'npm.cmd run compile', 'npm.cmd run standalone:restart']) {
    await modal.getByText(command, { exact: true }).waitFor();
  }
  assert.ok(await modal.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Windows commands fit the setup dialog');
  assert.equal(await page.evaluate(() => window.__uiActions.some(m => m.type === 'dashboard:setting' && m.key === 'alwaysActiveStartWithSystem')), false);
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByText('Windows boot startup setup cancelled.', { exact: true }).waitFor();
  await boot.click();
  const verify = modal.getByRole('button', { name: 'Verify and enable', exact: true });
  await verify.click();
  assert.equal(await boot.getAttribute('aria-pressed'), 'false');
  await page.waitForFunction(() => !!window.__startupRequest);
  const result = async (status, error, id) => page.evaluate(({status,error,id}) => {
    const request = window.__startupRequest;
    window.dispatchEvent(new MessageEvent('message', {data:{type:'dashboard:action-result',action:request.action,requestId:id || request.requestId,status,error}}));
  }, {status,error,id});
  await result('completed', undefined, 'unrelated-result');
  assert.equal(await boot.getAttribute('aria-pressed'), 'false');
  await result('failed', 'Access is denied');
  await modal.getByRole('alert').getByText('Access is denied', { exact: true }).waitFor();
  assert.equal(await boot.getAttribute('aria-pressed'), 'false');
  await page.screenshot({ path: path.join(output, `startup-verification-${width}.png`) });
  assert.ok(await modal.evaluate(element => { const r=element.getBoundingClientRect(); return r.x >= 0 && r.right <= innerWidth + 1; }), 'Setup fits the viewport');
  await page.clock.install();
  await verify.click();
  await page.clock.fastForward(30_001);
  await modal.getByRole('alert').getByText(/outcome is unconfirmed/).waitFor();
  await result('completed');
  assert.equal(await boot.getAttribute('aria-pressed'), 'false', 'Late completion does not fabricate a verified result');
  await verify.click();
  await page.clock.runFor(60);
  await result('completed');
  await modal.waitFor({state:'hidden'});
  assert.equal(await boot.getAttribute('aria-pressed'), 'true', 'Only matching confirmed success enables startup');
  assert.equal(await active.getAttribute('aria-pressed'), 'false', 'Always Active remains independent');
  await page.getByText('Windows boot startup verified and enabled.', {exact:true}).first().waitFor();
}
