import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {useWorkspaceDashboardAssets} from './workspace-dashboard-assets.mjs';

const origin='http://127.0.0.1:39875';
const raw=await(await fetch(origin+'/api/state')).json();
const output=path.resolve('output/settings-dropdowns');await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL==='bundled'?{}:{channel:'msedge'})});
try{
  for(const theme of ['light','dark'])for(const width of [1440,390,320]){
    const height=width===320?674:960;
    const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(15000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    const state={...raw,accounts:[],connectedPeers:[],peerAccounts:{},office:{id:'master',role:'unrestricted-admin',enabled:true,features:[],displayName:'Administrator'},settings:{...raw.settings,dashboardTheme:theme,webDashboardEnabled:true,teamWorkspaceEnabled:true,cliIntegrationEnabled:true}};
    const host=`(()=>{const state=${JSON.stringify(state)};const dispatch=data=>dispatchEvent(new MessageEvent('message',{data}));window.acquireVsCodeApi=()=>({getState(){return{}},setState(){},postMessage(message){setTimeout(()=>{if(message.type==='dashboard:ready'||message.type==='dashboard:workspace-presence'){dispatch({type:'dashboard:snapshot',state});dispatch({type:'dashboard:connection',connected:true});}else if(message.type==='dashboard:action')dispatch({type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:'completed',payload:message.action==='listCodexCliSessions'?{cliSessions:[],cliComposerConfig:{models:[],projects:[],defaultSandboxMode:'workspace-write',terminalSupported:false}}:{}});},5)}})})();`;
    await useWorkspaceDashboardAssets(page,origin,context);
    await context.route('**/assets/browserHost.js*',route=>route.fulfill({contentType:'text/javascript',body:host}));
    await context.route('**/api/office/**',route=>{
      assert.equal(route.request().method(),'GET','The local host receives no settings writes');
      const pathname=new URL(route.request().url()).pathname;
      if(pathname.endsWith('/settings'))return route.fulfill({json:{workspaceRoot:'C:/workspaces',databaseProvider:'sqlite',postgresConfigured:false,maxActiveRequests:2,defaultModel:'fast',regularModel:'fast',professionalModel:'quality',expertModel:'deep',routerModel:'fast',modelMode:'manual',globalPrompt:'Help users get work done.',services:{revision:'initial',rendererUrl:'',runtimeUrl:'',searchDomains:[],rendererConfigured:false,runtimeConfigured:false,searchConfigured:false}}});
      if(pathname.endsWith('/models'))return route.fulfill({json:{models:[{id:'fast',label:'Fast'},{id:'quality',label:'Quality'},{id:'deep',label:'Deep'}]}});
      return route.fulfill({json:{users:[],servers:[],entries:[],sessions:[],requests:[]}});
    });
    const start=Date.now();await page.goto(origin+'/?settings=users');
    const section=page.getByRole('combobox',{name:'Workspace section',exact:true});await section.waitFor();
    await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
    const check=async()=>{
      let count=0;
      for(const select of await page.locator('.settings-modal select:visible').all()){
        const style=await select.evaluate(element=>{const bounds=element.getBoundingClientRect(),css=getComputedStyle(element),option=element.options[0];return {height:bounds.height,width:bounds.width,right:bounds.right,left:bounds.left,appearance:css.appearance,radius:css.borderRadius,color:css.color,background:css.backgroundColor,optionColor:option?getComputedStyle(option).color:'',optionBackground:option?getComputedStyle(option).backgroundColor:''};});
        assert.ok(style.height>=(width<600?40:36));assert.ok(style.width>80&&style.left>=0&&style.right<=width+1);assert.equal(style.appearance,'none');assert.notEqual(style.radius,'0px');assert.notEqual(style.color,style.background);assert.equal(style.optionColor,style.color);assert.notEqual(style.optionColor,style.optionBackground);assert.notEqual(style.optionBackground,'rgba(0, 0, 0, 0)');count++;
      }
      return count;
    };
    assert.ok(await check()>0);await page.screenshot({path:path.join(output,`users-${theme}-${width}.png`)});
    await section.focus();assert.equal(await section.evaluate(element=>getComputedStyle(element).outlineStyle),'solid');
    await section.selectOption('workspace');await page.getByRole('textbox',{name:'Global User Workspace Prompt',exact:true}).waitFor();const workspaceSelects=await check();assert.ok(workspaceSelects>1);
    await page.screenshot({path:path.join(output,`workspace-${theme}-${width}.png`)});
    await section.selectOption('database');await page.getByRole('combobox',{name:/^Database provider/}).waitFor();await check();
    await page.screenshot({path:path.join(output,`database-${theme}-${width}.png`)});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
    console.log(JSON.stringify({width,theme,workspaceSelects,elapsedMs:Date.now()-start,optionContrast:true,focus:true,errors:0}));await context.close();
  }
}finally{await browser.close();}
