import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

const origin = 'http://127.0.0.1:39875';
const output = path.resolve('output/playwright/runtime-modules');
await mkdir(output, { recursive: true });
const css = await readFile('media/webview/quotaSummary.css', 'utf8');
const bundle = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'runtime-ui.tsx', loader: 'tsx', contents: `
import { render } from 'preact'; import { useState } from 'preact/hooks';
import { WorkspaceRuntimeSettings } from './webview-src/dashboard/workspaceRuntimeSettings';
function App(){const [settings,setSettings]=useState({codexModuleEnabled:false,claudeModuleEnabled:false});return <main><WorkspaceRuntimeSettings settings={settings} connected parentOpen onEnabled={provider=>setSettings(value=>({...value,[provider+'ModuleEnabled']:true}))} onDisable={provider=>setSettings(value=>({...value,[provider+'ModuleEnabled']:false}))} sendAction={(action,_account,payload)=>{const requestId=crypto.randomUUID();window.__requests.push(payload.runtimeRequest);if(window.__mode==='hold')return requestId;setTimeout(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:action-result',requestId,action,status:window.__mode==='error'?'failed':'completed',error:window.__mode==='error'?'Download failed: no disk space.':undefined,payload:{workspaceRuntime:{provider:payload.runtimeRequest.provider,available:payload.runtimeRequest.operation==='enable'||window.__mode!=='missing',enabled:payload.runtimeRequest.operation==='enable',loginCommand:"& 'C:/Runtime/claude.exe' auth login",message:payload.runtimeRequest.operation==='enable'?'Runtime verified and module enabled.':'Runtime checked.'}}}})),25);return requestId;}}/></main>;}render(<App/>,document.getElementById('app'));
` }, bundle: true, write: false, format: 'esm', jsx: 'automatic', jsxImportSource: 'preact' });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [1440,390]) {
    const context = await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message)); page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await useWorkspaceDashboardAssets(page,origin);
    const started=performance.now(); await page.goto(origin); await page.locator('.cli-workspace').waitFor();
    const rail=page.getByRole('button',{name:'Show sessions sidebar',exact:true}); if(await rail.isVisible())await rail.click();
    await page.getByRole('button',{name:'Account menu',exact:true}).click();await page.getByRole('menuitem',{name:'Settings',exact:true}).click();
    if(width===390)await page.getByRole('combobox',{name:'Settings section',exact:true}).selectOption('sessions');else await page.getByRole('tab',{name:'Workspace',exact:true}).click();
    await page.getByRole('heading',{name:'Session modules',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Codex',exact:true}).count(),1);
    assert.equal(await page.getByRole('button',{name:'Claude',exact:true}).count(),1);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(output,`live-settings-${width}.png`)});
    console.log(JSON.stringify({width,loadMs:Math.round(performance.now()-started),checks:'read-only local Workspace settings, no console errors, responsive module switches'}));await context.close();
  }
  for(const host of ['browser','vscode'])for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:900}});const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await page.addInitScript(()=>{window.__requests=[];window.__mode='missing';});
    await page.route(origin+'/?runtime-module-check',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html data-dashboard-host="${host}" data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css} body{padding:16px;margin:0;box-sizing:border-box;min-width:0}main{max-width:640px;min-width:0;margin:auto}</style></head><body><div id="app"></div><script type="module">${bundle.outputFiles[0].text}</script></body></html>`}));
    await page.goto(origin+'/?runtime-module-check');
    const codex=page.getByRole('button',{name:'Codex',exact:true}),claude=page.getByRole('button',{name:'Claude',exact:true});
    await codex.click();const dialog=page.getByRole('dialog',{name:'Set up Codex module',exact:true});await dialog.getByRole('button',{name:'Done',exact:true}).waitFor();
    assert.equal(await codex.getAttribute('aria-pressed'),'true');assert.equal(await claude.getAttribute('aria-pressed'),'false');
    assert.deepEqual(await page.evaluate(()=>window.__requests),[{provider:'codex',operation:'check'},{provider:'codex',operation:'enable'}]);
    await dialog.getByText('Sign in on this host',{exact:false}).waitFor();await page.screenshot({path:path.join(output,`success-${host}-${width}.png`)});await dialog.getByRole('button',{name:'Done',exact:true}).click();
    await page.evaluate(()=>window.__mode='error');await claude.click();const claudeDialog=page.getByRole('dialog',{name:'Set up Claude module',exact:true});await claudeDialog.getByRole('alert').filter({hasText:'no disk space'}).waitFor();
    assert.equal(await claude.getAttribute('aria-pressed'),'false');await page.evaluate(()=>window.__mode='success');await claudeDialog.getByRole('button',{name:'Retry setup',exact:true}).click();await claudeDialog.getByRole('button',{name:'Done',exact:true}).waitFor();await claudeDialog.getByRole('button',{name:'Done',exact:true}).click();
    await claude.click();assert.equal(await claude.getAttribute('aria-pressed'),'false');
    await page.evaluate(()=>window.__mode='hold');await page.clock.install();await claude.click();await page.clock.fastForward(120_100);await claudeDialog.getByRole('alert').filter({hasText:'outcome is unconfirmed'}).waitFor();
    assert.equal(await claude.getAttribute('aria-pressed'),'false');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(output,`timeout-${host}-${width}.png`)});console.log(JSON.stringify({host,width,checks:'detect then enable, isolated providers, install success, failure, retry, disable, timeout feedback'}));await context.close();
  }
}finally{await browser.close();}
