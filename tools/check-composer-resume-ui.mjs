import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkComposerResumeUi(page,{origin,parentId,runningId,width,height,output}) {
  const checkFailure = async scope => {
    await scope.locator('.cli-composer-warning').waitFor();
    await scope.getByRole('button', { name: 'Message settings', exact: true }).click();
    await scope.getByRole('alert').filter({ hasText: 'Resume was not confirmed. Your work was kept.' }).first().waitFor();
    await scope.getByRole('button', { name: 'Close message settings', exact: true }).click();
  };
  await page.goto(`${origin}/workspace/${parentId}`);
  const input=page.getByRole('textbox',{name:'Message Codex',exact:true}),play=page.getByRole('button',{name:'Resume session',exact:true});
  await input.waitFor();
  const shortBubble=page.locator('.cli-session-message.is-user .cli-session-message-text').filter({hasText:/^30px$/});
  await shortBubble.waitFor();
  const bubble=await shortBubble.evaluate(element=>{const style=getComputedStyle(element);return {height:element.getBoundingClientRect().height,line:parseFloat(style.lineHeight),padding:parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)+parseFloat(style.borderTopWidth)+parseFloat(style.borderBottomWidth)};});
  assert.ok(bubble.height-bubble.padding<=bubble.line+1,'Short messages stay on one line: '+JSON.stringify(bubble));
  await page.waitForFunction(()=>document.title==='Codex Manager - Workspace');
  await page.evaluate(()=>{window.__uiSnapshot.settings.privacyMode=false;dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:snapshot',state:structuredClone(window.__uiSnapshot)}}));});
  await page.waitForFunction(()=>document.title==='This PC - Workspace - Evaluate stack beyond expectations');
  const update=async patch=>page.evaluate(({id,patch})=>{
    for(const session of window.__uiSessions.filter(x=>x.id===id)) Object.assign(session,patch,{updatedAt:new Date().toISOString()});
    window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:action-result',action:'listCodexCliSessions',requestId:'dashboard-auto-resume-fixture',status:'completed',payload:{cliSessions:window.__uiSessions}}}));
  },{id:parentId,patch});
  await update({status:'idle',interrupted:true,goal:{objective:'Delete fixture goal',status:'active'}});
  if (width > 760) {
    const show = page.getByRole('button', { name: 'Show sessions sidebar', exact: true });
    const opened = await show.isVisible(); if (opened) await show.click();
    const row = page.locator('.cli-session-row').filter({ hasText: 'Evaluate stack beyond expectations' }).first();
    await row.hover();
    await row.getByRole('button', { name: /^Actions for / }).click();
    await page.getByRole('menuitem', { name: 'Start / Resume', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    if (opened) await page.getByRole('button', { name: 'Hide sessions sidebar', exact: true }).click();
  }
  const goalDelete=page.getByRole('button',{name:'Delete goal',exact:true});await goalDelete.waitFor();
  await goalDelete.click();const goalDialog=page.getByRole('dialog',{name:'Delete goal?',exact:true});await goalDialog.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await goalDelete.isVisible(),true,'Cancellation preserves the goal');
  await goalDelete.click();await goalDialog.getByRole('button',{name:'Delete goal',exact:true}).click();await goalDelete.waitFor({state:'hidden'});
  assert.ok(await page.evaluate(()=>window.__uiActions.some(action=>action.action==='setCodexSessionGoalStatus'&&action.payload.goalStatus==='clear'&&action.payload.confirmed===true)),'Goal deletion uses a confirmed native action');
  await update({status:'idle',interrupted:true,goal:null});await play.waitFor();
  const size=async locator=>{const box=await locator.boundingBox(),expected=width<=760?30:32;assert.ok(Math.abs(box.width-expected)<.1&&Math.abs(box.height-expected)<.1,`Action uses a balanced control size: ${JSON.stringify(box)}`);};
  await size(page.getByRole('button',{name:'Attach files',exact:true}));
  const iconSize=await page.locator('.cli-attach-button svg').boundingBox();assert.ok(Math.abs(iconSize.width-(width<=760?14:16))<.1);
  const meter=await page.locator('.cli-context-meter svg').boundingBox();assert.ok(Math.abs(meter.width-18)<.1);
  const settingsIcon=await page.locator('.cli-composer-permission svg').boundingBox();assert.ok(Math.abs(settingsIcon.width-(width<=760?14:16))<.1);
  await size(play);assert.equal(await play.locator('svg').count(),1);
  const modelBox=await page.getByRole('button',{name:'Message settings',exact:true}).boundingBox(),playBox=await play.boundingBox(),attachBox=await page.getByRole('button',{name:'Attach files',exact:true}).boundingBox();
  assert.ok(Math.abs(modelBox.height-playBox.height)<.1&&Math.abs(attachBox.y-playBox.y)<1&&Math.abs(modelBox.y-playBox.y)<1,'Composer controls share one height and baseline');

  await page.screenshot({path:path.join(output,`composer-resume-${width}x${height}.png`),animations:'disabled'});
  await input.fill('Keep my new request');await play.waitFor({state:'hidden'});
  await size(page.getByRole('button',{name:'Send message',exact:true}));
  await input.fill('');await play.waitFor();
  assert.equal(await input.getAttribute('placeholder'),'Message Codex…','Typing clears feedback from the previous action');
  await page.evaluate(()=>dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:false}})));
  assert.equal(await play.isDisabled(),true,'Offline Resume is disabled');
  await page.evaluate(()=>dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:true}})));
  await page.waitForFunction(()=>document.querySelector('.cli-resume-button')?.disabled===false);
  await page.evaluate(()=>{window.__holdResumeClick=true;});await play.click();
  const busy=page.getByRole('button',{name:'Resuming session',exact:true});await busy.waitFor();assert.equal(await busy.isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.__uiActions.filter(x=>x.action==='resumeCodexSessions').length),1);
  await input.fill('Keep this draft during Resume');
  assert.equal(await page.getByRole('button',{name:'Send message',exact:true}).isDisabled(),true,'Resume blocks concurrent dispatch');
  await page.waitForFunction(()=>!!window.__heldResumeResult?.requestId);
  await page.evaluate(()=>{window.__holdResumeClick=false;dispatchEvent(new MessageEvent('message',{data:{...window.__heldResumeResult,status:'failed',error:'Resume was not confirmed. Your work was kept.'}}));});
  await checkFailure(page);
  assert.equal(await input.inputValue(),'Keep this draft during Resume');
  await input.fill('');await play.waitFor();
  await update({interrupted:false});await play.waitFor({state:'hidden'});
  await update({interrupted:true,goal:{objective:'Finished',status:'complete'}});assert.equal(await play.count(),0);
  await update({status:'unknown',goal:null});assert.equal(await play.count(),0);
  await update({status:'idle',locked:true});assert.equal(await play.count(),0);
  await update({status:'idle',locked:false,interrupted:true});await play.waitFor();
  await play.click();
  const confirmed = page.locator('.cli-composer .cli-composer-state').filter({hasText:'Session resume confirmed.'});
  assert.equal(await confirmed.count(),0,'Successful Resume adds no composer status row');
  assert.equal(await input.getAttribute('placeholder'),'Message Codex…','Resume feedback does not replace the normal placeholder');
  await confirmed.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>window.__uiActions.filter(x=>x.action==='resumeCodexSessions').length),2,'Explicit retry starts one action');
  await page.goto(`${origin}/workspace/${runningId}`);await input.waitFor();await size(page.getByRole('button',{name:'Stop',exact:true}));
  assert.equal(await play.count(),0,'Running sessions show Stop');
  await page.goto(`${origin}/tasks`);
  await page.locator('.task-board-card').filter({hasText:'Release work'}).waitFor();
  await page.getByRole('button',{name:'Expand 1 subtasks',exact:true}).click();
  await page.locator('.task-board-card').filter({hasText:'Evaluate stack beyond expectations'}).click();
  await page.waitForFunction(()=>document.title==='Codex Manager - Tasks');
  await page.evaluate(()=>{window.__uiSnapshot.settings.privacyMode=false;dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:snapshot',state:structuredClone(window.__uiSnapshot)}}));});
  await page.waitForFunction(()=>document.title==='This PC - Tasks - Evaluate stack beyond expectations');
  const task=page.locator('.task-detail-modal');await task.getByRole('tab',{name:/^Agents/}).click();
  const taskInput=task.getByRole('textbox',{name:'Message Codex',exact:true});await taskInput.waitFor();
  await update({status:'idle',locked:false,interrupted:true,goal:null});
  const taskPlay=task.getByRole('button',{name:'Resume session',exact:true});await taskPlay.waitFor();await size(taskPlay);
  await page.evaluate(()=>{window.__failResumeClick=true;});
  const before=await page.evaluate(()=>window.__uiActions.filter(x=>x.action==='resumeCodexSessions').length);
  await taskPlay.click();await checkFailure(task);
  assert.equal(await page.locator('.task-detail-panel textarea[name="codex-message"]').getAttribute('placeholder'),'Message Codex…','Task failures remain visible separately from the normal placeholder');
  assert.equal(await page.evaluate(()=>window.__uiActions.filter(x=>x.action==='resumeCodexSessions').length),before+1,'Task conversation uses the same session Resume action');
  await taskInput.fill('Task draft stays editable');await size(task.getByRole('button',{name:'Send message',exact:true}));
  await taskInput.fill('');
  await update({status:'running',interrupted:false,locked:true});await task.getByRole('button',{name:'Stop',exact:true}).waitFor();
  await page.evaluate(id=>dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:codex-session-live',state:{sessionId:id,streamId:'01a04882-d037-7a42-ad24-9afb61901311',sequence:1,status:'failed',updatedAt:Date.now()+1000,messages:[]}}})),parentId);
  await taskPlay.waitFor();assert.equal(await task.getByRole('button',{name:'Stop',exact:true}).count(),0,'A failed live turn replaces stale running metadata with Play');


}
