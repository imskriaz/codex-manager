import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createOfficeUser,type OfficeUser} from '../src/services/officeUsers';
import {cleanupOfficeDeletedSessions,officeSessionFolder} from '../src/services/officeWorkspaceCleanup';
import {configureSqliteStateStore,SqliteStateStore} from '../src/storage/sqliteState';
import {officeStorageBytes} from '../src/services/officeQuota';
import {removeTestDirectory} from './testFilesystem';

describe('deleted User Workspace session cleanup',()=>{
 let root:string,store:SqliteStateStore,user:OfficeUser,project:string;
 beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'office-cleanup-'));store=await SqliteStateStore.open(path.join(root,'state.sqlite'));configureSqliteStateStore(store);user=await createOfficeUser({username:'cleanup@example.test',password:'password-123',workspacePath:path.join(root,'workspace')});project=path.join(user.workspacePath,'buyer-report');await fs.mkdir(project);store.set(`office-projects:${user.id}`,project,{id:project,label:'Buyer report',path:project});});
 afterEach(async()=>{configureSqliteStateStore(undefined);store.close();await removeTestDirectory(root);});
 async function session(deletedAt?:number,owner=user.id){const id=randomUUID();const folder=path.join(user.workspacePath,officeSessionFolder(id));await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'upload.txt'),'saved upload');store.set(`office-sessions:${user.id}`,id,{id,owner,deletedAt,updatedAt:'2000-01-01',turns:[]});store.set(`office-session-requests:${user.id}`,id,id);return{id,folder};}
 it('keeps active sessions and recent deletions, and removes only expired deleted session data',async()=>{
   const active=await session(),recent=await session(Date.now()),expired=await session(Date.now()-31*86400000),other=await session(Date.now()-31*86400000,'other');
   await fs.writeFile(path.join(project,'keep.txt'),'keep');await fs.writeFile(path.join(user.workspacePath,'legacy.txt'),'unassigned file');
   const before=await officeStorageBytes(user.workspacePath,user.id);await cleanupOfficeDeletedSessions(user,30);
   for(const item of [active,recent,other])expect(await fs.readFile(path.join(item.folder,'upload.txt'),'utf8')).toBe('saved upload');
   await expect(fs.stat(expired.folder)).rejects.toThrow();expect(store.get(`office-sessions:${user.id}`,expired.id)).toBeUndefined();expect(store.get(`office-session-requests:${user.id}`,expired.id)).toBeUndefined();
   expect(await fs.readFile(path.join(project,'keep.txt'),'utf8')).toBe('keep');expect(await fs.readFile(path.join(user.workspacePath,'legacy.txt'),'utf8')).toBe('unassigned file');expect(await officeStorageBytes(user.workspacePath,user.id)).toBeLessThan(before);
 });
 it('refuses linked session storage and preserves the destination and retained transcript',async()=>{
   const expired=await session(Date.now()-31*86400000);await fs.rm(expired.folder,{recursive:true});await fs.symlink(project,expired.folder,'junction');await fs.writeFile(path.join(project,'keep.txt'),'keep');
   await expect(cleanupOfficeDeletedSessions(user,30)).rejects.toThrow('Linked');expect(await fs.readFile(path.join(project,'keep.txt'),'utf8')).toBe('keep');expect(store.get(`office-sessions:${user.id}`,expired.id)).toBeDefined();
 });
 it('never removes a registered project inside the managed session tree',async()=>{
   const expired=await session(Date.now()-31*86400000);store.set(`office-projects:${user.id}`,'protected',{id:'protected',label:'Protected',path:expired.folder});await expect(cleanupOfficeDeletedSessions(user,30)).rejects.toThrow('saved project');expect(await fs.stat(expired.folder)).toBeDefined();
 });
});
