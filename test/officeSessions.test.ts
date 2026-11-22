import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as teamSettings from "../src/services/teamSettings";
import { saveOfficeInstructions } from "../src/services/officePreferences";
import { OfficeCapacityError, OfficeSessionService } from "../src/services/officeSessions";
import { sessionPlanMessage, messageSessionPlan } from '../src/domain/sessionPlan';
import { configureSqliteStateStore, SqliteStateStore } from "../src/storage/sqliteState";
import type { OfficeUser } from "../src/services/officeUsers";
import { removeTestDirectory } from "./testFilesystem";
import { acceptCliLiveState } from '../webview-src/dashboard/cliSessionLiveState';
import { isCodexSessionLiveState } from '../src/domain/codexSessionLive';
import type { DashboardCodexSessionLiveState } from '../src/domain/dashboard/types';

let root:string,storage:SqliteStateStore;
const services:OfficeSessionService[]=[];
const user:OfficeUser={id:"alex",username:"alex",displayName:"Alex",role:"user",enabled:true,features:["generalChat","files"],workspacePath:"C:/team/alex",mcpServers:[],defaultPrompt:"Help with office work.",createdAt:0};
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),"team-sessions-"));storage=await SqliteStateStore.open(path.join(root,"manager.sqlite"));configureSqliteStateStore(storage);vi.spyOn(teamSettings,"readTeamSettings").mockReturnValue({...teamSettings.readTeamSettings(),defaultModel:"configured-model"});});
afterEach(async()=>{vi.useRealTimers();vi.restoreAllMocks();services.forEach(service=>service.stop());services.length=0;configureSqliteStateStore(undefined);storage.close();await removeTestDirectory(root);});
function setup(generate=vi.fn(async()=>"Hello")){
 const changed=vi.fn();const service=new OfficeSessionService({readUser:async()=>user,generate,changed});services.push(service);return {service,generate,changed};
}
const start=(requestId="request-1",text="Hello")=>({type:"dashboard:action" as const,action:"startCodexCliSession" as const,requestId,payload:{text}});
it('delivers every follow-up live turn even with identical timestamps and across service instances',async()=>{
 const {service,changed}=setup();const first=await service.handle(user,start());await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe('idle'));
 await service.handle(user,{type:'dashboard:action',action:'sendCodexCliSessionMessage',requestId:'second',payload:{sessionId:first.cliSession!.id,text:'Second'}});await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe('idle'));
 let previous:DashboardCodexSessionLiveState|undefined;
 const snapshots=changed.mock.calls.flatMap(call=>call[1]).filter(message=>message.type==='dashboard:codex-session-live').map(message=>(message as any).state as DashboardCodexSessionLiveState);
 for(const state of snapshots){expect(isCodexSessionLiveState(state)).toBe(true);expect(acceptCliLiveState(previous,state)).toBe(true);previous=state;expect(state.messages.every(message=>message.turnId===state.turnId)).toBe(true);}
 expect(new Set(snapshots.map(state=>state.streamId)).size).toBe(2);
 service.stop();const next=setup();await next.service.handle(user,{type:'dashboard:action',action:'renameCodexCliSession',requestId:'rename',payload:{sessionId:first.cliSession!.id,text:'Renamed'}});
 const state=(next.changed.mock.calls.flatMap(call=>call[1]).find(message=>message.type==='dashboard:codex-session-live') as any).state;expect(acceptCliLiveState(previous,state)).toBe(true);
});
it('bounds large live snapshots while retaining complete saved history',async()=>{
 const generate=vi.fn(async()=> 'A'.repeat(20_000)),{service,changed}=setup(generate);const first=await service.handle(user,start());await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe('idle'));
 const snapshots=changed.mock.calls.flatMap(call=>call[1]).filter(message=>message.type==='dashboard:codex-session-live').map(message=>(message as any).state);
 expect(snapshots.every(state=>isCodexSessionLiveState(state))).toBe(true);expect(snapshots.at(-1).truncated).toBe(true);
 const read=await service.handle(user,{type:'dashboard:action',action:'getCodexCliSessionMessages',requestId:'read',payload:{sessionId:first.cliSession!.id}});expect(read.cliSessionMessages?.at(-1)?.text.length).toBe(20_000);
});
it('stops old queued work after an uncertain response and accepts an explicit continuation',async()=>{
 let reject!:(error:Error)=>void;const generate=vi.fn(()=>new Promise<string>((_resolve,no)=>{reject=no;}));const {service}=setup(generate);const first=await service.handle(user,start());await vi.waitFor(()=>expect(generate).toHaveBeenCalledTimes(1));
 await service.handle(user,{type:'dashboard:action',action:'sendCodexCliSessionMessage',requestId:'queued',payload:{sessionId:first.cliSession!.id,text:'Later'}});
 reject(new Error('Unknown result'));await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe('idle'));
 const read=await service.handle(user,{type:'dashboard:action',action:'getCodexCliSessionMessages',requestId:'read',payload:{sessionId:first.cliSession!.id}});expect(read.cliSessionMessages?.some(message=>message.text.includes('message was not run'))).toBe(true);
 generate.mockResolvedValueOnce('Recovered after checking saved work.');await service.handle(user,{type:'dashboard:action',action:'sendCodexCliSessionMessage',requestId:'continue',payload:{sessionId:first.cliSession!.id,text:'Continue'}});await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe('idle'));expect(generate).toHaveBeenCalledTimes(2);expect(JSON.stringify(generate.mock.calls[1])).toContain('Inspect saved work only if it is relevant');
});
it('releases a timed-out generation and rejects late reports or success',async()=>{
 vi.useFakeTimers();
 let finish!:(text:string)=>void,report!: (activity:any)=>void;const generate=vi.fn((_user:unknown,_model:unknown,_messages:unknown,_signal:unknown,_project:unknown,send:(activity:any)=>void)=>{report=send;return new Promise<string>(resolve=>{finish=resolve;});});
 const {service,changed}=setup(generate as any);const first=await service.handle(user,start());await vi.waitFor(()=>expect(generate).toHaveBeenCalledTimes(1));
 await vi.advanceTimersByTimeAsync(600_001);expect((service as any).running.size).toBe(0);report({id:'late',role:'assistant',text:'Late activity'});finish('Late success');await Promise.resolve();
 const read=await service.handle(user,{type:'dashboard:action',action:'getCodexCliSessionMessages',requestId:'read',payload:{sessionId:first.cliSession!.id}});expect(read.cliSessionMessages?.map(message=>message.text).join()).not.toMatch(/Late/);expect(changed.mock.calls.flatMap(call=>call[1]).some(message=>message.type==='dashboard:notice'&&message.message==='Your response is ready.')).toBe(false);
});
it('rejects oversized attachments rather than silently sending an unavailable file placeholder',async()=>{
 const {service,generate}=setup();const attachment={id:'file',name:'notes.txt',kind:'text',mimeType:'text/plain',data:'x'.repeat(33_000),size:33_000};
 await expect(service.handle(user,{...start(),payload:{text:'Read it',attachments:[attachment] as any}})).rejects.toThrow('uploads are temporarily unavailable');expect(service.list(user.id)).toEqual([]);expect(generate).not.toHaveBeenCalled();
});
it('deletes a conversation without publishing stale transcript content',async()=>{
 const {service,changed}=setup();const first=await service.handle(user,start());await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe('idle'));changed.mockClear();
 await service.handle(user,{type:'dashboard:action',action:'deleteCodexCliSession',requestId:'delete',payload:{sessionId:first.cliSession!.id,confirmed:true}});expect(service.list(user.id)).toEqual([]);expect(changed.mock.calls.flatMap(call=>call[1]).some(message=>message.type==='dashboard:codex-session-live')).toBe(false);
});
it('bounds optional model discovery and keeps the configured model available',async()=>{
 vi.useFakeTimers();const {service,generate}=setup();(service as any).options.models=()=>new Promise(()=>{});
 const pending=service.handle(user,{type:'dashboard:action',action:'listCodexCliSessions',requestId:'slow-models'});await vi.advanceTimersByTimeAsync(3001);
 const result=await pending;expect(result.cliComposerConfig?.defaultModel).toBe('configured-model');expect(result.cliComposerConfig?.models.map(item=>item.id)).toContain('configured-model');expect(result.cliComposerConfig?.modelDiscoveryWarning).toBeUndefined();expect(generate).not.toHaveBeenCalled();
});
it('repairs queues already blocked by an uncertain result from an older host',async()=>{
 const {service}=setup();const first=await service.handle(user,start());await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe('idle'));service.stop();
 const saved=storage.get<any>(`office-sessions:${user.id}`,first.cliSession!.id)!;saved.turns[0].state='uncertain';saved.turns.push({...saved.turns[0],id:crypto.randomUUID(),requestId:'old-queued',state:'queued',assistant:undefined});storage.set(`office-sessions:${user.id}`,saved.id,saved);
 const next=setup();next.service.start();await vi.waitFor(()=>expect(next.service.list(user.id)[0]?.status).toBe('idle'));expect(next.generate).not.toHaveBeenCalled();
 const read=await next.service.handle(user,{type:'dashboard:action',action:'getCodexCliSessionMessages',requestId:'read',payload:{sessionId:saved.id}});expect(read.cliSessionMessages?.some(message=>message.text.includes('message was not run'))).toBe(true);
});
it('persists a single updated plan and questions through reload and includes them when the user continues',async()=>{
 const generate=vi.fn(async(_user:unknown,_model:unknown,_messages:unknown,_signal:unknown,_project:unknown,report:(message:any)=>void)=>{
   report(sessionPlanMessage('plan',{steps:[{step:'Read requirements',status:'inProgress'},{step:'Write draft',status:'pending'}]}));
   report(sessionPlanMessage('plan',{steps:[{step:'Read requirements',status:'completed'},{step:'Write draft',status:'inProgress'}]}));
   report({id:'question',role:'assistant',text:'Which format?',questions:[{title:'Which format?',options:['Document','List']}]});return 'Please choose a format.';
 });
 const {service}=setup(generate as any);const first=await service.handle(user,start());await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe('idle'));service.stop();
 const next=setup();const read=await next.service.handle(user,{type:'dashboard:action',action:'getCodexCliSessionMessages',requestId:'read-plan',payload:{sessionId:first.cliSession!.id}});
 const plans=read.cliSessionMessages!.filter(message=>message.kind==='plan');expect(plans).toHaveLength(1);expect(plans[0].status).toBe('unknown');expect(messageSessionPlan(plans[0])?.steps.map(step=>step.status)).toEqual(['completed','inProgress']);
 expect(read.cliSessionMessages?.at(-1)?.questions).toHaveLength(1);
 await next.service.handle(user,{type:'dashboard:action',action:'sendCodexCliSessionMessage',requestId:'answer',payload:{sessionId:first.cliSession!.id,text:'Document'}});await vi.waitFor(()=>expect(next.generate).toHaveBeenCalledTimes(1));
 expect(next.generate.mock.calls[0]?.[2]).toEqual(expect.arrayContaining([{role:'assistant',content:'[x] Read requirements\n[ ] Write draft'},{role:'assistant',content:expect.stringContaining('Which format?')} ]));
});
it("stores private sessions and messages, rejects another user's identifiers, and keeps identity across service restarts",async()=>{
 const {service,generate}=setup();const first=await service.handle(user,start());const id=first.cliSession!.id;
 await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe("idle"));
 expect(generate).toHaveBeenCalledWith(user,"configured-model",[{role:"system",content:teamSettings.readTeamSettings().globalPrompt},{role:"system",content:user.defaultPrompt},{role:"user",content:"Hello"}],expect.any(AbortSignal),user.workspacePath,expect.any(Function),undefined,expect.any(String),undefined);
 expect(service.list("sam")).toEqual([]);
 await expect(service.handle({...user,id:"sam"},{type:"dashboard:action",action:"getCodexCliSessionMessages",requestId:"other",payload:{sessionId:id}})).rejects.toThrow("unavailable");
 service.stop();const next=setup().service;
 const read=await next.handle(user,{type:"dashboard:action",action:"getCodexCliSessionMessages",requestId:"read",payload:{sessionId:id}});
 expect(read.cliSession?.id).toBe(id);expect(read.cliSessionMessages?.map(message=>message.text)).toEqual(["Hello","Hello"]);
 await next.handle(user,{type:"dashboard:action",action:"sendCodexCliSessionMessage",requestId:"followup",payload:{sessionId:id,text:"Continue"}});
 await vi.waitFor(()=>expect(next.list(user.id)[0]?.status).toBe("idle"));
 expect(next.list(user.id)).toHaveLength(1);
});
it("deduplicates accepted requests and rejects a changed replay",async()=>{
 const {service,generate}=setup();const first=await service.handle(user,start());const replay=await service.handle(user,start());
 expect(replay.cliSession?.id).toBe(first.cliSession?.id);
 await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe("idle"));expect(generate).toHaveBeenCalledTimes(1);
 await expect(service.handle(user,start("request-1","Changed"))).rejects.toThrow("request changed");
});
it("retains a capacity rejection in the queue and resumes the original message when capacity returns",async()=>{
 const generate=vi.fn<() => Promise<string>>().mockRejectedValueOnce(new OfficeCapacityError()).mockResolvedValue("Ready");
 const {service,changed}=setup(generate);const first=await service.handle(user,start());
 await vi.waitFor(()=>expect(service.list(user.id)[0]?.queueError).toContain("All assistants are busy"));
 const namespace=`office-sessions:${user.id}`,session=storage.get<any>(namespace,first.cliSession!.id)!;
 session.turns[0].retryAt=0;storage.set(namespace,session.id,session);await service.pump();
 await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe("idle"));expect(generate).toHaveBeenCalledTimes(2);
 const result=await service.handle(user,{type:"dashboard:action",action:"getCodexCliSessionMessages",requestId:"read",payload:{sessionId:session.id}});
 expect(result.cliSessionMessages?.map(message=>message.text)).toEqual(["Hello","Ready"]);
 expect(changed.mock.calls.flatMap(call=>call[1]).some(message=>message.type==="dashboard:notice"&&message.message==="Your response is ready.")).toBe(true);
});
it("does not replay ambiguous model failures and cancels pending work without deleting history",async()=>{
 const generate=vi.fn(async()=>{throw new Error("account-private@example.test token expired");});const {service}=setup(generate);
 const first=await service.handle(user,start());await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe("idle"));
 await service.pump();expect(generate).toHaveBeenCalledTimes(1);
 const result=await service.handle(user,{type:"dashboard:action",action:"getCodexCliSessionMessages",requestId:"read",payload:{sessionId:first.cliSession!.id}});
 expect(JSON.stringify(result)).not.toContain("account-private");expect(result.cliSessionMessages?.at(-1)?.text).toContain("could not be confirmed");
 const cancel=await service.handle(user,{type:"dashboard:action",action:"cancelCodexCliSessionTurn",requestId:"cancel",payload:{sessionId:first.cliSession!.id}});
 expect(cancel.cliSessionMessages?.[0]?.text).toBe("Hello");
});
it("does not announce a completed response after the user cancels the turn",async()=>{
 let finish!:(value:string)=>void;const generate=vi.fn<ConstructorParameters<typeof OfficeSessionService>[0]["generate"]>((_user,_model,_messages,_signal,_project,report)=>{report({id:'active-call',kind:'tool-call',text:'Reading the document',status:'inProgress'});return new Promise<string>(resolve=>{finish=resolve;});});
 const {service,changed}=setup(generate as any);const first=await service.handle(user,start());
 await vi.waitFor(()=>expect(generate).toHaveBeenCalledTimes(1));
 const stopped=await service.handle(user,{type:"dashboard:action",action:"cancelCodexCliSessionTurn",requestId:"cancel",payload:{sessionId:first.cliSession!.id}});expect(stopped.notice?.message).toContain('already being saved');
 finish("Late response");await vi.waitFor(()=>expect((service as any).running.size).toBe(0));
 expect(changed.mock.calls.flatMap(call=>call[1]).some(message=>message.type==="dashboard:notice"&&message.message==="Your response is ready.")).toBe(false);
 const read=await service.handle(user,{type:"dashboard:action",action:"getCodexCliSessionMessages",requestId:"read",payload:{sessionId:first.cliSession!.id}});
 expect(read.cliSessionMessages?.map(message=>message.text)).toEqual(["Hello","Reading the document"]);expect(read.cliSessionMessages?.[1]?.status).toBe('interrupted');
});
it("retains every activity and command output in order across reload, with host paths masked",async()=>{
 const generate=vi.fn(async(_user:unknown,_model:unknown,_messages:unknown,_signal:unknown,_project:unknown,report:(message:any)=>void)=>{
   report({id:'read',kind:'tool-call',title:'Read file',text:'Reading the document',status:'inProgress'});
   report({id:'read',kind:'tool-call',title:'Read file',text:'Read the document',status:'completed',result:'All document text remains here.'});
   report({id:'command',kind:'command',command:'cd "C:/team/alex" && npm test',cwd:'C:/team/alex',text:'Checking your changes',output:'83 checks passed.',status:'completed'});
   return 'Finished';
 });
 const {service,changed}=setup(generate as any);const first=await service.handle(user,start());await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe('idle'));
 service.stop();const next=setup().service;const read=await next.handle(user,{type:'dashboard:action',action:'getCodexCliSessionMessages',requestId:'read',payload:{sessionId:first.cliSession!.id}});
 expect(read.cliSessionMessages?.map(message=>message.id)).toEqual([expect.any(String),'read','command',expect.any(String)]);
 expect(read.cliSessionMessages?.[1]?.result).toBe('All document text remains here.');expect(read.cliSessionMessages?.[2]?.command).toBe('cd "alex" && npm test');expect(read.cliSessionMessages?.[2]?.output).toBe('83 checks passed.');
 const sequences=changed.mock.calls.flatMap(call=>call[1]).filter(message=>message.type==='dashboard:codex-session-live').map(message=>(message as any).state.sequence);
 expect(new Set(sequences).size).toBe(sequences.length);
});
it("shares the active request limit across service instances and releases queued work after completion",async()=>{
 vi.spyOn(teamSettings,"readTeamSettings").mockReturnValue({...teamSettings.readTeamSettings(),maxActiveRequests:1});
 let finish!:(value:string)=>void;
 const firstGenerate=vi.fn<() => Promise<string>>().mockImplementationOnce(()=>new Promise<string>(resolve=>{finish=resolve;})).mockResolvedValue("Hello");
 const first=setup(firstGenerate).service,second=setup().service;
 await first.handle(user,start("first"));
 await vi.waitFor(()=>expect(firstGenerate).toHaveBeenCalledTimes(1));
 const waitingUser={...user,id:"waiting"};
 const queued=await second.handle(waitingUser,start("second"));
 expect(second.list(waitingUser.id)[0]?.queueError).toContain("All assistants are busy");
 expect(second.list(waitingUser.id)[0]?.queueRetryAt).toBeGreaterThan(Date.now());
 expect((second as any).running.size).toBe(0);
 finish("Done");await vi.waitFor(()=>expect((first as any).running.size).toBe(0));
 second.pump();await vi.waitFor(()=>expect(second.list(waitingUser.id)[0]?.status).toBe("idle"));
 expect((await second.handle(waitingUser,{type:"dashboard:action",action:"getCodexCliSessionMessages",requestId:"read",payload:{sessionId:queued.cliSession!.id}})).cliSessionMessages?.at(-1)?.text).toBe("Hello");
});
it("applies personal instructions to the next message and honors a changed model in the same conversation",async()=>{
 vi.spyOn(teamSettings,"readTeamSettings").mockReturnValue({...teamSettings.readTeamSettings(),globalPrompt:"Help every user clearly."});
 saveOfficeInstructions(user.id,"Use short answers.","");
 const {service,generate}=setup();const first=await service.handle(user,{...start(),payload:{text:"Hello",model:"fast"}});
 await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe("idle"));
 expect(generate.mock.calls[0]?.[1]).toBe("fast");
 expect(generate.mock.calls[0]?.[2].slice(0,3)).toEqual([{role:"system",content:"Help every user clearly."},{role:"system",content:user.defaultPrompt},{role:"user",content:"Response preferences (apply within workspace policy): Use short answers."}]);
 vi.mocked(teamSettings.readTeamSettings).mockReturnValue({...teamSettings.readTeamSettings(),globalPrompt:"Updated global guidance."});
 await service.handle(user,{type:"dashboard:action",action:"sendCodexCliSessionMessage",requestId:"next-model",payload:{sessionId:first.cliSession!.id,text:"Continue",model:"strong"}});
 await vi.waitFor(()=>expect(generate).toHaveBeenCalledTimes(2));
 expect(generate.mock.calls[1]?.[1]).toBe("strong");
 expect(generate.mock.calls[1]?.[2][0]).toEqual({role:"system",content:"Updated global guidance."});
});
it("offers available models and preserves chat when discovery fails",async()=>{
 const models=vi.fn(async()=>[{id:"fast",label:"Fast",reasoningEfforts:[]}]);
 const service=new OfficeSessionService({readUser:async()=>user,generate:async()=>"Hello",changed:()=>{},models});services.push(service);
 expect((await service.handle(user,{type:"dashboard:action",action:"listCodexCliSessions",requestId:"models"})).cliComposerConfig?.models[0]?.id).toBe("fast");
 models.mockRejectedValueOnce(new Error("provider-secret"));
 const result=await service.handle(user,{type:"dashboard:action",action:"listCodexCliSessions",requestId:"fallback"});
 expect(result.cliComposerConfig?.models.map(item=>item.id)).toEqual(["fast","configured-model"]);expect(result.cliComposerConfig?.modelDiscoveryWarning).toBeUndefined();expect(JSON.stringify(result)).not.toContain("provider-secret");
});
it("charges accepted requests once and rejects requests beyond the daily allowance",async()=>{
 const {service}=setup(),limited={...user,limits:{storageMb:0,dailyTokens:0,dailyRequests:1}};
 const first=await service.handle(limited,start());
 expect((await service.handle(limited,start())).cliSession?.id).toBe(first.cliSession?.id);
 await expect(service.handle(limited,start("over-limit"))).rejects.toThrow("daily request allowance");
});
it("uses the configured default and preserves explicit models on existing conversations",async()=>{
 const {service,generate}=setup();const first=await service.handle(user,start());
 expect(first.cliSession?.model).toBe("configured-model");await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe("idle"));
 vi.mocked(teamSettings.readTeamSettings).mockReturnValue({...teamSettings.readTeamSettings(),defaultModel:"new-default"});
 await service.handle(user,{type:"dashboard:action",action:"sendCodexCliSessionMessage",requestId:"same-conversation",payload:{sessionId:first.cliSession!.id,text:"Follow up"}});
 await vi.waitFor(()=>expect(generate).toHaveBeenCalledTimes(2));expect(generate.mock.calls[1]?.[1]).toBe("configured-model");
 const next=await service.handle(user,start("new-chat"));expect(next.cliSession?.model).toBe("new-default");
});
it("requires a user model when no default is configured and does not charge a rejected message",async()=>{
 vi.mocked(teamSettings.readTeamSettings).mockReturnValue({...teamSettings.readTeamSettings(),defaultModel:""});
 const {service,generate}=setup();
 await expect(service.handle(user,start())).rejects.toThrow("Choose a model");
 expect(service.list(user.id)).toEqual([]);expect(generate).not.toHaveBeenCalled();
 expect(storage.get(`office-usage:${user.id}`,new Date().toISOString().slice(0,10))).toBeUndefined();
 const selected=await service.handle(user,{...start(),payload:{text:"Hello",model:"chosen"}});
 expect(selected.cliSession?.model).toBe("chosen");
});
it("returns the master default even when the optional model catalogue cannot load",async()=>{
 const {service}=setup();
 const result=await service.handle(user,{type:"dashboard:action",action:"listCodexCliSessions",requestId:"config"});
 expect(result.cliComposerConfig?.defaultModel).toBe("configured-model");expect(result.cliComposerConfig?.models.map(item=>item.id)).toEqual(["configured-model"]);
});

it('persists the internal scheduled-run marker so restarted runs cannot recursively create schedules',async()=>{
 const {service,generate}=setup();const action=start();const first=await service.handle(user,action,{scheduled:true});
 await vi.waitFor(()=>expect(generate).toHaveBeenCalledTimes(1));
 expect((generate.mock.calls as unknown[][])[0]?.[6]).toBe(true);
 await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe('idle'));
 await service.handle(user,{type:'dashboard:action',action:'sendCodexCliSessionMessage',requestId:'manual-followup',payload:{sessionId:first.cliSession!.id,text:'Change the schedule'}});
 await vi.waitFor(()=>expect(generate).toHaveBeenCalledTimes(2));expect((generate.mock.calls as unknown[][])[1]?.[6]).toBeUndefined();
});

it('acknowledges a subscriber CSV attachment without a duplicate optimistic bubble and retains its model context',async()=>{
 const {service,generate}=setup();const attachment={id:'po',kind:'text' as const,name:'buyer-po.csv',mimeType:'text/csv',size:10,data:'Style,Qty'};
 const first=await service.handle(user,{...start(),payload:{text:'Cost this order',attachments:[attachment]}});
 await vi.waitFor(()=>expect(generate).toHaveBeenCalledTimes(1));
 const result=await service.handle(user,{type:'dashboard:action',action:'getCodexCliSessionMessages',requestId:'read',payload:{sessionId:first.cliSession!.id}});
 const echo=result.cliSessionMessages!.find(message=>message.role==='user')!;
 expect(echo.text).toBe('Cost this order');expect(echo.textAttachments).toEqual([{name:'buyer-po.csv',text:'Style,Qty'}]);
 const {isCliSubmissionEcho}=await import('../webview-src/dashboard/cliSessionComposerState');
 expect(isCliSubmissionEcho(echo,{text:'Cost this order',attachments:[attachment]},new Set())).toBe(true);
 expect((generate.mock.calls as unknown[][])[0]?.[2]).toEqual(expect.arrayContaining([{role:'user',content:'Cost this order\n\n<attached_file name="buyer-po.csv" chars=9>\nStyle,Qty\n</attached_file>'}]));
 await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe('idle'));
});

it('passes uploaded images to the model without persisting inline image data in conversation storage',async()=>{
 const {service,generate}=setup();const data='data:image/png;base64,iVBORw0KGgo=';
 (service as any).options.attachments=async()=>[{path:'uploads/sample.png',name:'sample.png',text:'',image:data,mimeType:'image/png'}];(service as any).options.images=async()=>[data];
 const first=await service.handle(user,{...start(),payload:{text:'Describe this image',attachments:[{id:'image',kind:'image',name:'sample.png',mimeType:'image/png',size:8,data}]}});await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe('idle'));
 expect(JSON.stringify(storage.get<any>(`office-sessions:${user.id}`,first.cliSession!.id))).not.toContain('iVBORw0KGgo=');expect(JSON.stringify(generate.mock.calls[0]?.[2])).toContain(data);
});

it('filters fallback models against current plan permissions without choosing a replacement',async()=>{
 const {service}=setup();(service as any).options.models=vi.fn().mockResolvedValueOnce([{id:'fast',label:'Fast',reasoningEfforts:[]}]).mockRejectedValue(new Error('unavailable'));
 await service.handle(user,{type:'dashboard:action',action:'listCodexCliSessions',requestId:'catalogue'});
 const limited={...user,plan:{name:'Limited',status:'active' as const,models:['permitted']}};
 const result=await service.handle(limited,{type:'dashboard:action',action:'listCodexCliSessions',requestId:'fallback'});
 expect(result.cliComposerConfig?.models.map(model=>model.id)).toEqual(['permitted']);expect(result.cliComposerConfig?.defaultModel).toBeUndefined();
});

it('keeps late model discovery for subsequent refreshes after the bounded initial fallback',async()=>{
 vi.useFakeTimers();const {service}=setup();let finish!:(models:any[])=>void;
 const discover=vi.fn(()=>new Promise<any[]>(resolve=>finish=resolve));(service as any).options.models=discover;
 const first=service.handle(user,{type:'dashboard:action',action:'listCodexCliSessions',requestId:'initial'});await vi.advanceTimersByTimeAsync(3001);
 expect((await first).cliComposerConfig?.models.map(item=>item.id)).toEqual(['configured-model']);
 const second=service.handle(user,{type:'dashboard:action',action:'listCodexCliSessions',requestId:'refresh'});finish([{id:'late',label:'Late',reasoningEfforts:[]}]);await vi.advanceTimersByTimeAsync(0);
 expect((await second).cliComposerConfig?.models[0].id).toBe('late');expect(discover).toHaveBeenCalledTimes(1);
});

it('routes Auto once per accepted turn, persists the chosen profile and thinking level, and ignores a forged backend model',async()=>{
 vi.mocked(teamSettings.readTeamSettings).mockReturnValue({...teamSettings.readTeamSettings(),modelMode:'auto',profilePicker:true,regularModel:'fast',professionalModel:'work',expertModel:'deep'});
 const {service,generate}=setup();const select=vi.fn(async()=>({model:'work',profile:'professional',reasoningEffort:'high'}));(service as any).options.selectModel=select;
 const started=await service.handle(user,{...start(),payload:{text:'Prepare a merchandising report',model:'forged-backend',reasoningEffort:'max'}});
 await vi.waitFor(()=>expect(service.list(user.id)[0].status).toBe('idle'));
 expect(select).toHaveBeenCalledOnce();expect(generate.mock.calls[0][1]).toBe('work');expect(generate.mock.calls[0][8]).toBe('high');
 expect(service.list(user.id)[0]).toMatchObject({model:'work',modelProfile:'professional',modelSelection:'auto',reasoningEffort:'high'});
 const config=await service.handle(user,{type:'dashboard:action',action:'listCodexCliSessions',requestId:'models'});expect(config.cliComposerConfig?.models.map(model=>model.label)).toEqual(['Auto','Regular','Professional','Expert']);
 expect(config.cliComposerConfig?.defaultModel).toBe('auto');expect(started.cliSession?.modelSelection).toBe('auto');
});
it('passes a pinned profile and supported thinking level without accepting a plan-excluded profile',async()=>{
 vi.mocked(teamSettings.readTeamSettings).mockReturnValue({...teamSettings.readTeamSettings(),modelMode:'auto',profilePicker:true,regularModel:'fast',professionalModel:'work',expertModel:'deep'});
 const {service}=setup();const select=vi.fn(async()=>({model:'deep',profile:'expert',reasoningEffort:'high'}));(service as any).options.selectModel=select;
 await service.handle(user,{...start(),payload:{text:'Audit',model:'expert',reasoningEffort:'high'}});await vi.waitFor(()=>expect(select).toHaveBeenCalledOnce());expect(select.mock.calls[0][5]).toMatchObject({profile:'expert',reasoningEffort:'high'});
 const limited={...user,id:'limited',plan:{name:'Small',status:'active' as const,models:['fast']}};await expect(service.handle(limited,{...start(),requestId:'denied',payload:{text:'Audit',model:'expert'}})).rejects.toThrow('included in your plan');
});
it('stores and sends manual thinking levels and keeps general greetings independent of uncertain file recovery',async()=>{
 const {service,generate}=setup();const first=await service.handle(user,{...start(),payload:{text:'hi',model:'fast',reasoningEffort:'high'}});await vi.waitFor(()=>expect(service.list(user.id)[0].status).toBe('idle'));
 expect(generate.mock.calls[0][8]).toBe('high');expect(service.list(user.id)[0].reasoningEffort).toBe('high');
 const stored=storage.get<any>(`office-sessions:${user.id}`,first.cliSession!.id);stored.turns[0].state='uncertain';stored.turns[0].assistant=undefined;storage.set(`office-sessions:${user.id}`,stored.id,stored);
 await service.handle(user,{type:'dashboard:action',action:'sendCodexCliSessionMessage',requestId:'hello-again',payload:{sessionId:stored.id,text:'How are you'}});await vi.waitFor(()=>expect(generate).toHaveBeenCalledTimes(2));
 expect(JSON.stringify(generate.mock.calls[1][2])).toContain('greetings and general chat do not need file checks');
});

it('starts another chat without inheriting project messages or pending recovery instructions',async()=>{
 const {service,generate}=setup();await service.handle(user,{...start('old-project','Edit index.html for Earlier project'),payload:{text:'Edit index.html for Earlier project',projectPath:'C:/team/alex/earlier'}});await vi.waitFor(()=>expect(service.list(user.id)[0].status).toBe('idle'));
 const first=storage.get<any>(`office-sessions:${user.id}`,service.list(user.id)[0].id);first.turns[0].state='uncertain';storage.set(`office-sessions:${user.id}`,first.id,first);
 await service.handle(user,start('fresh-chat','Hi, how are you?'));await vi.waitFor(()=>expect(generate).toHaveBeenCalledTimes(2));
 expect(JSON.stringify(generate.mock.calls[1][2])).not.toMatch(/Earlier project|index.html|earlier reply/i);expect(generate.mock.calls[1][4]).toBe(user.workspacePath);
});
