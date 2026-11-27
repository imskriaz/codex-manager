import assert from 'node:assert/strict';
import path from 'node:path';

export async function checkUserSettingsPolishUi(page,context,{width,output,nav}){
  const theme=await page.evaluate(()=>document.documentElement.dataset.theme);
  const owner='alex@example.test';
  await context.route('**/api/workspace/account',route=>{assert.equal(route.request().method(),'GET');return route.fulfill({json:{profile:{displayName:'Alex Morgan — Operations and merchandising',username:'alex.morgan.operations@example.test'},plan:{name:'Professional workspace',status:'active',models:[],expiresAt:Date.now()+86400000*30},sessions:[{id:'current',current:true,expiresAt:0},{id:'phone',current:false,expiresAt:Date.now()+86400000},{id:'laptop',current:false,expiresAt:Date.now()+86400000*7}]}});});
  await context.route('**/api/workspace/preferences',route=>{assert.equal(route.request().method(),'GET');return route.fulfill({json:{instructions:'Use concise summaries, highlight deadlines, and keep buyer correspondence professional.',limits:{dailyTokens:100000,dailyRequests:100,storageMb:100},usage:{tokens:24500,requests:12,storageBytes:2097152,resetsAt:Date.now()+3600000}}});});
  await context.route('**/api/workspace/memory',route=>{assert.equal(route.request().method(),'GET');return route.fulfill({json:{memory:{enabled:true,revision:'m1',entries:[{id:'memory-1',text:'Use USD for garment costings.',updatedAt:Date.now()}]}}});});
  await context.route('**/api/workspace/proxy',route=>{assert.equal(route.request().method(),'GET');return route.fulfill({json:{enabled:true,keys:[{id:'work-key',name:'Work laptop',createdAt:Date.now()}],settings:{revision:'0',mappings:{}},profiles:['regular','professional','expert'].map(profile=>({profile}))}});});
  await context.route('**/api/workspace/schedules**',route=>{assert.equal(route.request().method(),'GET');return route.fulfill({json:{schedules:[{id:'schedule-1',revision:'r1',title:'Morning production follow-up',prompt:'Review open approvals and prepare a buyer follow-up summary.',model:'regular',projectPath:'',frequency:'daily',timeZone:'Asia/Dhaka',time:'09:00',weekday:1,enabled:true,nextRunAt:Date.now()+3600000,runStatus:'completed'}]}});});
  await context.route('**/api/workspace/file-history',route=>{assert.equal(route.request().method(),'GET');return route.fulfill({json:{records:[]}});});
  await page.evaluate(()=>{window.__libraryFiles=[{path:'reports/buyer-follow-up-and-production-status-november.xlsx',name:'buyer-follow-up-and-production-status-november.xlsx',type:'file',depth:0},{path:'reports/meeting-notes.txt',name:'meeting-notes.txt',type:'file',depth:0}];});
  const settings=page.getByRole('dialog',{name:'Settings',exact:true});
  const snapshot=async(label,dialog=settings)=>{
    assert.ok(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1),label+' has no horizontal overflow');
    const bounds=await dialog.boundingBox(),viewport=page.viewportSize();assert.ok(bounds&&bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width+1&&bounds.y+bounds.height<=viewport.height+1,label+' fits viewport');
    assert.match(await dialog.evaluate(element=>getComputedStyle(element).fontFamily),/Inter|Segoe UI|sans-serif/);
    for(const body of await dialog.locator('.settings-modal-body:visible').all())assert.ok(await body.evaluate(element=>element.scrollWidth<=element.clientWidth+1),label+' content fits its panel');
    const title=dialog.locator('.settings-modal-title').first();if(await title.count())assert.match(await title.evaluate(element=>getComputedStyle(element).fontFamily),/Inter|Segoe UI|sans-serif/);
    await page.screenshot({path:path.join(output,`polish-${label}-${theme}-${width}.png`),animations:'disabled'});
  };
  for(const tab of ['General','Personalization','Account','Proxy','Usage','Scheduled','Library']){
    await nav(tab);
    if(tab==='Account'){
      await settings.getByRole('button',{name:'Edit name',exact:true}).waitFor();await settings.getByText('Your profile, plan and sign-in security.',{exact:true}).waitFor();
      const name=await settings.locator('.user-account dd > span').first().boundingBox();assert.ok(name&&name.width>=100&&name.height<100,'Long account names remain readable instead of squeezed beside an action');
    }
    if(tab==='General'){
      const appearance=settings.getByRole('combobox',{name:'Appearance',exact:true});assert.ok((await appearance.boundingBox()).width>=120);assert.ok(await appearance.inputValue());
    }
    if(tab==='Personalization')await settings.getByRole('button',{name:'Edit instructions',exact:true}).and(page.locator(':enabled')).waitFor();
    if(tab==='Proxy')await settings.getByRole('button',{name:'Revoke Work laptop',exact:true}).waitFor();
    if(tab==='Usage')await settings.getByRole('region',{name:'Your usage',exact:true}).waitFor();
    if(tab==='Scheduled')await settings.getByRole('heading',{name:'Morning production follow-up',exact:true}).waitFor();
    if(tab==='Library')await settings.getByRole('searchbox',{name:'Search library',exact:true}).waitFor();
    await page.locator('#user-settings-panel').evaluate(element=>{element.scrollTop=0;});
    await snapshot(tab.toLowerCase());
    assert.equal(await settings.getByRole('alert').count(),0,tab+' has no failed loads');
    if(tab==='Account'){
      for(const [button,title,close]of [['Edit name','Edit name','Close name editor'],['Change password','Change password','Close password editor'],['Manage devices','Signed-in devices','Close devices']]){
        await settings.getByRole('button',{name:button,exact:true}).click();const dialog=page.getByRole('dialog',{name:title,exact:true});await dialog.waitFor();await snapshot(title.toLowerCase().replaceAll(' ','-'),dialog);
        await dialog.getByRole('button',{name:close,exact:true}).click();
      }
      await settings.getByRole('status').filter({hasText:'Account editing cancelled.'}).waitFor();
    }
    if(tab==='Personalization'){
      await settings.getByRole('button',{name:'Edit instructions',exact:true}).click();let dialog=page.getByRole('dialog',{name:'Custom instructions',exact:true});await snapshot('instructions',dialog);await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
      await settings.getByRole('button',{name:'Manage memories',exact:true}).click();dialog=page.getByRole('dialog',{name:'Saved memories',exact:true});await dialog.getByText('Use USD for garment costings.',{exact:true}).waitFor();await snapshot('memories',dialog);await dialog.getByRole('button',{name:'Close saved memories',exact:true}).click();
    }
    if(tab==='Library'){
      const filter=settings.getByRole('combobox',{name:'File type',exact:true});await filter.selectOption('documents');await settings.getByRole('searchbox',{name:'Search library',exact:true}).fill('meeting');await settings.getByText('meeting-notes.txt',{exact:true}).waitFor();await snapshot('library-filtered');
      await settings.getByRole('button',{name:'File recovery',exact:true}).click();const dialog=page.getByRole('dialog',{name:'File recovery',exact:true});await dialog.getByText('No deleted files yet.',{exact:true}).waitFor();await snapshot('file-recovery',dialog);await dialog.getByRole('button',{name:'Close file recovery',exact:true}).click();
    }
  }
  await nav('Account');assert.equal(await settings.locator('form[action="/logout"]').count(),1);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  console.log(JSON.stringify({width,theme,tabs:7,dialogs:6,longValues:true,libraryFilter:true,errors:0,owner}));
}
