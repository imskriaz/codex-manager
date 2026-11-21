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
const team = { users: [], servers: [], workspaceRoot: 'D:/team', databaseProvider: 'sqlite', postgresConfigured: false, entries: [{id:'audit-fixture',at:Date.now(),actor:{id:'master',name:'Master'},action:'Fixture action',status:'completed',sessionId:'fixture-session'}], requests: [{id:'proxy-fixture',startedAt:Date.now(),method:'POST',path:'/v1/responses',status:'completed',apiKeyName:'Fixture key',inputTokens:12,outputTokens:4}] };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const host of ['browser', 'webview']) for (const [width, height] of [[1440, 900], [390, 844], [844, 390]]) {
    const state = { ...original, accounts: [], connectedPeers: [{ id: 'local-fixture', local: true, connected: true, name: 'This system' }], peerAccounts: {}, office: host === 'browser' ? { id: 'master', role: 'unrestricted-admin', displayName: 'Administrator', features: [] } : undefined, onboardingCompleted: true,
      settings: { ...original.settings, dashboardTheme: 'dark', cliIntegrationEnabled: true, webDashboardEnabled: true, teamWorkspaceEnabled: true, persistentLoggingEnabled: true, dailyTokenUsageEnabled: true, codexAppRestartEnabled: true, encryptedSyncEnabled: true, webSocketServerEnabled: true, apiAccessEnabled: true, autoSwitchEnabled: true, modelCapacityAutoSwitchEnabled: true } };
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 760, serviceWorkers: 'block' });
    const page = await context.newPage(); page.setDefaultTimeout(12_000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await useWorkspaceDashboardAssets(page, origin);
    let activityFailure = false;
    await page.route('**/api/**', route => {
      const request = route.request();
      if (activityFailure && request.url().endsWith('/api/office/logs')) return route.fulfill({ status: 503, json: { error: 'Activity storage is temporarily unavailable.' } });
      if (request.method() !== 'GET') return route.fulfill({ status: 409, json: { error: 'The user changed in another window. Refresh before retrying.' } });
      return route.fulfill({ json: team });
    });
    await page.route('**/assets/browserHost.js*', route => route.fulfill({ contentType: 'text/javascript', body: `(() => {
      document.documentElement.dataset.dashboardHost=${JSON.stringify(host)};
      const state=${JSON.stringify(state)}, team=${JSON.stringify(team)};
      const dispatch=data=>window.dispatchEvent(new MessageEvent('message',{data:structuredClone(data)}));
      window.__settingsActions=[];
      window.__setPeerConnected=connected=>{state.connectedPeers[0].connected=connected;dispatch({type:'dashboard:snapshot',state});};
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
          if(message.action==='viewLogs')payload={logDownload:{text:JSON.stringify({records:[{timestamp:new Date().toISOString(),level:'error',scope:'fixture',message:'Fixture system log',sequence:1}]})}};
          if(message.action==='teamSettingsRequest'){
            if(message.payload.teamSettingsRequest.method!=='GET')error='The user changed in another window. Refresh before retrying.';
            else if(window.__teamActivityFailure && message.payload.teamSettingsRequest.path==='/api/office/logs')error='Activity storage is temporarily unavailable.';
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
    for (const [section, table, label] of [['logs','User audit log','Fixture action'],['proxy','Proxy requests','POST /v1/responses']]) {
      await select(section);
      const list = settings.getByRole('table', {name:table});
      await list.getByRole('button', {name:label,exact:true}).click();
      const details=page.getByRole('dialog',{name:label,exact:true});await details.waitFor();
      await details.getByRole('button',{name:'Close record details'}).click();
      const heights=await list.locator('tbody tr').evaluateAll(rows=>rows.map(row=>row.getBoundingClientRect().height));
      assert.ok(heights.every(height=>height<=34),'Record rows stay compact: '+JSON.stringify(heights));
      await page.screenshot({path:path.join(output,host+'-table-'+section+'-'+width+'x'+height+'.png')});
    }
    await select('system-log');
    await settings.getByRole('button',{name:'Show log',exact:true}).click();
    await settings.getByRole('table',{name:'System log entries'}).getByRole('button',{name:'Log entry details'}).click();
    const logDetail=page.getByRole('dialog',{name:'Log entry details'});await logDetail.waitFor();
    await logDetail.getByRole('button',{name:'Close record details'}).click();
    await settings.getByRole('button',{name:'Close log',exact:true}).click();
    await select('mcp');
    assert.equal(await settings.getByRole('textbox', { name: 'Connection ID', exact: true }).count(), 0, 'Connections tab shows the list without an always-open add form');
    await settings.getByRole('button', { name: 'Add connection', exact: true }).click();
    const connectionModal = page.getByRole('dialog', { name: 'Add data connection', exact: true });
    await connectionModal.waitFor();
    await connectionModal.getByRole('textbox', { name: 'Connection ID', exact: true }).fill('fixture');
    await connectionModal.getByRole('textbox', { name: 'Display name', exact: true }).fill('Fixture');
    await connectionModal.getByRole('textbox', { name: 'MCP endpoint', exact: true }).fill('https://example.test/mcp');
    await connectionModal.getByRole('button', { name: 'Add connection', exact: true }).click();
    await connectionModal.getByRole('alert').getByText('The user changed in another window. Refresh before retrying.', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, host+'-add-connection-'+width+'x'+height+'.png') });
    assert.ok(await connectionModal.evaluate(element => {const r=element.getBoundingClientRect();return r.x>=0 && r.right<=innerWidth+1 && r.y>=0 && r.bottom<=innerHeight+1;}), 'Add connection fits viewport');
    await connectionModal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await connectionModal.waitFor({ state: 'hidden' });
    await settings.getByText('Adding a data connection cancelled.', { exact: true }).waitFor();
    await select('logs');
    activityFailure = true;
    await page.evaluate(() => { window.__teamActivityFailure = true; });
    await settings.getByRole('button', { name: 'Refresh', exact: true }).click();
    await settings.getByRole('alert').getByText('Activity storage is temporarily unavailable.', { exact: true }).waitFor();
    assert.equal(await settings.getByText('No activity has been recorded yet.', { exact: true }).count(), 0, 'A failed load never looks like an empty successful result');
    activityFailure = false;
    await page.evaluate(() => { window.__teamActivityFailure = false; });
    const search = settings.getByRole('searchbox', { name: 'Search all settings' });
    assert.equal(await settings.locator('.settings-search input').count(), 1, 'Only one settings search exists');
    assert.equal(await search.getAttribute('placeholder'), 'Search');
    await search.fill('file limit');
    await settings.getByRole('button', { name: /Text file limit/ }).click();
    await settings.locator('#settings-panel-sessions').waitFor();
    await search.fill('retry capacity');
    await settings.getByRole('button', { name: /Capacity retry delay/ }).click();
    await settings.locator('#settings-panel-automation').waitFor();
    const toggleSizes = await settings.locator('.settings-inline-toggle:visible').evaluateAll(elements => elements.map(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
    assert.ok(toggleSizes.every(size => size.width === 38 && size.height === 22), 'Toggles stay compact in both hosts and touch layouts: ' + JSON.stringify(toggleSizes));
    await search.fill('a query that cannot match any setting');
    await settings.getByText('0 matching options', { exact: true }).waitFor();
    await settings.getByRole('button', { name: 'Clear settings search' }).click();
    assert.equal(await search.evaluate(element => document.activeElement === element), true, 'Clearing search keeps keyboard focus');
    assert.equal(await search.getAttribute('type'), 'text', 'No duplicate native search clear control');
    if (width < 760) assert.ok(await search.evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 16), 'Search does not trigger mobile input zoom');
    await page.evaluate(() => window.__setSettings({ autoSwitchEnabled: false, quotaWarningEnabled: false }));
    for (const query of ['Refresh quotas before switching', 'Yellow threshold', 'reset plan', '5h quota or less']) {
      await search.fill(query);
      assert.ok(await settings.locator('.settings-search-result').count() > 0, 'Collapsed option remains searchable: '+query);
    }
    await search.fill('Consecutive failures');
    await settings.getByRole('button', { name: /Consecutive failures/ }).click();
    const autoSwitch = settings.getByRole('button', { name: 'Automatic Account Switching', exact: true });
    assert.equal(await autoSwitch.getAttribute('aria-pressed'), 'false', 'Searching never enables a feature');
    assert.equal(await autoSwitch.evaluate(element => document.activeElement === element), true, 'Collapsed result focuses its parent switch');
    await page.evaluate(() => window.__setSettings({ autoSwitchEnabled: true, quotaWarningEnabled: true }));
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
    await failures.waitFor({ state: 'hidden' });
    assert.equal(await retry.isVisible(), false, 'The main capacity toggle hides both sliders');
    await page.evaluate(() => window.__setSettings({ modelCapacityAutoSwitchEnabled: true }));
    await failures.waitFor();
    await select('automation');
    await settings.locator('.settings-modal-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await select('general');
    assert.equal(await settings.locator('.settings-modal-body').evaluate(element => element.scrollTop), 0, 'Changing tabs resets content scroll');
    await page.evaluate(() => window.__setPeerConnected(false));
    assert.equal(await settings.getByRole('button', { name: 'Reset zoom', exact: true }).isEnabled(), true, 'Local zoom works while disconnected');
    assert.equal(await settings.locator('[data-setting=shared-password] .settings-action-btn').isEnabled(), false, 'Host mutations stay disabled offline');
    await page.evaluate(() => window.__setPeerConnected(true));
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
    await search.fill('postgresql');
    await settings.getByRole('button', { name: /Database provider/ }).first().click();
    const webModule = settings.locator('[data-setting=webDashboardEnabled] .settings-inline-toggle');
    assert.equal(await webModule.evaluate(element => element === document.activeElement), true, 'Disabled Team result focuses Web Dashboard before Team');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ host, width, height, sections, gates: true, errorsPreserved: true, runtimeErrors: errors.length }));
    await context.close();
  }
} finally { await browser.close(); }
console.log(`Screenshots: ${output}`);
