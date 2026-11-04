import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DashboardHostMessage } from '../src/domain/dashboard/types';
const harness=vi.hoisted(()=>({slots:[] as any[],cursor:0,effects:[] as Array<()=>void>}));
vi.mock('preact/hooks',()=>({
  useState(initial:unknown){const i=harness.cursor++;harness.slots[i]??={value:initial};return[harness.slots[i].value,(next:unknown)=>{harness.slots[i].value=typeof next==='function'?next(harness.slots[i].value):next;}];},
  useRef(initial:unknown){const i=harness.cursor++;return harness.slots[i]??={current:initial};},
  useEffect(setup:()=>void|(()=>void),dependencies:unknown[]){const i=harness.cursor++,prior=harness.slots[i];if(prior&&dependencies.every((v,j)=>Object.is(v,prior.dependencies[j])))return;const slot={dependencies,cleanup:undefined as void|(()=>void)};harness.slots[i]=slot;harness.effects.push(()=>{prior?.cleanup?.();slot.cleanup=setup();});}
}));
import { useSessionResume } from '../webview-src/dashboard/sessionResume';
let options:Parameters<typeof useSessionResume>[0];const send=vi.fn(),feedback=vi.fn();
function render(patch:Partial<typeof options>={}){options={...options,...patch};harness.cursor=0;const value=useSessionResume(options);harness.effects.splice(0).forEach(effect=>effect());return value;}
const emit=(data:DashboardHostMessage)=>window.dispatchEvent(new MessageEvent('message',{data}));
beforeEach(()=>{vi.useFakeTimers();harness.slots=[];harness.cursor=0;harness.effects=[];send.mockReset().mockReturnValue('resume-1');feedback.mockReset();vi.stubGlobal('window',new EventTarget());options={session:{id:'session',title:'Session',status:'idle',interrupted:true,goal:null},connected:true,blocked:false,send,feedback};});
afterEach(()=>{for(const slot of harness.slots)slot?.cleanup?.();vi.useRealTimers();vi.unstubAllGlobals();});
it('starts Resume once and waits for its matching acknowledgement',()=>{
  const hook=render();expect(hook.available).toBe(true);hook.resume();hook.resume();expect(send).toHaveBeenCalledOnce();expect(render().pending).toBe(true);
  emit({type:'dashboard:action-result',action:'resumeCodexSessions',requestId:'other',status:'completed'});expect(render().pending).toBe(true);
  emit({type:'dashboard:action-result',action:'resumeCodexSessions',requestId:'resume-1',status:'completed',payload:{notice:{level:'info',message:'Continuation started.'}}});
  expect(render().pending).toBe(false);expect(render().status).toEqual({level:'info',message:'Continuation started.'});expect(feedback).toHaveBeenCalledWith({level:'info',message:'Continuation started.'});
});
it('blocks offline, busy, completed, unknown, and locked sessions',()=>{
  render({connected:false}).resume();render({connected:true,blocked:true}).resume();
  for(const patch of [{interrupted:false},{status:'unknown' as const},{locked:true},{archived:true}])render({blocked:false,session:{...options.session!,...patch}}).resume();
  expect(send).not.toHaveBeenCalled();
});
it.each(['failed','cancelled'] as const)('reports %s without retrying or changing the draft',status=>{
  render().resume();emit({type:'dashboard:action-result',action:'resumeCodexSessions',requestId:'resume-1',status,error:'Resume not accepted'});
  expect(render().pending).toBe(false);expect(feedback).toHaveBeenCalledWith(expect.objectContaining({message:'Resume not accepted'}));expect(send).toHaveBeenCalledOnce();
});
it('reports missing sends and synchronous failures without entering a pending state',()=>{
  send.mockReturnValueOnce(undefined);render().resume();expect(render().pending).toBe(false);
  send.mockImplementationOnce(()=>{throw Error('Disconnected');});render().resume();expect(render().pending).toBe(false);expect(feedback).toHaveBeenLastCalledWith({level:'error',message:'Disconnected'});
});
it('times out visibly without automatic retries and ignores late results after navigation',async()=>{
  render().resume();await vi.advanceTimersByTimeAsync(80001);expect(render().pending).toBe(false);expect(feedback).toHaveBeenCalledWith(expect.objectContaining({message:expect.stringContaining('unconfirmed')}));expect(send).toHaveBeenCalledOnce();
  send.mockReturnValue('resume-2');render().resume();render({session:{...options.session!,id:'other'}});
  emit({type:'dashboard:action-result',action:'resumeCodexSessions',requestId:'resume-2',status:'completed'});await vi.advanceTimersByTimeAsync(80001);
  expect(render().pending).toBe(false);expect(feedback).toHaveBeenCalledTimes(1);
});
