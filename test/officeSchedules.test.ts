import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {configureSqliteStateStore,SqliteStateStore} from '../src/storage/sqliteState';
import {configureCrossWindowOperationCoordinator} from '../src/utils/crossWindowOperations';
import {OfficeScheduleService} from '../src/services/officeSchedules';
import {OfficeSessionService} from '../src/services/officeSessions';
import {nextScheduleRun,type OfficeSchedule} from '../src/domain/officeSchedule';
import type {OfficeUser} from '../src/services/officeUsers';
import {readOfficeUsage} from '../src/services/officeQuota';
import {removeTestDirectory} from './testFilesystem';
let root:string,store:SqliteStateStore,service:OfficeScheduleService,now:number;
const user:OfficeUser={id:'alex',username:'alex@example.test',displayName:'Alex',role:'user',enabled:true,features:['tasks','files'],defaultPrompt:'',workspacePath:'C:/private/alex',mcpServers:[],createdAt:0};
let enqueue:ReturnType<typeof vi.fn>;
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'office-schedules-'));vi.stubEnv('CODEX_MANAGER_STORAGE_ROOT',root);await configureCrossWindowOperationCoordinator(root);store=await SqliteStateStore.open(path.join(root,'manager.sqlite'));configureSqliteStateStore(store);now=Date.parse('2026-11-22T03:00:00Z');vi.spyOn(Date,'now').mockImplementation(()=>now);enqueue=vi.fn(async()=>crypto.randomUUID());service=new OfficeScheduleService({readUser:async()=>user,enqueue});service.start();});
afterEach(async()=>{service.stop();vi.restoreAllMocks();configureSqliteStateStore(undefined);store.close();vi.unstubAllEnvs();await removeTestDirectory(root);});
const input=()=>({title:'Buyer follow-up',prompt:'Prepare a lab dip approval reminder draft. Do not send email.',model:'gpt-6-luna',projectPath:user.workspacePath,frequency:'once',timeZone:'Asia/Dhaka',nextRunAt:now+60000});
it('persists, runs and completes a one-time schedule once, with the selected model',async()=>{
 const task=await service.save(user,input());expect(service.list(user)).toHaveLength(1);expect(task).not.toHaveProperty('owner');
 now+=61000;await service.pump();await service.pump();expect(enqueue).toHaveBeenCalledTimes(1);
 expect(enqueue.mock.calls[0][1]).toMatchObject({model:'gpt-6-luna',projectPath:user.workspacePath,prompt:input().prompt});
 expect(service.list(user)[0]).toMatchObject({enabled:false,lastSessionId:expect.any(String),lastRunAt:now});
});
it('isolates owners, guards stale edits and pauses without changing past conversations',async()=>{
 const task=await service.save(user,input()),other={...user,id:'sam'};expect(service.list(other)).toEqual([]);
 await expect(service.remove(other,task.id,task.revision)).rejects.toThrow('unavailable');
 await expect(service.save(other,{...input(),revision:task.revision},task.id)).rejects.toThrow('changed');
 const paused=await service.setEnabled(user,task.id,task.revision,false);now+=61000;await service.pump();expect(enqueue).not.toHaveBeenCalled();
 await expect(service.run(user,task.id,task.revision)).rejects.toThrow('changed');
 const run=await service.run(user,task.id,paused.revision);expect(run.enabled).toBe(false);expect(run.lastSessionId).toBeTruthy();
 await service.remove(user,task.id,run.revision);expect(service.list(user)).toEqual([]);
});
it('coalesces missed recurring runs and retains visible quota failures',async()=>{
 const task=await service.save(user,{...input(),frequency:'daily'});now+=4*86400000;
 enqueue.mockRejectedValueOnce(new Error('Your daily request allowance has been reached.'));
 await service.pump();await service.pump();expect(enqueue).toHaveBeenCalledTimes(1);
 const current=service.list(user)[0]!;expect(current.enabled).toBe(true);expect(current.nextRunAt).toBeGreaterThan(now);expect(current.lastError).toContain('allowance');
 await expect(service.save(user,{...input(),revision:task.revision},task.id)).rejects.toThrow('changed');
});
it('rejects invalid time zones, models, dates and disabled permissions',async()=>{
 for(const patch of [{timeZone:'Not/AZone'},{model:''},{nextRunAt:now-1},{frequency:'every-second'},{enabled:'yes'}])await expect(service.save(user,{...input(),...patch})).rejects.toThrow();
 await expect(service.save({...user,features:['files']},input())).rejects.toThrow('unavailable');expect(service.list(user)).toEqual([]);
});
it('bounds an unconfirmed enqueue and ignores its late completion',async()=>{
 let finish!:(value:string)=>void,signal:AbortSignal|undefined;
 enqueue.mockImplementation((_user,_task,_id,abort)=>{signal=abort;return new Promise<string>(resolve=>{finish=resolve;});});
 const task=await service.save(user,input());const result=await service.run(user,task.id,task.revision);
 expect(result.lastError).toContain('could not be confirmed');expect(signal?.aborted).toBe(true);
 finish(crypto.randomUUID());await Promise.resolve();expect(service.list(user)[0]?.lastSessionId).toBeUndefined();
});
it('keeps recurrence at the saved local time across DST and skips a repeated clock hour',()=>{
 const base={frequency:'daily' as const,timeZone:'America/New_York',time:'09:00',weekday:0};
 expect(new Date(nextScheduleRun(base,Date.parse('2026-03-07T14:00:00Z'))!).toISOString()).toBe('2026-03-08T13:00:00.000Z');
 expect(new Date(nextScheduleRun({...base,time:'02:30'},Date.parse('2026-03-07T07:30:00Z'))!).toISOString()).toBe('2026-03-08T07:30:00.000Z');
 expect(new Date(nextScheduleRun({...base,time:'01:30'},Date.parse('2026-11-01T05:31:00Z'))!).toISOString()).toBe('2026-11-02T06:30:00.000Z');
 expect(new Date(nextScheduleRun({...base,frequency:'weekly',timeZone:'Asia/Dhaka'},Date.parse('2026-11-22T03:01:00Z'))!).toISOString()).toBe('2026-11-29T03:00:00.000Z');
});
it('recovers a crash after acceptance without creating another conversation or charging another request',async()=>{
 const sessions=new OfficeSessionService({readUser:async()=>user,changed:()=>{},generate:async()=> 'Buyer reminder draft ready.'});
 service.stop();service=new OfficeScheduleService({readUser:async()=>user,enqueue:async(actor,task,requestId)=>{const result=await sessions.handle(actor,{type:'dashboard:action',action:'startCodexCliSession',requestId,payload:{text:task.prompt,model:task.model,projectPath:task.projectPath}});return result.cliSession!.id;}});service.start();
 try{
  const task=await service.save(user,input());now+=61000;
  const original=store.set.bind(store);let fail=true;
  const save=vi.spyOn(store,'set').mockImplementation((namespace,key,value)=>{if(fail&&namespace==='office-schedules'&&key===task.id&&!(value as OfficeSchedule)?.pending){fail=false;throw new Error('Simulated process loss');}original(namespace,key,value);});
  await expect(service.run(user,task.id,task.revision)).rejects.toThrow('process loss');save.mockRestore();
  expect(store.get<OfficeSchedule>('office-schedules',task.id)?.pending).toBeTruthy();await service.pump();
  expect(sessions.list(user.id)).toHaveLength(1);expect(readOfficeUsage(user.id).requests).toBe(1);expect(service.list(user)[0]?.lastSessionId).toBe(sessions.list(user.id)[0]?.id);
 }finally{sessions.stop();}
});
