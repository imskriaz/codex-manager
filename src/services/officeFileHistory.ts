import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {getSqliteStateStore} from '../storage/sqliteState';
import type {OfficeUser} from './officeUsers';
import {resolveOfficePath} from './officeWorkspacePaths';
import {officeStorageBytes} from './officeQuota';

export type OfficeFileRecord={id:string;path:string;kind:'version'|'trash';at:number;bytes:number;revision:string};
const ns=(user:OfficeUser)=>`office-file-history:${user.id}`;
function store(){const value=getSqliteStateStore();if(!value)throw new Error('File recovery is unavailable.');return value;}
async function privateFolder(root:string,kind:OfficeFileRecord['kind']){const folder=path.join(root,kind==='trash'?'.workspace-trash':'.workspace-history');await fs.mkdir(folder,{recursive:true});const stat=await fs.lstat(folder);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('File recovery storage is unavailable.');return folder;}
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('base64url');
export function listOfficeFileHistory(user:OfficeUser){return store().keys(ns(user)).flatMap(id=>store().get<OfficeFileRecord>(ns(user),id)??[]).sort((a,b)=>b.at-a.at);}
/** Callers hold the user's storage lock and validate the current file revision first. */
export async function preserveOfficeFile(user:OfficeUser,project:string,file:string,kind:OfficeFileRecord['kind']='version'){
 const root=await fs.realpath(user.workspacePath),target=await resolveOfficePath(root,project,file),stat=await fs.lstat(target);
 if(target===root)throw new Error('The workspace root is protected.');
 if(listOfficeFileHistory(user).length>=500)throw new Error('File recovery storage is full. Remove old versions or empty Trash in Library.');
 if(kind==='version'&&(!stat.isFile()||stat.size>50*1048576))throw new Error('This file is too large to version safely.');
 if(kind==='version'&&user.limits?.storageMb&&(await officeStorageBytes(root))+stat.size>user.limits.storageMb*1048576)throw new Error('Storage is full. Clear old versions or Trash before editing.');
 const id=randomUUID(),folder=await privateFolder(root,kind),destination=path.join(folder,id);
 const revision=stat.isFile()?hash(await fs.readFile(target)):'';
 const record:OfficeFileRecord={id,path:path.relative(root,target).split(path.sep).join('/'),kind,at:Date.now(),bytes:stat.isFile()?stat.size:0,revision};
 // Metadata is written first so an interrupted move never creates an untracked backup.
 store().set(ns(user),id,record);
 try{if(kind==='trash')await fs.rename(target,destination);else await fs.copyFile(target,destination,fs.constants.COPYFILE_EXCL);}
 catch(error){store().set(ns(user),id,undefined);throw error;}
 return record;
}
export async function restoreOfficeFile(user:OfficeUser,id:string,expectedRevision?:string){
 if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Choose a saved version.');const record=store().get<OfficeFileRecord>(ns(user),id);if(!record)throw new Error('This saved file is unavailable.');
 const root=await fs.realpath(user.workspacePath),target=await resolveOfficePath(root,root,record.path,true),source=path.join(await privateFolder(root,record.kind),id),saved=await fs.lstat(source);
 if(saved.isSymbolicLink()||saved.isFile()&&saved.nlink>1)throw new Error('Linked recovery files are unavailable.');
 if(record.kind==='trash'){
  try{await fs.lstat(target);throw new Error('A file already exists at this location. Rename it before restoring.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const parent=path.dirname(target);await fs.mkdir(parent,{recursive:true});await resolveOfficePath(root,root,path.relative(root,parent)||'.');await fs.rename(source,target);store().set(ns(user),id,undefined);
 }else{
  const current=await fs.readFile(target);if(!expectedRevision||hash(current)!==expectedRevision)throw new Error('This file changed. Refresh before restoring a version.');
  const contents=await fs.readFile(source);if(hash(contents)!==record.revision)throw new Error('This saved version changed.');
  if(user.limits?.storageMb&&(await officeStorageBytes(root))+contents.length>user.limits.storageMb*1048576)throw new Error('Storage is full. Clear old versions or Trash before restoring.');
  await preserveOfficeFile(user,root,record.path);const temporary=path.join(path.dirname(target),'.'+randomUUID()+'.codex-manager.tmp');
  try{await fs.writeFile(temporary,contents,{flag:'wx'});if(hash(await fs.readFile(target))!==expectedRevision)throw new Error('This file changed while restoring. Refresh before retrying.');await fs.rename(temporary,target);}finally{await fs.rm(temporary,{force:true});}
 }
 return {path:record.path,message:'File restored.'};
}
export async function discardOfficeFile(user:OfficeUser,id:string){
 const record=store().get<OfficeFileRecord>(ns(user),id);if(!record||!/^[a-f0-9-]{36}$/.test(id))throw new Error('This saved file is unavailable.');
 const root=await fs.realpath(user.workspacePath),target=path.join(await privateFolder(root,record.kind),id);const stat=await fs.lstat(target);if(stat.isSymbolicLink())throw new Error('Linked recovery files are unavailable.');
 // The checked absolute target is exactly one UUID entry in this user's private recovery folder.
 await fs.rm(target,{recursive:true,force:false});store().set(ns(user),id,undefined);return {message:'Saved file permanently removed.'};
}
