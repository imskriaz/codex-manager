import { afterEach, expect, it, vi } from 'vitest';
import { syncCodexSessionAccess } from '../src/services/codexSessionAccessSync';
import type { CodexAppServerRpc } from '../src/services/codexAppServerRpc';
const settings={sandboxPolicy:{type:'dangerFullAccess'}};
function client() {
  const listeners=new Set<(method:string,raw:unknown)=>void>();
  const request=vi.fn(async()=>({}));
  return {rpc:{request,onNotification:(listener:(method:string,raw:unknown)=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);}} as unknown as Pick<CodexAppServerRpc,'request'|'onNotification'>,request,listeners,emit:(id:string,sandboxPolicy:unknown)=>{for(const listener of listeners)listener('thread/settings/updated',{threadId:id,threadSettings:{sandboxPolicy}});}};
}
afterEach(()=>vi.useRealTimers());
it('waits for actual settings after acknowledgement and ignores unrelated or invalid updates',async()=>{
  const c=client();let completed=false;
  const result=syncCodexSessionAccess(c.rpc,'thread',settings).then(value=>{completed=true;return value;});
  await Promise.resolve();expect(completed).toBe(false);
  c.emit('other',{type:'dangerFullAccess'});c.emit('thread',null);await Promise.resolve();expect(completed).toBe(false);
  c.emit('thread',{type:'dangerFullAccess'});expect((await result).access.mode).toBe('danger-full-access');expect(c.listeners.size).toBe(0);
  expect(c.request).toHaveBeenCalledExactlyOnceWith('thread/settings/update',{threadId:'thread',...settings},10000);
});
it('handles confirmation before acknowledgment without replaying a request',async()=>{
  const c=client();c.request.mockImplementation(async()=>{c.emit('thread',{type:'dangerFullAccess'});return {};});
  expect((await syncCodexSessionAccess(c.rpc,'thread',settings)).access.mode).toBe('danger-full-access');expect(c.request).toHaveBeenCalledOnce();
});
it('reports conflicting applied permissions without claiming the requested mode',async()=>{
  const c=client();c.request.mockImplementation(async()=>{c.emit('thread',{type:'readOnly'});return {};});
  await expect(syncCodexSessionAccess(c.rpc,'thread',settings)).rejects.toThrow('different permissions');expect(c.listeners.size).toBe(0);
});
it('bounds missing confirmation and cleans up after rejection',async()=>{
  vi.useFakeTimers();const c=client();
  const result=expect(syncCodexSessionAccess(c.rpc,'thread',settings)).rejects.toThrow('did not confirm');
  await vi.advanceTimersByTimeAsync(3001);await result;expect(c.listeners.size).toBe(0);
  c.request.mockRejectedValueOnce(new Error('Owner disconnected'));
  await expect(syncCodexSessionAccess(c.rpc,'thread',settings)).rejects.toThrow('Owner disconnected');expect(c.listeners.size).toBe(0);
});
it('keeps an already confirmed policy unchanged, including all folder restrictions',async()=>{
  const c=client(),current={sandboxPolicy:{type:'workspaceWrite',writableRoots:['D:/specific'],networkAccess:false}};
  const result=await syncCodexSessionAccess(c.rpc,'thread',{sandboxPolicy:{type:'workspaceWrite'}},current);
  expect(result.settings).toBe(current);expect(c.request).not.toHaveBeenCalled();
});
