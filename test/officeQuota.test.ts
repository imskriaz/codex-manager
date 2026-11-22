import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {configureSqliteStateStore, SqliteStateStore} from '../src/storage/sqliteState';
import {beginOfficeTokens, recoverOfficeTokens, reconcileOfficeTokens, checkOfficeStorage, checkOfficeTokens, claimOfficeRequest, officeStorageBytes, readOfficeUsage, recordOfficeTokens, validateOfficeLimits} from '../src/services/officeQuota';
import {readOfficeInstructions, saveOfficeInstructions} from '../src/services/officePreferences';
import type {OfficeUser} from '../src/services/officeUsers';
import {removeTestDirectory} from './testFilesystem';

let root: string, store: SqliteStateStore, user: OfficeUser;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-quota-'));
  store = await SqliteStateStore.open(path.join(root, 'usage.sqlite')); configureSqliteStateStore(store);
  await fs.mkdir(path.join(root, 'files'));
  user = {id:'alex',username:'alex',displayName:'Alex',role:'user',enabled:true,features:['files','generalChat'],defaultPrompt:'',workspacePath:path.join(root,'files'),mcpServers:[],createdAt:0,limits:{storageMb:1,dailyTokens:100,dailyRequests:1}};
});
afterEach(async () => {vi.useRealTimers(); configureSqliteStateStore(undefined); store.close(); await removeTestDirectory(root);});
it('keeps instructions private and rejects stale saves and oversized input', () => {
  saveOfficeInstructions('alex','Be clear.','');
  expect(readOfficeInstructions('sam')).toBe('');
  expect(() => saveOfficeInstructions('alex','Changed','')).toThrow('another window');
  expect(() => saveOfficeInstructions('alex','a'.repeat(8001),'Be clear.')).toThrow('8,000');
  expect(readOfficeInstructions('alex')).toBe('Be clear.');
});
it('meters tokens per user, blocks exhausted or unknown usage, and resets daily', () => {
  claimOfficeRequest(user); recordOfficeTokens(user.id,100);
  expect(readOfficeUsage(user.id)).toMatchObject({tokens:100,requests:1});
  expect(() => checkOfficeTokens(user)).toThrow('daily token allowance');
  expect(() => checkOfficeTokens({...user,id:'sam'})).not.toThrow();
  vi.useFakeTimers(); vi.setSystemTime(new Date(readOfficeUsage(user.id).resetsAt));
  expect(readOfficeUsage(user.id)).toMatchObject({tokens:0,requests:0});
  recordOfficeTokens(user.id,undefined); expect(() => checkOfficeTokens(user)).toThrow('unavailable');
});
it('counts storage, blocks growth beyond the allowance, and allows shrinking existing files', async () => {
  await fs.writeFile(path.join(user.workspacePath,'big.txt'),Buffer.alloc(1024*1024));
  expect(await officeStorageBytes(user.workspacePath)).toBe(1024*1024);
  await expect(checkOfficeStorage(user,user.workspacePath,'new.txt','extra')).rejects.toThrow('storage allowance');
  await expect(checkOfficeStorage(user,user.workspacePath,'big.txt','smaller')).resolves.toBeUndefined();
  await expect(checkOfficeStorage({...user,id:'sam',limits:undefined},user.workspacePath,'new.txt','extra')).resolves.toBeUndefined();
});
it('rejects malformed allowances', () => {
  for(const value of [null,{}, {storageMb:-1,dailyTokens:1,dailyRequests:1},{storageMb:1,dailyTokens:0.1,dailyRequests:1}]) expect(() => validateOfficeLimits(value)).toThrow();
  expect(validateOfficeLimits({storageMb:10,dailyTokens:1000,dailyRequests:20})).toEqual({storageMb:10,dailyTokens:1000,dailyRequests:20});
});
it('accepts a queued request while token usage for the active request is pending', () => {
  beginOfficeTokens(user);
  expect(() => claimOfficeRequest(user)).not.toThrow();
  expect(readOfficeUsage(user.id).requests).toBe(1);
  expect(() => beginOfficeTokens(user)).toThrow('daily token allowance');
  recordOfficeTokens(user.id,20);
  expect(() => beginOfficeTokens(user)).not.toThrow();
});

it('settles unknown usage into a reservation, recovers stale claims, reconciles with a revision and keeps midnight accounting on its original day',()=>{
 const claim=beginOfficeTokens(user,20);recordOfficeTokens(user.id,undefined,claim);expect(readOfficeUsage(user.id)).toMatchObject({pending:false,reservedTokens:20,unconfirmed:true});expect(()=>checkOfficeTokens(user)).not.toThrow();
 const usage=readOfficeUsage(user.id),revision=JSON.stringify([usage.day,usage.tokens,usage.reservedTokens,!!usage.unconfirmed]);expect(()=>reconcileOfficeTokens(user.id,'stale',12)).toThrow('changed');reconcileOfficeTokens(user.id,revision,12);expect(readOfficeUsage(user.id)).toMatchObject({tokens:12,reservedTokens:0,unconfirmed:false});
 vi.useFakeTimers();const next=beginOfficeTokens(user,30);vi.advanceTimersByTime(660001);recoverOfficeTokens(user.id);expect(readOfficeUsage(user.id)).toMatchObject({pending:false,reservedTokens:30});recordOfficeTokens(user.id,9,next);expect(readOfficeUsage(user.id).tokens).toBe(12);
 const before=readOfficeUsage(user.id).day;const crossing=beginOfficeTokens(user,10);vi.setSystemTime(new Date(readOfficeUsage(user.id).resetsAt+1));recordOfficeTokens(user.id,7,crossing);expect(readOfficeUsage(user.id).tokens).toBe(0);expect(store.get<any>(`office-usage:${user.id}`,before).tokens).toBe(19);
});
