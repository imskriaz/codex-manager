import assert from 'node:assert/strict';
import path from 'node:path';
export async function checkAccountCenterUi(page,{origin,output}) {
  await page.goto(origin+'/workspace'); await page.locator('.cli-workspace').waitFor();
  for(const [viewport,center] of [[320,280],[390,366],[760,320],[1440,280],[1440,420],[1440,720]]) {
    await page.setViewportSize({width:viewport,height:850});
    const trigger=page.getByRole('button',{name:'Open account center',exact:true});
    if(!await trigger.isVisible()) {const show=page.getByRole('button',{name:'Show sessions sidebar',exact:true});if(await show.isVisible())await show.click();}
    await trigger.click(); const dialog=page.getByRole('dialog',{name:'Account center',exact:true});await dialog.waitFor();
    await dialog.evaluate((element,width)=>{element.style.setProperty('--account-center-width',width+'px');element.style.height='650px';},center);
    await dialog.locator('.saved-card-front').first().waitFor();
    const layout=await dialog.evaluate(element=>{
      const selectors=['.cli-account-grid','.accounts-grid','.saved-card-front','.saved-progress','.dashboard-account-toolbar'];
      return {overflow:selectors.flatMap(selector=>[...element.querySelectorAll(selector)].filter(node=>node.scrollWidth>node.clientWidth+1).map(node=>({selector,width:node.clientWidth,scroll:node.scrollWidth}))),bounds:element.getBoundingClientRect().toJSON(),quota:[...element.querySelectorAll('.saved-progress .percent')].map(node=>({width:node.getBoundingClientRect().width,text:node.textContent})),identity:[...element.querySelectorAll('.saved-title')].map(node=>node.getBoundingClientRect().width)};
    });
    assert.deepEqual(layout.overflow,[],`Account Center ${viewport}/${center} has no horizontal overflow`);
    assert.ok(layout.bounds.x>=-1&&layout.bounds.right<=viewport+1,'Dialog fits viewport');
    assert.ok(layout.quota.every(item=>item.width>10),'Quota percentages remain visible');
    assert.ok(layout.identity.every(width=>width>60),'Identity retains useful space');
    await page.screenshot({path:path.join(output,`account-center-${viewport}-${center}.png`)});
    await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  }
}
