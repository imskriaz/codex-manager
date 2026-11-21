import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {configureSqliteStateStore, SqliteStateStore} from '../src/storage/sqliteState';
import {beginOfficeTokens, checkOfficeStorage, checkOfficeTokens, claimOfficeRequest, officeStorageBytes, readOfficeUsage, recordOfficeTokens, validateOfficeLimits} from '../src/services/officeQuota';
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
