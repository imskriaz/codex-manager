import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import type {OfficeUser} from './officeUsers';
import {resolveOfficePath} from './officeWorkspacePaths';
import {writeOfficeBinary} from './officeFiles';
import {runCrossWindowExclusive} from '../utils/crossWindowOperations';

const crcTable=Array.from({length:256},(_,index)=>{let value=index;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
function crc32(data:Buffer){let value=0xffffffff;for(const byte of data)value=crcTable[(value^byte)&255]!^(value>>>8);return(value^0xffffffff)>>>0;}

/** Bounded ZIP32 writer. File names and aggregate size are validated before allocation. */
export function workspaceZip(files:Array<{name:string;data:Buffer}>):Buffer{
  if(!files.length||files.length>500)throw new Error('Choose between 1 and 500 files for a ZIP.');
  const names=new Set<string>();let total=0,offset=0;const records:Buffer[]=[],directory:Buffer[]=[];
  for(const file of files){
    const name=file.name.replace(/\\/g,'/'),key=name.toLowerCase();
    if(!name||name.startsWith('/')||name.split('/').some(part=>!part||part==='.'||part==='..'||/[\x00-\x1f:]/.test(part))||names.has(key)||Buffer.byteLength(name)>4096)throw new Error('Choose unique relative file names for the ZIP.');
    names.add(key);total+=file.data.length;if(total>50*1048576)throw new Error('Keep ZIP contents under 50 MB.');
    const encoded=Buffer.from(name),data=deflateRawSync(file.data),crc=crc32(file.data),header=Buffer.alloc(30),central=Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt16LE(33,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(file.data.length,22);header.writeUInt16LE(encoded.length,26);
    central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);header.copy(central,6,4,28);central.writeUInt32LE(offset,42);
    records.push(header,encoded,data);directory.push(central,encoded);offset+=header.length+encoded.length+data.length;
  }
  const index=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...records,index,end]);
}

export async function createOfficeArchive(user:OfficeUser,project:string,input:Record<string,unknown>){
  if(!user.enabled||user.role!=='user'||!user.features.includes('files'))throw new Error('File access is unavailable.');
  if(typeof input['path']!=='string'||!/\.zip$/i.test(input['path'])||!Array.isArray(input['files'])||!input['files'].length||input['files'].length>500||input['files'].some(file=>typeof file!=='string'))throw new Error('Choose a ZIP name and up to 500 files.');
  return runCrossWindowExclusive(`office-storage:${user.id}`,'Create workspace ZIP',async()=>{
    const root=await fs.realpath(user.workspacePath);if(!project||await fs.realpath(project)===root)throw new Error('Choose a saved project before creating an archive.');
    const destination=await resolveOfficePath(root,project,input['path'],true),files:Array<{name:string;data:Buffer;target:string;revision:string}>=[];let total=0;
    for(const file of input['files'] as string[]){
      const target=await resolveOfficePath(root,project,file),name=path.relative(project,target).split(path.sep).join('/');
      if(target===destination||name.startsWith('../')||!name)throw new Error('Choose files inside the current project, excluding the ZIP itself.');
      const stat=await fs.stat(target);if(!stat.isFile()||(total+=stat.size)>50*1048576)throw new Error('Choose ordinary files totalling under 50 MB.');
      const data=await fs.readFile(target);files.push({name,data,target,revision:createHash('sha256').update(data).digest('hex')});
    }
    const data=workspaceZip(files);
    for(const file of files){await resolveOfficePath(root,project,file.name);if(createHash('sha256').update(await fs.readFile(file.target)).digest('hex')!==file.revision)throw new Error('A file changed while preparing the ZIP. Try again with the latest files.');}
    const saved=await writeOfficeBinary(user,project,input['path'] as string,data,typeof input['revision']==='string'?input['revision']:undefined);
    return{...saved,files:files.length,message:'ZIP ready to download.'};
  });
}
