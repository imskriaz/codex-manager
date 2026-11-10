import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DashboardHostMessage } from '../src/domain/dashboard/types';
const harness=vi.hoisted(()=>({slots:[] as any[],cursor:0,effects:[] as Array<()=>void>}));
vi.mock('preact/hooks',()=>({
  useState(initial:unknown){const i=harness.cursor++;harness.slots[i]??={value:initial};return[harness.slots[i].value,(next:unknown)=>{harness.slots[i].value=typeof next==='function'?next(harness.slots[i].value):next;}];},
  useRef(initial:unknown){const i=harness.cursor++;return harness.slots[i]??={current:initial};},
  useEffect(setup:()=>void|(()=>void),dependencies:unknown[]){const i=harness.cursor++,prior=harness.slots[i];if(prior&&dependencies.every((v,j)=>Object.is(v,prior.dependencies[j])))return;const slot={dependencies,cleanup:undefined as void|(()=>void)};harness.slots[i]=slot;harness.effects.push(()=>{prior?.cleanup?.();slot.cleanup=setup();});}
}));
import {useSessionAccess} from '../webview-src/dashboard/sessionAccess';
let options:Parameters<typeof useSessionAccess>[0];const send=vi.fn(),feedback=vi.fn();
function render(patch:Partial<typeof options>={}){options={...options,...patch};harness.cursor=0;const value=useSessionAccess(options);harness.effects.splice(0).forEach(effect=>effect());return value;}
const emit=(data:DashboardHostMessage)=>window.dispatchEvent(new MessageEvent('message',{data}));
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(100000);harness.slots=[];harness.cursor=0;harness.effects=[];send.mockReset().mockReturnValue('access-1');feedback.mockReset();vi.stubGlobal('window',new EventTarget());options={session:{id:'session',title:'Session',status:'idle',deviceId:'pc',sandboxMode:'workspace-write'},connected:true,send,feedback};});
afterEach(()=>{for(const slot of harness.slots)slot?.cleanup?.();vi.useRealTimers();vi.unstubAllGlobals();});
it('syncs changes from Codex while rejecting stale or different-PC updates',()=>{
  render();emit({type:'dashboard:codex-session-access',sessionId:'session',deviceId:'pc',access:{mode:'danger-full-access',updatedAt:100001}});
  expect(render().mode).toBe('danger-full-access');
  emit({type:'dashboard:codex-session-access',sessionId:'session',deviceId:'other',access:{mode:'read-only',updatedAt:100002}});
  emit({type:'dashboard:codex-session-access',sessionId:'session',deviceId:'pc',access:{mode:'workspace-write',updatedAt:100000}});
  expect(render().mode).toBe('danger-full-access');expect(send).not.toHaveBeenCalled();
});
it('sends a permission change once and only shows the confirmed setting',()=>{
  let hook=render();hook.change('read-only');hook.change('danger-full-access');hook=render();
  expect(send).toHaveBeenCalledExactlyOnceWith('read-only');expect(hook.pending).toBe(true);expect(hook.mode).toBe('workspace-write');
  emit({type:'dashboard:action-result',action:'setCodexSessionAccess',requestId:'access-1',status:'completed',payload:{cliSession:{...options.session!,access:{mode:'read-only',updatedAt:100001}}}});
  hook=render();expect(hook.pending).toBe(false);expect(hook.mode).toBe('read-only');
});
it('preserves the actual setting on failure and blocks offline writes',async()=>{
  render().change('danger-full-access');emit({type:'dashboard:action-result',action:'setCodexSessionAccess',requestId:'access-1',status:'failed',error:'Owner disconnected'});
  expect(render().mode).toBe('workspace-write');expect(feedback).toHaveBeenCalledWith(expect.objectContaining({message:'Owner disconnected'}));
  render({connected:false}).change('read-only');expect(send).toHaveBeenCalledOnce();
  render({connected:true}).change('read-only');await vi.advanceTimersByTimeAsync(80001);expect(render().status).toContain('unconfirmed');expect(send).toHaveBeenCalledTimes(2);
});
it('keeps a newer Codex change instead of replacing it with an older acknowledgement',()=>{
  render().change('read-only');emit({type:'dashboard:codex-session-access',sessionId:'session',deviceId:'pc',access:{mode:'danger-full-access',updatedAt:100003}});
  emit({type:'dashboard:action-result',action:'setCodexSessionAccess',requestId:'access-1',status:'completed',payload:{cliSession:{...options.session!,access:{mode:'read-only',updatedAt:100002}}}});
  expect(render().mode).toBe('danger-full-access');
  expect(render({session:{id:'other',title:'Other',status:'idle',deviceId:'pc',sandboxMode:'read-only'}}).mode).toBe('read-only');
});

it('changes approval independently, blocks duplicates, and waits for confirmation', () => {
  const hook = render(); hook.change(undefined, true); hook.change(undefined, true);
  expect(send).toHaveBeenCalledExactlyOnceWith(undefined, true);
  expect(render().autoApprove).toBe(false);
  emit({ type: 'dashboard:action-result', action: 'setCodexSessionAccess', requestId: 'access-1', status: 'completed', payload: { cliSession: { ...options.session!, access: { mode: 'workspace-write', approvalPolicy: 'never', updatedAt: 100001 } } } });
  expect(render().autoApprove).toBe(true); expect(render().mode).toBe('workspace-write');
});

it('turns auto approval off without changing Full access and preserves it on failure', () => {
  render({ session: { ...options.session!, access: { mode: 'danger-full-access', profile: ':danger-full-access', approvalPolicy: 'never', updatedAt: 100000 } } }).change(undefined, false);
  expect(send).toHaveBeenCalledExactlyOnceWith(undefined, false);
  expect(render().autoApprove).toBe(true);
  emit({ type: 'dashboard:action-result', action: 'setCodexSessionAccess', requestId: 'access-1', status: 'completed', payload: { cliSession: { ...options.session!, access: { mode: 'danger-full-access', profile: ':danger-full-access', approvalPolicy: 'on-request', updatedAt: 100001 } } } });
  expect(render().autoApprove).toBe(false);
  expect(render().mode).toBe('danger-full-access');
  render().change(undefined, true);
  emit({ type: 'dashboard:action-result', action: 'setCodexSessionAccess', requestId: 'access-1', status: 'failed', error: 'Owner disconnected' });
  expect(render().autoApprove).toBe(false);
});
