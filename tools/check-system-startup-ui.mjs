import assert from 'node:assert/strict';
import path from 'node:path';

// The responsive harness intercepts the host and blocks API writes.
export async function checkSystemStartupUi(page, { origin, width, output }) {
  const consoleErrors = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  // Settings loads email preferences even while their section is hidden.
  await page.route('**/api/email/*', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { preferences: { address: '', enabled: false, ready: false, needsAnswer: false, failed: false, includeResult: false }, watches: [], available: false } })
    : route.abort());
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
  const modal = page.getByRole('dialog', { name: 'Set up system startup', exact: true });
  await modal.waitFor();
  assert.equal(await boot.getAttribute('aria-pressed'), 'false', 'Opening instructions does not enable startup');
  const replyCheck = async (check, error, id) => page.evaluate(({check,error,id}) => {
    const request = window.__startupCheckRequest;
    window.dispatchEvent(new MessageEvent('message', {data:{type:'dashboard:action-result',action:'checkSystemStartup',requestId:id || request.requestId,status:error ? 'failed' : 'completed',error,payload:check ? {systemStartupCheck:check} : undefined}}));
  }, {check,error,id});
  const check = {ready:true,platform:'win32',host:'vscode',checks:[
    {label:'Operating system',status:'passed',detail:'Windows'},
    {label:'Manager host',status:'passed',detail:'VS Code extension'},
    {label:'Node.js runtime',status:'passed',detail:'Compatible runtime: C:/node/node.exe'},
    {label:'Windows account',status:'warning',detail:'Not elevated: startup may be limited to sign-in.',instruction:'For startup before sign-in, reopen VS Code using Run as administrator.'}
  ]};
  await modal.getByText('Checking this system before showing setup instructions...', {exact:true}).waitFor();
  assert.equal(await modal.getByText('Next steps for this system', {exact:true}).count(), 0, 'Instructions wait for actual check results');
  assert.equal(await modal.getByRole('button', {name:'Verify and enable',exact:true}).count(), 0);
  await replyCheck(check, undefined, 'unrelated-check');
  assert.equal(await modal.getByText('Windows', {exact:true}).count(), 0);
  await replyCheck(check);
  await modal.getByText('VS Code extension', {exact:true}).waitFor();
  await modal.getByText(check.checks[3].instruction, {exact:true}).waitFor();
  assert.equal(await modal.getByText(/macOS|npm.cmd/).count(), 0, 'Only relevant instructions appear');
  await page.screenshot({ path: path.join(output, `startup-detected-${width}.png`) });
  await modal.getByRole('button', {name:'Check again',exact:true}).click();
  await replyCheck({...check,ready:false,checks:[{label:'Node.js runtime',status:'blocked',detail:'Runtime missing',instruction:'Install Node.js 22.13 or newer.'}]});
  await modal.getByText('Install Node.js 22.13 or newer.', {exact:true}).waitFor();
  assert.equal(await modal.getByRole('button', {name:'Verify and enable',exact:true}).count(), 0);
  await modal.getByRole('button', {name:'Check again',exact:true}).click();
  await replyCheck(undefined, 'Permission probe failed');
  await modal.getByRole('alert').getByText('Permission probe failed', {exact:true}).waitFor();
  await modal.getByRole('button', {name:'Check again',exact:true}).click();
  await replyCheck({...check,platform:'darwin',host:'node',checks:[{label:'Operating system',status:'passed',detail:'macOS'},{label:'Manager host',status:'passed',detail:'Standalone Node.js'}]});
  await modal.getByText('Standalone Node.js', {exact:true}).waitFor();
  assert.equal(await modal.getByText('Next steps for this system', {exact:true}).count(), 0, 'Passed prerequisites need no repair instructions');
  await modal.getByRole('button', {name:'Cancel',exact:true}).click();
  await page.getByText('System startup setup cancelled.', {exact:true}).waitFor();
  await boot.click();
  await page.clock.install();
  await page.clock.fastForward(12_001);
  await modal.getByRole('alert').getByText(/System check timed out/).waitFor();
  await replyCheck(check);
  assert.equal(await modal.getByRole('button', {name:'Verify and enable',exact:true}).count(), 0, 'Late preflight cannot enable verification');
  await modal.getByRole('button', {name:'Check again',exact:true}).click();
  await replyCheck(check);
  const verify = modal.getByRole('button', { name: 'Verify and enable', exact: true });
  await verify.click();
  await modal.getByText('Registering and verifying system startup...', {exact:true}).waitFor();
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
  await modal.getByRole('button', {name:'Check again',exact:true}).click();
  await replyCheck(check);
  await verify.click();
  await page.clock.fastForward(30_001);
  await modal.getByRole('alert').getByText(/outcome is unconfirmed/).waitFor();
  await result('completed');
  assert.equal(await boot.getAttribute('aria-pressed'), 'false', 'Late completion does not fabricate a verified result');
  await modal.getByRole('button', {name:'Check again',exact:true}).click();
  await replyCheck(check);
  await verify.click();
  await page.clock.runFor(60);
  await result('completed');
  await modal.getByRole('status').getByText('Startup registration passed verification. Start with system is now enabled.', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, `startup-passed-${width}.png`) });
  await modal.getByRole('button', { name: 'Done', exact: true }).click();
  await modal.waitFor({state:'hidden'});
  assert.equal(await boot.getAttribute('aria-pressed'), 'true', 'Only matching confirmed success enables startup');
  assert.equal(await active.getAttribute('aria-pressed'), 'false', 'Always Active remains independent');
  await page.getByText('System startup registration verified and enabled.', {exact:true}).first().waitFor();
  assert.deepEqual(consoleErrors, [], 'Startup instructions have no browser console errors');
}
