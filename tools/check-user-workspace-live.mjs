import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {useWorkspaceDashboardAssets} from './workspace-dashboard-assets.mjs';

// Explicit opt-in: uses the named existing account and performs real requests and writes.
const username=process.argv.find(value=>value.startsWith('--username='))?.slice(11);
if(!process.argv.includes('--live')||!username)throw Error('Use --live --username=<account>. Sign in interactively; never pass a password.');
const origin='http://127.0.0.1:39875',root=await mkdtemp(path.join(os.tmpdir(),'codex-manager-user-journey-'));
const report={checks:[],files:[],sessions:[]};
const record=(name,details={})=>{report.checks.push({name,...details});console.log(JSON.stringify({name,...details}));};
const browser=await chromium.launch({channel:'msedge',headless:false});
// A forwarded request must authenticate even on loopback; never inherit local administrator access.
const context=await browser.newContext({viewport:{width:1280,height:900},extraHTTPHeaders:{'X-Forwarded-For':'127.0.0.1'}});
const page=await context.newPage();page.setDefaultTimeout(15000);
try{
 await page.goto(origin+'/login?returnTo=/workspace');
 await page.locator('input[name="username"]').fill(username);
 console.log('Sign in in the opened test browser. No password is read or recorded.');
 const deadline=Date.now()+300000;let state;
 while(Date.now()<deadline){
  const response=await context.request.get(origin+'/api/state');
  if(response.ok()){state=await response.json();if(state.office?.username===username&&state.office.role==='user')break;}
  await new Promise(resolve=>setTimeout(resolve,1500));
 }
 assert.equal(state?.office?.username,username,'Sign-in was not completed within five minutes');
 assert.equal(state.office.role,'user');assert.deepEqual(state.accounts,[]);record('real subscriber sign-in and private state');
 const action=async(name,payload={})=>{
  const response=await context.request.post(origin+'/api/message',{headers:{Origin:origin,'X-Codex-Dashboard':'1'},data:{type:'dashboard:action',requestId:randomUUID(),action:name,payload}});
  assert.equal(response.ok(),true,`Action HTTP ${response.status()}`);return (await response.json()).messages.find(message=>message.type==='dashboard:action-result');
 };
 await useWorkspaceDashboardAssets(page,origin,context);await page.goto(origin+'/workspace');
 await page.getByRole('button',{name:'Start a new chat',exact:true}).click();
 const model=page.getByRole('combobox',{name:'Model',exact:true});await model.waitFor();assert.equal(await model.inputValue(),'gpt-6-luna');record('Luna default and visible model picker');
 await page.locator('.cli-composer textarea').fill('QA: In one sentence explain a time and action calendar for garment merchandising. Do not create files.');
 await page.getByRole('button',{name:'Send message',exact:true}).click();await page.waitForURL(/\/workspace\/[a-f0-9-]{36}/);
 const id=page.url().split('/').at(-1);report.sessions.push(id);
 const wait=async()=>{const end=Date.now()+110000;while(Date.now()<end){const result=await action('getCodexCliSessionMessages',{sessionId:id});assert.equal(result.status,'completed',result.error);if(result.payload.cliSession.status==='idle')return result.payload;if(result.payload.cliSession.queueError)record('live queue',{message:result.payload.cliSession.queueError});await new Promise(resolve=>setTimeout(resolve,2000));}throw Error('Live request did not complete within the test deadline.');};
 let result=await wait();assert.ok(result.cliSessionMessages.some(message=>message.role==='assistant'&&message.text));record('real general chat');
 const folder='QA-merchandising-'+randomUUID().slice(0,8);
 const po=folder+'/buyer-po.csv';report.files.push(po);
 const saved=await action('saveWorkspaceFile',{filePath:po,fileContent:'Style,Quantity,Fabric,Trims,CM,Wash,Overhead,Markup\nST-100,2400,1.20,0.35,0.70,0.15,0.10,10%\n'});assert.equal(saved.status,'completed',saved.error);record('real nested file creation');
 const work=await action('sendCodexCliSessionMessage',{sessionId:id,text:`Read ${po}. Create ${folder}/costing.csv with total unit cost, 10% markup selling price and total order value. Create ${folder}/buyer-followup.txt as an email draft requesting lab dip approval. Mark missing facts unknown; do not send email. Plan first, perform the work and provide open/download links.`});assert.equal(work.status,'completed',work.error);
 result=await wait();
 for(const [file,pattern] of [['costing.csv',/2\.75/],['buyer-followup.txt',/lab dip/i]]){const name=folder+'/'+file;report.files.push(name);const read=await action('readWorkspaceFile',{filePath:name});assert.equal(read.status,'completed',read.error);assert.match(read.payload.workspaceFile.content,pattern);}
 record('real garment costing and buyer email draft');
 const answer=result.cliSessionMessages.filter(message=>message.role==='assistant').at(-1)?.text??'';assert.match(answer,/download=1/);record('deliverable links');
 const usage=await(await context.request.get(origin+'/api/workspace/preferences')).json();assert.ok(usage.usage.tokens>0);assert.equal(usage.usage.pending,false);record('confirmed usage accounting');
 const screenshot=path.join(root,'subscriber-mobile.png');await page.setViewportSize({width:360,height:674});await page.screenshot({path:screenshot});record('mobile screenshot');
}catch(error){report.failure=error.message;console.error(error.stack);process.exitCode=1;}
finally{await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log('QA report: '+root);await browser.close();}
