import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { SqliteStateStore, configureSqliteStateStore } from '../src/storage/sqliteState';
import { getCodexSessionLiveState } from '../src/services/codexSessionLive';
import { flushSessionRecording } from '../src/services/sessionRecording';
import { respondCodexAppServerPrompt, listPendingCodexAppServerPrompts } from '../src/services/codexAppServerPrompts';
import * as sessions from '../src/services/claudeSessions';

const mocks = vi.hoisted(() => ({ query:vi.fn(), renameSession:vi.fn(), archiveSession:vi.fn(),unarchiveSession:vi.fn(),deleteSession:vi.fn(),forkSession:vi.fn(),getSessionMessages:vi.fn(),resolve:vi.fn() }));
vi.mock('../src/services/claudeCliRuntime', () => ({
  claudeConfigHome:()=> 'claude-test', claudeEnvironment:()=>({}), claudeAccountKey:()=> 'native-account', resolveClaudeCliExecutable:mocks.resolve,
  claudeSdk:async()=>mocks
}));
let root: string, store: SqliteStateStore;
let finish:()=>void, received:unknown[], nativeOptions:any, identity:string, interrupted:boolean, replayFollowUp:boolean;

beforeEach(async()=>{
  root=await mkdtemp(path.join(tmpdir(),'manager-claude-'));store=await SqliteStateStore.open(path.join(root,'manager.sqlite'));configureSqliteStateStore(store);
  vi.clearAllMocks();mocks.resolve.mockResolvedValue('claude.exe');mocks.getSessionMessages.mockResolvedValue([]);received=[];interrupted=false;replayFollowUp=false;
  mocks.query.mockImplementation(({prompt,options})=>{
    nativeOptions=options;identity=options.sessionId??options.resume;
    const done=new Promise<void>(resolve=>{finish=resolve;});
    return {
      initializationResult:async()=>({models:[{value:'opus',displayName:'Opus',supportedEffortLevels:['low','high','max']}]}),
      close:vi.fn(),setPermissionMode:vi.fn().mockResolvedValue(undefined),interrupt:vi.fn(async()=>{interrupted=true;finish();}),
      async *[Symbol.asyncIterator](){
        const iterator=prompt[Symbol.asyncIterator]();const user=await iterator.next();received.push(user.value);yield {...user.value,session_id:identity};
        yield {type:'stream_event',session_id:identity,event:{type:'message_start',message:{id:'msg',usage:{input_tokens:100}}}};
        yield {type:'stream_event',session_id:identity,event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}};
        yield {type:'stream_event',session_id:identity,event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hello from native Claude'}}};
        yield {type:'rate_limit_event',session_id:identity,rate_limit_info:{status:'allowed_warning',rateLimitType:'five_hour',utilization:.75,resetsAt:2_000_000_000}};
        await done;
        if(replayFollowUp){const followUp=await iterator.next();received.push(followUp.value);yield {...followUp.value,session_id:identity};}
        yield {type:'result',subtype:interrupted?'error_during_execution':'success',session_id:identity,is_error:interrupted,errors:interrupted?['Stopped']:undefined,usage:{input_tokens:100,output_tokens:7},modelUsage:{opus:{contextWindow:200000}},queued_turn_count:0};
      }
    };
  });
});
afterEach(async()=>{finish?.();await new Promise(resolve=>setTimeout(resolve,40));flushSessionRecording();configureSqliteStateStore(undefined);store.close();await rm(root,{recursive:true,force:true});});
const until=async(predicate:()=>boolean)=>{await vi.waitFor(()=>expect(predicate()).toBe(true),{timeout:2000,interval:5});};
const start=()=>sessions.startClaudeSession({text:'Hello',projectPath:root,model:'claude-code/opus',reasoningEffort:'high',sandboxMode:'danger-full-access',autoApprove:false});

describe('Claude native sessions',()=>{
  it('starts without opening an editor, streams, saves provider identity and records native quota',async()=>{
    const id=await start();await until(()=>sessions.readClaudeSession(id)?.nativeQuota?.limits.length===1);
    expect(nativeOptions).toMatchObject({model:'opus',sessionId:id,permissionMode:'default',allowDangerouslySkipPermissions:false,settingSources:['user','project','local']});
    expect(received).toHaveLength(1);
    expect(getCodexSessionLiveState(id)).toMatchObject({provider:'claude',status:'running',messages:expect.arrayContaining([expect.objectContaining({text:'Hello from native Claude'})])});
    expect(sessions.readClaudeSession(id)).toMatchObject({provider:'claude',nativeQuota:{limits:[{kind:'five_hour',usedPercent:75}]}});
    finish();await until(()=>sessions.readClaudeSession(id)?.status==='idle');
    expect(getCodexSessionLiveState(id)?.status).toBe('completed');
    expect((await sessions.readClaudeHistory(id)).messages.some(row=>row.text==='Hello from native Claude')).toBe(true);
    expect(sessions.listClaudeSessions().map(row=>row.id)).toContain(id);
  });
  it('uses native Resume and prevents cross-provider sends',async()=>{
    const id=await start();finish();await until(()=>sessions.readClaudeSession(id)?.status==='idle');
    await expect(sessions.sendClaudeMessage(id,{text:'Next',model:'gpt-test'})).rejects.toThrow('OpenAI');
    const turn=sessions.sendClaudeMessage(id,{text:'Next',model:'claude-code/opus',reasoningEffort:'low'});
    await until(()=>nativeOptions.resume===id);finish();await turn;expect(nativeOptions.sessionId).toBeUndefined();
  });
  it('requires the matching active turn for follow-ups and Stop',async()=>{
    const id=await start();
    await expect(sessions.steerClaudeSession(id,{text:'Wrong'},randomUUID())).rejects.toThrow('changed');
    await expect(sessions.stopClaudeSession(id,randomUUID())).rejects.toThrow('changed');
    expect(await sessions.stopClaudeSession(id,sessions.readClaudeSession(id)?.steerTurnId)).toBe(true);
    await until(()=>getCodexSessionLiveState(id)?.status==='cancelled');
  });
  it('rejects a native model change during a running turn without sending input',async()=>{
    const id=await start();
    await expect(sessions.sendClaudeMessage(id,{text:'Keep my message',model:'claude-code/sonnet'})).rejects.toThrow('Stop the active Claude turn');
    expect(received).toHaveLength(1);finish();
  });
  it('acknowledges follow-ups only after native replay confirms receipt',async()=>{
    replayFollowUp=true;const id=await start();let confirmed=false;
    const followUp=sessions.steerClaudeSession(id,{text:'Next'},sessions.readClaudeSession(id)!.steerTurnId!).then(()=>{confirmed=true;});
    await Promise.resolve();expect(confirmed).toBe(false);finish();await followUp;expect(confirmed).toBe(true);
  });
  it('reports an unconfirmed follow-up when the native turn closes without replay',async()=>{
    const id=await start();const followUp=sessions.steerClaudeSession(id,{text:'Next'},sessions.readClaudeSession(id)!.steerTurnId!);
    const outcome=expect(followUp).rejects.toThrow('before confirming');finish();await outcome;
  });
  it('keeps an accepted native turn alive when the startup request is released',async()=>{
    const controller=new AbortController();
    const id=await sessions.startClaudeSession({text:'Hello',projectPath:root,model:'claude-code/opus',signal:controller.signal});
    controller.abort();expect(nativeOptions.abortController.signal.aborted).toBe(false);
    finish();await until(()=>sessions.readClaudeSession(id)?.status==='idle');expect(getCodexSessionLiveState(id)?.status).toBe('completed');
  });
  it('round-trips Claude tool approvals through the initiating dashboard',async()=>{
    const id=await start(),controller=new AbortController();
    const permission=nativeOptions.canUseTool('Bash',{command:'read-only-check'},{signal:controller.signal});
    await until(()=>listPendingCodexAppServerPrompts().some(row=>row.threadId===id));
    const request=listPendingCodexAppServerPrompts().find(row=>row.threadId===id)!;
    expect(request.title).toContain('Claude');
    await respondCodexAppServerPrompt(request.id,'decline');
    expect(await permission).toMatchObject({behavior:'deny'});finish();
  });
  it('preserves native question answers and clears prompts on cancellation',async()=>{
    const id=await start(),controller=new AbortController();
    const permission=nativeOptions.canUseTool('AskUserQuestion',{questions:[{header:'Choice',question:'Which?',options:[{label:'A',description:'One'}]}]},{signal:controller.signal});
    await until(()=>listPendingCodexAppServerPrompts().some(row=>row.threadId===id));
    const request=listPendingCodexAppServerPrompts().find(row=>row.threadId===id)!;
    await respondCodexAppServerPrompt(request.id,'approve',{'q-0':'A'});
    expect(await permission).toMatchObject({behavior:'allow',updatedInput:{answers:{'Which?':'A'}}});
    const cancelled=nativeOptions.canUseTool('Bash',{command:'x'},{signal:controller.signal});controller.abort();
    expect(await cancelled).toMatchObject({behavior:'deny',interrupt:true});finish();
  });
  it('applies native access settings and rejects invalid reasoning before prompt delivery',async()=>{
    const id=await start();await sessions.setClaudeAccess(id,'read-only',false);
    expect(await nativeOptions.canUseTool('Bash',{command:'write'},{signal:new AbortController().signal})).toMatchObject({behavior:'deny'});
    finish();await until(()=>sessions.readClaudeSession(id)?.status==='idle');
    const before=received.length;
    await expect(sessions.sendClaudeMessage(id,{text:'Unsafe effort',model:'claude-code/opus',reasoningEffort:'xhigh'})).rejects.toThrow('not supported');
    expect(received).toHaveLength(before);
  });
  it.each(['rename','archive','restore','fork','delete'] as const)('uses the native %s API while guarding active writers',async operation=>{
    const id=await start();await expect(sessions.mutateClaudeSession(id,operation,'Renamed')).rejects.toThrow();finish();
    await until(()=>sessions.readClaudeSession(id)?.status==='idle');
    mocks.forkSession.mockResolvedValue({sessionId:randomUUID()});
    await sessions.mutateClaudeSession(id,operation,'Renamed');
    const method={rename:'renameSession',archive:'archiveSession',restore:'unarchiveSession',fork:'forkSession',delete:'deleteSession'}[operation] as keyof typeof mocks;
    expect(mocks[method]).toHaveBeenCalled();
    if(operation==='delete')expect(sessions.isClaudeSession(id)).toBe(false);
  });
});
