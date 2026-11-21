import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

// Both host modes use an intercepted in-memory host. No real settings or users change.
const origin = 'http://127.0.0.1:39875';
const snapshotResponse = await fetch(`${origin}/api/state`, { signal: AbortSignal.timeout(15_000) });
if (!snapshotResponse.ok) throw new Error('Local snapshot returned '+snapshotResponse.status);
const original = await snapshotResponse.json();
const output = path.join(tmpdir(), 'codex-manager-settings-hosts');
await mkdir(output, { recursive: true });
const team = { users: [], servers: [], workspaceRoot: 'D:/team', databaseProvider: 'sqlite', postgresConfigured: false, entries: [], requests: [] };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const host of ['browser', 'webview']) for (const [width, height] of [[1440, 900], [390, 844], [844, 390]]) {
    const state = { ...original, accounts: [], connectedPeers: [{ id: 'local-fixture', local: true, connected: true, name: 'This system' }], peerAccounts: {}, office: host === 'browser' ? { id: 'master', role: 'unrestricted-admin', displayName: 'Administrator', features: [] } : undefined, onboardingCompleted: true,
      settings: { ...original.settings, dashboardTheme: 'dark', cliIntegrationEnabled: true, webDashboardEnabled: true, teamWorkspaceEnabled: true, persistentLoggingEnabled: true, dailyTokenUsageEnabled: true, codexAppRestartEnabled: true, encryptedSyncEnabled: true, webSocketServerEnabled: true, apiAccessEnabled: true, autoSwitchEnabled: true, modelCapacityAutoSwitchEnabled: true } };
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 760, serviceWorkers: 'block' });
    const page = await context.newPage(); page.setDefaultTimeout(12_000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await useWorkspaceDashboardAssets(page, origin);
    await page.route('**/api/**', route => {
      const request = route.request();
      if (request.method() !== 'GET') return route.fulfill({ status: 409, json: { error: 'The user changed in another window. Refresh before retrying.' } });
      return route.fulfill({ json: team });
    });
    await page.route('**/assets/browserHost.js*', route => route.fulfill({ contentType: 'text/javascript', body: `(() => {
      document.documentElement.dataset.dashboardHost=${JSON.stringify(host)};
      const state=${JSON.stringify(state)}, team=${JSON.stringify(team)};
      const dispatch=data=>window.dispatchEvent(new MessageEvent('message',{data:structuredClone(data)}));
      window.__settingsActions=[];
      window.__setSettings=patch=>{Object.assign(state.settings,patch);dispatch({type:'dashboard:snapshot',state});};
      window.acquireVsCodeApi=()=>({setState(){},postMessage(message){
        window.__settingsActions.push(message);
        setTimeout(()=>{
          if(message.type==='dashboard:ready'){dispatch({type:'dashboard:snapshot',state});dispatch({type:'dashboard:connection',connected:true});return;}
          if(message.type==='dashboard:setting'){state.settings[message.key]=message.value;dispatch({type:'dashboard:snapshot',state});return;}
          if(message.type!=='dashboard:action')return;
          let payload={},error;
          if(message.action==='listCodexCliSessions')payload={cliSessions:[],cliComposerConfig:{models:[],projects:[],terminalSupported:false}};
          if(message.action==='getMasterUsername')payload={masterUsername:'fixture-admin'};
          if(message.action==='teamSettingsRequest'){
            if(message.payload.teamSettingsRequest.method!=='GET')error='The user changed in another window. Refresh before retrying.';
            else payload={teamSettingsResponse:team};
          }
          dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:error?'failed':'completed',error,payload});
        },10);
      }});
    })();` }));
    await page.goto(origin + '/workspace', { waitUntil: 'domcontentloaded' });
    await page.locator('#settingsOpenButton').waitFor({ state: 'attached' });
    if (host === 'browser') {
      const rail = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
      if (await rail.isVisible()) await rail.click();
      try { await page.locator('#cli-session-sidebar .cli-settings-shortcut').click(); } catch (error) { await page.screenshot({ path: path.join(output, 'sidebar-failure.png') }); console.log(JSON.stringify({ url: page.url(), errors, body: (await page.locator('body').innerText()).slice(0,2500) })); throw error; }
    }
    const brand = page.locator('.hero .brand-copy').first();
    if (await brand.isVisible()) {
      const geometry = await brand.evaluate(element => ({ height: element.getBoundingClientRect().height, button: document.querySelector('.hero-settings .settings-btn').getBoundingClientRect().height }));
      assert.ok(Math.abs(geometry.height - geometry.button) <= 4, `${host}: brand and buttons align ${JSON.stringify(geometry)}`);
    }
    if (host === 'webview') await page.locator('#settingsOpenButton').click();
    const settings = page.locator('.settings-master-modal'); await settings.waitFor();
    const picker = settings.locator('.settings-mobile-picker select');
    const select = async id => { if (await picker.isVisible()) await picker.selectOption(id); else await settings.locator(`#settings-tab-${id}`).click(); };
    const sections = await picker.locator('option').evaluateAll(options => options.map(option => option.value));
    assert.ok(sections.includes('users') && sections.includes('tools'), `${host}: same sections are available`);
    for (const section of sections) {
      await select(section); await settings.locator(`#settings-panel-${section}`).waitFor();
      assert.ok(await settings.locator('.settings-modal-body').evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${host}/${width}/${section}: no horizontal scroll`);
      await page.screenshot({ path: path.join(output, `${host}-${section}-${width}x${height}.png`) });
    }
    const search = settings.getByRole('searchbox', { name: 'Search all settings' });
    assert.equal(await settings.getByRole('searchbox').count(), 1, 'Only one settings search exists');
    assert.equal(await search.getAttribute('placeholder'), 'Search');
    await search.fill('file limit');
    await settings.getByRole('button', { name: /Text file limit/ }).click();
    await settings.locator('#settings-panel-sessions').waitFor();
    await search.fill('retry capacity');
    await settings.getByRole('button', { name: /Capacity retry delay/ }).click();
    await settings.locator('#settings-panel-automation').waitFor();
    const toggleSizes = await settings.locator('.settings-inline-toggle:visible').evaluateAll(elements => elements.map(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
    assert.ok(toggleSizes.every(size => size.width === 38 && size.height === 22), 'Toggles stay compact in both hosts and touch layouts: ' + JSON.stringify(toggleSizes));
    await select('automation');
    const failures = settings.getByRole('slider', { name: 'Consecutive failures', exact: true });
    const retry = settings.getByRole('slider', { name: 'Capacity retry delay', exact: true });
    assert.equal(await failures.getAttribute('min'), '1');
    assert.equal(await failures.getAttribute('max'), '100');
    assert.equal(await retry.getAttribute('max'), '60');
    await failures.focus(); await failures.press('End');
    await page.waitForFunction(() => window.__settingsActions.some(item => item.type === 'dashboard:setting' && item.key === 'modelCapacityFailureCount' && item.value === 100));
    await retry.focus(); await retry.press('Home');
    await page.waitForFunction(() => window.__settingsActions.some(item => item.type === 'dashboard:setting' && item.key === 'standaloneCapacityRetryDelaySeconds' && item.value === 1));
    await failures.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, host+'-capacity-'+width+'x'+height+'.png') });
    await page.evaluate(() => window.__setSettings({ modelCapacityAutoSwitchEnabled: false }));
    await failures.waitFor({ state: 'detached' });
    assert.equal(await retry.count(), 0, 'The main capacity toggle hides both sliders');
    await page.evaluate(() => window.__setSettings({ modelCapacityAutoSwitchEnabled: true }));
    await failures.waitFor();
    await select('users');
    await settings.getByRole('button', { name: 'Add user', exact: true }).click();
    await settings.getByRole('region', { name: 'Add Team user', exact: true }).waitFor();
    await settings.getByRole('textbox', { name: 'Email', exact: true }).fill('alex@example.test');
    await settings.getByRole('textbox', { name: 'Password', exact: true }).fill('fixture-password');
    await settings.getByRole('button', { name: 'Create user', exact: true }).click();
    await settings.getByRole('alert').getByText('The user changed in another window. Refresh before retrying.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 1, 'Errors stay in the one Settings dialog');
    await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.evaluate(() => window.__setSettings({ teamWorkspaceEnabled: false }));
    await settings.locator('#settings-panel-general').waitFor();
    assert.equal(await picker.locator('option[value=users]').count(), 0, 'The main toggle hides dependent tabs in both pickers');
    assert.equal(await settings.locator('#settings-tab-users').count(), 0);
    for (const [section, key] of [['sessions','cliIntegrationEnabled'], ['sync','encryptedSyncEnabled'], ['desktop','codexAppRestartEnabled'], ['usage','dailyTokenUsageEnabled'], ['system-log','persistentLoggingEnabled'], ['connections','webSocketServerEnabled']]) {
      await select(section);
      await page.evaluate(key => window.__setSettings({ [key]: false }), key);
      await settings.locator('#settings-panel-general').waitFor();
      assert.equal(await picker.locator('option[value="'+section+'"]').count(), 0);
      await page.evaluate(key => window.__setSettings({ [key]: true }), key);
    }
    await page.evaluate(() => window.__setSettings({ cliIntegrationEnabled: false }));
    await search.fill('file limit');
    await settings.getByRole('button', { name: /Text file limit/ }).click();
    await settings.locator('#settings-panel-modules').waitFor();
    await page.evaluate(() => window.__setSettings({ cliIntegrationEnabled: true }));
    await select('modules');
    assert.ok(await settings.getByRole('button', { name: 'Enable Team workspace', exact: true }).isVisible(), 'Access keeps the main toggle reachable');
    await page.evaluate(() => window.__setSettings({ teamWorkspaceEnabled: true }));
    await picker.locator('option[value=users]').waitFor({ state: 'attached' });
    await select('users');
    await page.evaluate(() => window.__setSettings({ webDashboardEnabled: false }));
    await settings.locator('#settings-panel-general').waitFor();
    assert.equal(await picker.locator('option[value=users]').count(), 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ host, width, height, sections, gates: true, errorsPreserved: true, runtimeErrors: errors.length }));
    await context.close();
  }
} finally { await browser.close(); }
console.log(`Screenshots: ${output}`);
