import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OfficeLocalFolderConnections } from '../src/services/officeLocalFolders';
import {createHash} from 'node:crypto';
import {LOCAL_FILE_CHUNK_BYTES} from '../src/domain/workspaceFileLimits';
let service: OfficeLocalFolderConnections;
const client = '11111111-1111-1111-1111-111111111111', other = '22222222-2222-2222-2222-222222222222';
beforeEach(() => { vi.useFakeTimers(); service = new OfficeLocalFolderConnections(); });
afterEach(() => { service.close(); vi.useRealTimers(); });

it('routes a command once and accepts only its owning connection response', async () => {
  service.connect('alex', '/project', client);
  const result = service.request('alex', '/project', { operation: 'read', path: 'report.txt' });
  const commands = service.poll('alex', '/project', client); expect(commands).toHaveLength(1);
  expect(service.poll('alex', '/project', client)).toEqual([]);
  expect(() => service.complete('sam', '/project', client, commands[0].id, {})).toThrow('offline');
  expect(() => service.complete('alex', '/project', other, commands[0].id, {})).toThrow('offline');
  const value = { data: Buffer.from('Report').toString('base64'), revision: 'a'.repeat(64), size: 6 };
  service.complete('alex', '/project', client, commands[0].id, value);
  await expect(result).resolves.toEqual(value);
});
it('keeps projects and users separate and refuses an active second tab', () => {
  service.connect('alex', '/project', client);
  expect(() => service.connect('alex', '/project', other)).toThrow('another browser tab');
  expect(() => service.request('alex', '/other', { operation: 'list' })).toThrow('offline');
  expect(() => service.request('sam', '/project', { operation: 'list' })).toThrow('offline');
  expect(() => service.request('alex', '/project', { operation: 'write', path: '../secret' })).toThrow('relative path');
});
it('resumes the same polling client after suspension and host restart without replaying writes', async () => {
  service.connect('alex', '/project', client);
  const pending=service.request('alex','/project',{operation:'write',path:'notes.txt',data:'eA=='});
  expect(service.poll('alex','/project',client)).toHaveLength(1);
  const expired=expect(pending).rejects.toThrow('not replayed');
  await vi.advanceTimersByTimeAsync(31_000);await expired;
  expect(service.poll('alex','/project',client)).toEqual([]);
  service.close();service=new OfficeLocalFolderConnections();
  expect(service.poll('alex','/project',client)).toEqual([]);
  expect(()=>service.poll('alex','/project',other)).toThrow('another browser tab');
  const result=service.request('alex','/project',{operation:'list'}),[command]=service.poll('alex','/project',client);
  service.complete('alex','/project',client,command.id,{files:[]});await expect(result).resolves.toEqual({files:[]});
});
it('expires undelivered writes without replay and ignores late results', async () => {
  service.connect('alex', '/project', client);
  const result = service.request('alex', '/project', { operation: 'write', path: 'report.txt', data: 'eA==' });
  const assertion = expect(result).rejects.toThrow('not replayed');
  await vi.advanceTimersByTimeAsync(12000); await assertion;
  expect(service.poll('alex', '/project', client)).toEqual([]);
  service.complete('alex', '/project', client, 'late', { revision: 'a'.repeat(64), size: 1 });
});
it('reads files larger than 10 MB in bounded chunks and verifies the complete hash',async()=>{
 service.connect('alex','/project',client);
 const data=Buffer.alloc(12*1048576+7,97),revision=createHash('sha256').update(data).digest('hex'),pending=service.readFile('alex','/project','large.xlsx');
 for(let offset=0;offset<data.length;offset+=LOCAL_FILE_CHUNK_BYTES){
   let command:ReturnType<typeof service.poll>[number]|undefined;
   await vi.waitFor(()=>{command??=service.poll('alex','/project',client)[0];expect(command).toBeDefined();});
   expect(command).toMatchObject({offset,length:LOCAL_FILE_CHUNK_BYTES});
   service.complete('alex','/project',client,command!.id,{data:data.subarray(offset,offset+LOCAL_FILE_CHUNK_BYTES).toString('base64'),revision,size:data.length});
 }
 const result=await pending;expect(result.size).toBe(data.length);expect(result.data.equals(data)).toBe(true);
});
it('refuses corrupted chunk data and retains ownership while a long transfer is active',async()=>{
 service.connect('alex','/project',client);
 const pending=service.readFile('alex','/project','large.xlsx'),[command]=service.poll('alex','/project',client);
 await vi.advanceTimersByTimeAsync(31000);
 expect(()=>service.connect('alex','/project',other)).toThrow('another browser tab');
 service.complete('alex','/project',client,command.id,{data:'eA==',revision:'a'.repeat(64),size:1});
 await expect(pending).rejects.toThrow('changed during transfer');
});
it('keeps delivered mutations fenced after timeout until the browser confirms completion', async () => {
  service.connect('alex','/project',client);
  const result=service.request('alex','/project',{operation:'write',path:'report.txt',data:'eA=='});
  const [command]=service.poll('alex','/project',client);
  const failed=expect(result).rejects.toThrow('not confirm completion');
  await vi.advanceTimersByTimeAsync(12000);await failed;
  expect(()=>service.assertIdle('alex','/project')).toThrow('still in progress');
  expect(()=>service.request('alex','/project',{operation:'write',path:'report.txt',data:'eQ=='})).toThrow('previous folder action');
  expect(service.poll('alex','/project',client)).toEqual([]);
  service.complete('alex','/project',client,command.id,{revision:'a'.repeat(64),size:1});
  expect(()=>service.assertIdle('alex','/project')).not.toThrow();
});
it('requires a complete inspection and strips unrecognized browser result fields', async () => {
  service.connect('alex','/project',client);
  const result=service.request('alex','/project',{operation:'inspect',path:'reports'});
  const [command]=service.poll('alex','/project',client);
  service.complete('alex','/project',client,command.id,{message:'OK'});
  await expect(result).rejects.toThrow('invalid result');
  const reading=service.request('alex','/project',{operation:'read',path:'report.txt'});
  const [next]=service.poll('alex','/project',client);
  service.complete('alex','/project',client,next.id,{data:'eA==',revision:'a'.repeat(64),size:1,deletedPath:'untrusted'} as never);
  expect(await reading).not.toHaveProperty('deletedPath');
});
it('reports disconnected or expired connections without moving actions to the host', async () => {
  service.connect('alex', '/project', client);
  const result = service.request('alex', '/project', { operation: 'list' });
  const assertion = expect(result).rejects.toThrow('disconnected');
  service.disconnect('alex', '/project', client); await assertion;
  expect(() => service.request('alex', '/project', { operation: 'list' })).toThrow('offline');
  service.connect('alex', '/project', client); vi.advanceTimersByTime(30000);
  expect(() => service.request('alex', '/project', { operation: 'list' })).toThrow('offline');
  expect(() => service.connect('alex', '/project', other)).not.toThrow();
});
it('preserves errors and rejects malformed folder results', async () => {
  service.connect('alex', '/project', client);
  const failed = service.request('alex', '/project', { operation: 'list' });
  const [command] = service.poll('alex', '/project', client);
  service.complete('alex', '/project', client, command.id, undefined, 'Permission revoked');
  await expect(failed).rejects.toThrow('Permission revoked');
  const invalid = service.request('alex', '/project', { operation: 'list' });
  const [second] = service.poll('alex', '/project', client);
  service.complete('alex', '/project', client, second.id, { files: [{ path: '../secret', name: 'secret', type: 'file', depth: 0 }] });
  await expect(invalid).rejects.toThrow('invalid result');
});
