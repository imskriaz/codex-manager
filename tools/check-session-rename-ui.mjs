import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkSessionRenameUi(page, { origin, parentId, runningId, width, output }) {
  await page.goto(`${origin}/workspace/${parentId}`);
  const header = page.locator('.cli-conversation-header');
  const title = header.locator('.cli-conversation-title h1');
  const composer = page.getByRole('textbox', { name: 'Message Codex', exact: true });
  await composer.waitFor();
  const original = await title.textContent();
  await composer.fill('Keep this draft through renames');
  const rename = async name => {
    await page.getByRole('button', { name: 'Session actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Session name', exact: true });
    await input.fill(name);
    await page.locator('.cli-rename-form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await page.locator('.cli-rename-form').waitFor({ state: 'hidden' });
  };
  const release = async () => page.evaluate(() => {
    const result = window.__heldRenameResult;
    if(result.status === 'completed') for(const item of window.__uiSessions.filter(item=>item.id===result.payload.cliSession.id)) item.title=result.payload.cliSession.title;
    window.dispatchEvent(new MessageEvent('message', { data: result }));
    delete window.__heldRenameResult;
  });
  await page.evaluate(() => { window.__holdNextRename=true; });
  await rename('  Better   conversation title  ');
  await title.filter({ hasText: 'Better conversation title' }).waitFor();
  await page.locator('.cli-session-row-select').filter({hasText:'Better conversation title'}).waitFor({state:'attached'});
  await page.waitForFunction(() => !!window.__heldRenameResult);
  assert.equal(await page.evaluate(() => window.__uiActions.filter(item=>item.action==='renameCodexCliSession').length),1,'Repeated submit dispatches one rename');
  await page.evaluate(() => {
    const result=window.__heldRenameResult;
    window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:action-result',action:'listCodexCliSessions',requestId:'realtime-rename-old',status:'completed',payload:{cliSessions:window.__uiSessions}}}));
    window.dispatchEvent(new MessageEvent('message',{data:{...result,action:'getCodexCliSessionMessages',requestId:'realtime-rename-old-message',payload:{cliSession:window.__uiSessions[0],cliSessionMessages:window.__uiMessages}}}));
  });
  assert.equal(await title.textContent(),'Better conversation title','An old discovery or message snapshot cannot replace a pending title');
  await release();
  await page.getByRole('button',{name:'Session actions',exact:true}).click();
  await page.getByRole('menuitem',{name:'Rename',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await composer.inputValue(),'Keep this draft through renames');

  await page.evaluate(() => { window.__holdNextRename=true;window.__failNextRename=true; });
  await rename('Failed rename');
  await title.filter({hasText:'Failed rename'}).waitFor();
  await page.waitForFunction(() => !!window.__heldRenameResult);
  await release();
  await title.filter({hasText:'Better conversation title'}).waitFor();
  await page.locator('.cli-composer-warning[aria-label="Rename storage is unavailable. The original title was kept."]').waitFor();

  await page.evaluate(() => {
    window.__holdNextRename=true;
    const originalSetTimeout=window.setTimeout;
    window.__restoreRenameTimer=()=>{window.setTimeout=originalSetTimeout;};
    window.setTimeout=(callback,delay,...args)=>originalSetTimeout(callback,delay===75000?3000:delay,...args);
  });
  await rename('Unconfirmed rename');
  await title.filter({hasText:'Unconfirmed rename'}).waitFor();
  await page.waitForFunction(() => !!window.__heldRenameResult);
  await page.evaluate(() => window.__restoreRenameTimer());
  await title.filter({hasText:'Better conversation title'}).waitFor();
  assert.equal(await composer.inputValue(),'Keep this draft through renames','Timeout rollback retains the draft');

  await page.evaluate(id => {history.pushState({},'',`/workspace/${id}`);dispatchEvent(new PopStateEvent('popstate'));},runningId);
  await title.filter({hasText:'Running workspace task'}).waitFor();
  await release();
  assert.equal(await title.textContent(),'Running workspace task','A late rename cannot change another selected session');
  assert.ok(page.url().includes(runningId));
  assert.equal(await page.evaluate(() => window.__uiActions.filter(item=>item.action==='renameCodexCliSession').length),3,'Timeouts and late acknowledgments never replay the rename');
  await page.evaluate(id => {history.pushState({},'',`/workspace/${id}`);dispatchEvent(new PopStateEvent('popstate'));},parentId);
  await title.filter({hasText:'Unconfirmed rename'}).waitFor();
  await page.evaluate(() => {window.__holdNextRename=true;});
  await rename('Local title remains local');
  await page.waitForFunction(() => !!window.__heldRenameResult);
  await page.evaluate(() => {
    window.__systemFixture=true;
    window.__uiSnapshot.connectedPeers.push({id:'fixture-system',name:'Remote system',connected:true,local:false,sessionCount:1});
    window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:snapshot',state:window.__uiSnapshot}}));
  });
  const sidebar=page.getByRole('button',{name:'Show sessions sidebar',exact:true});
  if(await sidebar.isVisible()) await sidebar.click();
  await page.locator('.cli-rail-system select').selectOption('fixture-system');
  await page.locator('.cli-session-row-select').filter({hasText:'Remote system session'}).click();
  await title.filter({hasText:'Remote system session'}).waitFor();
  await release();
  assert.equal(await title.textContent(),'Remote system session','A local rename acknowledgment cannot change a selected remote conversation');
  assert.ok(page.url().includes('device=fixture-system'));
  assert.equal(await page.evaluate(() => window.__uiActions.filter(item=>item.action==='renameCodexCliSession' && item.payload.targetDeviceId).length),0,'Changing systems never replays local mutations remotely');
  await page.screenshot({path:path.join(output,`session-rename-${width}.png`)});
  assert.notEqual(original,'Better conversation title');
}
