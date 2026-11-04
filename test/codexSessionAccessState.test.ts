import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({records:new Map<string,unknown>(),fail:false}));
vi.mock('../src/storage/sqliteState',()=>({getSqliteStateStore:()=>({get:(namespace:string,key:string)=>state.records.get(namespace+key),set:(namespace:string,key:string,value:unknown)=>{if(state.fail)throw Error('storage full');state.records.set(namespace+key,structuredClone(value));}})}));
const mode={mode:'workspace-write' as const,updatedAt:Date.now()};
const raw={sandboxPolicy:{type:'workspaceWrite',writableRoots:['D:/work','D:/shared'],networkAccess:false,readOnlyAccess:{type:'restricted',readableRoots:['D:/docs']}}};
beforeEach(()=>{state.records.clear();state.fail=false;vi.resetModules();});
afterEach(()=>vi.restoreAllMocks());
it('recovers the exact confirmed policy across restarts without adding folder or network grants',async()=>{
  let cache=await import('../src/services/codexSessionAccessState');
  expect(cache.saveCodexSessionAccess('D:/home','session',mode,raw)).toBe(true);
  vi.resetModules();cache=await import('../src/services/codexSessionAccessState');
  expect(cache.readSavedCodexSessionAccess('D:/home','session')).toEqual({access:mode,settings:raw});
  expect(cache.readSavedCodexSessionAccess('D:/other-home','session')).toBeUndefined();
});
it('preserves a named profile without combining it with a sandbox override',async()=>{
  const cache=await import('../src/services/codexSessionAccessState');const access={...mode,profile:'restricted-docs'};
  cache.saveCodexSessionAccess('D:/home','session',access,raw);
  expect(cache.readSavedCodexSessionAccess('D:/home','session')?.settings).toEqual({permissions:'restricted-docs'});
});
it('reports storage failure while retaining the already accepted state in memory',async()=>{
  const cache=await import('../src/services/codexSessionAccessState');vi.spyOn(console,'warn').mockImplementation(()=>{});state.fail=true;
  expect(cache.saveCodexSessionAccess('D:/home','session',mode,raw)).toBe(false);
  expect(cache.readSavedCodexSessionAccess('D:/home','session')?.access).toEqual(mode);
  expect(state.records.size).toBe(0);
});
