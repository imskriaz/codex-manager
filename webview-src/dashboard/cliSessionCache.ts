import type {
  DashboardCliComposerConfig,
  DashboardCliSessionMessage,
  DashboardCliSessionSummary,
  DashboardState
} from "../../src/domain/dashboard/types";
import { sameCliSessionTarget } from "./cliSessionRoute";
import { normalizeCliComposerDraft, type CliComposerDraft } from "./cliSessionComposerState";

const DB_NAME = "codex-manager-cache";
const DB_VERSION = 1;
const STORE_NAME = "cli-sessions";
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60_000;
const DASHBOARD_CACHE_KEY = "dashboard-state";
const MAX_DASHBOARD_CACHE_AGE_MS = MAX_CACHE_AGE_MS;
const MAX_DRAFT_AGE_MS = 30 * 24 * 60 * 60_000;
const MAX_DRAFT_RECORDS = 20;
const MAX_DRAFT_BYTES = 16 * 1024 * 1024;

type CacheRecord = {
  key: string;
  updatedAt: number;
  value: unknown;
  sizeBytes?: number;
};

export type CliSessionListCache = {
  sessions: DashboardCliSessionSummary[];
  composerConfig?: DashboardCliComposerConfig;
  ageMs?: number;
};

function cliSessionKey(session: DashboardCliSessionSummary): string {
  return `${session.deviceId ?? "local"}:${session.id}`;
}

const SESSION_METADATA = ["model","reasoningEffort","goal","sessionSurface","subAgent","parentSessionId","agentName"] as const;

/** Missing metadata is inconclusive; explicit goal removal and runtime status remain authoritative. */
export function mergeCachedCliSessions(
  incoming: DashboardCliSessionSummary[],
  previous: DashboardCliSessionSummary[],
  deviceId?: string,
  partial = false
): DashboardCliSessionSummary[] {
  const previousByKey = new Map(previous.map((session) => [cliSessionKey(session), session]));
  const source = incoming.filter(session => deviceId ? session.deviceId === deviceId : !session.deviceId);
  const merged = [...new Map(source.map(session => [cliSessionKey(session), session])).values()].map((session) => {
    const prior = previousByKey.get(cliSessionKey(session));
    return mergeCachedCliSession(session,prior);
  });
  const incomingKeys = new Set(merged.map(cliSessionKey));
  const retained = previous.filter(session => !incomingKeys.has(cliSessionKey(session)) &&
    (partial || (deviceId ? session.deviceId !== deviceId : Boolean(session.deviceId))));
  return deviceId ? [...retained, ...merged] : [...merged, ...retained];
}

export function mergeCachedCliSession(
  incoming: DashboardCliSessionSummary,
  previous?: DashboardCliSessionSummary
): DashboardCliSessionSummary {
  if (!previous || !sameCliSessionTarget(incoming,previous) ||
      !(previous.projectPath && !incoming.projectPath || SESSION_METADATA.some(key=>incoming[key]===undefined && previous[key]!==undefined))) return incoming;
  return { ...incoming,projectPath:incoming.projectPath || previous.projectPath,
    model:incoming.model ?? previous.model,reasoningEffort:incoming.reasoningEffort ?? previous.reasoningEffort,
    goal:incoming.goal === undefined ? previous.goal : incoming.goal,
    sessionSurface:incoming.sessionSurface ?? previous.sessionSurface,subAgent:incoming.subAgent ?? previous.subAgent,
    parentSessionId:incoming.parentSessionId ?? previous.parentSessionId,agentName:incoming.agentName ?? previous.agentName };
}

let browserLocalSystemId: string | undefined;
let requireSystemIdentity = false;

export function bindBrowserCacheSystem(systemId?: string): void {
  requireSystemIdentity = true;
  browserLocalSystemId = systemId && systemId !== 'local' ? systemId : undefined;
}
const cacheSystemId = (deviceId?: string): string | undefined => deviceId && deviceId !== 'local' ? deviceId : browserLocalSystemId ?? (requireSystemIdentity ? undefined : 'local');

let cacheDatabase: Promise<IDBDatabase | undefined> | undefined;
let pendingDashboardState: DashboardState | undefined;
const listWriteVersions = new Map<string, number>();
let dashboardWrite: Promise<void> | undefined;
const draftWrites = new Map<string, { value: CliComposerDraft; waiters: Array<(saved: boolean) => void> }>();
let flushingDrafts: Promise<void> | undefined;

function openCache(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === "undefined") return Promise.resolve(undefined);
  cacheDatabase ??= new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      cacheDatabase = undefined;
      resolve(undefined);
    }, 2_000);
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DB_NAME, DB_VERSION); }
    catch { clearTimeout(timer); settled = true; resolve(undefined); return; }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME))
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (settled) { request.result.close(); return; }
      settled = true;
      request.result.onversionchange = () => {
        request.result.close();
        cacheDatabase = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      cacheDatabase = undefined;
      resolve(undefined);
    };
    request.onblocked = () => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      cacheDatabase = undefined;
      resolve(undefined);
    };
  });
  const opening = cacheDatabase;
  return opening.then((db) => {
    if (!db && cacheDatabase === opening) cacheDatabase = undefined;
    return db;
  }, () => { if (cacheDatabase === opening) cacheDatabase = undefined; return undefined; });
}

export async function readCliSessionListCache(deviceId?: string): Promise<CliSessionListCache | undefined> {
  const systemId = cacheSystemId(deviceId);
  if (!systemId) return undefined;
  const cached = await readFreshRecord<Partial<CliSessionListCache>>(`list:${systemId}`, MAX_CACHE_AGE_MS);
  if (!cached || !Array.isArray(cached.value.sessions)) return undefined;
  return { sessions: cached.ageMs > 5000 ? cached.value.sessions.map(session => ({ ...session, status: 'unknown', canStop: false })) : cached.value.sessions, composerConfig: cached.value.composerConfig, ageMs: cached.ageMs };
}

export async function readCliComposerDraft(key: string): Promise<CliComposerDraft | undefined> {
  const record = await readFreshRecord<unknown>(`composer:${key}`, MAX_DRAFT_AGE_MS);
  return record ? normalizeCliComposerDraft(record.value) : undefined;
}

export async function readLegacyCliComposerDraft(key: string): Promise<CliComposerDraft | undefined> {
  try {
    const parts = JSON.parse(key) as unknown[];
    if (!Array.isArray(parts) || parts.length !== 3 || parts[0] === 'local') return undefined;
    parts[0] = 'local';
    return readCliComposerDraft(JSON.stringify(parts));
  } catch { return undefined; }
}

/** One durable record per device/session, so separate open chats cannot overwrite each other. */
export async function writeCliComposerDraft(key: string, value: CliComposerDraft): Promise<boolean> {
  if (!normalizeCliComposerDraft(value)) return false;
  const result = new Promise<boolean>((resolve) => {
    const existing = draftWrites.get(key);
    draftWrites.set(key, { value, waiters: [...(existing?.waiters ?? []), resolve] });
  });
  startComposerFlush();
  return result;
}

function startComposerFlush(): void {
  flushingDrafts ??= flushComposerWrites().finally(() => {
    flushingDrafts = undefined;
    if (draftWrites.size) startComposerFlush();
  });
}

async function flushComposerWrites(): Promise<void> {
  while (draftWrites.size) {
    const [key, pending] = draftWrites.entries().next().value!;
    draftWrites.delete(key);
    const saved = await saveCliComposerDraft(key, pending.value);
    for (const resolve of pending.waiters) resolve(saved);
  }
}

async function saveCliComposerDraft(key: string, value: CliComposerDraft): Promise<boolean> {
  const normalized = normalizeCliComposerDraft(value);
  if (!normalized) return false;
  const db = await openCache();
  if (!db) return false;
  return new Promise<boolean>((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const timer = setTimeout(() => { try { transaction.abort(); } catch { /* settled */ } resolve(false); }, 3_000);
    const store = transaction.objectStore(STORE_NAME);
    const target = `composer:${key}`;
    const record: CacheRecord = { key: target, updatedAt: Date.now(), value: normalized };
    record.sizeBytes = JSON.stringify(record).length * 2;
    let count = 0;
    let bytes = record.sizeBytes;
    const emptyDrafts: Array<{ key: string; updatedAt: number; size: number }> = [];
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) {
        for (const empty of emptyDrafts.sort((a, b) => a.updatedAt - b.updatedAt)) {
          if (count < MAX_DRAFT_RECORDS && bytes <= MAX_DRAFT_BYTES) break;
          store.delete(empty.key); count -= 1; bytes -= empty.size;
        }
        if (count >= MAX_DRAFT_RECORDS || bytes > MAX_DRAFT_BYTES) { transaction.abort(); return; }
        store.put(record);
        return;
      }
      const prior = entry.value as CacheRecord | undefined;
      if (!prior || typeof prior.key !== "string") { entry.continue(); return; }
      if (prior.key.startsWith("composer:") && prior.key !== target) {
        if (!Number.isFinite(prior.updatedAt) || prior.updatedAt > Date.now() || Date.now() - prior.updatedAt > MAX_DRAFT_AGE_MS)
          entry.delete();
        else {
          const draft = normalizeCliComposerDraft(prior.value);
          if (!draft) { entry.delete(); entry.continue(); return; }
          const size = Number.isFinite(prior.sizeBytes) && prior.sizeBytes! > 0 && prior.sizeBytes! <= MAX_DRAFT_BYTES
            ? prior.sizeBytes! : JSON.stringify({ key: prior.key, updatedAt: prior.updatedAt, value: draft }).length * 2;
          count += 1; bytes += size;
          if (!draft.text && !draft.attachments.length) emptyDrafts.push({ key: prior.key, updatedAt: prior.updatedAt, size });
        }
      }
      entry.continue();
    };
    transaction.oncomplete = () => { clearTimeout(timer); resolve(true); };
    transaction.onerror = transaction.onabort = () => { clearTimeout(timer); resolve(false); };
  }).catch(() => false);
}

export async function readCliSessionMessagesCache(
  sessionId: string,
  deviceId?: string
): Promise<DashboardCliSessionMessage[] | undefined> {
  const systemId = cacheSystemId(deviceId);
  if (!systemId) return undefined;
  const cached = await readFreshRecord<unknown>(`messages:${JSON.stringify([systemId, sessionId])}`, MAX_CACHE_AGE_MS);
  return cached && Array.isArray(cached.value) ? (cached.value as DashboardCliSessionMessage[]) : undefined;
}

export async function writeCliSessionListCache(value: CliSessionListCache, deviceId?: string): Promise<void> {
  const systemId = cacheSystemId(deviceId);
  if (!systemId) return;
  const key = `list:${systemId}`;
  const version = (listWriteVersions.get(key) ?? 0) + 1;
  listWriteVersions.set(key, version);
  const previous = value.composerConfig ? undefined : await readCliSessionListCache(deviceId);
  if (listWriteVersions.get(key) !== version) return;
  const sessions = value.sessions.filter(session => deviceId ? session.deviceId === deviceId : !session.deviceId);
  await writeRecord({ key, updatedAt: Date.now(), value: {
    sessions: mergeCachedCliSessions(sessions, previous?.sessions ?? [], deviceId),
    composerConfig: value.composerConfig ?? previous?.composerConfig
  } });
}

export async function writeCliSessionMessagesCache(
  sessionId: string,
  messages: DashboardCliSessionMessage[],
  deviceId?: string
): Promise<void> {
  const systemId = cacheSystemId(deviceId);
  if (!systemId) return;
  await writeRecord({ key: `messages:${JSON.stringify([systemId, sessionId])}`, updatedAt: Date.now(), value: messages });
}

export async function readDashboardStateCache(): Promise<DashboardState | undefined> {
  const cached = await readFreshRecord<unknown>(DASHBOARD_CACHE_KEY, MAX_DASHBOARD_CACHE_AGE_MS);
  if (!cached?.value || typeof cached.value !== "object" || !("state" in cached.value)) return undefined;
  const state = { ...(cached.value as { state: DashboardState }).state };
  delete state.usageHistory;
  delete state.dailyUsageCache;
  return state;
}

export async function readDashboardAccountsCache(deviceId: string): Promise<DashboardState["accounts"] | undefined> {
  const cached = await readFreshRecord<DashboardState["accounts"]>(`accounts:${deviceId}`, MAX_DASHBOARD_CACHE_AGE_MS);
  if (cached && Array.isArray(cached.value)) return cached.value;
  const legacy = await readDashboardStateCache();
  return legacy?.peerAccounts?.[deviceId] ?? (legacy?.connectedPeers?.some(peer => peer.local && peer.id === deviceId) ? legacy.accounts : undefined);
}

export function scopeDashboardAccounts(state: DashboardState, deviceId?: string): DashboardState {
  const accounts = deviceId ? state.peerAccounts?.[deviceId] : undefined;
  return { ...state, peerAccounts: deviceId && accounts ? { [deviceId]: accounts } : {} };
}

export function writeDashboardStateCache(state: DashboardState): Promise<void> {
  // Keep recovery metadata, while graph history stays in the host database.
  pendingDashboardState = { ...state, peerAccounts: { ...pendingDashboardState?.peerAccounts, ...state.peerAccounts } };
  delete pendingDashboardState.usageHistory;
  delete pendingDashboardState.dailyUsageCache;
  dashboardWrite ??= flushDashboardStateWrites().finally(() => {
    dashboardWrite = undefined;
    if (pendingDashboardState) void writeDashboardStateCache(pendingDashboardState);
  });
  return dashboardWrite;
}

export async function invalidateCliSessionCache(sessionId?: string, deviceId?: string): Promise<void> {
  const systemId = cacheSystemId(deviceId);
  if (!systemId) return;
  const listKey = `list:${systemId}`, messagesKey = `messages:${JSON.stringify([systemId, sessionId])}`;
  listWriteVersions.set(listKey, (listWriteVersions.get(listKey) ?? 0) + 1);
  const db = await openCache();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const finish = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { try { transaction.abort(); } catch { /* settled */ } finish(); }, 3_000);
    transaction.objectStore(STORE_NAME).delete(listKey);
    if (sessionId) transaction.objectStore(STORE_NAME).delete(messagesKey);
    transaction.oncomplete = transaction.onerror = transaction.onabort = finish;
  }).catch(() => undefined);
}

async function flushDashboardStateWrites(): Promise<void> {
  while (pendingDashboardState) {
    const state = pendingDashboardState;
    pendingDashboardState = undefined;
    const updatedAt = Date.now();
    const localId = state.connectedPeers?.find(peer => peer.local)?.id ?? "local";
    await Promise.all([
      writeRecord({ key: DASHBOARD_CACHE_KEY, updatedAt, value: { state: scopeDashboardAccounts(state) } }),
      ...Object.entries({ ...state.peerAccounts, [localId]: state.accounts }).filter(([, accounts]) => Array.isArray(accounts)).map(([deviceId, accounts]) =>
        writeRecord({ key: `accounts:${deviceId}`, updatedAt, value: accounts }))
    ]);
  }
}

async function readFreshRecord<T>(key: string, maxAgeMs: number): Promise<{ value: T; ageMs: number } | undefined> {
  const record = await readRecord(key);
  if (!record) return undefined;
  const ageMs = Date.now() - record.updatedAt;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs ? { value: record.value as T, ageMs } : undefined;
}

async function readRecord(key: string): Promise<CacheRecord | undefined> {
  const db = await openCache();
  if (!db) return undefined;
  return new Promise<CacheRecord | undefined>((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const finish = (record?: CacheRecord): void => { clearTimeout(timer); resolve(record); };
    const timer = setTimeout(() => { try { transaction.abort(); } catch { /* settled */ } finish(); }, 3_000);
    transaction.onabort = transaction.onerror = () => finish();
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => finish(request.result as CacheRecord | undefined);
    request.onerror = () => finish();
  }).catch(() => undefined);
}

async function writeRecord(record: CacheRecord): Promise<void> {
  const db = await openCache(); if (!db) return;
  record.sizeBytes = JSON.stringify(record).length * 2;
  if (record.sizeBytes > 4 * 1024 * 1024) return;
  await new Promise<void>(resolve => {
    const tx = db.transaction(STORE_NAME, 'readwrite'), store = tx.objectStore(STORE_NAME);
    const timer = setTimeout(() => { try { tx.abort(); } catch { /* settled */ } resolve(); }, 3000);
    const prior: Array<{ key: string; at: number; bytes: number }> = [];
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (row) {
        const value = row.value as CacheRecord | undefined;
        if (typeof value?.key !== 'string') { row.continue(); return; }
        if (!value.key.startsWith('composer:') && !value.key.startsWith('browser:outbox:') && value.key !== record.key) {
          if (!Number.isFinite(value.updatedAt) || value.updatedAt > Date.now() || Date.now() - value.updatedAt > MAX_CACHE_AGE_MS) row.delete();
          else prior.push({ key: value.key, at: value.updatedAt, bytes: value.sizeBytes ?? JSON.stringify(value).length * 2 });
        }
        row.continue(); return;
      }
      let bytes = prior.reduce((total, value) => total + value.bytes, record.sizeBytes!);
      prior.sort((a,b) => a.at - b.at);
      while (prior.length >= 80 || bytes > 24 * 1024 * 1024) {
        const evicted = prior.shift(); if (!evicted) break;
        store.delete(evicted.key); bytes -= evicted.bytes;
      }
      store.put(record);
    };
    tx.oncomplete = tx.onerror = tx.onabort = () => { clearTimeout(timer); resolve(); };
  }).catch(() => undefined);
}

/** Durable task/comment outbox entries are never silently evicted. */
export async function readBrowserCache<T>(key: string): Promise<T | undefined> {
  return (await readFreshRecord<T>(`browser:${key}`, MAX_CACHE_AGE_MS))?.value;
}
export async function writeBrowserCache(key: string, value: unknown): Promise<boolean> {
  const db = await openCache(); if (!db) return false;
  const record: CacheRecord = { key: `browser:${key}`, updatedAt: Date.now(), value };
  try { record.sizeBytes = JSON.stringify(record).length * 2; } catch { return false; }
  if (record.sizeBytes > 2 * 1024 * 1024) return false;
  const durable = record.key.startsWith('browser:outbox:');
  return new Promise<boolean>(resolve => {
    const tx = db.transaction(STORE_NAME, 'readwrite'), store = tx.objectStore(STORE_NAME);
    const timer = setTimeout(() => { try { tx.abort(); } catch { /* settled */ } resolve(false); }, 3000);
    const cached: Array<{ key: string; bytes: number; at: number }> = [];
    let draftCount = 0, draftBytes = durable ? record.sizeBytes! : 0;
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (row) {
        const prior = row.value as CacheRecord;
        if (typeof prior?.key !== 'string') { row.continue(); return; }
        if (prior.key !== record.key) {
          const bytes = prior.sizeBytes ?? JSON.stringify(prior).length * 2;
          if (prior.key.startsWith('browser:outbox:')) { draftCount++; draftBytes += bytes; }
          else if (!prior.key.startsWith('composer:')) {
            if (!Number.isFinite(prior.updatedAt) || prior.updatedAt > Date.now() || Date.now() - prior.updatedAt > MAX_CACHE_AGE_MS) row.delete();
            else cached.push({ key: prior.key, bytes, at: prior.updatedAt });
          }
        }
        row.continue(); return;
      }
      // A full durable outbox rejects the new write; it never evicts unsynced work.
      if (durable && (draftCount >= 100 || draftBytes > 8 * 1024 * 1024)) { tx.abort(); return; }
      let bytes = cached.reduce((sum, entry) => sum + entry.bytes, durable ? 0 : record.sizeBytes!);
      cached.sort((a,b) => a.at - b.at);
      while (cached.length >= 80 || bytes > 24 * 1024 * 1024) { const oldest = cached.shift(); if (!oldest) break; store.delete(oldest.key); bytes -= oldest.bytes; }
      store.put(record);
    };
    tx.oncomplete = () => { clearTimeout(timer); resolve(true); };
    tx.onerror = tx.onabort = () => { clearTimeout(timer); resolve(false); };
  }).catch(() => false);
}

export async function listBrowserOutbox<T>(): Promise<Array<{ key: string; value: T }>> {
  const db = await openCache(); if (!db) return [];
  return new Promise<Array<{ key: string; value: T }>>(resolve => {
    const tx = db.transaction(STORE_NAME, 'readonly'), rows: Array<{ key: string; value: T }> = [];
    const timer = setTimeout(() => { try { tx.abort(); } catch { /* settled */ } resolve([]); }, 3000);
    const cursor = tx.objectStore(STORE_NAME).openCursor(IDBKeyRange.bound('browser:outbox:', 'browser:outbox:\uffff'));
    cursor.onsuccess = () => {
      const row = cursor.result; if (!row) return;
      const record = row.value as CacheRecord;
      if (typeof record?.key === 'string' && record.key.startsWith('browser:outbox:')) rows.push({ key: record.key.slice(8), value: record.value as T });
      row.continue();
    };
    tx.oncomplete = () => { clearTimeout(timer); resolve(rows); };
    tx.onerror = tx.onabort = () => { clearTimeout(timer); resolve([]); };
  }).catch(() => []);
}
export async function deleteBrowserCache(key: string): Promise<boolean> {
  const db = await openCache(); if (!db) return false;
  return new Promise<boolean>(resolve => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const timer = setTimeout(() => { try { tx.abort(); } catch { /* settled */ } resolve(false); }, 3000);
    tx.objectStore(STORE_NAME).delete(`browser:${key}`);
    tx.oncomplete = () => { clearTimeout(timer); resolve(true); };
    tx.onerror = tx.onabort = () => { clearTimeout(timer); resolve(false); };
  }).catch(() => false);
}
