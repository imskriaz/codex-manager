import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {fetch} from 'undici';
import {readOfficeIntegrations,boundedResponse} from './officeIntegrations';
import {getOfficeUser,type OfficeUser} from './officeUsers';
import {resolveOfficePath} from './officeWorkspacePaths';
import {writeOfficeBinary} from './officeFiles';
import {runCrossWindowExclusive} from '../utils/crossWindowOperations';

const digest=(data:Buffer)=>createHash('sha256').update(data).digest('base64url');
export function runtimeFileName(value:unknown):value is string{
 return typeof value==='string'&&value.length>0&&value.length<=500&&!path.isAbsolute(value)&&!value.includes('\\')&&!value.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.')||/[:\x00-\x1f]/.test(part)||/^(?:node_modules|venv|__pycache__)$/i.test(part));
}
export async function runOfficeRuntime(user:OfficeUser,project:string,input:Record<string,unknown>,signal:AbortSignal){
 const settings=readOfficeIntegrations();if(!settings.runtimeUrl)throw new Error('Isolated execution is not configured. Your project files remain available.');
 if(!user.enabled||user.role!=='user'||!user.features.includes('files')||!user.features.includes('terminal'))throw new Error('Isolated execution is not enabled for this workspace.');
 if(!['node','python','php'].includes(String(input['language']))||typeof input['code']!=='string'||!input['code'].trim()||input['code'].length>32000||!Array.isArray(input['files'])||input['files'].length>30||input['files'].some(file=>!runtimeFileName(file)))throw new Error('Choose Node, Python or PHP, a script under 32,000 characters and up to thirty project files.');
 const root=await fs.realpath(user.workspacePath),cwd=await fs.realpath(project);if(cwd===root)throw new Error('Choose a saved project before running code.');
 let bytes=0;const files:Array<{path:string;data:string;revision:string}>=[];
 for(const name of [...new Set(input['files'] as string[])]){const target=await resolveOfficePath(root,cwd,name),relative=path.relative(cwd,target);if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Choose files inside this project.');const stat=await fs.stat(target);if(!stat.isFile()||stat.size>2*1048576||(bytes+=stat.size)>8*1048576)throw new Error('Runtime inputs must total under 8 MB, with each file under 2 MB.');const data=await fs.readFile(target);files.push({path:name,data:data.toString('base64'),revision:digest(data)});}
 signal.throwIfAborted();const response=await fetch(settings.runtimeUrl+'/v1/run',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(settings.runtimeToken?{Authorization:'Bearer '+settings.runtimeToken}:{})},body:JSON.stringify({language:input['language'],code:input['code'],files:files.map(({path,data})=>({path,data}))}),signal:AbortSignal.any([signal,AbortSignal.timeout(65000)])});
 if(!response.ok){await response.body?.cancel();throw new Error('Isolated execution could not be confirmed. No output files were imported; inspect the project before retrying.');}
 const result=JSON.parse((await boundedResponse(response,12*1048576)).toString('utf8')) as {status?:unknown;stdout?:unknown;stderr?:unknown;files?:unknown};
 if(!['completed','failed','timeout'].includes(String(result.status))||typeof result.stdout!=='string'||typeof result.stderr!=='string'||result.stdout.length>32000||result.stderr.length>32000||!Array.isArray(result.files)||result.files.length>30)throw new Error('The execution result could not be verified. No files were imported.');
 const outputs:Array<{path:string;data:Buffer}>=[],seen=new Set<string>();bytes=0;
 for(const raw of result.files){if(!raw||typeof raw!=='object')throw new Error('An output file was invalid.');const file=raw as Record<string,unknown>;if(!runtimeFileName(file['path'])||seen.has(file['path'].toLowerCase())||typeof file['data']!=='string'||!/^([a-z0-9+/]{4})*([a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(file['data']))throw new Error('An output file was invalid.');seen.add(file['path'].toLowerCase());const data=Buffer.from(file['data'],'base64');if(data.length>2*1048576||(bytes+=data.length)>8*1048576)throw new Error('Runtime output files exceeded the workspace limit.');outputs.push({path:'runtime-output/'+file['path'],data});}
 if(result.status!=='completed')return {status:result.status,stdout:result.stdout,stderr:result.stderr,files:[],message:(result.status==='timeout'?'Execution reached its time limit.':'Execution failed.')+' No output files were imported.'+(result.stderr?' '+result.stderr.slice(0,2000):'')};
 return runCrossWindowExclusive(`office-storage:${user.id}`,'Import runtime output',async()=>{
  signal.throwIfAborted();const current=await getOfficeUser(user.id);if(!current?.enabled||current.workspacePath!==user.workspacePath||!current.features.includes('files')||!current.features.includes('terminal'))throw new Error('Runtime access changed. Output files were not imported.');
  for(const file of files){const target=await resolveOfficePath(root,cwd,file.path);if(digest(await fs.readFile(target))!==file.revision)throw new Error('An input file changed during execution. Output files were not imported.');}
  // Each execution gets a unique folder; imported results never replace user files.
  const folder=crypto.randomUUID(),saved:string[]=[];try{for(const file of outputs){signal.throwIfAborted();const output=`runtime-output/${folder}/`+file.path.slice('runtime-output/'.length);await writeOfficeBinary(current,cwd,output,file.data);saved.push(output);}}catch(error){throw new Error(`Runtime finished; ${saved.length} output file(s) were saved before import stopped. Review Files before retrying. ${error instanceof Error?error.message:'Output import failed.'}`);}
  return {status:'completed',stdout:result.stdout,stderr:result.stderr,files:saved,message:'Isolated execution completed. Output files are ready.',limits:'No network, no host access, up to 60 seconds. This runs scripts; it does not publish a persistent server.'};
 },{waitMs:2000});
}
