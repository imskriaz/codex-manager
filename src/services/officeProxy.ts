import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getSqliteStateStore } from '../storage/sqliteState';
import { OFFICE_PROFILES, officeProfiles } from '../domain/officeModels';
import { OFFICE_PROXY_DEFAULTS, type OfficeProxyAlias, type OfficeProxyKey, type OfficeProxySettings } from '../domain/officeProxy';
import { checkOfficeEntitlement, getOfficeUser, OfficeEntitlementError, type OfficeUser } from './officeUsers';
import { readTeamSettings } from './teamSettings';
import { beginOfficeTokens, claimOfficeRequest } from './officeQuota';

type StoredKey = OfficeProxyKey & { hash: string; requestId: string };
export type OfficeProxyAccess = { user: OfficeUser; key: OfficeProxyKey };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function storage() {
  const store = getSqliteStateStore();
  if (!store) throw new Error('Proxy storage is unavailable. Try again.');
  return store;
}
export function requireOfficeProxyUser(user: OfficeUser): void {
  if (!user.enabled || user.role !== 'user' || !user.features.some(feature => feature === 'generalChat' || feature === 'tasks')) throw new OfficeEntitlementError('Proxy access is unavailable for this workspace.');
  checkOfficeEntitlement(user);
}
export function readOfficeProxySettings(owner: string): OfficeProxySettings {
  return storage().get<OfficeProxySettings>('office-proxy-settings', owner) ?? { revision: '0', mappings: {} };
}
export function officeProxyProfiles(user: OfficeUser, availableModels?: string[]) {
  requireOfficeProxyUser(user);
  return officeProfiles(readTeamSettings(), user.plan?.models, availableModels);
}
export function officeProxySnapshot(user: OfficeUser, enabled: boolean) {
  const keys = storage().get<StoredKey[]>('office-proxy-keys', user.id) ?? [];
  return { enabled, keys: keys.map(({ id, name, createdAt }) => ({ id, name, createdAt })), settings: readOfficeProxySettings(user.id), profiles: officeProfiles(readTeamSettings(), user.plan?.models).map(({ profile }) => ({ profile })) };
}
export function createOfficeProxyKey(user: OfficeUser, input: Record<string, unknown>) {
  requireOfficeProxyUser(user);
  if (typeof input['name'] !== 'string' || !input['name'].trim() || input['name'].length > 80 || /[\x00-\x1f\x7f]/.test(input['name'])) throw new Error('Enter a key name of 1–80 characters.');
  if (typeof input['requestId'] !== 'string' || !/^[a-f0-9-]{36}$/.test(input['requestId'])) throw new Error('Reload Proxy before generating a key.');
  const store = storage();
  return store.transaction(() => {
    const keys = store.get<StoredKey[]>('office-proxy-keys', user.id) ?? [];
    if (keys.some(key => key.requestId === input['requestId'])) throw new Error('This key was already generated. Reload keys; if its value was lost, revoke it before creating another.');
    if (keys.length >= 16) throw new Error('Revoke an unused key first. You can have up to 16 keys.');
    const value = `cm_${randomBytes(32).toString('hex')}`;
    const key: StoredKey = { id: randomUUID(), name: (input['name'] as string).trim(), createdAt: Date.now(), hash: hash(value), requestId: input['requestId'] as string };
    store.set('office-proxy-keys', user.id, [...keys, key]);
    store.set('office-proxy-key-index', key.hash, user.id);
    return { id: key.id, value };
  });
}
export function revokeOfficeProxyKey(owner: string, input: Record<string, unknown>): void {
  const store = storage();
  store.transaction(() => {
    const keys = store.get<StoredKey[]>('office-proxy-keys', owner) ?? [];
    const key = keys.find(item => item.id === input['id']);
    if (!key || input['confirmed'] !== true) throw new Error('Confirm an existing key owned by your workspace.');
    store.set('office-proxy-key-index', key.hash, undefined);
    store.set('office-proxy-keys', owner, keys.filter(item => item.id !== key.id));
  });
}
export async function readOfficeProxyAccess(candidate: string | undefined): Promise<OfficeProxyAccess | undefined> {
  if (!candidate || !/^cm_[a-f0-9]{64}$/.test(candidate)) return undefined;
  const store = getSqliteStateStore();
  const digest = hash(candidate), owner = store?.get<string>('office-proxy-key-index', digest);
  if (!owner) return undefined;
  const key = store?.get<StoredKey[]>('office-proxy-keys', owner)?.find(item => item.hash === digest);
  const user = await getOfficeUser(owner);
  if (!key || !user) return undefined;
  requireOfficeProxyUser(user);
  return { user, key: { id: key.id, name: key.name, createdAt: key.createdAt } };
}
export function saveOfficeProxySettings(user: OfficeUser, input: Record<string, unknown>): void {
  const profiles = officeProxyProfiles(user).map(choice => choice.profile);
  const mappings = input['mappings'];
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) throw new Error('Choose valid model mappings.');
  for (const [alias, profile] of Object.entries(mappings)) {
    if (!Object.hasOwn(OFFICE_PROXY_DEFAULTS, alias) || !OFFICE_PROFILES.includes(profile as never) || !profiles.includes(profile as never)) throw new Error('Choose an available workspace profile, or Auto.');
  }
  const store = storage();
  store.transaction(() => {
    if (input['expected'] !== readOfficeProxySettings(user.id).revision) throw new Error('Proxy settings changed in another window. Reload before saving.');
    store.set('office-proxy-settings', user.id, { revision: randomUUID(), mappings });
  });
}
export function officeProxyModels(user: OfficeUser, availableModels: string[], claude: boolean) {
  const profiles = officeProxyProfiles(user, availableModels), settings = readOfficeProxySettings(user.id);
  if (!availableModels.length) return [];
  return (Object.keys(OFFICE_PROXY_DEFAULTS) as OfficeProxyAlias[]).filter(alias => alias.startsWith('claude-') === claude).flatMap(alias => {
    const profile = settings.mappings[alias] ?? OFFICE_PROXY_DEFAULTS[alias];
    const choice = profiles.find(item => item.profile === profile) ?? (!settings.mappings[alias] ? profiles[0] : undefined);
    return choice ? [{ id: alias, name: alias, model: choice.model, profile: choice.profile }] : [];
  });
}
export function claimOfficeProxyGeneration(user: OfficeUser, estimatedTokens: number) {
  requireOfficeProxyUser(user);
  return storage().transaction(() => { claimOfficeRequest(user); return beginOfficeTokens(user, estimatedTokens, 'proxy'); });
}
