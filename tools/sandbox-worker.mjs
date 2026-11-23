import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export function dockerArgs(name,image){
 return ['run','--rm','--name',name,'--network','none','--read-only','--user','65534:65534','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64','--cpus','1','--memory','256m','--memory-swap','256m','--ulimit','fsize=8388608','--tmpfs','/work:rw,noexec,nosuid,size=64m,mode=1777','--tmpfs','/tmp:rw,noexec,nosuid,size=32m,mode=1777','-i',image];
}
export function validRun(body){
 if(!body||!['node','python','php'].includes(body.language)||typeof body.code!=='string'||!body.code.trim()||body.code.length>32000||!Array.isArray(body.files)||body.files.length>30)return false;
 let bytes=0;const seen=new Set();for(const file of body.files){if(!file||typeof file.path!=='string'||file.path.length>500||file.path.includes('\\')||file.path.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.')||/[:\x00-\x1f]/.test(part))||seen.has(file.path.toLowerCase())||typeof file.data!=='string'||!/^([a-z0-9+/]{4})*([a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(file.data))return false;seen.add(file.path.toLowerCase());const size=Buffer.byteLength(file.data,'base64');if(size>2*1048576||(bytes+=size)>8*1048576)return false;}return true;
}
function command(args,input,signal,limit=12*1048576){
 return new Promise((resolve,reject)=>{const child=spawn('docker',args,{windowsHide:true,stdio:['pipe','pipe','pipe'],signal}),output=[],errors=[];let bytes=0,failed=false;
  const read=(chunk,stderr)=>{bytes+=chunk.length;if(bytes>limit){failed=true;child.kill();reject(new Error('Sandbox output limit reached.'));return;}(stderr?errors:output).push(chunk);};child.stdout.on('data',chunk=>read(chunk,false));child.stderr.on('data',chunk=>read(chunk,true));child.on('error',reject);child.on('close',code=>{if(!failed)resolve({code,output:Buffer.concat(output).toString('utf8'),error:Buffer.concat(errors).toString('utf8')});});child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
export function startSandboxWorker(){
 const key=process.env['WORKSPACE_SANDBOX_TOKEN']??'',image=process.env['WORKSPACE_SANDBOX_IMAGE']??'';if(key.length<32||!image||!/^[-a-zA-Z0-9._/:@]+$/.test(image))throw new Error('Set WORKSPACE_SANDBOX_TOKEN (32+ characters) and WORKSPACE_SANDBOX_IMAGE before starting.');let busy=0;
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');const supplied=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+key);
  if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.writeHead(401).end(JSON.stringify({error:'Unauthorized'}));return;}
  if(req.url==='/health'&&req.method==='GET'){try{const value=await command(['info','--format','{{.OSType}}'],undefined,AbortSignal.timeout(3000),4096);res.writeHead(value.code===0&&value.output.trim()==='linux'?200:503).end(JSON.stringify({ready:value.code===0&&value.output.trim()==='linux',isolated:true}));}catch{res.writeHead(503).end(JSON.stringify({ready:false}));}return;}
  if(req.url!=='/v1/run'||req.method!=='POST'){res.writeHead(404).end('{}');return;}if(busy>=2){res.writeHead(429).end(JSON.stringify({error:'Sandbox busy'}));return;}
  busy++;const name='workspace-'+randomUUID(),controller=new AbortController(),timer=setTimeout(()=>{controller.abort();if(!req.complete)req.destroy();},60000);req.setTimeout(15000,()=>{controller.abort();req.destroy();});req.on('aborted',()=>controller.abort());res.on('close',()=>{if(!res.writableEnded)controller.abort();});
  try{const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>12*1048576)throw new Error('Request too large.');chunks.push(chunk);}const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!validRun(payload))throw new Error('Invalid runtime request.');
   const result=await command(dockerArgs(name,image),JSON.stringify(payload),controller.signal);if(result.code!==0)throw new Error('Sandbox did not finish.');const value=JSON.parse(result.output);res.end(JSON.stringify(value));
  }catch{res.writeHead(controller.signal.aborted?504:400).end(JSON.stringify({error:controller.signal.aborted?'Execution timed out.':'Sandbox could not complete this request.'}));}
  finally{clearTimeout(timer);await command(['rm','--force',name],undefined,AbortSignal.timeout(5000),4096).catch(()=>undefined);busy--;}
 });server.listen(Number(process.env['WORKSPACE_SANDBOX_PORT']??39901),'127.0.0.1');return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)startSandboxWorker();
