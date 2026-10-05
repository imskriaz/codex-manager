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
const MAX_CACHE_AGE_MS = 5 * 60_000;
const DASHBOARD_CACHE_KEY = "dashboard-state";
const MAX_DASHBOARD_CACHE_AGE_MS = 30 * 60_000;
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

/** Preserve known folder metadata when a short/partial refresh omits it. */
export function mergeCachedCliSessions(
  incoming: DashboardCliSessionSummary[],
  previous: DashboardCliSessionSummary[]
): DashboardCliSessionSummary[] {
  const previousByKey = new Map(previous.map((session) => [cliSessionKey(session), session]));
  return incoming.map((session) => {
    const prior = previousByKey.get(cliSessionKey(session));
    return prior?.projectPath && !session.projectPath ? { ...session, projectPath: prior.projectPath } : session;
  });
}

export function mergeCachedCliSession(
  incoming: DashboardCliSessionSummary,
  previous?: DashboardCliSessionSummary
): DashboardCliSessionSummary {
  return sameCliSessionTarget(incoming, previous) && previous?.projectPath && !incoming.projectPath ? { ...incoming, projectPath: previous.projectPath } : incoming;
}

let cacheDatabase: Promise<IDBDatabase | undefined> | undefined;
let pendingDashboardState: DashboardState | undefined;
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

export async function readCliSessionListCache(): Promise<CliSessionListCache | undefined> {
  const cached = await readFreshRecord<Partial<CliSessionListCache>>("list", MAX_CACHE_AGE_MS);
  if (!cached || !Array.isArray(cached.value.sessions)) return undefined;
  return { sessions: cached.value.sessions, composerConfig: cached.value.composerConfig, ageMs: cached.ageMs };
}

export async function readCliComposerDraft(key: string): Promise<CliComposerDraft | undefined> {
  const record = await readFreshRecord<unknown>(`composer:${key}`, MAX_DRAFT_AGE_MS);
  return record ? normalizeCliComposerDraft(record.value) : undefined;
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
  const cached = await readFreshRecord<unknown>(`messages:${JSON.stringify([deviceId ?? "local", sessionId])}`, MAX_CACHE_AGE_MS);
  return cached && Array.isArray(cached.value) ? (cached.value as DashboardCliSessionMessage[]) : undefined;
}

export async function writeCliSessionListCache(value: CliSessionListCache): Promise<void> {
  await writeRecord({ key: "list", updatedAt: Date.now(), value });
}

export async function writeCliSessionMessagesCache(
  sessionId: string,
  messages: DashboardCliSessionMessage[],
  deviceId?: string
): Promise<void> {
  await writeRecord({ key: `messages:${JSON.stringify([deviceId ?? "local", sessionId])}`, updatedAt: Date.now(), value: messages });
}

export async function readDashboardStateCache(): Promise<DashboardState | undefined> {
  const cached = await readFreshRecord<unknown>(DASHBOARD_CACHE_KEY, MAX_DASHBOARD_CACHE_AGE_MS);
  if (!cached?.value || typeof cached.value !== "object" || !("state" in cached.value)) return undefined;
  return (cached.value as { state: DashboardState }).state;
}

export function writeDashboardStateCache(state: DashboardState): Promise<void> {
  // Quota history can grow over time; keep the browser cache bounded and never
  // let a burst of WebSocket snapshots create parallel IndexedDB writes.
  pendingDashboardState = { ...state, usageHistory: (state.usageHistory ?? []).slice(-500) };
  dashboardWrite ??= flushDashboardStateWrites().finally(() => {
    dashboardWrite = undefined;
  });
  return dashboardWrite;
}

export async function invalidateCliSessionCache(sessionId?: string, deviceId?: string): Promise<void> {
  const db = await openCache();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete("list");
    if (sessionId) transaction.objectStore(STORE_NAME).delete(`messages:${JSON.stringify([deviceId ?? "local", sessionId])}`);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  }).catch(() => undefined);
}

async function flushDashboardStateWrites(): Promise<void> {
  while (pendingDashboardState) {
    const state = pendingDashboardState;
    pendingDashboardState = undefined;
    await writeRecord({ key: DASHBOARD_CACHE_KEY, updatedAt: Date.now(), value: { state } });
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
  const db = await openCache();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  }).catch(() => undefined);
}
