import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { OfficeUser } from './officeUsers';
import { getSqliteStateStore } from '../storage/sqliteState';

export type OfficeLimits = { storageMb: number; dailyTokens: number; dailyRequests: number };
export const unlimitedOfficeLimits: OfficeLimits = {storageMb: 0, dailyTokens: 0, dailyRequests: 0};
export class OfficeQuotaError extends Error {}
export function validateOfficeLimits(value: unknown): OfficeLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose valid user allowances.');
  const limits = value as Record<string, unknown>;
  for (const key of Object.keys(unlimitedOfficeLimits)) if (typeof limits[key] !== 'number' || !Number.isSafeInteger(limits[key]) || (limits[key] as number) < 0 || (limits[key] as number) > 1_000_000_000) throw new Error('Allowances must be whole numbers from 0 to 1,000,000,000. Use 0 for unlimited.');
  return {storageMb: limits['storageMb'] as number, dailyTokens: limits['dailyTokens'] as number, dailyRequests: limits['dailyRequests'] as number};
}
const dayKey = () => new Date().toISOString().slice(0, 10);
type Usage = {tokens:number; requests:number; unconfirmed?:boolean; pending?:boolean; reservedTokens?:number; pendingTokens?:number; pendingUntil?:number; claimId?:string};
export type OfficeTokenClaim = {day:string; id:string};
export function readOfficeUsage(owner: string) {
  const day = dayKey();
  return {day, resetsAt: Date.parse(`${day}T00:00:00Z`) + 86_400_000, ...(getSqliteStateStore()?.get<Usage>(`office-usage:${owner}`, day) ?? {tokens: 0, requests: 0})};
}
export function checkOfficeTokens(user: OfficeUser, includePending = true): void {
  const usage = readOfficeUsage(user.id), limit = user.limits?.dailyTokens ?? 0;
  if (limit && (usage.tokens + (usage.reservedTokens??0) >= limit || usage.unconfirmed && !usage.reservedTokens || includePending && usage.pending)) throw new OfficeQuotaError('Your daily token allowance is unavailable or has been reached. Check Usage in settings for the reset time.');
}
/** Called inside the session acceptance transaction, after replay detection. */
export function claimOfficeRequest(user: OfficeUser): void {
  checkOfficeTokens(user, false);
  const usage = readOfficeUsage(user.id);
  if (user.limits?.dailyRequests && usage.requests >= user.limits.dailyRequests) throw new OfficeQuotaError('Your daily request allowance has been reached. Check Usage in settings for the reset time.');
  const store = getSqliteStateStore();
  if (!store) throw new Error('Usage is unavailable. Please try again.');
  store.set(`office-usage:${user.id}`, usage.day, {...usage, requests: usage.requests + 1});
}
export function recordOfficeTokens(owner: string, tokens: unknown, claim?:OfficeTokenClaim): void {
  const store = getSqliteStateStore();
  if (!store) throw new Error('Usage could not be saved.');
  store.transaction(() => {
    const day=claim?.day??dayKey(),usage=store.get<Usage>(`office-usage:${owner}`,day)??{tokens:0,requests:0};
    if(claim&&usage.claimId!==claim.id)return;
    const valid = typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0;
    store.set(`office-usage:${owner}`, day, {...usage, pending:false, pendingUntil:undefined, pendingTokens:undefined, claimId:undefined, tokens:usage.tokens+(valid?tokens:0), reservedTokens:(usage.reservedTokens??0)+(valid?0:usage.pendingTokens??0), unconfirmed:usage.unconfirmed||!valid});
  });
}
export function beginOfficeTokens(user: OfficeUser, estimatedTokens=0): OfficeTokenClaim {
  const store = getSqliteStateStore();
  if (!store) throw new Error('Usage is unavailable. Please try again.');
  return store.transaction(() => {
    checkOfficeTokens(user);
    const usage = readOfficeUsage(user.id);
    const id=crypto.randomUUID();
    store.set(`office-usage:${user.id}`, usage.day, {...usage, pending:true,claimId:id,pendingTokens:Math.max(0,Math.ceil(estimatedTokens)),pendingUntil:Date.now()+660_000});
    return {day:usage.day,id};
  });
}

export function recoverOfficeTokens(owner:string,idle=false):void {
  const usage=readOfficeUsage(owner);
  if(usage.pending&&(idle||usage.pendingUntil!==undefined&&usage.pendingUntil<Date.now()))recordOfficeTokens(owner,undefined,usage.claimId?{day:usage.day,id:usage.claimId}:undefined);
}

export function reconcileOfficeTokens(owner:string,expected:unknown,additionalTokens:unknown):void {
  const current=getSqliteStateStore();if(!current)throw new Error('Usage is unavailable.');
  current.transaction(()=>{const usage=readOfficeUsage(owner);if(usage.pending)throw new Error('Wait for the current response before reviewing usage.');
    if(expected!==JSON.stringify([usage.day,usage.tokens,usage.reservedTokens??0,!!usage.unconfirmed]))throw new Error('Usage changed. Refresh before reviewing it.');
    if(typeof additionalTokens!=='number'||!Number.isSafeInteger(additionalTokens)||additionalTokens<0)throw new Error('Enter verified additional token usage.');
    current.set(`office-usage:${owner}`,usage.day,{...usage,tokens:usage.tokens+additionalTokens,reservedTokens:0,unconfirmed:false});});
}

/** Charge user payload bytes, including retained conversations, rather than shared SQLite pages. */
export function officeStateBytes(owner: string): number {
  const store = getSqliteStateStore();
  if (!store) throw new Error('Storage usage is unavailable.');
  const postgresBytes = store.officePayloadBytes(owner);
  if (postgresBytes !== undefined) return postgresBytes;
  const namespaces = ['office-sessions', 'office-session-requests', 'office-session-revisions', 'office-preferences', 'office-projects', 'office-schedules', 'office-usage'].map(name => `${name}:${owner}`);
  const row = store.prepare(`SELECT COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes FROM state WHERE namespace IN (${namespaces.map(() => '?').join(',')}) OR (namespace IN ('office-memory','office-recommendations') AND key=?) OR (namespace='office-schedules' AND json_extract(value,'$.owner')=?)`).get(...namespaces, owner, owner);
  return Number(row?.['bytes'] ?? 0);
}
export async function officeStorageBytes(folder: string, owner?: string): Promise<number> {
  const deadline = Date.now() + 2000;
  let count = 0, bytes = owner ? officeStateBytes(owner) : 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
      if (++count > 20_000 || Date.now() > deadline) throw new Error('Storage usage could not be checked in time. Please try again.');
      const file = path.join(directory, entry.name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) throw new Error('Linked storage cannot be measured safely.');
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) bytes += stat.size;
    }
  };
  await walk(folder);
  return bytes;
}
export async function checkOfficeStorage(user: OfficeUser, project: string, file: string, content: string, preserve=false): Promise<void> {
  if (!user.limits?.storageMb) return;
  let previous = 0;
  try { const stat = await fs.lstat(path.resolve(project, file)); if (stat.isFile()) previous = stat.size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const used = await officeStorageBytes(user.workspacePath, user.id), next = used - (preserve?0:previous) + Buffer.byteLength(content, 'utf8');
  if (next > user.limits.storageMb * 1024 * 1024 && next > used) throw new Error('Your storage allowance is full. Remove files or ask for more space before saving.');
}
