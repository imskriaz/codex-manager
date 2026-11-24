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
import { LocalWhisperStatus } from './webview-src/dashboard/localWhisperStatus';
function App(){
 const [enabled,enable]=useState(false),[draft,setDraft]=useState('Existing draft'),[scope,setScope]=useState('one');
 return <main><label><input type="checkbox" checked={enabled} onChange={e=>enable(e.currentTarget.checked)}/>Local Whisper dictation</label>
 <p>Enabling downloads the runtime and multilingual model (about 500 MB). Browser dictation is the default.</p>
 <LocalWhisperStatus enabled={enabled}/>
 <div class="cli-composer" style="position:relative;margin-top:100px"><textarea aria-label="Message" value={draft} onInput={e=>setDraft(e.currentTarget.value)}/>
 <VoiceDictation localWhisperEnabled={enabled} scope={scope} onText={text=>{setDraft(value=>value+' '+text);return true;}} onFeedback={notice=>window.__feedback.push(notice)}/></div>
 <button onClick={()=>setScope(value=>value==='one'?'two':'one')}>Switch composer</button></main>;
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
   window.__feedback=[];window.__requests=[];window.__ready=true;window.__mode='success';window.__micStops=0;
   window.acquireVsCodeApi=()=>({postMessage(message){window.__requests.push(message);const operation=message.payload?.dictationRequest?.operation;
    const reply=()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dashboard:action-result',requestId:message.requestId,action:message.action,status:window.__mode==='error'&&operation==='transcribe'?'failed':'completed',error:'Local transcription failed. Your draft is kept.',payload:{dictation:operation==='transcribe'?{ready:true,text:'বাংলা 日本語 مرحبا',language:'bn'}:{ready:window.__ready,message:window.__ready?'Local Whisper is ready.':'Downloading the multilingual model…'}}}}));
    if(operation==='transcribe'&&window.__mode==='hold')window.__release=reply;else setTimeout(reply,10);
   }});
   window.SpeechRecognition=class{start(){window.__recognition=this;this.onstart?.();}stop(){this.onend?.();}abort(){}};
   Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{window.__micStarts=(window.__micStarts||0)+1;if(window.__mode==='denied')throw {name:'NotAllowedError'};return {getTracks:()=>[{stop:()=>window.__micStops++}]};}}});
   window.AudioContext=class{
    sampleRate=16000;destination={};
    createMediaStreamSource(){return {connect(){},disconnect(){}};}
    createScriptProcessor(){window.__processor={connect(){},disconnect(){}};return window.__processor;}
    createGain(){return {gain:{value:0},connect(){},disconnect(){}};}
    close(){return Promise.resolve();}resume(){return Promise.resolve();}
   };
   window.__frame=()=>window.__processor.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(16000).fill(.1)}});
  });
  await page.route(origin+'/?dictation-check', route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html data-dashboard-host="${host}" data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\nbody{padding:18px;margin:0;box-sizing:border-box}#app{width:100%;min-width:0}main{max-width:560px;margin:auto}textarea{width:100%;box-sizing:border-box}</style></head><body><div id="app"></div><script type="module">${bundle.outputFiles[0].text}</script></body></html>`}));
  const started=performance.now();await page.goto(origin+'/?dictation-check');
  const mic=page.getByRole('button',{name:'Dictate message',exact:true});await mic.waitFor();
  const loadMs=Math.round(performance.now()-started);
  await mic.click();const modal=page.getByRole('dialog',{name:'Voice dictation',exact:true});await modal.waitFor();
  assert.equal(await page.evaluate(()=>window.__micStarts||0),0,'Default browser opens the existing review modal');
  await modal.getByRole('button',{name:'Start dictation',exact:true}).click();
  await page.evaluate(()=>window.__recognition.onresult({resultIndex:0,results:[{isFinal:true,0:{transcript:'Browser words'}}]}));
  await modal.getByRole('button',{name:'Stop',exact:true}).click();await modal.getByRole('button',{name:'Use text',exact:true}).click();
  const composer=page.getByRole('textbox',{name:'Message',exact:true});await composer.waitFor();assert.match(await composer.inputValue(),/Browser words/);
  await page.evaluate(()=>window.__ready=false);await page.getByRole('checkbox').check();await page.getByRole('status').filter({hasText:'Downloading the multilingual model'}).waitFor();
  await mic.click();await page.getByRole('button',{name:'Stop dictation',exact:true}).waitFor();
  assert.equal(await modal.count(),0,'Local mode starts without a modal');await page.evaluate(()=>{window.__frame();window.__ready=true;});
  await page.getByRole('button',{name:'Stop dictation',exact:true}).click();await mic.waitFor();
  await page.waitForFunction(()=>document.querySelector('textarea[aria-label=Message]').value.includes('বাংলা 日本語 مرحبا'));
  assert.match(await composer.inputValue(),/^Existing draft Browser words/);
  assert.ok(await page.evaluate(()=>window.__micStops>0));
  await page.screenshot({path:path.join(output,`${host}-${width}-layout.png`)});assert.deepEqual(await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,over:[...document.querySelectorAll('body *')].filter(n=>n.getBoundingClientRect().right>innerWidth+2).slice(0,8).map(n=>({tag:n.tagName,cls:n.className,box:n.getBoundingClientRect().toJSON()}))})),{width,scroll:width,over:[]});
  await page.screenshot({path:path.join(output,`${host}-${width}.png`)});
  await page.evaluate(()=>window.__mode='error');await mic.click();await page.getByRole('button',{name:'Stop dictation',exact:true}).waitFor();await page.evaluate(()=>window.__frame());await page.getByRole('button',{name:'Stop dictation',exact:true}).click();await page.getByRole('alert').filter({hasText:'Local transcription failed'}).waitFor();await page.getByRole('link',{name:'Save recording'}).waitFor();
  const saved=await composer.inputValue();
  await page.evaluate(()=>window.__mode='hold');await mic.click();await page.getByRole('button',{name:'Stop dictation',exact:true}).waitFor();await page.evaluate(()=>window.__frame());await page.getByRole('button',{name:'Stop dictation',exact:true}).click();await page.waitForFunction(()=>!!window.__release);await page.getByRole('button',{name:'Switch composer'}).click();await page.evaluate(()=>window.__release());await page.waitForTimeout(100);assert.equal(await composer.inputValue(),saved,'Late results cannot write into another composer');
  await page.evaluate(()=>window.__mode='denied');await mic.click();await page.getByRole('alert').filter({hasText:'Microphone access was denied'}).waitFor();
  assert.deepEqual(errors,[]);console.log(JSON.stringify({host,width,loadMs,checks:'browser default modal, optional download status, immediate local mic, Unicode composer append, recording recovery, stale-result cancellation, denied microphone, console and responsive layout'}));
  await context.close();
 }
} finally { await browser.close(); }
console.log('Screenshots: '+output);
