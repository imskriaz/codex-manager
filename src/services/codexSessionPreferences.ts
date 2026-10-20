import { getCodexHomeStateKey } from "../codex/authFile";
import { getSqliteStateStore } from "../storage/sqliteState";
import { randomUUID } from 'node:crypto';
import { isSessionQueuePriority } from '../domain/sessionQueuePriority';
import { isAutoResumeEnabled } from '../infrastructure/config/extensionSettings';

export type CodexSessionPreference = {
  autoResume?: boolean;
  queue?: boolean;
  priority?: number;
  queueClaimedAt?: number;
  queueError?: string;
  queueRevision?: string;
  queueClaimId?: string;
};

const NAMESPACE = "codex-session-preferences";
const TITLE_NAMESPACE = "codex-session-title-overrides";
type TitleOverride = { title: string; writtenAt: number };
const key = (home: string, id: string) => `${getCodexHomeStateKey(home)}:${id.toLowerCase()}`;

function read(store: ReturnType<typeof getSqliteStateStore>, home: string, id: string): CodexSessionPreference {
  const value = store?.get<CodexSessionPreference>(NAMESPACE, key(home, id));
  return normalizePreference(value);
}

function normalizePreference(value: unknown): CodexSessionPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const preference = value as CodexSessionPreference;
  return preference.priority === undefined || isSessionQueuePriority(preference.priority) ? preference
    : { ...preference, queueError: 'Saved queue priority is invalid. Choose a positive whole number before requeuing.' };
}

function readNamespace(home: string, namespace: string): Map<string, unknown> {
  const store = getSqliteStateStore();
  const result = new Map<string, unknown>();
  if (!store) return result;
  const prefix = `${getCodexHomeStateKey(home)}:`;
  for (const row of store.prepare("SELECT key,value FROM state WHERE namespace=? AND key LIKE ? LIMIT 30000").all(namespace, `${prefix}%`)) {
    const keyValue = String(row["key"]);
    try { result.set(keyValue.slice(prefix.length), JSON.parse(String(row["value"]))); } catch { /* Ignore one corrupt optional preference. */ }
  }
  return result;
}

export function readCodexSessionPreferences(home: string, ids: readonly string[]): Map<string, CodexSessionPreference> {
  const values = readNamespace(home, NAMESPACE);
  const result = new Map<string, CodexSessionPreference>();
  for (const id of ids) {
    const value = values.get(id.toLowerCase());
    result.set(id, normalizePreference(value));
  }
  return result;
}

export function writeCodexSessionPreference(home: string, id: string, patch: Partial<CodexSessionPreference>): CodexSessionPreference {
  if (patch.priority !== undefined && !isSessionQueuePriority(patch.priority)) throw new Error('Choose a positive whole number for queue priority.');
  const store = getSqliteStateStore();
  if (!store) throw new Error('Session preference storage is unavailable. The change was not saved.');
  return store.transaction(() => {
    const next = { ...read(store, home, id), ...patch };
    if (next.autoResume === undefined && next.queue !== true && next.priority === undefined && !next.queueClaimedAt && !next.queueError) store.set(NAMESPACE, key(home, id), undefined);
    else store.set(NAMESPACE, key(home, id), next);
    return next;
  });
}

export function claimCodexSessionQueue(home: string, id: string, revision: string | undefined): string | undefined {
  const store = getSqliteStateStore();
  if (!store) throw new Error('Session queue storage is unavailable. No work was started.');
  return store.transaction(() => {
    const current = read(store, home, id);
    if (!current.queue || current.queueClaimId || current.queueClaimedAt || current.queueError || current.queueRevision !== revision) return undefined;
    const claimId = randomUUID();
    writeCodexSessionPreference(home, id, { queueClaimId: claimId, queueClaimedAt: Date.now() });
    return claimId;
  });
}

export function finishCodexSessionQueueClaim(home: string, id: string, claimId: string, error?: string, keepQueued = false): void {
  const store = getSqliteStateStore();
  if (!store) throw new Error('Session queue result could not be saved. Review the session before requeuing.');
  store.transaction(() => {
    if (read(store, home, id).queueClaimId !== claimId) return;
    writeCodexSessionPreference(home, id, error ? { queueError: error } : { queue: keepQueued, priority: keepQueued ? read(store, home, id).priority : undefined, queueClaimId: undefined, queueClaimedAt: undefined, queueError: undefined });
  });
}

export function readQueuedCodexSessionPreferences(home: string): Map<string, CodexSessionPreference> {
  const store = getSqliteStateStore();
  if (!store) return new Map();
  const prefix = `${getCodexHomeStateKey(home)}:`;
  return new Map(store.prepare("SELECT key,value FROM state WHERE namespace=? AND key LIKE ? AND json_valid(value) AND json_extract(value,'$.queue')=1 LIMIT 256").all(NAMESPACE, `${prefix}%`).map(row => [String(row['key']).slice(prefix.length), normalizePreference(JSON.parse(String(row['value'])))]));
}

export function isCodexSessionAutoResumeDisabled(home: string, id: string): boolean {
  return read(getSqliteStateStore(), home, id).autoResume === false;
}

export function hasCodexSessionAutoResumeOptIn(home: string): boolean {
  const store = getSqliteStateStore();
  if (!store) return false;
  const prefix = `${getCodexHomeStateKey(home)}:`;
  return Boolean(store.prepare("SELECT 1 FROM state WHERE namespace=? AND key LIKE ? AND json_extract(value,'$.autoResume')=1 LIMIT 1").get(NAMESPACE, `${prefix}%`));
}

export function isCodexSessionAutoResumeEnabled(home: string, id: string): boolean {
  const preference = read(getSqliteStateStore(), home, id);
  return (isAutoResumeEnabledForHome() || preference.autoResume === true) && preference.autoResume !== false;
}

function isAutoResumeEnabledForHome(): boolean {
  return isAutoResumeEnabled();
}

export function orderCodexSessionRecoveryIds(home: string, ids: readonly string[]): string[] {
  const preferences = readCodexSessionPreferences(home, ids);
  return [...ids].sort((left, right) => {
    const a = preferences.get(left), b = preferences.get(right);
    const aQueued = a?.queue === true, bQueued = b?.queue === true;
    if (aQueued !== bQueued) return aQueued ? 1 : -1;
    if (!aQueued) return 0;
    return (a?.priority ?? 3) - (b?.priority ?? 3);
  });
}

export function readCodexSessionTitleOverrides(home: string, ids: readonly string[]): Map<string, string> {
  const values = readNamespace(home, TITLE_NAMESPACE);
  const result = new Map<string, string>();
  for (const id of ids) {
    const title = values.get(id.toLowerCase());
    if (typeof title === "string" && title.trim()) result.set(id, title);
    else if (title && typeof title === 'object') {
      const value = title as TitleOverride;
      if (typeof value.title === 'string' && Number.isFinite(value.writtenAt) && Date.now() - value.writtenAt >= 0 && Date.now() - value.writtenAt < 60_000) result.set(id, value.title);
    }
  }
  return result;
}

export function writeCodexSessionTitleOverride(home: string, id: string, title: string): void {
  const store = getSqliteStateStore();
  if (!store) throw new Error('Codex renamed the conversation, but Manager title storage is unavailable. Refresh sessions to read the native title.');
  store.set(TITLE_NAMESPACE, key(home, id), { title: title.trim().slice(0, 160), writtenAt: Date.now() });
}

/** Native confirmation retires the bridge so later renames in Codex remain authoritative. */
export function reconcileCodexSessionTitles(home: string, rows: ReadonlyArray<{ id: string; title: string }>): Map<string, string> {
  const store = getSqliteStateStore(), values = readNamespace(home, TITLE_NAMESPACE);
  const overrides = new Map<string, string>();
  const retired = rows.filter(row => {
    const value = values.get(row.id.toLowerCase());
    if (value === undefined) return false;
    if (value && typeof value === 'object') {
      const override = value as TitleOverride, age = Date.now() - override.writtenAt;
      if (typeof override.title === 'string' && Number.isFinite(age) && age >= 0 && age < 60_000 && override.title !== row.title) { overrides.set(row.id, override.title); return false; }
    }
    return true;
  });
  if (retired.length && store) store.transaction(() => {
    for (const row of retired) { store.set(TITLE_NAMESPACE, key(home, row.id), undefined); overrides.delete(row.id); }
  });
  return overrides;
}
