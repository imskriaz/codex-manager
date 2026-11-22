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

let root:string,storage:SqliteStateStore;
const services:OfficeSessionService[]=[];
const user:OfficeUser={id:"alex",username:"alex",displayName:"Alex",role:"user",enabled:true,features:["generalChat","files"],workspacePath:"C:/team/alex",mcpServers:[],defaultPrompt:"Help with office work.",createdAt:0};
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),"team-sessions-"));storage=await SqliteStateStore.open(path.join(root,"manager.sqlite"));configureSqliteStateStore(storage);vi.spyOn(teamSettings,"readTeamSettings").mockReturnValue({...teamSettings.readTeamSettings(),defaultModel:"configured-model"});});
afterEach(async()=>{vi.restoreAllMocks();services.forEach(service=>service.stop());services.length=0;configureSqliteStateStore(undefined);storage.close();await removeTestDirectory(root);});
function setup(generate=vi.fn(async()=>"Hello")){
 const changed=vi.fn();const service=new OfficeSessionService({readUser:async()=>user,generate,changed});services.push(service);return {service,generate,changed};
}
const start=(requestId="request-1",text="Hello")=>({type:"dashboard:action" as const,action:"startCodexCliSession" as const,requestId,payload:{text}});
it('persists a single updated plan and questions through reload and includes them when the user continues',async()=>{
 const generate=vi.fn(async(_user:unknown,_model:unknown,_messages:unknown,_signal:unknown,_project:unknown,report:(message:any)=>void)=>{
   report(sessionPlanMessage('plan',{steps:[{step:'Read requirements',status:'inProgress'},{step:'Write draft',status:'pending'}]}));
   report(sessionPlanMessage('plan',{steps:[{step:'Read requirements',status:'completed'},{step:'Write draft',status:'inProgress'}]}));
   report({id:'question',role:'assistant',text:'Which format?',questions:[{title:'Which format?',options:['Document','List']}]});return 'Please choose a format.';
 });
 const {service}=setup(generate as any);const first=await service.handle(user,start());await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe('idle'));service.stop();
 const next=setup();const read=await next.service.handle(user,{type:'dashboard:action',action:'getCodexCliSessionMessages',requestId:'read-plan',payload:{sessionId:first.cliSession!.id}});
 const plans=read.cliSessionMessages!.filter(message=>message.kind==='plan');expect(plans).toHaveLength(1);expect(plans[0].status).toBe('unknown');expect(messageSessionPlan(plans[0])?.steps.map(step=>step.status)).toEqual(['completed','inProgress']);
 await next.service.handle(user,{type:'dashboard:action',action:'sendCodexCliSessionMessage',requestId:'answer',payload:{sessionId:first.cliSession!.id,text:'Document'}});await vi.waitFor(()=>expect(next.generate).toHaveBeenCalledTimes(1));
 expect(next.generate.mock.calls[0]?.[2]).toEqual(expect.arrayContaining([{role:'assistant',content:'[x] Read requirements\n[ ] Write draft'},{role:'assistant',content:expect.stringContaining('Which format?')} ]));
});
it("stores private sessions and messages, rejects another user's identifiers, and keeps identity across service restarts",async()=>{
 const {service,generate}=setup();const first=await service.handle(user,start());const id=first.cliSession!.id;
 await vi.waitFor(()=>expect(service.list(user.id)[0]?.status).toBe("idle"));
 expect(generate).toHaveBeenCalledWith(user,"configured-model",[{role:"system",content:user.defaultPrompt},{role:"user",content:"Hello"}],expect.any(AbortSignal),user.workspacePath,expect.any(Function));
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
 await service.handle(user,{type:"dashboard:action",action:"cancelCodexCliSessionTurn",requestId:"cancel",payload:{sessionId:first.cliSession!.id}});
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
 expect(generate.mock.calls[0]?.[2].slice(0,3)).toEqual([{role:"system",content:"Help every user clearly."},{role:"system",content:user.defaultPrompt},{role:"system",content:"Use short answers."}]);
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
 expect(result.cliComposerConfig?.modelDiscoveryWarning).toContain("selected model is kept");expect(JSON.stringify(result)).not.toContain("provider-secret");
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
 expect(result.cliComposerConfig?.defaultModel).toBe("configured-model");expect(result.cliComposerConfig?.models).toEqual([]);
});
