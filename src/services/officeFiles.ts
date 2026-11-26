import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {OfficeUser} from './officeUsers';
import {validateChatAttachments,type ChatAttachment} from '../domain/chatAttachments';
import {resolveOfficePath} from './officeWorkspacePaths';
import {officeStorageBytes} from './officeQuota';
import {extractOfficeDocument} from './officeDocuments';
import {preserveOfficeFile} from './officeFileHistory';
import {officeSessionFolder} from './officeWorkspaceCleanup';
import {getSqliteStateStore} from '../storage/sqliteState';
import {officeLocalFolders,officeLocalProject} from './officeLocalFolders';
import {MAX_WORKSPACE_FILE_BYTES} from '../domain/workspaceFileLimits';

/** Read small saved slide batches; generation never evaluates user-provided code. */
export async function readOfficeSlideParts(user:OfficeUser,project:string,files:unknown):Promise<unknown[]> {
 if(!user.enabled||user.role!=='user'||!user.features.includes('files'))throw new Error('File access is unavailable.');
 if(!Array.isArray(files)||!files.length||files.length>10||new Set(files).size!==files.length||files.some(file=>typeof file!=='string'||!file.endsWith('.json')))throw new Error('Choose one to ten saved JSON slide parts.');
 const root=await fs.realpath(user.workspacePath),slides:unknown[]=[];let bytes=0;
 for(const file of files as string[]) {
  if(officeLocalProject(user.id,project)){
    const value=await officeLocalFolders.request(user.id,project,{operation:'read',path:file});
    const data=Buffer.from(value.data??'','base64');if(data.length>64000||(bytes+=data.length)>256000)throw new Error('Keep each slide part under 64 KB and all parts under 256 KB.');
    const part:unknown=JSON.parse(data.toString('utf8'));if(!Array.isArray(part)||!part.length||part.length>6)throw new Error('Save one to six slides in each part.');slides.push(...part as unknown[]);continue;
  }
  const target=await resolveOfficePath(root,project,file),stat=await fs.stat(target);
  if(!stat.isFile()||stat.size>64000||(bytes+=stat.size)>256000)throw new Error('Keep each slide part under 64 KB and all parts under 256 KB.');
  let part:unknown;try{part=JSON.parse(await fs.readFile(target,'utf8'));}catch{throw new Error('Each saved slide part must contain a JSON array of slide objects.');}
  if(!Array.isArray(part)||!part.length||part.length>6)throw new Error('Save one to six slides in each part.');
  slides.push(...part as unknown[]);
 }
 return slides;
}

export async function writeOfficeBinary(user:OfficeUser,project:string,file:string,data:Buffer,revision?:string){
 if(!user.enabled||user.role!=='user'||!user.features.includes('files'))throw new Error('File access is unavailable.');
 if(officeLocalProject(user.id,project)){
  if(data.length>MAX_WORKSPACE_FILE_BYTES)throw new Error('Keep connected-folder files at or below 100 MB.');
  const value=await officeLocalFolders.request(user.id,project,{operation:'write',path:file,data:data.toString('base64'),revision});
  if(typeof value.revision!=='string'||typeof value.size!=='number')throw new Error('Saving to the local folder was not confirmed. Inspect the file before retrying.');
  return {path:file,revision:value.revision,size:value.size,message:'Saved to your local folder.'};
 }
 if(data.length>MAX_WORKSPACE_FILE_BYTES)throw new Error('Keep each file at or below 100 MB.');const root=await fs.realpath(user.workspacePath),target=await resolveOfficePath(root,project,file,true);
 if(target===root)throw new Error('Choose a file inside your workspace.');
 let previous:Buffer|undefined;try{previous=await fs.readFile(target);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const hash=(buffer:Buffer)=>createHash('sha256').update(buffer).digest('base64url');
 if(previous&&(!revision||hash(previous)!==revision))throw new Error('This file exists or changed. Read its latest revision before saving.');
 if(user.limits?.storageMb&&(await officeStorageBytes(root,user.id))+data.length>user.limits.storageMb*1048576)throw new Error('Your storage allowance is full. Clear files or Trash before saving.');
 let parent=root;for(const part of path.relative(root,path.dirname(target)).split(path.sep).filter(Boolean)){parent=path.join(parent,part);await fs.mkdir(parent,{recursive:true});await resolveOfficePath(root,root,path.relative(root,parent));}
  if(previous)await preserveOfficeFile(user,project,file,'version',{replacementBytes:data.length});
 const temporary=path.join(path.dirname(target),'.'+randomUUID()+'.codex-manager.tmp');
 try{await fs.writeFile(temporary,data,{flag:'wx'});if(previous){const current=await fs.readFile(target);if(hash(current)!==revision)throw new Error('The file changed while saving. Refresh before retrying.');await fs.rename(temporary,target);}else await fs.link(temporary,target);}finally{await fs.rm(temporary,{force:true});}
 return {path:file,revision:hash(data),size:data.length,message:'File saved.'};
}
export async function importOfficeAttachment(user:OfficeUser,file:ChatAttachment,extract=true,sessionId?:string){
 if(!user.features.includes('files'))throw new Error('File uploads are disabled for this workspace.');
 const data=file.kind==='text'?Buffer.from(file.data,'utf8'):Buffer.from(file.data.slice(file.data.indexOf(',')+1),'base64');
 const extension=path.extname(file.name).slice(1).toLowerCase();let text='';
 if(file.kind==='text')text=file.data;
 else if(file.kind==='image'){if(data.length>8*1048576)throw new Error('Keep each image under 8 MB.');}
 const relative=(sessionId?officeSessionFolder(sessionId)+'/uploads/':'uploads/')+createHash('sha256').update(file.id).digest('hex').slice(0,12)+'-'+file.name.replace(/[^\p{L}\p{N}._ -]/gu,'-');
 const root=await fs.realpath(user.workspacePath),target=await resolveOfficePath(root,root,relative,true);
 let exists=false;try{const saved=await fs.readFile(target);if(!saved.equals(data))throw new Error('This upload changed. Attach the original file again.');exists=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(!exists)await writeOfficeBinary(user,root,relative,data);
 if(extract&&file.kind==='file') {
  try{text=await extractOfficeDocument(file.name,data);}
  catch(error){text='The original upload is saved. Automatic document reading failed: '+(error instanceof Error?error.message:'Reading could not be confirmed.')+' Use read_file on the saved path to retry; for XLSX choose a worksheet and row/column range. Do not claim the file contents were read.';}
 }
 return {path:relative,name:file.name,text:text.length>30000?text.slice(0,30000)+'\n[Excerpt. Read the saved file for more.]':text,...(file.kind==='image'?{image:file.data,mimeType:file.mimeType}:{}),extension};
}
export async function readOfficeDocument(user:OfficeUser,project:string,file:string,format:'text'|'html'='text',range?:import('./officeWorkbook').WorkbookReadRange){
 return (await readOfficeDocumentSnapshot(user,project,file,format,range)).content;
}
export async function readOfficeDocumentSnapshot(user:OfficeUser,project:string,file:string,format:'text'|'html'='text',range?:import('./officeWorkbook').WorkbookReadRange,sessionId?:string){
 if(!user.enabled||user.role!=='user'||!user.features.includes('files'))throw new Error('File access is unavailable.');
 if(file.replace(/\\/g,'/').split('/').some(part=>part.toLowerCase()==='.workspace-sessions')){
  const session=sessionId?getSqliteStateStore()?.get<{owner:string;deletedAt?:number}>(`office-sessions:${user.id}`,sessionId):undefined;
  if(!session||session.owner!==user.id||session.deletedAt!==undefined||!file.replace(/\\/g,'/').startsWith(officeSessionFolder(sessionId!)+'/uploads/'))throw new Error('This upload belongs to another conversation or is unavailable.');
  project=user.workspacePath;
 }
 if(officeLocalProject(user.id,project)){
  const value=await officeLocalFolders.readFile(user.id,project,file);
  const data=value.data;
  return {content:await extractOfficeDocument(file,data,format,range),revision:value.revision!,size:data.length};
 }
 const root=await fs.realpath(user.workspacePath),target=await resolveOfficePath(root,project,file);const stat=await fs.stat(target);if(stat.size>MAX_WORKSPACE_FILE_BYTES)throw new Error('Keep each Office document at or below 100 MB.');const data=await fs.readFile(target);
 const content=format==='html'&&/\.(docx|pptx|xlsx)$/i.test(file)?await (await import('./officeRendering')).renderOfficePreview(file,data,new AbortController().signal):await extractOfficeDocument(file,data,format,range);
 return {content,revision:createHash('sha256').update(data).digest('base64url'),size:data.length};
}

export async function readOfficeImage(user:OfficeUser,file:string,mimeType:string){
 if(!user.enabled||!user.features.includes('files')||!['image/png','image/jpeg','image/webp'].includes(mimeType))throw new Error('This image is unavailable.');
 const sessionId=file.replace(/\\/g,'/').match(/^\.workspace-sessions\/([^/]+)\//)?.[1];
 if(sessionId){const session=getSqliteStateStore()?.get<{owner:string;deletedAt?:number}>(`office-sessions:${user.id}`,sessionId);if(!session||session.owner!==user.id||session.deletedAt!==undefined)throw new Error('This image is unavailable.');}
 const root=await fs.realpath(user.workspacePath),target=await resolveOfficePath(root,root,file),stat=await fs.stat(target);
 if(stat.size>8*1048576)throw new Error('Keep each image under 8 MB.');const data=await fs.readFile(target),url=`data:${mimeType};base64,${data.toString('base64')}`;
 validateChatAttachments([{id:'image',name:path.basename(file),kind:'image',mimeType,size:data.length,data:url}]);return {data,url};
}
