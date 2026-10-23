import assert from 'node:assert/strict';

// The responsive harness intercepts every action; documentation contains fictional identities.
export function prepareDocsSnapshot(state, sessions, messages) {
  Object.assign(state, {brandSub:'Your Codex workspace, across connected PCs',onboardingCompleted:true,
    connectedPeers:[{id:'fixture-local',name:'Studio desktop',local:true,connected:true,sessionCount:2},{id:'fixture-system',name:'Build laptop',connected:true,sessionCount:1}],
    tokenAutomation:{enabled:true},indexHealth:{status:'healthy'},terminalNotice:undefined,dailyUsageCache:[],usageHistory:[],usageSummary:undefined,
    encryptedSyncNeedsConfiguration:false,encryptedSyncNeedsSettingsSync:false});
  Object.assign(state.settings,{dashboardTheme:'dark',privacyMode:false,cloudflaredDomain:'dashboard.example',codexCliPath:'',codexAppPath:'',resolvedCodexAppPath:'',autoResumeEnabled:true});
  state.accounts=['Studio','Build','Review','Personal','Docs','Design','Research','Backup'].map((name,index)=>({
    id:`demo-${index}`,displayName:name,accountName:name,email:`${name.toLowerCase()}@example.test`,authProviderLabel:'OAuth',accountStructureLabel:'Personal',workspaceLabel:name,isTeamWorkspace:false,
    subscriptionText:'24d left',subscriptionTitle:'Plus subscription',planTypeLabel:'Plus',addMethodLabel:'OAuth',addedAtLabel:'Today',
    isActive:index===0,isCurrentWindowAccount:index===0,enabled:true,switchQueued:false,queuePriority:false,tokenRefreshEnabled:true,canRefreshToken:true,showInStatusBar:true,canToggleStatusBar:true,statusToggleTitle:'Show quota',hasQuota402:false,healthKind:'healthy',healthLabel:'Ready',dismissedHealth:false,
    runningDeviceName:index===0?'Studio desktop':undefined,runningOnThisDevice:index===0,runningDeviceOnline:index===0,tags:index===0?['Daily']:index===1?['Build']:[],
    accountId:`demo-${name.toLowerCase()}`,loginAt:Date.now()-86400000,sessionStartedAt:Date.now()-1920000,totalUsageMs:21600000,lastQuotaAt:Date.now()-30000,autoSwitchLockedUntil:index===0?Date.now()+900000:undefined,
    metrics:[{key:'hourly',label:'5h',period:'hourly',percentage:92-index*11,resetAt:Math.floor(Date.now()/1000)+7200,visible:true},{key:'weekly',label:'Weekly',period:'weekly',percentage:84-index*9,resetAt:Math.floor(Date.now()/1000)+345600,visible:true}]
  }));
  state.peerAccounts={'fixture-system':[{...state.accounts[1],id:'remote-account',displayName:'Build',isActive:true,isCurrentWindowAccount:true,runningDeviceName:'Build laptop',runningOnThisDevice:true,runningDeviceOnline:true}]};
  sessions[0].title='Prepare the release';sessions[0].goal.objective='Complete the release checklist';sessions[1].title='Verify the desktop build';
  messages.splice(0,messages.length,
    {id:'docs-request',kind:'message',role:'user',text:'Review the changes and prepare the release checklist.'},
    {id:'docs-check',kind:'command',command:'npm run verify',text:'npm run verify',output:'Type checks and lint completed.',status:'completed',durationMs:2400},
    {id:'docs-change',kind:'file-change',text:'Updated release notes',status:'completed',changes:[{path:'src/app.ts',kind:'update',diff:'@@ -1 +1 @@\n-old\n+updated'},{path:'README.md',kind:'update'}]},
    {id:'docs-answer',kind:'message',role:'assistant',text:'### Release review\n\nThe workspace changes are ready for review.\n\n- Validation completed successfully.\n- Release notes include the new workspace features.\n- Project files remain in this session’s context.\n\nOpen the [Source file](src/app.ts:12) in Files, or review the [project guide](README.md).'}
  );
}

export async function captureDocsScreenshots(page,{origin,width,parentId}) {
  await page.addInitScript(()=>{window.__docsFixture=true;window.__systemFixture=true;window.__tagTheme='dark';});
  const shot=async name=>{await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:`media/docs-${name}.png`,animations:'disabled'});};
  const rail=async()=>{const show=page.getByRole('button',{name:'Show sessions sidebar',exact:true});if(await show.isVisible())await show.click();};
  await page.goto(origin+'/');await page.locator('#dashboard-main').waitFor();await page.locator('.saved-card-container').first().waitFor();
  if(width>=760)assert.equal(await page.locator('.brand-version').textContent(),'v1.5.1');
  assert.match(await page.locator('body').innerText(),/example\.test|Studio/);
  await shot(width<760?'mobile':'dashboard');
  if(width>=760){
    await page.locator('#settingsOpenButton').click();await page.locator('#settings-tab-automation').click();
    await page.getByRole('button',{name:'Auto resume sessions',exact:true}).scrollIntoViewIfNeeded();
    await shot('settings');await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'API access',exact:true}).click();await page.getByRole('dialog',{name:'API access',exact:true}).waitFor();
    await shot('api');await page.keyboard.press('Escape');
    await page.goto(origin+'/workspace');await page.locator('.cli-workspace').waitFor();await rail();
    await page.getByRole('combobox',{name:'System',exact:true}).selectOption('fixture-system');
    await page.locator('.cli-session-row-select').filter({hasText:'Remote system session'}).click();
    await page.locator('.cli-session-message').first().waitFor();
    await shot('remote');
    await page.goto(origin+'/workspace');await page.locator('.cli-workspace').waitFor();await rail();
    await page.getByRole('combobox',{name:'System',exact:true}).selectOption('fixture-local');
    await page.getByRole('button',{name:'Project task board',exact:true}).click();
    await page.locator('.task-board-card').first().waitFor();await shot('board');
  }
  await page.goto(`${origin}/workspace/${parentId}`);await page.getByRole('textbox',{name:'Message Codex',exact:true}).waitFor();
  const hide=page.getByRole('button',{name:'Hide sessions sidebar',exact:true});if(width<760&&await hide.isVisible())await hide.click();
  if(width<760)await shot('session-mobile');
  else{
    await page.getByRole('link',{name:'Source file',exact:true}).click();
    await page.locator('.cli-file-editor .cm-content').waitFor();
    assert.equal(await page.getByRole('tab',{name:'app.ts',exact:true}).count(),1);
    await shot('workspace');
  }
}
