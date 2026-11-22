import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {validateOfficeFilePath} from './officeAccess';
import {officeStorageBytes} from './officeQuota';
import {runCrossWindowExclusive} from '../utils/crossWindowOperations';
import {waitWithin} from '../utils/concurrency';
import type {OfficeUser} from './officeUsers';

const within=(root:string,target:string)=>{const relative=path.relative(root,target);return relative===''||!relative.startsWith('..')&&!path.isAbsolute(relative);};
/** Every component is checked: these operations never follow workspace links. */
async function resolve(root:string,project:string,input:unknown,missing=false){
  if(typeof input!=='string'||!input||input.length>4096||path.isAbsolute(input))throw new Error('Choose a relative path inside your workspace.');
  if(input!=='.')validateOfficeFilePath(input);
  const target=path.resolve(project,input.replace(/\\/g,path.sep));
  if(!within(root,target))throw new Error('Workspace access denied.');
  let current=root;
  const parts=path.relative(root,target).split(path.sep).filter(Boolean);
  for(const part of parts){
    current=path.join(current,part);
    try{const stat=await fs.lstat(current);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink>1)throw new Error('Linked files and folders are unavailable for this action.');}
    catch(error){if(missing&&(error as NodeJS.ErrnoException).code==='ENOENT')return target;throw error;}
  }
  if(!within(root,await fs.realpath(target)))throw new Error('Workspace access denied.');
  return target;
}
async function snapshot(root:string,target:string){
  const deadline=Date.now()+5000,entries:Array<{file:string;directory:boolean;stamp:string;bytes:number}>=[],pending=[target];
  while(pending.length){
    if(entries.length>=5000||Date.now()>=deadline)throw new Error('This folder is too large to check at once. Manage smaller folders instead.');
    const file=pending.pop()!;await resolve(root,root,path.relative(root,file)||'.');
    const stat=await waitWithin(fs.lstat(file),Math.max(1,deadline-Date.now()),'File inspection timed out. Refresh before retrying.');
    if(!stat.isDirectory()&&!stat.isFile())throw new Error('Only ordinary files and folders can be managed here.');
    entries.push({file,directory:stat.isDirectory(),stamp:JSON.stringify([stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs]),bytes:stat.isFile()?stat.size:0});
    if(stat.isDirectory())for(const name of await waitWithin(fs.readdir(file),Math.max(1,deadline-Date.now()),'Folder inspection timed out.'))pending.push(path.join(file,name));
  }
  entries.sort((a,b)=>a.file.localeCompare(b.file));
  return {entries,revision:createHash('sha256').update(JSON.stringify(entries)).digest('base64url')};
}
export async function manageOfficeWorkspacePaths(user:OfficeUser,project:string,args:Record<string,unknown>){
  if(!user.enabled||user.role!=='user'||!user.features.includes('files'))throw new Error('File access is unavailable.');
  return runCrossWindowExclusive(`office-storage:${user.id}`,'Manage workspace files',async()=>{
    const root=await fs.realpath(user.workspacePath),cwd=await fs.realpath(project);
    if(!within(root,cwd))throw new Error('Workspace access denied.');
    const operation=args['operation'];
    if(!['inspect','create_folder','copy_file','move_file','delete'].includes(String(operation)))throw new Error('Choose a supported file action.');
    const target=await resolve(root,cwd,args['path'],operation==='create_folder');
    if(operation==='create_folder'){
      if(target===root)throw new Error('Choose a new folder inside your workspace.');
      await fs.mkdir(target,{recursive:true});await resolve(root,cwd,args['path']);
      return {message:'Folder created.',path:args['path']};
    }
    if(operation!=='inspect'&&target===root)throw new Error('The workspace root cannot be moved or deleted. Choose a file or project folder.');
    const before=await snapshot(root,target),folder=before.entries.find(item=>item.file===target)!.directory;
    if(operation==='inspect')return {path:args['path'],kind:folder?'folder':'file',revision:before.revision,files:before.entries.filter(item=>!item.directory).length,entries:before.entries.map(item=>({path:path.relative(cwd,item.file).split(path.sep).join('/')||'.',kind:item.directory?'folder':'file'}))};
    if(target===root)throw new Error('The workspace root cannot be moved or deleted. Choose a file or project folder.');
    if(args['revision']!==before.revision)throw new Error('These files changed. Inspect them again before continuing.');
    if(operation==='copy_file'||operation==='move_file'){
      if(folder)throw new Error('Choose a file to copy or move. Create a destination folder first if needed.');
      const destination=await resolve(root,cwd,args['destination'],true);
      if(destination===root||destination===target)throw new Error('Choose a different destination file.');
      if(operation==='copy_file'){
        if(user.limits?.storageMb&&(await officeStorageBytes(root))+before.entries[0]!.bytes>user.limits.storageMb*1048576)throw new Error('Your storage allowance is full. Remove files before copying.');
        await fs.copyFile(target,destination,constants.COPYFILE_EXCL);
      }else{
        await fs.link(target,destination);
        try{await fs.unlink(target);}catch{throw new Error('The destination was created, but the original could not be removed. Review both files before retrying.');}
      }
      return {message:operation==='copy_file'?'File copied.':'File moved.',path:args['destination'],revision:(await snapshot(root,destination)).revision};
    }
    let changed=false;
    try{
      for(const item of [...before.entries.filter(item=>!item.directory),...before.entries.filter(item=>item.directory).sort((a,b)=>b.file.length-a.file.length)]){
        await resolve(root,root,path.relative(root,item.file));
        if(item.directory)await fs.rmdir(item.file);
        else {const latest=await snapshot(root,item.file);if(latest.entries[0]!.stamp!==item.stamp)throw new Error('A file changed during cleanup.');await fs.unlink(item.file);}
        changed=true;
      }
    }catch(error){throw new Error(changed?'Some items were deleted, but cleanup stopped. Inspect the remaining files before retrying.':error instanceof Error?error.message:'Cleanup failed. Your files were kept.');}
    return {message:folder?'Folder and its contents deleted.':'File deleted.',deletedPath:target};
  });
}
