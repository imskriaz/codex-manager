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
    const [clearing,setClearing]=useState(false),[notice,setNotice]=useState(),[error,setError]=useState();
    window.repopulate=()=>{setSnapshot({capturedAt:Date.now(),requests});setNotice(undefined);};
    window.refreshCount=window.refreshCount??0;
    return <>{error?<p role="alert">{error}</p>:null}<ApiProxyPanel snapshot={snapshot} connected baseUrl={location.origin} clearing={clearing} clearNotice={notice} keyAccess={{tokens:[],enabled:true,pending:false,onCreate:()=>{},onLoad:()=>{},onRefresh:()=>{}}}
      onClear={()=>{window.clearCount=(window.clearCount??0)+1;setClearing(true);setNotice(undefined);setError(undefined);setTimeout(()=>{setClearing(false);if(window.failClear){setError('Proxy logs could not be cleared. Retry.');return;}setSnapshot({capturedAt:Date.now(),requests:[]});setNotice('Proxy request logs cleared.');},100);}}
      onRefresh={()=>{window.refreshCount++;setSnapshot(current=>({capturedAt:Date.now(),requests:current.requests.map(row=>row.id==='claude'?{...row,status:'completed',httpStatus:200,durationMs:1250,firstOutputMs:350,inputTokens:900,outputTokens:100}:row)}));}}/></>;
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
    assert.equal(await page.locator('.api-proxy-diagram-pane,.api-proxy-routes').count(),0,'The route panel is removed');
    assert.equal(await page.getByRole('heading',{name:'Request route',exact:true}).count(),0);
    assert.equal(await page.locator('.api-log-actions button').last().getAttribute('aria-label'),'Proxy connection settings','Settings follows All logs');
    assert.equal(await page.locator('.api-log-actions button').nth(2).getAttribute('aria-label'),'Show all logs');
    assert.ok((await rows.first().innerText()).includes('claude-opus'));
    assert.ok((await rows.first().innerText()).includes('gpt-codex'));
    const bounds=await page.locator('.api-log-actions').boundingBox();
    const pane=await page.locator('.api-proxy-log-pane').boundingBox();
    const panel=await page.locator('.api-proxy-panel').boundingBox();
    assert.ok(Math.abs(pane.x-panel.x)<2 && Math.abs(pane.width-panel.width)<2,'Logs span the full proxy panel');
    assert.ok(bounds.x>=pane.x && bounds.x+bounds.width<=pane.x+pane.width,'All log actions fit inside the card at every width');
    await page.screenshot({path:path.join(output,'proxy-running-'+theme+'-'+width+'.png')});
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
    const clear=page.getByRole('button',{name:'Clear proxy logs'});
    await page.evaluate(()=>{window.failClear=true;});
    await clear.click();
    assert.equal(await clear.isDisabled(),true,'Clear cannot be submitted twice while pending');
    await page.getByRole('alert').filter({hasText:'could not be cleared'}).waitFor();
    assert.equal(await rows.count(),4,'A failed clear preserves recorded rows');
    await page.evaluate(()=>{window.failClear=false;});
    await clear.click();
    await page.getByRole('status').filter({hasText:'Proxy request logs cleared.'}).waitFor();
    assert.equal(await rows.count(),0);
    assert.equal(await clear.isDisabled(),true,'Clearing an empty log is disabled');
    await page.getByRole('button',{name:'Refresh proxy'}).click();
    assert.equal(await rows.count(),0,'Refreshing does not restore deleted rows');
    await page.evaluate(()=>window.repopulate());
    assert.equal(await rows.count(),4,'New traffic can appear after clearing');
    assert.equal(await page.evaluate(()=>window.clearCount),2,'A failed action only retries on the next click');
    assert.deepEqual(errors,[]);
    results.push({theme,width,elapsedMs:Date.now()-started});
    await page.close();
  }
  console.log(JSON.stringify({results,screenshots:output},null,2));
} finally {await browser.close();}
