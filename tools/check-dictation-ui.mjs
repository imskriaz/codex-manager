import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:39875';
assert.ok((await fetch(origin)).ok, 'The read-only local dashboard is available');
const output = path.resolve('output/playwright/dictation');
await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'dictation-ui.tsx', loader: 'tsx', contents: `
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { VoiceDictation } from './webview-src/dashboard/voiceDictation';
function App(){
 const [draft,setDraft]=useState('Existing draft');
 return <main><div class="cli-composer"><textarea aria-label="Message" value={draft} onInput={e=>setDraft(e.currentTarget.value)}/>
 <VoiceDictation onText={text=>{setDraft(value=>value+' '+text);return true;}} onFeedback={notice=>window.__feedback.push(notice)}/></div></main>;
}render(<App/>,document.getElementById('app'));
` }, bundle: true, write: false, format: 'esm', jsx: 'automatic', jsxImportSource: 'preact' });
const css = await readFile('media/webview/quotaSummary.css', 'utf8');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
 for (const host of ['browser', 'vscode']) for (const width of [1440, 390]) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e=>errors.push(e.message)); page.on('console', m=>{if(m.type()==='error')errors.push(m.text());});
  await page.addInitScript(() => {
   window.__feedback=[];window.__requests=[];
   window.acquireVsCodeApi=()=>({postMessage(message){window.__requests.push(message);}});
   window.SpeechRecognition=class{start(){window.__recognition=this;this.onstart?.();}stop(){this.onend?.();}abort(){}};
  });
  await page.route(origin+'/?dictation-check', route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html data-dashboard-host="${host}" data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\nbody{padding:18px;margin:0;box-sizing:border-box}#app{width:100%;min-width:0}main{max-width:560px;margin:auto}textarea{width:100%;box-sizing:border-box}</style></head><body><div id="app"></div><script type="module">${bundle.outputFiles[0].text}</script></body></html>`}));
  const started=performance.now();await page.goto(origin+'/?dictation-check');
  const mic=page.getByRole('button',{name:'Dictate message',exact:true});await mic.waitFor();
  const loadMs=Math.round(performance.now()-started);
  await mic.click();const modal=page.getByRole('dialog',{name:'Voice dictation',exact:true});await modal.waitFor();
  await modal.getByRole('button',{name:'Start dictation',exact:true}).click();
  await page.evaluate(()=>window.__recognition.onresult({resultIndex:0,results:[{isFinal:true,0:{transcript:'Browser words'}}]}));
  await modal.getByRole('button',{name:'Stop',exact:true}).click();
  await modal.getByRole('button',{name:'Use text',exact:true}).click();
  assert.equal(await page.getByRole('textbox',{name:'Message',exact:true}).inputValue(),'Existing draft Browser words');
  await mic.click();await modal.waitFor();await modal.getByRole('button',{name:'Start dictation',exact:true}).click();
  await page.evaluate(()=>window.__recognition.onerror({error:'not-allowed'}));
  await modal.getByRole('alert').filter({hasText:'Microphone access was denied'}).waitFor();
  await page.screenshot({path:path.join(output,`${host}-${width}.png`)});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'Dictation fits the viewport');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('textbox',{name:'Message',exact:true}).inputValue(),'Existing draft Browser words');
  assert.deepEqual(await page.evaluate(()=>window.__requests),[],'Browser dictation sends no host actions');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({host,width,loadMs,checks:'browser review modal, transcript append, denied microphone, preserved draft, no host calls, console and responsive layout'}));
  await context.close();
 }
} finally { await browser.close(); }
console.log('Screenshots: '+output);
