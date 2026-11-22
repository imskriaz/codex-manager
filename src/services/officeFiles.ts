import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {OfficeUser} from './officeUsers';
import {validateChatAttachments,type ChatAttachment} from '../domain/chatAttachments';
import {resolveOfficePath} from './officeWorkspacePaths';
import {officeStorageBytes} from './officeQuota';
import {extractOfficeDocument} from './officeDocuments';
import {preserveOfficeFile} from './officeFileHistory';

export async function writeOfficeBinary(user:OfficeUser,project:string,file:string,data:Buffer,revision?:string){
 if(!user.enabled||user.role!=='user'||!user.features.includes('files'))throw new Error('File access is unavailable.');
 if(data.length>50*1048576)throw new Error('Keep each file under 50 MB.');const root=await fs.realpath(user.workspacePath),target=await resolveOfficePath(root,project,file,true);
 if(target===root)throw new Error('Choose a file inside your workspace.');
 let previous:Buffer|undefined;try{previous=await fs.readFile(target);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const hash=(buffer:Buffer)=>createHash('sha256').update(buffer).digest('base64url');
 if(previous&&(!revision||hash(previous)!==revision))throw new Error('This file exists or changed. Read its latest revision before saving.');
 if(user.limits?.storageMb&&(await officeStorageBytes(root))+data.length>user.limits.storageMb*1048576)throw new Error('Your storage allowance is full. Clear files or Trash before saving.');
 let parent=root;for(const part of path.relative(root,path.dirname(target)).split(path.sep).filter(Boolean)){parent=path.join(parent,part);await fs.mkdir(parent,{recursive:true});await resolveOfficePath(root,root,path.relative(root,parent));}
 if(previous)await preserveOfficeFile(user,project,file);
 const temporary=path.join(path.dirname(target),'.'+randomUUID()+'.codex-manager.tmp');
 try{await fs.writeFile(temporary,data,{flag:'wx'});if(previous){const current=await fs.readFile(target);if(hash(current)!==revision)throw new Error('The file changed while saving. Refresh before retrying.');await fs.rename(temporary,target);}else await fs.link(temporary,target);}finally{await fs.rm(temporary,{force:true});}
 return {path:file,revision:hash(data),size:data.length,message:'File saved.'};
}
export async function importOfficeAttachment(user:OfficeUser,file:ChatAttachment,extract=true){
 if(!user.features.includes('files'))throw new Error('File uploads are disabled for this workspace.');
 const data=file.kind==='text'?Buffer.from(file.data,'utf8'):Buffer.from(file.data.slice(file.data.indexOf(',')+1),'base64');
 const extension=path.extname(file.name).slice(1).toLowerCase();let text='';
 if(file.kind==='text')text=file.data;
 else if(file.kind==='image'){if(data.length>8*1048576)throw new Error('Keep each image under 8 MB.');}
 else if(extract)text=await extractOfficeDocument(file.name,data);
 const relative='uploads/'+createHash('sha256').update(file.id).digest('hex').slice(0,12)+'-'+file.name.replace(/[^\p{L}\p{N}._ -]/gu,'-');
 const root=await fs.realpath(user.workspacePath),target=await resolveOfficePath(root,root,relative,true);
 let exists=false;try{const saved=await fs.readFile(target);if(!saved.equals(data))throw new Error('This upload changed. Attach the original file again.');exists=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(!exists)await writeOfficeBinary(user,root,relative,data);
 return {path:relative,name:file.name,text:text.length>30000?text.slice(0,30000)+'\n[Excerpt. Read the saved file for more.]':text,...(file.kind==='image'?{image:file.data,mimeType:file.mimeType}:{}),extension};
}
export async function readOfficeDocument(user:OfficeUser,project:string,file:string,format:'text'|'html'='text'){const root=await fs.realpath(user.workspacePath),target=await resolveOfficePath(root,project,file);const stat=await fs.stat(target);if(stat.size>10*1048576)throw new Error('Keep each Office document under 10 MB.');return extractOfficeDocument(file,await fs.readFile(target),format);}

export async function readOfficeImage(user:OfficeUser,file:string,mimeType:string){
 if(!user.enabled||!user.features.includes('files')||!['image/png','image/jpeg','image/webp'].includes(mimeType))throw new Error('This image is unavailable.');
 const root=await fs.realpath(user.workspacePath),target=await resolveOfficePath(root,root,file),stat=await fs.stat(target);
 if(stat.size>8*1048576)throw new Error('Keep each image under 8 MB.');const data=await fs.readFile(target),url=`data:${mimeType};base64,${data.toString('base64')}`;
 validateChatAttachments([{id:'image',name:path.basename(file),kind:'image',mimeType,size:data.length,data:url}]);return {data,url};
}
