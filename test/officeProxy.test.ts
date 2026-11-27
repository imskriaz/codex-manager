import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqliteStateStore, configureSqliteStateStore } from '../src/storage/sqliteState';
import { createOfficeProxyKey, revokeOfficeProxyKey, readOfficeProxyAccess, officeProxySnapshot, saveOfficeProxySettings, officeProxyModels, claimOfficeProxyGeneration } from '../src/services/officeProxy';
import * as users from '../src/services/officeUsers';
import * as settings from '../src/services/teamSettings';
import { beginOfficeTokens, recoverOfficeTokens, readOfficeUsage, recordOfficeTokens } from '../src/services/officeQuota';
import { removeTestDirectory } from './testFilesystem';

let root: string, store: SqliteStateStore;
const user = { id: 'alex', username: 'alex', displayName: 'Alex', role: 'user', enabled: true, features: ['generalChat'], limits: { dailyRequests: 2, dailyTokens: 100 }, plan: { status: 'active', models: [] } } as unknown as users.OfficeUser;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'office-proxy-'));
  store = await SqliteStateStore.open(path.join(root, 'state.sqlite')); configureSqliteStateStore(store);
  vi.spyOn(users, 'getOfficeUser').mockResolvedValue(user);
  vi.spyOn(settings, 'readTeamSettings').mockReturnValue({ regularModel: 'fast', professionalModel: 'quality', expertModel: 'deep', defaultModel: 'fast' } as never);
});
afterEach(async () => { vi.restoreAllMocks(); configureSqliteStateStore(undefined); store.close(); await removeTestDirectory(root); });
const create = (owner = user, requestId = randomUUID()) => createOfficeProxyKey(owner, { name: 'My client', requestId });

it('stores only hashed credentials, isolates owners and revokes immediately', async () => {
  const key = create();
  expect(key.value).toMatch(/^cm_[a-f0-9]{64}$/);
  expect(await readOfficeProxyAccess(key.value)).toMatchObject({ user: { id: user.id }, key: { id: key.id } });
  expect(JSON.stringify(store.entries('office-proxy-keys'))).not.toContain(key.value);
  expect(JSON.stringify(officeProxySnapshot(user, true))).not.toContain(key.value);
  expect(officeProxySnapshot({ ...user, id: 'other' }, true).keys).toEqual([]);
  expect(() => revokeOfficeProxyKey('other', { id: key.id, confirmed: true })).toThrow('owned');
  revokeOfficeProxyKey(user.id, { id: key.id, confirmed: true });
  expect(await readOfficeProxyAccess(key.value)).toBeUndefined();
});
it('prevents duplicate creation after uncertain results, bounds keys and validates input', () => {
  const requestId = randomUUID(); create(user, requestId);
  expect(() => create(user, requestId)).toThrow('already generated');
  for (let count = 1; count < 16; count++) create();
  expect(() => create()).toThrow('16 keys');
  expect(() => createOfficeProxyKey(user, { name: '', requestId })).toThrow('key name');
  expect(() => createOfficeProxyKey(user, { name: 'key', requestId: 'bad' })).toThrow('Reload');
});
it('revalidates user status and entitlement on every use while retaining revocation access', async () => {
  const key = create();
  for (const blocked of [{ ...user, enabled: false }, { ...user, features: [] }, { ...user, plan: { ...user.plan!, status: 'paused' as const } }, { ...user, plan: { ...user.plan!, expiresAt: Date.now() - 100 } }]) {
    vi.mocked(users.getOfficeUser).mockResolvedValue(blocked);
    await expect(readOfficeProxyAccess(key.value)).rejects.toThrow();
    expect(() => create(blocked)).toThrow();
    expect(officeProxySnapshot(blocked, false).keys).toHaveLength(1);
  }
});
it('automatically maps profiles and Claude roles to actual configured models and permits overrides', () => {
  const available = ['fast', 'quality', 'deep'];
  expect(officeProxyModels(user, available, false)).toMatchObject([{ id: 'regular', model: 'fast' }, { id: 'professional', model: 'quality' }, { id: 'expert', model: 'deep' }]);
  expect(officeProxyModels(user, available, true)).toMatchObject([{ id: 'claude-opus', model: 'deep' }, { id: 'claude-sonnet', model: 'quality' }, { id: 'claude-haiku', model: 'fast' }, { id: 'claude-fable', model: 'deep' }]);
  saveOfficeProxySettings(user, { expected: '0', mappings: { professional: 'expert', 'claude-sonnet': 'regular' } });
  expect(officeProxyModels(user, available, false).find(model => model.id === 'professional')?.model).toBe('deep');
  expect(officeProxyModels(user, available, true).find(model => model.id === 'claude-sonnet')?.model).toBe('fast');
  expect(() => saveOfficeProxySettings(user, { expected: '0', mappings: {} })).toThrow('changed');
  expect(() => saveOfficeProxySettings(user, { mappings: { invented: 'expert' } })).toThrow('available');
  expect(officeProxyModels(user, [], false)).toEqual([]);
  const restricted = { ...user, plan: { ...user.plan!, models: ['fast'] } };
  expect(officeProxyModels(restricted, available, false).some(model => model.model !== 'fast')).toBe(false);
  expect(officeProxyModels(restricted, available, false).some(model => model.id === 'professional')).toBe(false);
});
it('shares request and token limits with workspace chat and rolls back failed reservations', () => {
  const first = claimOfficeProxyGeneration(user, 10);
  expect(() => claimOfficeProxyGeneration(user, 10)).toThrow('allowance');
  expect(readOfficeUsage(user.id).requests).toBe(1);
  recordOfficeTokens(user.id, 15, first);
  const second = claimOfficeProxyGeneration(user, 10); recordOfficeTokens(user.id, 15, second);
  expect(readOfficeUsage(user.id)).toMatchObject({ requests: 2, tokens: 30, pending: false });
  expect(() => claimOfficeProxyGeneration(user, 10)).toThrow('request allowance');
});

it('protects active proxy reservations from idle-chat recovery and concurrent unlimited users', () => {
  const unlimited = { ...user, limits: {dailyTokens:0,dailyRequests:0,storageMb:0} };
  const claim = claimOfficeProxyGeneration(unlimited, 20);
  recoverOfficeTokens(user.id, true);
  expect(readOfficeUsage(user.id)).toMatchObject({pending:true,claimId:claim.id,pendingSource:'proxy'});
  expect(() => claimOfficeProxyGeneration(unlimited, 10)).toThrow('already running');
  expect(() => beginOfficeTokens(unlimited, 10)).toThrow('already running');
  expect(readOfficeUsage(user.id).requests).toBe(1);
  recordOfficeTokens(user.id, 15, claim);
  const chat = beginOfficeTokens(unlimited, 10);
  expect(() => claimOfficeProxyGeneration(unlimited, 10)).toThrow('already running');
  recordOfficeTokens(user.id, 5, chat);
  expect(readOfficeUsage(user.id)).toMatchObject({tokens:20,pending:false});
});
