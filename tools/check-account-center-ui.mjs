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
      return {overflow:selectors.flatMap(selector=>[...element.querySelectorAll(selector)].filter(node=>node.scrollWidth>node.clientWidth+1).map(node=>({selector,width:node.clientWidth,scroll:node.scrollWidth}))),bounds:element.getBoundingClientRect().toJSON(),quota:[...element.querySelectorAll('.saved-progress .percent')].map(node=>({width:node.getBoundingClientRect().width,text:node.textContent})),identity:[...element.querySelectorAll('.saved-title')].map(node=>node.getBoundingClientRect().width),cards:[...element.querySelectorAll('.saved-card-front')].map(card=>({width:card.getBoundingClientRect().width,background:getComputedStyle(card).background,columns:getComputedStyle(card.querySelector('.saved-progress')).gridTemplateColumns.split(' ').length,primary:card.querySelector('.saved-top-actions').getBoundingClientRect().y,secondary:card.querySelector('.saved-actions').getBoundingClientRect().y}))};
    });
    assert.deepEqual(layout.overflow,[],`Account Center ${viewport}/${center} has no horizontal overflow`);
    assert.ok(layout.bounds.x>=-1&&layout.bounds.right<=viewport+1,'Dialog fits viewport');
    assert.ok(layout.quota.every(item=>item.width>10),'Quota percentages remain visible');
    assert.ok(layout.identity.every(width=>width>60),'Identity retains useful space');
    assert.ok(layout.cards.every(card=>card.background.includes('gradient')||!card.background.includes('rgba(0, 0, 0, 0)')), 'Dashboard card surfaces are preserved');
    assert.ok(layout.cards.filter(card=>card.width>340).every(card=>card.columns===2&&Math.abs(card.primary-card.secondary)<3),'Normal-width cards keep actions aligned and quotas side by side');
    await page.screenshot({path:path.join(output,`account-center-${viewport}-${center}.png`)});
    const theme = await page.evaluate(() => { const value = document.documentElement.getAttribute('data-theme'); document.documentElement.setAttribute('data-theme', 'dark'); return value; });
    await page.waitForTimeout(250);
    await page.screenshot({path:path.join(output,`account-center-${viewport}-${center}-dark.png`)});
    await page.evaluate(value => value === null ? document.documentElement.removeAttribute('data-theme') : document.documentElement.setAttribute('data-theme', value), theme);
    await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  }
}
