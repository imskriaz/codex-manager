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
export function readOfficeUsage(owner: string) {
  const day = dayKey();
  return {day, resetsAt: Date.parse(`${day}T00:00:00Z`) + 86_400_000, ...(getSqliteStateStore()?.get<{tokens: number; requests: number; unconfirmed?: boolean; pending?: boolean}>(`office-usage:${owner}`, day) ?? {tokens: 0, requests: 0})};
}
export function checkOfficeTokens(user: OfficeUser, includePending = true): void {
  const usage = readOfficeUsage(user.id), limit = user.limits?.dailyTokens ?? 0;
  if (limit && (usage.tokens >= limit || usage.unconfirmed || includePending && usage.pending)) throw new OfficeQuotaError('Your daily token allowance is unavailable or has been reached. Check Usage in settings for the reset time.');
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
export function recordOfficeTokens(owner: string, tokens: unknown): void {
  const store = getSqliteStateStore();
  if (!store) throw new Error('Usage could not be saved.');
  store.transaction(() => {
    const usage = readOfficeUsage(owner);
    const valid = typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0;
    store.set(`office-usage:${owner}`, usage.day, {...usage, pending: false, tokens: usage.tokens + (valid ? tokens : 0), unconfirmed: usage.unconfirmed || !valid});
  });
}
export function beginOfficeTokens(user: OfficeUser): void {
  const store = getSqliteStateStore();
  if (!store) throw new Error('Usage is unavailable. Please try again.');
  store.transaction(() => {
    checkOfficeTokens(user);
    const usage = readOfficeUsage(user.id);
    store.set(`office-usage:${user.id}`, usage.day, {...usage, pending: true});
  });
}

export async function officeStorageBytes(folder: string): Promise<number> {
  const deadline = Date.now() + 2000;
  let count = 0, bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
      if (++count > 20_000 || Date.now() > deadline) throw new Error('Storage usage could not be checked in time. Please try again.');
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) bytes += (await fs.lstat(file)).size;
    }
  };
  await walk(folder);
  return bytes;
}
export async function checkOfficeStorage(user: OfficeUser, project: string, file: string, content: string): Promise<void> {
  if (!user.limits?.storageMb) return;
  let previous = 0;
  try { const stat = await fs.lstat(path.resolve(project, file)); if (stat.isFile()) previous = stat.size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const used = await officeStorageBytes(user.workspacePath), next = used - previous + Buffer.byteLength(content, 'utf8');
  if (next > user.limits.storageMb * 1024 * 1024 && next > used) throw new Error('Your storage allowance is full. Remove files or ask for more space before saving.');
}
