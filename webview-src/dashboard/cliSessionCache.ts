import type {
  DashboardCliComposerConfig,
  DashboardCliSessionMessage,
  DashboardCliSessionSummary,
  DashboardState
} from "../../src/domain/dashboard/types";

const DB_NAME = "codex-manager-cache";
const DB_VERSION = 1;
const STORE_NAME = "cli-sessions";
const MAX_CACHE_AGE_MS = 5 * 60_000;
const DASHBOARD_CACHE_KEY = "dashboard-state";
const MAX_DASHBOARD_CACHE_AGE_MS = 30 * 60_000;

type CacheRecord = {
  key: string;
  updatedAt: number;
  value: unknown;
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
  return previous?.projectPath && !incoming.projectPath ? { ...incoming, projectPath: previous.projectPath } : incoming;
}

let cacheDatabase: Promise<IDBDatabase | undefined> | undefined;
let pendingDashboardState: DashboardState | undefined;
let dashboardWrite: Promise<void> | undefined;

function openCache(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === "undefined") return Promise.resolve(undefined);
  cacheDatabase ??= new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME))
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        cacheDatabase = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      cacheDatabase = undefined;
      resolve(undefined);
    };
    request.onblocked = () => {
      cacheDatabase = undefined;
      resolve(undefined);
    };
  });
  return cacheDatabase;
}

export async function readCliSessionListCache(): Promise<CliSessionListCache | undefined> {
  const cached = await readFreshRecord<Partial<CliSessionListCache>>("list", MAX_CACHE_AGE_MS);
  if (!cached || !Array.isArray(cached.value.sessions)) return undefined;
  return { sessions: cached.value.sessions, composerConfig: cached.value.composerConfig, ageMs: cached.ageMs };
}

export async function readCliSessionMessagesCache(
  sessionId: string
): Promise<DashboardCliSessionMessage[] | undefined> {
  const cached = await readFreshRecord<unknown>(`messages:${sessionId}`, MAX_CACHE_AGE_MS);
  return cached && Array.isArray(cached.value) ? (cached.value as DashboardCliSessionMessage[]) : undefined;
}

export async function writeCliSessionListCache(value: CliSessionListCache): Promise<void> {
  await writeRecord({ key: "list", updatedAt: Date.now(), value });
}

export async function writeCliSessionMessagesCache(
  sessionId: string,
  messages: DashboardCliSessionMessage[]
): Promise<void> {
  await writeRecord({ key: `messages:${sessionId}`, updatedAt: Date.now(), value: messages });
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

export async function invalidateCliSessionCache(sessionId?: string): Promise<void> {
  const db = await openCache();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete("list");
    if (sessionId) transaction.objectStore(STORE_NAME).delete(`messages:${sessionId}`);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
  });
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
  return ageMs <= maxAgeMs ? { value: record.value as T, ageMs } : undefined;
}

async function readRecord(key: string): Promise<CacheRecord | undefined> {
  const db = await openCache();
  if (!db) return undefined;
  return new Promise((resolve) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result as CacheRecord | undefined);
    request.onerror = () => resolve(undefined);
  });
}

async function writeRecord(record: CacheRecord): Promise<void> {
  const db = await openCache();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
  });
}
