import { randomUUID } from 'node:crypto';
import { getSqliteStateStore } from '../storage/sqliteState';
import { runCrossWindowExclusive } from '../utils/crossWindowOperations';
import type { OfficeUser } from './officeUsers';
import { nextScheduleRun, scheduleClock, type OfficeSchedule, type UserSchedule } from '../domain/officeSchedule';
import { userWorkspaceNotice } from '../domain/teamWorkspacePresentation';
import { waitWithin } from '../utils/concurrency';

const namespace='office-schedules';
function store(){const value=getSqliteStateStore();if(!value)throw new Error('Scheduled tasks are unavailable. Please try again.');return value;}
function publicSchedule({owner:_owner,pending:_pending,...value}:OfficeSchedule):UserSchedule{return value;}
function access(user:OfficeUser){if(!user.enabled||user.role!=='user'||!user.features.includes('tasks'))throw new Error('Scheduled tasks are unavailable for this workspace.');}

export class OfficeScheduleService {
  private timer?:NodeJS.Timeout;
  private pumping=false;
  private stopped=true;
  constructor(private readonly options:{readUser:(id:string)=>Promise<OfficeUser|undefined>; enqueue:(user:OfficeUser,schedule:OfficeSchedule,requestId:string,signal:AbortSignal)=>Promise<string>}){}
  start(){this.stopped=false;this.timer??=setInterval(()=>void this.pump(),15000);this.timer.unref?.();void this.pump();}
  stop(){this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;}
  list(user:OfficeUser):UserSchedule[]{access(user);return store().keys(namespace).map(id=>store().get<OfficeSchedule>(namespace,id)).filter((task):task is OfficeSchedule=>task?.owner===user.id).sort((a,b)=>a.nextRunAt-b.nextRunAt).map(publicSchedule);}
  private read(user:OfficeUser,id:string){access(user);const task=store().get<OfficeSchedule>(namespace,id);if(!task||task.owner!==user.id)throw new Error('This scheduled task is unavailable.');return task;}
  async save(user:OfficeUser,input:Record<string,unknown>,id:string=randomUUID()):Promise<UserSchedule>{
    access(user);
    // eslint-disable-next-line @typescript-eslint/require-await -- Coordinator callbacks return promises.
    return runCrossWindowExclusive('office-schedule:'+id,'Save scheduled task',async()=>{
      const existing=store().get<OfficeSchedule>(namespace,id);
      if(existing&&(existing.owner!==user.id||input['revision']!==existing.revision))throw new Error('This schedule changed. Refresh and review it before saving.');
      if(!existing&&input['revision']!==undefined)throw new Error('This scheduled task is unavailable.');
      if(typeof input['title']!=='string'||!input['title'].trim()||input['title'].length>120||typeof input['prompt']!=='string'||!input['prompt'].trim()||input['prompt'].length>32000)throw new Error('Add a title and instructions of up to 32,000 characters.');
      if(typeof input['model']!=='string'||!/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(input['model']))throw new Error('Choose a model for this task.');
      if(!['once','daily','weekly'].includes(String(input['frequency'])))throw new Error('Choose a valid repeat setting.');
      if(input['enabled']!==undefined&&typeof input['enabled']!=='boolean')throw new Error('Choose whether this schedule is active.');
      if(typeof input['timeZone']!=='string'||input['timeZone'].length>100)throw new Error('Choose a valid time zone.');
      const nextRunAt=input['nextRunAt'];
      if(typeof nextRunAt!=='number'||!Number.isSafeInteger(nextRunAt)||nextRunAt<=Date.now()||nextRunAt>Date.now()+5*366*86400000)throw new Error('Choose a future time within the next five years.');
      let clock:ReturnType<typeof scheduleClock>;try{clock=scheduleClock(nextRunAt,input['timeZone']);}catch{throw new Error('Choose a valid time zone.');}
      const task:OfficeSchedule={id,owner:user.id,revision:randomUUID(),title:input['title'].trim(),prompt:input['prompt'].trim(),model:input['model'],projectPath:typeof input['projectPath']==='string'?input['projectPath']:user.workspacePath,frequency:input['frequency'] as OfficeSchedule['frequency'],timeZone:input['timeZone'],...clock,enabled:input['enabled']!==false,nextRunAt,...(existing?.lastSessionId?{lastSessionId:existing.lastSessionId,lastRunAt:existing.lastRunAt}:{} )};
      store().transaction(()=>{if(!existing&&this.list(user).length>=50)throw new Error('You can keep up to 50 scheduled tasks. Remove one before adding another.');store().set(namespace,id,task);});
      return publicSchedule(task);
    });
  }
  async remove(user:OfficeUser,id:string,revision:unknown){
    // eslint-disable-next-line @typescript-eslint/require-await -- Coordinator callbacks return promises.
    await runCrossWindowExclusive('office-schedule:'+id,'Remove scheduled task',async()=>{const task=this.read(user,id);if(revision!==task.revision)throw new Error('This schedule changed. Refresh before removing it.');store().set(namespace,id,undefined);});
  }
  async setEnabled(user:OfficeUser,id:string,revision:unknown,enabled:boolean):Promise<UserSchedule>{
    // eslint-disable-next-line @typescript-eslint/require-await -- Coordinator callbacks return promises.
    return runCrossWindowExclusive('office-schedule:'+id,'Update scheduled task',async()=>{
      const task=this.read(user,id);if(task.revision!==revision)throw new Error('This schedule changed. Refresh before updating it.');
      if(enabled&&task.nextRunAt<=Date.now()){const next=nextScheduleRun(task,Date.now());if(next===undefined)throw new Error('Edit this task and choose a new future time.');task.nextRunAt=next;}
      task.enabled=enabled;task.revision=randomUUID();store().set(namespace,id,task);return publicSchedule(task);
    });
  }
  async run(user:OfficeUser,id:string,revision:unknown):Promise<UserSchedule>{
    return this.execute(user,id,true,revision);
  }
  private async execute(user:OfficeUser,id:string,manual=false,revision?:unknown):Promise<UserSchedule>{
    return runCrossWindowExclusive('office-schedule:'+id,'Start scheduled task',async()=>{
      const task=this.read(user,id), now=Date.now();
      if(manual&&task.revision!==revision)throw new Error('This schedule changed. Refresh before running it.');
      if(!manual&&!task.pending&&(!task.enabled||task.nextRunAt>now))return publicSchedule(task);
      if(!task.pending){task.pending={requestId:`schedule-${task.id}-${randomUUID()}`,dueAt:manual?now:task.nextRunAt,manual};store().set(namespace,id,task);}
      const manualRun=task.pending.manual;
      const current=await waitWithin(this.options.readUser(user.id),3000,'Workspace access could not be checked. Refresh before retrying.');
      const controller=new AbortController();
      try{
        if(!current)throw new Error('This workspace is unavailable.');access(current);
        const sessionId=await waitWithin(this.options.enqueue(current,task,task.pending.requestId,controller.signal),5000,'The run could not be confirmed. Check conversations before retrying.',controller.signal);
        task.lastSessionId=sessionId;task.lastRunAt=now;task.lastError=undefined;
      }catch(error){task.lastError=userWorkspaceNotice(error instanceof Error?error.message:'This task could not be started.');task.lastRunAt=now;}finally{controller.abort();}
      task.pending=undefined;task.revision=randomUUID();
      if(!manualRun){const next=nextScheduleRun(task,now);if(next!==undefined)task.nextRunAt=next;else task.enabled=false;}
      store().set(namespace,id,task);
      return publicSchedule(task);
    });
  }
  async pump(){
    if(this.stopped||this.pumping)return;this.pumping=true;
    try{
      const now=Date.now();const due=store().keys(namespace).map(id=>store().get<OfficeSchedule>(namespace,id)).filter((task):task is OfficeSchedule=>!!task&&(!!task.pending||task.enabled&&task.nextRunAt<=now)).slice(0,20);
      for(const task of due){if(this.stopped)break;const user=await waitWithin(this.options.readUser(task.owner),3000,'Scheduled workspace access check timed out.');if(user?.enabled&&user.role==='user'&&user.features.includes('tasks'))await this.execute(user,task.id);}
    }catch(error){console.warn('[codexManager] Scheduled task dispatch failed',error);}finally{this.pumping=false;}
  }
}
