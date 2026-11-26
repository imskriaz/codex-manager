import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { useWorkspaceDashboardAssets } from './workspace-dashboard-assets.mjs';

const origin = 'http://127.0.0.1:39875';
const output = path.resolve('output/playwright/codex-models');
await mkdir(output, { recursive: true });
const css = await readFile('media/webview/quotaSummary.css', 'utf8');
const bundle = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'models-ui.tsx', loader: 'tsx', contents: `
import { render } from 'preact';import { useState } from 'preact/hooks';
import { CodexModelsSetting } from './webview-src/dashboard/codexModelsSetting';
function App(){const [saved,setSaved]=useState('gpt-6.2-sol\\ngpt-6.2-astra');return <main><CodexModelsSetting saved={saved} onSaved={setSaved} connected sendAction={(action,_account,payload)=>{const requestId=crypto.randomUUID();window.__requests.push({action,payload});if(action==='manageCodexModels'&&window.__mode!=='hold')setTimeout(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:action-result',requestId,action,status:window.__mode==='error'?'failed':'completed',error:window.__mode==='error'?'The account cannot use this model.':undefined,payload:{codexModels:{ids:payload.codexModelRequest.operation==='load'?'loaded-model':payload.codexModelRequest.ids,message:payload.codexModelRequest.operation==='load'?'Loaded 1 model.':payload.codexModelRequest.operation==='save'?'Fallback models saved.':'Model test completed successfully.'}}}})),10);return requestId;}}/></main>;}render(<App/>,document.getElementById('app'));
` }, bundle: true, write: false, format: 'esm', jsx: 'automatic', jsxImportSource: 'preact' });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
 for (const width of [1440,390]) {
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await useWorkspaceDashboardAssets(page,origin);
  const started=performance.now();await page.goto(origin);await page.locator('.cli-workspace').waitFor();
  const rail=page.getByRole('button',{name:'Show sessions sidebar',exact:true});if(await rail.isVisible())await rail.click();
  await page.getByRole('button',{name:'Account menu',exact:true}).click();await page.getByRole('menuitem',{name:'Settings',exact:true}).click();
  if(width===390)await page.getByRole('combobox',{name:'Settings section',exact:true}).selectOption('sessions');else await page.getByRole('tab',{name:'Workspace',exact:true}).click();
  await page.getByRole('heading',{name:'Codex fallback models',exact:true}).waitFor();
  assert.equal(await page.getByText('Local Whisper dictation',{exact:true}).count(),0);
  assert.ok(await page.getByRole('button',{name:'Clear all',exact:true}).count());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(output,`settings-${width}.png`)});
  console.log(JSON.stringify({width,loadMs:Math.round(performance.now()-started),checks:'read-only live dashboard, fallback settings, browser-only dictation, no page errors, responsive layout'}));
  await context.close();
 }
 for(const host of ['browser','vscode'])for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:900}});const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.addInitScript(()=>{window.__requests=[];window.__mode='success';});
  await page.route(origin+'/?model-settings-check',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html data-dashboard-host="${host}" data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\nbody{padding:16px;margin:0;box-sizing:border-box;min-width:0}main{max-width:640px;min-width:0;margin:auto}</style></head><body><div id="app"></div><script type="module">${bundle.outputFiles[0].text}</script></body></html>`}));
  await page.goto(origin+'/?model-settings-check');
  await page.getByRole('button',{name:'Load models',exact:true}).click();await page.getByRole('status').filter({hasText:'Loaded 1 model.'}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:/^Fallback model /}).count(),1,'Loading replaces stale fallback entries');
  assert.equal(await page.getByRole('textbox',{name:'Fallback model 1',exact:true}).inputValue(),'loaded-model');
  await page.getByRole('button',{name:'Test loaded-model',exact:true}).click();await page.getByRole('status').filter({hasText:'Model test completed successfully.'}).first().waitFor();
  await page.getByRole('button',{name:'Add model',exact:true}).click();await page.getByRole('textbox',{name:'Fallback model 2',exact:true}).fill('custom-model');
  await page.getByRole('button',{name:'Save fallback models',exact:true}).click();await page.getByRole('status').filter({hasText:'Fallback models saved.'}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'Fallback model 2',exact:true}).inputValue(),'custom-model','Saved edits remain visible');
  await page.evaluate(()=>window.__mode='error');await page.getByRole('button',{name:'Test custom-model',exact:true}).click();await page.getByRole('alert').filter({hasText:'The account cannot use this model.'}).first().waitFor();
  await page.evaluate(()=>window.__mode='hold');await page.clock.install();await page.getByRole('button',{name:'Test custom-model',exact:true}).click();await page.clock.fastForward(35_100);await page.getByRole('alert').filter({hasText:'outcome is unconfirmed'}).first().waitFor();
  assert.equal(await page.getByRole('textbox',{name:'Fallback model 2',exact:true}).inputValue(),'custom-model');
  await page.evaluate(()=>window.__mode='success');
  await page.getByRole('button',{name:'Clear all',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:/^Fallback model /}).count(),0,'Clear all removes every editable fallback');
  await page.getByRole('button',{name:'Save fallback models',exact:true}).click();await page.getByRole('status').filter({hasText:'Fallback models saved.'}).waitFor();
  assert.equal(await page.evaluate(()=>window.__requests.filter(request=>request.payload?.codexModelRequest?.operation==='save').at(-1).payload.codexModelRequest.ids),'','Saving the cleared list sends an explicit empty value');
  await page.getByRole('button',{name:'Load models',exact:true}).click();await page.getByRole('status').filter({hasText:'Loaded 1 model.'}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'Fallback model 1',exact:true}).inputValue(),'loaded-model','Reload rebuilds the cleared catalogue');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),JSON.stringify(await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,over:[...document.querySelectorAll('body *')].filter(n=>n.getBoundingClientRect().right>innerWidth+2).slice(0,8).map(n=>({tag:n.tagName,cls:n.className,box:n.getBoundingClientRect().toJSON()}))}))));
  assert.deepEqual(errors,[]);await page.screenshot({path:path.join(output,`feedback-${host}-${width}.png`)});console.log(JSON.stringify({host,width,checks:'live load, save persistence, test success, native failure, timeout, preserved edits, responsive feedback'}));await context.close();
 }
}finally{await browser.close();}
