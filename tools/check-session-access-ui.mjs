import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkSessionAccessUi(page,{origin,parentId,width,height,output}) {
  await page.goto(`${origin}/workspace/${parentId}`);
  const input=page.getByRole('textbox',{name:'Message Codex',exact:true}); await input.waitFor(); await input.fill('');
  const form=page.locator('.cli-composer'),toggle=page.getByRole('button',{name:'Message settings',exact:true});
  const checkLayout=async()=>{
    const field=await input.boundingBox(),toolbar=await page.locator('.cli-composer-toolbar').boundingBox(),box=await form.boundingBox();
    assert.ok(field.width>=box.width-32,'The message field keeps the full composer width');
    assert.ok(toolbar.y>=field.y+field.height-1,'The toolbar is always on the second row');
    assert.ok(box.x>=0&&box.x+box.width<=width+1,'The composer fits the viewport');
    assert.equal(await page.locator('.cli-composer-selectors .cli-context-meter').count(),0,'Only Attach is on the left');
    assert.equal(await toggle.locator('.cli-context-meter').count(),1,'Context stays beside the model');
    const meter=await toggle.locator('.cli-context-meter').boundingBox(),model=await toggle.locator('.cli-composer-model').boundingBox();
    assert.ok(model.x-meter.x-meter.width<=10,'Context sits immediately beside the model label');
    assert.ok(!(await toggle.innerText()).includes('GPT-'),'Displayed names omit GPT without changing model IDs');
  };
  await checkLayout();
  await page.screenshot({path:path.join(output,`composer-blank-${width}x${height}.png`),animations:"disabled"});
  const external=async(mode,stamp=Date.now())=>page.evaluate(({sessionId,mode,stamp})=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:codex-session-access',sessionId,access:{mode,updatedAt:stamp}}})),{sessionId:parentId,mode,stamp});
  await external('danger-full-access');
  await toggle.click(); const access=page.getByRole('combobox',{name:'Access mode',exact:true});
  await page.waitForFunction(()=>document.querySelector('select[name="sandbox-mode"]')?.value==='danger-full-access');
  await access.selectOption('read-only');
  await page.waitForFunction(()=>document.querySelector('select[name="sandbox-mode"]')?.value==='read-only');
  assert.equal(await page.evaluate(()=>window.__uiActions.filter(x=>x.action==='setCodexSessionAccess').length),1,'Changing access syncs once');
  assert.equal(await page.getByRole('combobox',{name:'Model',exact:true}).inputValue(),'gpt-5','Model IDs stay unchanged');
  await page.keyboard.press('Escape');
  await input.fill('Keep this draft through permission changes'); await checkLayout();
  await page.screenshot({path:path.join(output,`composer-access-${width}x${height}.png`),animations:'disabled'});
  await external('workspace-write',Date.now()+1000);
  await toggle.click(); assert.equal(await access.inputValue(),'workspace-write','A Codex change immediately updates the workspace');
  await page.evaluate(()=>{window.__failAccess=true;}); await access.selectOption('danger-full-access');
  await page.getByText('Access change could not be confirmed.',{exact:true}).first().waitFor();
  assert.equal(await access.inputValue(),'workspace-write','Failed changes keep the confirmed policy');
  assert.equal(await input.inputValue(),'Keep this draft through permission changes');
  await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:false}})));
  assert.equal(await access.isDisabled(),true,'Offline access changes are blocked');
  await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:connection',connected:true}})));
  await page.keyboard.press('Escape');
}
