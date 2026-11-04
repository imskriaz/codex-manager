import path from 'node:path';
import { getSqliteStateStore } from '../storage/sqliteState';
import { isCodexSessionAccess, recordedCodexSandboxPolicy, type CodexSessionAccess } from '../domain/codexSessionAccess';

export type SavedCodexSessionAccess = { access: CodexSessionAccess; settings: { permissions?: string; sandboxPolicy?: Record<string, unknown> } };
const current = new Map<string, SavedCodexSessionAccess>();
const keyFor = (home: string, id: string) => JSON.stringify([path.resolve(home), id.toLowerCase()]);
export function readSavedCodexSessionAccess(home: string, id: string): SavedCodexSessionAccess | undefined {
  const key = keyFor(home,id);
  let saved: SavedCodexSessionAccess | undefined;
  try {
    const raw = getSqliteStateStore()?.get<SavedCodexSessionAccess>('session-access',key);
    if (raw && isCodexSessionAccess(raw.access) && raw.settings && JSON.stringify(raw.settings).length <= 64_000 &&
      (typeof raw.settings.permissions === 'string' && raw.settings.permissions === raw.access.profile && !raw.settings.sandboxPolicy || !raw.settings.permissions && recordedCodexSandboxPolicy(raw.settings.sandboxPolicy))) saved = raw;
  } catch (error) { console.warn('[codexManager] saved session access is unavailable',error); }
  const cached=current.get(key);
  return cached && cached.access.updatedAt >= (saved?.access.updatedAt ?? 0) ? cached : saved;
}
export function saveCodexSessionAccess(home: string, id: string, access: CodexSessionAccess, raw: unknown): boolean {
  const value=raw && typeof raw==='object' ? raw as Record<string,unknown> : {};
  const sandboxPolicy=recordedCodexSandboxPolicy(value['sandboxPolicy'] ?? value['sandbox_policy'] ?? value['sandbox']);
  const settings=access.profile ? { permissions:access.profile } : sandboxPolicy ? { sandboxPolicy } : undefined;
  if (!settings) return true;
  const key=keyFor(home,id),prior=readSavedCodexSessionAccess(home,id);
  if (prior && prior.access.updatedAt>access.updatedAt) return true;
  const entry={access,settings};current.set(key,entry);
  if(current.size>256)current.delete(current.keys().next().value!);
  try { const store=getSqliteStateStore(); if (!store) return false; store.set('session-access',key,entry); return true; }
  catch(error){console.warn('[codexManager] session access recovery could not be saved',error);return false;}
}
