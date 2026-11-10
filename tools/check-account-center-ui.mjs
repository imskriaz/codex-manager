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
    assert.equal(await dialog.getByRole('heading', { name: /Saved Accounts/ }).count(), 0, 'Account Center omits the redundant Saved Accounts title');
    await dialog.getByRole('button', { name: 'Add account', exact: true }).waitFor();
    const more = dialog.locator('.account-center-actions').getByRole('button', { name: 'More account actions', exact: true });
    await more.click();
    const menu = page.getByRole('menu', { name: 'More account actions', exact: true });
    await menu.waitFor();
    assert.equal(await menu.getByRole('menuitem').count(), 4, 'Compact More menu keeps account tools reachable');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    const toolbar = await dialog.locator('.dashboard-account-toolbar').evaluate(element => [...element.children].map(child=>child.getBoundingClientRect().toJSON()));
    assert.ok(toolbar.every(bounds=>Math.abs(bounds.y+bounds.height/2-toolbar[0].y-toolbar[0].height/2)<3), 'Search and all icon controls stay on one row: '+JSON.stringify(toolbar));
    assert.equal(await dialog.locator('.dashboard-select-control > svg').count(), await dialog.locator('.dashboard-select-control').count(), 'Each compact selector has an icon');
    const footer = await dialog.locator('.cli-account-navigation').evaluate(element=>({width:element.clientWidth,scroll:element.scrollWidth,buttons:[...element.querySelectorAll('button')].map(button=>button.getBoundingClientRect().toJSON())}));
    assert.ok(footer.scroll<=footer.width+1&&footer.buttons.every(bounds=>Math.abs(bounds.y-footer.buttons[0].y)<3&&bounds.height<=30), 'Compact footer keeps every shortcut on one row without overflow');
    const dashboardView = await page.locator('.panel .section[class*="dashboard-view-"]').getAttribute('class');
    await dialog.locator('.dashboard-view-toggle').click();
    await dialog.locator('.saved-table-row').first().waitFor();
    assert.equal(await page.locator('.panel .section[class*="dashboard-view-"]').getAttribute('class'), dashboardView, 'Account Center view never changes the dashboard view');
    await dialog.locator('.dashboard-view-toggle').click();
    await dialog.locator('.saved-card-front').first().waitFor();
    const layout=await dialog.evaluate(element=>{
      const selectors=['.cli-account-grid','.accounts-grid','.saved-card-front','.saved-progress','.dashboard-account-toolbar'];
      return {overflow:selectors.flatMap(selector=>[...element.querySelectorAll(selector)].filter(node=>node.scrollWidth>node.clientWidth+1).map(node=>({selector,width:node.clientWidth,scroll:node.scrollWidth}))),bounds:element.getBoundingClientRect().toJSON(),quota:[...element.querySelectorAll('.saved-progress .percent')].map(node=>({width:node.getBoundingClientRect().width,text:node.textContent})),identity:[...element.querySelectorAll('.saved-title')].map(node=>node.getBoundingClientRect().width),cards:[...element.querySelectorAll('.saved-card-front')].map(card=>({width:card.getBoundingClientRect().width,background:getComputedStyle(card).background,columns:getComputedStyle(card.querySelector('.saved-progress')).gridTemplateColumns.split(' ').length,primary:card.querySelector('.saved-top-actions').getBoundingClientRect().y,secondary:card.querySelector('.saved-actions').getBoundingClientRect().y}))};
    });
    assert.deepEqual(layout.overflow,[],`Account Center ${viewport}/${center} has no horizontal overflow`);
    assert.ok(layout.bounds.x>=-1&&layout.bounds.right<=viewport+1,'Dialog fits viewport');
    if (viewport <= 760) {
      assert.ok(Math.abs(layout.bounds.width - viewport) < 2, 'Mobile Account Center uses the screen width');
      await dialog.getByRole('button', { name: 'Close account menu', exact: true }).waitFor();
      assert.equal(await dialog.getAttribute('aria-modal'), 'true', 'Mobile Account Center traps keyboard focus');
    }
    assert.ok(layout.quota.every(item=>item.width>10),'Quota percentages remain visible');
    assert.ok(layout.identity.every(width=>width>60),'Identity retains useful space');
    assert.ok(layout.cards.every(card=>card.background.includes('gradient')||!card.background.includes('rgba(0, 0, 0, 0)')), 'Dashboard card surfaces are preserved');
    assert.ok(layout.cards.every(card=>card.columns===2&&Math.abs(card.primary-card.secondary)<3),'Even narrow cards keep all actions on one row and quotas side by side');
    const controls = await dialog.locator('.saved-card-front').evaluateAll(cards => cards.map(card => ({height:card.getBoundingClientRect().height,buttons:[...card.querySelectorAll('.saved-top-actions button, .saved-actions button')].map(button=>({width:button.getBoundingClientRect().width,height:button.getBoundingClientRect().height}))})));
    assert.ok(controls.every(card=>card.height<110&&card.buttons.every(button=>button.width>=24&&button.width<=26&&button.height>=24&&button.height<=26)), 'Compact cards retain 24px action targets without tall wrapped rows');
    await page.screenshot({path:path.join(output,`account-center-${viewport}-${center}.png`)});
    const theme = await page.evaluate(() => { const value = document.documentElement.getAttribute('data-theme'); document.documentElement.setAttribute('data-theme', 'dark'); return value; });
    await page.waitForTimeout(250);
    await page.screenshot({path:path.join(output,`account-center-${viewport}-${center}-dark.png`)});
    await page.evaluate(value => value === null ? document.documentElement.removeAttribute('data-theme') : document.documentElement.setAttribute('data-theme', value), theme);
    await dialog.getByRole('button', { name: 'Close account menu', exact: true }).click();await dialog.waitFor({state:'detached'});
  }
  await page.setViewportSize({width:390,height:850});
  const trigger = page.getByRole('button',{name:'Open account center',exact:true});
  if (!await trigger.isVisible()) await page.getByRole('button',{name:'Show sessions sidebar',exact:true}).click();
  await trigger.click();
  const dialog = page.getByRole('dialog',{name:'Account center',exact:true});
  await dialog.waitFor();
  const snapshot = await (await page.request.get(origin+'/api/state')).json();
  await page.evaluate(state => dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:snapshot',state}})), snapshot);
  await page.waitForTimeout(100);
  await page.evaluate(() => dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:action-result',action:'switch',requestId:'account-center-failed-fixture',status:'failed',error:'Switch was not confirmed.'}})));
  assert.equal(await dialog.isVisible(), true, 'A failed switch keeps Account Center open');
  const old = snapshot.accounts.find(account=>account.isActive), next = snapshot.accounts.find(account=>!account.isActive);
  assert.ok(old && next, 'Two saved accounts support a read-only switch UI fixture');
  const updateAccounts = accounts => accounts?.map(account=>({...account,isActive:account.id===next.id}));
  snapshot.accounts = updateAccounts(snapshot.accounts);
  for (const peer of snapshot.peers ?? []) if (peer.local && snapshot.peerAccounts?.[peer.id]) snapshot.peerAccounts[peer.id] = updateAccounts(snapshot.peerAccounts[peer.id]);
  await page.evaluate(state => dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:snapshot',state}})), snapshot);
  await dialog.waitFor({state:'detached'});
}
