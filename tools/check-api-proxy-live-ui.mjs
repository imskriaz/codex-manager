import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const origin = 'http://127.0.0.1:39875';
assert.equal((await fetch(origin + '/api/state')).ok, true);
const output = path.join(tmpdir(), 'codex-manager-proxy-live-ui');
await mkdir(output, { recursive: true });
const compiled = await build({ stdin: { contents: `
  import { render } from 'preact';
  import { useState } from 'preact/hooks';
  import { ApiProxyPanel } from './webview-src/dashboard/apiProxyPanel';
  const now=Date.now();
  const requests=[
    {id:'claude',startedAt:now,method:'POST',path:'/v1/messages',model:'claude-opus',upstreamModel:'gpt-codex',accountId:'account',accountEmail:'fixture@example.test',apiKeyName:'Claude proxy',status:'running'},
    {id:'validation',startedAt:now,method:'POST',path:'/v1/messages',status:'failed',httpStatus:400,error:'Request validation failed',errorDetail:'Unsupported request parameter.'},
    {id:'stream',startedAt:now,method:'POST',path:'/v1/messages',model:'claude-opus',upstreamModel:'gpt-codex',accountId:'account',accountEmail:'fixture@example.test',apiKeyName:'Claude proxy',status:'failed',httpStatus:200,errorStatus:502,error:'Stream failed',errorDetail:'The backend returned inconsistent response text.',durationMs:900},
    {id:'estimate',startedAt:now,method:'POST',path:'/v1/messages/count_tokens',model:'claude-opus',apiKeyName:'Claude proxy',status:'completed',httpStatus:200,durationMs:3,estimatedInputTokens:900}
  ];
  function App(){
    const [snapshot,setSnapshot]=useState({capturedAt:now,requests});
    window.refreshCount=window.refreshCount??0;
    return <ApiProxyPanel snapshot={snapshot} connected baseUrl={location.origin} keyAccess={{tokens:[],enabled:true,pending:false,onCreate:()=>{},onLoad:()=>{},onRefresh:()=>{}}}
      onRefresh={()=>{window.refreshCount++;setSnapshot({capturedAt:Date.now(),requests:requests.map(row=>row.id==='claude'?{...row,status:'completed',httpStatus:200,durationMs:1250,firstOutputMs:350,inputTokens:900,outputTokens:100}:row)});}}/>;
  }
  render(<App/>,document.getElementById('app'));
`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', jsx: 'automatic', jsxImportSource: 'preact' });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const theme of ['dark','light']) for (const width of [1440,390,320]) {
    const page = await browser.newPage({ viewport: { width, height: 950 }, serviceWorkers: 'block' });
    const errors = [];
    page.on('pageerror', error=>errors.push(error.message));
    page.on('console', entry=>{if(entry.type()==='error')errors.push(entry.text());});
    await page.route('**/*', route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/__proxy-live')return route.fulfill({contentType:'text/html',body:'<!doctype html><html data-theme="'+theme+'"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="app" style="height:100vh;width:100%;overflow:hidden"></div><script type="module" src="/__proxy-live.js"></script></body></html>'});
      if(url.pathname==='/__proxy-live.js')return route.fulfill({contentType:'text/javascript',body:compiled.outputFiles[0].text});
      return route.abort();
    });
    const started=Date.now();
    await page.goto(origin+'/__proxy-live');
    for(const file of ['shared.css','quotaSummary.css'])await page.addStyleTag({content:await readFile('media/webview/'+file,'utf8')});
    const rows=page.locator('.api-proxy-table tbody tr');
    assert.equal(await rows.count(),4);
    assert.ok(await rows.evaluateAll(rows=>rows.every(row=>row.getBoundingClientRect().height<=36)),'Request rows use one compact line');
    const route=page.getByRole('img',{name:'Proxy routes from saved accounts to API keys'});
    assert.equal(await route.locator('.is-account').count(),1,'Only actual account routes are shown');
    assert.ok(!(await route.innerText()).includes('Account unavailable'));
    assert.ok((await rows.first().innerText()).includes('claude-opus'));
    assert.ok((await rows.first().innerText()).includes('gpt-codex'));
    await page.getByRole('button',{name:'Proxy connection settings'}).click();
    const dialog=page.getByRole('dialog',{name:'Proxy connection'});
    assert.deepEqual(await dialog.getByRole('tab').allTextContents(),['Claude','Codex']);
    assert.equal(await dialog.getByRole('tab',{name:'Claude',exact:true}).getAttribute('aria-selected'),'true');
    const before=await page.evaluate(()=>window.refreshCount);
    await page.waitForFunction(previous=>window.refreshCount>previous,before,{timeout:6000});
    assert.ok((await rows.first().innerText()).includes('completed'),'Request status refreshes while the connection dialog is open');
    await dialog.getByRole('tab',{name:'Codex',exact:true}).click();
    await dialog.getByRole('button',{name:'Close proxy connection'}).click();
    await page.getByRole('button',{name:'Proxy connection settings'}).click();
    assert.equal(await dialog.getByRole('tab',{name:'Claude',exact:true}).getAttribute('aria-selected'),'true','Reopening resets to Claude');
    await dialog.getByRole('button',{name:'Close proxy connection'}).click();
    assert.equal(await rows.first().locator('td').nth(4).getAttribute('title'),'First output: 350 ms');
    assert.ok((await rows.nth(2).innerText()).includes('Error 502'),'Stream errors show their failure status after HTTP 200');
    await page.getByRole('button',{name:'Show all logs'}).click();
    assert.ok((await rows.nth(2).innerText()).includes('inconsistent response text'));
    assert.ok(await rows.evaluateAll(rows=>rows.every(row=>row.getBoundingClientRect().height<=36)),'Details retain a single line');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'Horizontal overflow stays inside the request table');
    await page.screenshot({path:path.join(output,'proxy-'+theme+'-'+width+'.png')});
    assert.deepEqual(errors,[]);
    results.push({theme,width,elapsedMs:Date.now()-started});
    await page.close();
  }
  console.log(JSON.stringify({results,screenshots:output},null,2));
} finally {await browser.close();}
