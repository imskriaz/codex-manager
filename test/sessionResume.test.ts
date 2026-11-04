import { reconcileCliSessionStatus } from '../webview-src/dashboard/cliSessionLiveState';
import { cliSessionTargetKey } from '../webview-src/dashboard/cliSessionRoute';
import { expect, it } from 'vitest';
import { canResumeCodexSession } from '../src/domain/codexSessionState';
const session={id:'session',title:'Interrupted',status:'idle' as const,interrupted:true,goal:null};
it('offers Resume only for a verified interrupted and unfinished parent session',()=>{
  expect(canResumeCodexSession(session)).toBe(true);
  expect(canResumeCodexSession(undefined)).toBe(false);
  for(const patch of [{interrupted:false},{status:'running' as const},{status:'unknown' as const},{locked:true},{archived:true},{subAgent:true},{parentSessionId:'parent'},...['complete','completed','blocked'].map(status=>({goal:{objective:'Work',status}}))])
    expect(canResumeCodexSession({...session,...patch})).toBe(false);
  for(const status of ['active','paused','usage_limited'])expect(canResumeCodexSession({...session,goal:{objective:'Work',status}})).toBe(true);
});

it('uses confirmed live failure and completion ahead of a stale running row',()=>{
  const row={...session,status:'running' as const,interrupted:false,locked:true};
  for(const status of ['failed','completed'] as const){
    const result=reconcileCliSessionStatus(row,{[cliSessionTargetKey(row)]:{sessionId:row.id,streamId:'live',sequence:1,status,updatedAt:Date.now(),messages:[]}});
    expect(canResumeCodexSession(result)).toBe(status==='failed');
  }
});
