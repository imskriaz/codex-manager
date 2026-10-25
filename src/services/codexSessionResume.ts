import { sqliteConfiguration } from "../storage/sqliteContext";
import { clearExplicitSessionGoalPause, isExplicitSessionGoalPause, markExplicitSessionGoalPause, readCodexSessionGoals } from "./codexSessionGoals";
import { getCodexHomeStateKey } from "../codex/authFile";
import { isCodexCapacityInterruption, isCodexQuotaInterruption } from "../domain/codexSessionState";
import { getNativeCodexSessionRunning, readNativeCodexSessionRunning, startNativeCodexSessionTurn, cancelNativeCodexSessionTurn, waitForNativeCodexSessionReady } from "./codexNativeSessionStatus";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { execFile, spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readSubAgentMetadata, type SubAgentMetadata } from "../domain/sessionSource";
import { prepareChatInput, readChatTextAttachments, withoutChatTextAttachments, type ChatAttachment } from "../domain/chatAttachments";
import { appServerChatInput } from "./codexChatAttachments";
import { CodexAppServerRpc, CodexAppServerTurnInterruptedError, CodexAppServerDisconnectedError } from "./codexAppServerRpc";
import { attachCodexAppServerPrompts, cancelCodexAppServerPrompts } from "./codexAppServerPrompts";
import { getCodexSessionLiveState, reserveCodexSessionLive } from "./codexSessionLive";
import { recordNativeSessionStatus, recordSessionLive } from "./sessionRecording";
import { publishDashboardRealtime } from "./dashboardRealtime";
import { readRunningTurnRows, saveRunningTurnRows, readSessionDiscovery, saveSessionDiscovery, readSessionStatuses, readSessionCatalogue, saveSessionCatalogue, invalidateSessionCatalogue, removeDeletedSessionCache } from "../storage/sqliteSessions";
import type {
  DashboardCliComposerConfig,
  DashboardCliSessionMessage,
  DashboardCliSessionSummary,
  DashboardCliSandboxMode
} from "../domain/dashboard/types";
import { runCrossWindowExclusive, runCrossWindowSharedRead, sharedResourceKey } from "../utils/crossWindowOperations";
import { recordPersistentEvent } from "../utils/persistentLog";
import { readSafeFileSnapshot } from "../utils/safeFileReads";
import { getCodexManagerStorageRoot } from "../utils/storageRoot";
import { createSharedInspection, runWithConcurrencyLimit, waitWithin } from "../utils/concurrency";
import { getSqliteStateStore, hasSqliteStateFile, readSqliteStateFile, sqliteStoreForFile, type SqliteStateStore } from "../storage/sqliteState";
import { normalizeNativePath } from "../utils/nativePaths";
import { readQueuedCodexSessionPreferences, readCodexSessionPreferences, readCodexSessionTitleOverrides, writeCodexSessionPreference, writeCodexSessionTitleOverride, reconcileCodexSessionTitles, markCodexSessionManualStop, clearCodexSessionManualStop, retireCodexSessionQueue } from "./codexSessionPreferences";
import { isAutoResumeEnabled } from "../infrastructure/config/extensionSettings";
import { isSessionQueuePriority } from '../domain/sessionQueuePriority';

const CODEX_EXTENSION_ID = "openai.chatgpt";
const CODEX_CONVERSATION_VIEW_TYPE = "chatgpt.conversationEditor";
const CODEX_CONVERSATION_SCHEME = "openai-codex";
const CODEX_CONVERSATION_AUTHORITY = "route";
const SESSION_INDEX_FILE = "session_index.jsonl";
const RUNNING_TURNS_FILE = "codex-manager-running-turns.json";
const SESSION_DIRECTORY = "sessions";
const SESSION_LOCK_DIRECTORY = "thread-writer-locks";
const MAX_SESSION_INDEX_BYTES = 5 * 1024 * 1024;
const MAX_SESSION_TRANSCRIPT_READ_BYTES = 25 * 1024 * 1024;
const MAX_VISIBLE_CLI_SESSIONS = 10_000;
const SESSION_TRANSCRIPT_DETAIL_LIMIT = 200;
const MAX_VISIBLE_SESSION_MESSAGES = 250;
const MAX_TRANSCRIPT_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_MESSAGE_CHARS = 12_000;
const MAX_SESSION_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_IMAGE_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_SCAN_ENTRIES = 10_000;
const MAX_MODELS_CACHE_BYTES = 5 * 1024 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_CLI_PROMPT_CHARS = 64_000;
const CLI_TURN_TIMEOUT_MS = 15 * 60 * 1000;
export const SESSION_DISCOVERY_RETRY_GAP_MS = 30_000;
const MAX_TRACKED_CLI_TURNS = 30;
const MAX_RUNNING_TURNS_BYTES = 256 * 1024;
const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const APP_SERVER_MODEL_LIST_TIMEOUT_MS = 5_000;
const CLI_AVAILABILITY_TIMEOUT_MS = 10_000;
const CLI_AVAILABILITY_CACHE_TTL_MS = 60_000;
const CLI_UNAVAILABLE_CACHE_TTL_MS = 5_000;
const CLI_MODEL_LIST_CACHE_TTL_MS = 60_000;
const CLI_MODEL_LIST_FAILURE_TTL_MS = 5_000;
export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const editorOpens = new Map<string, Promise<void>>();
const catalogueRefreshes = new Map<string, Promise<DashboardCliSessionSummary[]>>();
// Codex model IDs may be provider-qualified (for example 9router's
// `cx/gpt-5.2-codex`). They are passed as argv values, never shell text.
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;
const REASONING_EFFORT_PATTERN = /^(minimal|low|medium|high|xhigh|max|ultra)$/;
const recentNewSessions = new Map<string, { summary: DashboardCliSessionSummary; text: string }>();
const newSessionFailures = new Map<string, Error>();
const activeAppServerTurns = new Map<string, { rpc: CodexAppServerRpc; turnId?: string; cancelRequested?: boolean; stop?: Promise<boolean> }>();
const activeNativeTurns = new Map<string, { home: string; turnId: string; streamId: string; stop?: Promise<boolean> }>();
const nativeTurnObservers = new Map<string, Promise<void>>();
const maintenanceConnection = new AsyncLocalStorage<{ home: string; ids: Set<string>; rpc?: Promise<CodexAppServerRpc> }>();

/** Reuse one native process for a bounded cleanup job, never for session turns. */
export async function withCodexSessionMaintenance<T>(ids: string[], task: () => Promise<T>): Promise<T> {
  ids.forEach(validateSessionId);
  const context = { home: resolveCodexHome(), ids: new Set(ids), rpc: undefined as Promise<CodexAppServerRpc> | undefined };
  return maintenanceConnection.run(context, async () => {
    try { return await task(); }
    finally { if (context.rpc) await context.rpc.then(rpc => rpc.close(), () => undefined); }
  });
}

function ownedNativeTurn(home: string, id: string) {
  const turn = activeNativeTurns.get(id);
  return turn?.home === path.resolve(home) ? turn : undefined;
}

function ownsSessionTurn(home: string, id: string): boolean {
  return activeAppServerTurns.has(id) || Boolean(ownedNativeTurn(home, id));
}

function nativeTurnStarted(home: string, id: string, turnId: string): void {
  activeNativeTurns.set(id, { home: path.resolve(home), turnId, streamId: randomUUID() });
  publishNativeTurnState(home, id, "running", turnId);
}

function publishNativeTurnState(home: string, sessionId: string, status: "running" | "completed" | "cancelled" | "failed" | "disconnected", turnId?: string, streamId?: string): void {
  if (home !== resolveCodexHome()) return;
  let updatedAt = Date.now();
  try { updatedAt = Math.max(updatedAt, (getCodexSessionLiveState(sessionId)?.updatedAt ?? 0) + 1); }
  catch (error) { recordPersistentEvent("debug", "session-resume", "Earlier live state unavailable for native update", { sessionRef: toSessionLogRef(sessionId) }, error); }
  const state = { sessionId, streamId: streamId ?? ownedNativeTurn(home, sessionId)?.streamId ?? randomUUID(), sequence: status === "running" ? 1 : 2, status, turnId, updatedAt, messages: [] };
  try { recordSessionLive(state); }
  catch (error) { recordPersistentEvent("warning", "session-resume", "Native update could not be saved", { sessionRef: toSessionLogRef(sessionId) }, error); }
  publishDashboardRealtime({ type: "dashboard:codex-session-live", state });
}
let cliAvailabilityCache: { key: string; available: boolean; checkedAt: number } | undefined;
let cliAvailabilityProbe: Promise<boolean> | undefined;
let cliAvailabilityProbeKey: string | undefined;
let cliModelListCache:
  { codexHome: string; models: DashboardCliComposerConfig["models"]; fetchedAt: number } | undefined;
let cliModelListProbe: Promise<DashboardCliComposerConfig["models"]> | undefined;
let cliModelListProbeHome: string | undefined;
type CliTranscriptMessageCache = {
  size: number;
  mtimeMs: number;
  offset: number;
  remainder: Buffer;
  nextSequence: number;
  messages: DashboardCliSessionMessage[];
  windowed: boolean;
  currentTurnId?: string;
};
type CliTranscriptReadResult = {
  messages: DashboardCliSessionMessage[];
  transcriptBytes: number;
  bytesRead: number;
  cacheHit: boolean;
  partialLine: boolean;
  windowed: boolean;
};
const cliTranscriptMessageCache = new Map<string, CliTranscriptMessageCache & { retainedBytes: number }>();
const cliTranscriptMetadataCache = new Map<
  string,
  {
    projectPath?: string;
    sessionSurface?: DashboardCliSessionSummary["sessionSurface"];
    subAgent?: boolean;
    parentSessionId?: string;
    agentName?: string;
    expiresAt: number;
  }
>();
const CLI_TRANSCRIPT_METADATA_CACHE_TTL_MS = 60_000;
// Summary and message reads commonly arrive together. Reusing the bounded
// directory index avoids rescanning a large session tree for each read while
// keeping new transcripts visible after a short refresh window.
const CLI_TRANSCRIPT_PATH_CACHE_TTL_MS = 3_000;
const cliTranscriptPathCache = new Map<string, { checkedAt: number; signature: string; complete: boolean; covered: Set<string>; paths: Map<string, string> }>();
let cliExecutableCache: { signature: string; executable: CodexCliExecutable; resolvedAt: number } | undefined;

export class CodexCliTurnCancelledError extends Error {
  constructor() {
    super("Codex stopped this turn before it completed.");
    this.name = "CodexCliTurnCancelledError";
  }
}

export type TrackedCliTurn = {
  id: string;
  projectPath: string;
  startedAt: number;
  ownerPid?: number;
  childPid?: number;
  observedRunning?: boolean;
};

type CliSessionIndexEntry = { id: string; thread_name?: string; updated_at?: string };

/** Read local Codex session metadata without resuming or subscribing to a thread. */
export async function readCodexCliSessions(
  codexHome = resolveCodexHome(),
  limit = MAX_VISIBLE_CLI_SESSIONS,
  force = false
): Promise<DashboardCliSessionSummary[]> {
  // Keep discovery local so dashboard load never starts a second app-server
  // that can compete with Codex while it is opening and replaying history.
  const store = getSqliteStateStore();
  if (!store || limit !== MAX_VISIBLE_CLI_SESSIONS) return readLocalSessionList(codexHome, limit);
  try {
    const cached = force ? undefined : readSessionCatalogue(store, codexHome);
    const generation = cached?.generation ?? invalidateSessionCatalogue(store, codexHome, force);
    const key = `${getCodexHomeStateKey(codexHome)}:${generation}`;
    const refresh = () => {
      const pending = catalogueRefreshes.get(key);
      if (pending) return pending;
      if (catalogueRefreshes.size >= 8) return Promise.reject(new Error("Session history refresh is busy. Saved history was kept; retry shortly."));
      const startedAt = Date.now();
      const work = fs.access(codexHome).then(() => readLocalSessionList(codexHome, limit, generation)).then(rows => {
        try { saveSessionCatalogue(store, codexHome, generation, rows, startedAt); }
        catch (error) { recordPersistentEvent("warning", "session-list", "Session cache could not be saved; live history remains available", undefined, error); }
        return withCurrentSessionStatuses(store,codexHome,rows);
      }).finally(() => { if (catalogueRefreshes.get(key) === work) catalogueRefreshes.delete(key); });
      catalogueRefreshes.set(key, work);
      return work;
    };
    if (!force && cached && !cached.invalidated) {
      const stale = Date.now() - cached.checkedAt >= 5_000 || cached.bootAt < Date.now() - os.uptime() * 1000 - 60_000;
      if (stale) void refresh().catch(error => recordPersistentEvent("warning", "session-list", "Saved history retained while discovery retries", undefined, error));
      return withCurrentSessionStatuses(store,codexHome,cached.rows,stale);
    }
    return refresh();
  } catch (error) {
    recordPersistentEvent("warning", "session-list", "Session cache unavailable; reading local history", undefined, error);
    return readLocalSessionList(codexHome, limit);
  }
}

function withCurrentSessionStatuses(store:SqliteStateStore,home:string,rows:DashboardCliSessionSummary[],stale = false): DashboardCliSessionSummary[] {
  const statuses = readSessionStatuses(store,home);
  const preferences = readCodexSessionPreferences(home, rows.map(row => row.id));
  const titles = readCodexSessionTitleOverrides(home, rows.map(row => row.id));
  const autoResume = isAutoResumeEnabled();
  return rows.map(row => {
    const preference = preferences.get(row.id);
    const decorated: DashboardCliSessionSummary = { ...row, title: titles.get(row.id) ?? row.title };
    delete decorated.autoResumeEnabled; delete decorated.queueEnabled; delete decorated.queuePriority; delete decorated.queueError;
    if (autoResume || preference?.autoResume !== undefined) decorated.autoResumeEnabled = (autoResume || preference?.autoResume === true) && preference?.autoResume !== false;
    if (preference?.queue === true) {
      decorated.queueEnabled = true;
      decorated.queuePriority = preference.priority ?? 3;
      decorated.queueError = preference.queueError ?? (preference.queueClaimedAt ? 'A queued start was not confirmed. Review the session before requeuing.' : undefined);
    }
    if (row.archived) return decorated;
    const native = getNativeCodexSessionRunning(home,row.id);
    const current = native === undefined ? statuses.get(row.id) : native ? "running" : "idle";
    if (current === undefined && (!stale || row.status !== "running")) return decorated;
    const status = current === "starting" ? "unknown" : current ?? "unknown";
    if (status !== "running" && status !== "idle" && status !== "unknown") return decorated;
    const canStop = status === "running" && ownsSessionTurn(home,row.id);
    return { ...decorated,status,canStop,locked:status !== "idle",
      statusError:status === "unknown" ? row.statusError ?? "Checking saved running activity. Refresh before sending." : undefined,
      runningBy:status === "running" ? canStop ? "Codex Manager" : "another Codex process" : undefined,
      runningSince:status === "running" ? row.runningSince : undefined,
      interrupted:status === "running" ? false : row.interrupted };
  });
}

async function readLocalSessionList(codexHome: string, limit: number, generation = ""): Promise<DashboardCliSessionSummary[]> {
  return runCrossWindowSharedRead(sharedResourceKey("local-session-list", [getCodexHomeStateKey(codexHome), limit, generation]), "Local session discovery", () => readLocalSessionListInternal(codexHome, limit, generation));
}

async function readLocalSessionListInternal(codexHome: string, limit: number, generation: string): Promise<DashboardCliSessionSummary[]> {
  const startedAt = Date.now();
  let statusError: string | undefined;
  const state = await readStateSessionRecords(codexHome, undefined, undefined, MAX_VISIBLE_CLI_SESSIONS, true);
  const index = await readCodexCliSessionIndex(codexHome).catch((error: unknown) => {
    if (!state.length || generation) throw error;
    statusError = `The session index is unavailable; some history may be missing. ${error instanceof Error ? error.message : String(error)}`;
    recordPersistentEvent("warning", "session-list", "Session index unavailable; reading state metadata", { reason: error instanceof Error ? error.message : String(error) });
    return [] as CliSessionIndexEntry[];
  });
  const records = new Map(state.map((record) => [record.id, record]));
  const entries = new Map(index.map((entry) => [entry.id, entry]));
  for (const record of state) entries.set(record.id, mergeSessionIndexEntry(record, entries.get(record.id)));
  const runningIds = new Set(await readRunningCodexSessionIds(codexHome).catch((error: unknown) => {
    statusError = (error instanceof Error ? error.message : String(error)) || "Session inspection failed.";
    recordPersistentEvent("warning", "session-list", "Running state unavailable; showing local history", { reason: statusError });
    return [];
  }));
  for (const id of runningIds) if (!entries.has(id)) entries.set(id, { id });
  if (!entries.size) return [];
  const archivedIds = await readArchivedSessionIds(codexHome);
  for (const record of state) { if (record.archived) archivedIds.add(record.id); else if (record.archived === false) archivedIds.delete(record.id); }
  const cappedLimit = Math.max(1, Math.min(MAX_VISIBLE_CLI_SESSIONS, Math.round(limit) || MAX_VISIBLE_CLI_SESSIONS));
  const ordered = [...entries.values()].sort((a, b) => Number(runningIds.has(b.id)) - Number(runningIds.has(a.id)) || String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  const child = (entry: CliSessionIndexEntry): boolean => Boolean(readSubAgentMetadata(records.get(entry.id)?.source).subAgent);
  const visibleEntries = [...ordered.filter((entry) => !child(entry) && !archivedIds.has(entry.id)).filter((entry, index) => runningIds.has(entry.id) || index < cappedLimit), ...ordered.filter((entry) => !child(entry) && archivedIds.has(entry.id)).slice(0, cappedLimit), ...ordered.filter(child).filter((entry, index) => runningIds.has(entry.id) || index < cappedLimit)];
  const detailedIds = new Set(visibleEntries.filter((entry, index) => index < SESSION_TRANSCRIPT_DETAIL_LIMIT || runningIds.has(entry.id) || !records.has(entry.id)).map(entry => entry.id));
  const transcriptPaths = await findCliSessionTranscripts(codexHome, detailedIds);
  const deleted = statusError ? [] : visibleEntries.filter(entry => !records.has(entry.id) && !transcriptPaths.has(entry.id) && !runningIds.has(entry.id)).map(entry => entry.id);
  const deletedIds = new Set(deleted);
  const goals = await readCodexSessionGoals(codexHome, visibleEntries.map(entry => entry.id));
  const summaries: DashboardCliSessionSummary[] = [];
  await runWithConcurrencyLimit(visibleEntries, 32, async (entry, index) => {
    if (deletedIds.has(entry.id)) return;
    const record = records.get(entry.id);
    if (record && !detailedIds.has(entry.id)) {
      summaries[index] = { id: entry.id, title: normalizeSessionTitle(entry.thread_name, entry.id), projectPath: record.cwd,
        model: record.model, reasoningEffort: record.reasoningEffort, updatedAt: record.updatedAt, archived: archivedIds.has(entry.id),
        status: statusError ? "unknown" : "idle", statusError, locked: Boolean(statusError), canStop: false,
        ...(goals ? { goal: goals.get(entry.id) ?? null } : {}), ...readSubAgentMetadata(record.source) };
      return;
    }
    const summary = await toCliSessionSummary(codexHome, entry, archivedIds.has(entry.id), transcriptPaths.get(entry.id),
      statusError ? { status: "unknown", statusError } : transcriptPaths.has(entry.id) || runningIds.has(entry.id) ? { status: runningIds.has(entry.id) ? "running" : "idle" } : undefined);
    const turnState = cliTranscriptTurnStateCache.get(transcriptPaths.get(entry.id) ?? "")?.state;
    summaries[index] = { ...summary, model: summary.model ?? record?.model, reasoningEffort: summary.reasoningEffort ?? record?.reasoningEffort,
      interrupted: turnState && turnState !== "unknown" ? summary.status !== "running" && (["active", "failed", "quota-paused"].includes(turnState) || cliTranscriptTurnStateCache.get(transcriptPaths.get(entry.id) ?? "")?.cancelled === true) : undefined,
      ...(goals ? { goal: goals.get(entry.id) ?? null } : {}), ...readSubAgentMetadata(record?.source), ...(!summary.projectPath && record?.cwd ? { projectPath: record.cwd } : {}) };
  });
  const store = getSqliteStateStore();
  if (!statusError && store && generation && deleted.length) {
    try { removeDeletedSessionCache(store, codexHome, deleted, generation, startedAt); }
    catch (error) { recordPersistentEvent("warning", "session-list", "Deleted session cache cleanup deferred", undefined, error); }
  }
  const preferences = readCodexSessionPreferences(codexHome, summaries.filter(Boolean).map((summary) => summary.id));
  const titleOverrides = reconcileCodexSessionTitles(codexHome, summaries.filter(Boolean));
  const autoResume = isAutoResumeEnabled();
  return summaries.filter(Boolean).map((summary) => {
    const preference = preferences.get(summary.id);
    return { ...summary, title: titleOverrides.get(summary.id) ?? summary.title,
      ...(autoResume || preference?.autoResume !== undefined ? { autoResumeEnabled: (autoResume || preference?.autoResume === true) && preference?.autoResume !== false } : {}),
      ...(preference?.queue === true ? { queueEnabled: true, queuePriority: preference.priority ?? 3, queueError: preference.queueError ?? (preference.queueClaimedAt ? 'A queued start was not confirmed. Review the session before requeuing.' : undefined) } : {}),
    };
  });
}

type StateSessionRecord = { id: string; title?: string; model?: string; reasoningEffort?: string; updatedAt?: string; archived?: boolean; source?: unknown; cwd?: string; rolloutPath?: string };
async function readStateSessionRecords(home: string, id?: string | string[], projectRoots?: string[], limit = MAX_VISIBLE_CLI_SESSIONS, strict = false): Promise<StateSessionRecord[]> {
  let db: { prepare(sql: string): { all(...args: string[]): Record<string, unknown>[] }; close(): void } | undefined;
  try {
    const names = (await fs.readdir(home).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; })).filter((name) => /^state_[0-9]+\.sqlite$/.test(name));
    names.sort((a, b) => Number(b.match(/[0-9]+/)?.[0]) - Number(a.match(/[0-9]+/)?.[0]));
    if (!names[0]) return [];
    const moduleName = "node:sqlite";
    const sqlite = await import(moduleName) as { DatabaseSync: new (file: string, options: { readOnly: boolean }) => NonNullable<typeof db> };
    db = new sqlite.DatabaseSync(path.join(home, names[0]), { readOnly: true });
    if (projectRoots) {
      try {
        for (const row of db.prepare("SELECT path FROM project_roots ORDER BY project_id, position LIMIT 2000").all())
          if (typeof row["path"] === "string") projectRoots.push(normalizeNativePath(row["path"]));
      } catch { /* Older Codex stores projects only in thread metadata. */ }
    }
    const available = new Set(db.prepare("PRAGMA table_info(threads)").all().map(row => row["name"]));
    const columns = ["id", "title", "model", "reasoning_effort", "updated_at", "archived", "source", "cwd", "rollout_path"].filter(column => available.has(column));
    if (!available.has("id")) { if (strict) throw new Error("Codex session metadata is unavailable. Saved history was retained."); return []; }
    const query = `SELECT ${columns.join(", ")} FROM threads`;
    const rows = Array.isArray(id) ? (id.length ? db.prepare(`${query} WHERE id IN (${id.map(() => "?").join(",")})`).all(...id) : [])
      : id ? db.prepare(`${query} WHERE id = ?`).all(id)
      : db.prepare(`${query}${available.has("updated_at") ? " ORDER BY updated_at DESC" : ""} LIMIT ${Math.max(1, Math.min(10001, Math.floor(limit)))}`).all();
    return rows.flatMap((row) => {
      if (typeof row["id"] !== "string" || !SESSION_ID_PATTERN.test(row["id"])) return [];
      return [{ id: row["id"], title: typeof row["title"] === "string" ? row["title"] : undefined,
        model: typeof row["model"] === "string" ? row["model"].slice(0, 256) : undefined,
        reasoningEffort: typeof row["reasoning_effort"] === "string" ? row["reasoning_effort"].slice(0, 64) : undefined,
        updatedAt: typeof row["updated_at"] === "number" && Number.isFinite(row["updated_at"]) ? new Date(row["updated_at"] * 1000).toISOString() : undefined,
        archived: row["archived"] === 1 ? true : row["archived"] === 0 ? false : undefined, source: row["source"], cwd: typeof row["cwd"] === "string" ? normalizeNativePath(row["cwd"]) : undefined,
        rolloutPath: typeof row["rollout_path"] === "string" && row["rollout_path"].length <= 4096 ? normalizeNativePath(row["rollout_path"]) : undefined }];
    });
  } catch (error) { if (strict) throw error; return []; } // Optional metadata; old hosts and unavailable databases use JSONL.
  finally { db?.close(); }
}

/** Explicit maintenance reads all native rows before offering a destructive preview. */
export async function readCodexSessionMaintenanceCandidates(home = resolveCodexHome()): Promise<Array<{ id: string; title: string; archived: boolean; projectPath?: string; transcriptPath?: string; parentSessionId?: string; model?: string; updatedAt?: string }>> {
  const records = await readStateSessionRecords(home, undefined, undefined, 10001, true);
  if (records.length > 10000) throw new Error("More than 10,000 chats need cleanup. Reduce the history in Codex before retrying.");
  const index = await readCodexCliSessionIndex(home);
  if (index.length > 10000) throw new Error("The session history is too large for one cleanup. Reduce it in Codex before retrying.");
  const result = new Map(records.map(row => [row.id, { id: row.id, title: normalizeSessionTitle(row.title, row.id), archived: row.archived === true, projectPath: row.cwd, transcriptPath: row.rolloutPath, parentSessionId: readSubAgentMetadata(row.source).parentSessionId, model: row.model, updatedAt: row.updatedAt }]));
  const missing = index.filter(row => !result.has(row.id));
  if (result.size + missing.length > 10000) throw new Error("The session history is too large for one cleanup. Reduce it in Codex before retrying.");
  const archived = missing.length || records.some(row => row.archived === undefined) ? await readArchivedSessionIds(home) : new Set<string>();
  for (const row of records) if (row.archived === undefined) result.get(row.id)!.archived = archived.has(row.id);
  const paths = missing.length ? await findCliSessionTranscripts(home, new Set(missing.map(row => row.id))) : new Map<string, string>();
  for (const row of missing) {
    const transcriptPath = paths.get(row.id), metadata = await readCliSessionMetadata(home, row.id, transcriptPath);
    result.set(row.id, { id: row.id, title: normalizeSessionTitle(row.thread_name, row.id), archived: archived.has(row.id), projectPath: metadata.projectPath, transcriptPath, parentSessionId: metadata.parentSessionId, model: undefined, updatedAt: normalizeTimestamp(row.updated_at) });
  }
  return [...result.values()];
}

export async function clearCodexSessionGoal(sessionId: string): Promise<void> {
  validateSessionId(sessionId);
  await runCliSessionMutation(sessionId, "Clear Codex goal", async () => {
    if (await isCliSessionRunning(resolveCodexHome(), sessionId)) throw new Error("This conversation is running. Stop it before clearing its goal.");
    await runCodexAppServerRequest("thread/goal/clear", { threadId: sessionId });
  });
}

/** Explicit goal controls can pause a running owner without waiting for its turn lease. */
export async function setCodexSessionGoalStatus(sessionId: string, status: "active" | "paused"): Promise<void> {
  validateSessionId(sessionId);
  if (status !== "active" && status !== "paused") throw new Error("Choose Pause or Resume for this goal.");
  await runCrossWindowExclusive(`codex:goal:${sessionId.toLowerCase()}`, "Update Codex goal", async () => {
    const params = { threadId: sessionId, status, origin: "automatic" };
    const rpc = activeAppServerTurns.get(sessionId)?.rpc;
    const result = rpc ? await rpc.request<{ goal?: { status?: string } }>("thread/goal/set", params) :
      await runCodexAppServerRequest<{ goal?: { status?: string } }>("thread/goal/set", params);
    if (result.goal?.status !== status) throw new Error("Codex did not confirm the goal change. Refresh before retrying.");
    if (status === "paused") markExplicitSessionGoalPause(resolveCodexHome(), sessionId);
    else {
      clearExplicitSessionGoalPause(resolveCodexHome(), sessionId);
      clearCodexSessionManualStop(resolveCodexHome(), sessionId);
    }
  });
}

export type CodexSessionRecoveryMetadata = { title?: string; projectPath?: string; updatedAt: number };

/** Recovery capture reads local metadata without runtime inspection or an app server. */
export async function readCodexCliSessionRecoveryMetadata(ids: string[], home = resolveCodexHome()): Promise<Record<string, CodexSessionRecoveryMetadata>> {
  ids.forEach(validateSessionId);
  if (!ids.length) return {};
  const state = await readStateSessionRecords(home, ids);
  const titled = new Set(state.filter(record => normalizeSessionTitle(record.title,record.id) !== "Untitled conversation").map(record => record.id));
  const index = ids.every(id => titled.has(id)) ? [] : await readCodexCliSessionIndex(home);
  const wanted = new Set(ids);
  const titles: Record<string, CodexSessionRecoveryMetadata> = {};
  for (const entry of index) {
    if (wanted.has(entry.id) && entry.thread_name?.trim()) titles[entry.id] = { ...titles[entry.id], title: entry.thread_name.trim().slice(0, 256), updatedAt: Date.now() };
  }
  for (const record of state) titles[record.id] = { ...titles[record.id], title: record.title?.trim() && normalizeSessionTitle(record.title, record.id) !== "Untitled conversation" ? record.title.trim().slice(0, 256) : titles[record.id]?.title, projectPath: record.cwd, updatedAt: Date.now() };
  for (const id of ids) {
    const recent = recentNewSessions.get(id)?.summary.title;
    if (recent?.trim() && !titles[id]?.title) titles[id] = { title: recent.trim().slice(0, 256), projectPath: recentNewSessions.get(id)?.summary.projectPath, updatedAt: Date.now() };
    if (titles[id]?.title) titles[id]!.title = normalizeSessionTitle(titles[id]!.title, id);
  }
  return titles;
}

export async function readCodexCliSessionSummary(
  sessionId: string,
  codexHome = resolveCodexHome()
): Promise<DashboardCliSessionSummary | undefined> {
  validateSessionId(sessionId);
  const recent = recentNewSessions.get(sessionId)?.summary;
  if (recent && ownsSessionTurn(codexHome, sessionId)) return recent;
  const state = (await readStateSessionRecords(codexHome, sessionId))[0];
  const indexed = (await readCodexCliSessionIndex(codexHome).catch(error => { if (!state) throw error; return [] as CliSessionIndexEntry[]; })).find(candidate => candidate.id === sessionId);
  const entry = state ? mergeSessionIndexEntry(state, indexed) : indexed;
  if (!entry) {
    const recent = recentNewSessions.get(sessionId)?.summary;
    return recent ? { ...recent, status: ownsSessionTurn(codexHome, sessionId) ? "running" : "idle", canStop: ownsSessionTurn(codexHome, sessionId) } : (await readCodexCliSessions(codexHome)).find(session => session.id === sessionId);
  }
  const transcriptPath = (await findCliSessionTranscripts(codexHome, new Set([sessionId]))).get(sessionId);
  const archiveRelative = transcriptPath ? path.relative(path.join(codexHome, "archived_sessions"), transcriptPath) : undefined;
  const archived = state?.archived ?? Boolean(archiveRelative && !path.isAbsolute(archiveRelative) && archiveRelative !== ".." && !archiveRelative.startsWith(`..${path.sep}`));
  const summary = await toCliSessionSummary(codexHome, entry, archived, transcriptPath);
  const goals = await readCodexSessionGoals(codexHome, [sessionId]);
  const title = reconcileCodexSessionTitles(codexHome, [summary]).get(sessionId) ?? summary.title;
  return { ...summary, title, model: summary.model ?? state?.model, reasoningEffort: summary.reasoningEffort ?? state?.reasoningEffort, ...(goals ? { goal: goals.get(sessionId) ?? null } : {}), ...readSubAgentMetadata(state?.source), ...(!summary.projectPath && state?.cwd ? { projectPath: state.cwd } : {}) };
}

/** Archived cleanup must work even when the native renderer cannot answer IPC. */
export async function readCodexArchiveMaintenanceState(sessionId: string, home = resolveCodexHome()): Promise<{ archived: boolean; status: "idle" | "running" | "unknown" } | undefined> {
  validateSessionId(sessionId);
  const record = (await readStateSessionRecords(home, sessionId, undefined, 1, true))[0];
  if (!record || record.archived === undefined) {
    const legacy = await readCodexCliSessionSummary(sessionId, home);
    return legacy ? { archived: legacy.archived === true, status: legacy.status } : undefined;
  }
  if (!record.archived) return { archived: false, status: "running" };
  if (ownsSessionTurn(home, sessionId) || getNativeCodexSessionRunning(home, sessionId) === true)
    return { archived: true, status: "running" };
  const lock = path.join(home, SESSION_LOCK_DIRECTORY, `${sessionId}.lock`);
  const stat = await fs.lstat(lock).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("The session writer lock is invalid. This conversation was kept.");
  const running = Boolean(stat && await isWriterLockHeld(lock));
  const current = (await readStateSessionRecords(home, sessionId, undefined, 1, true))[0];
  return current ? { archived: current.archived === true, status: running || !current.archived ? "running" : "idle" } : undefined;
}

/** Read every currently running, unarchived local session without the dashboard's display limit. */
const recentRunningSessions = new Map<string, { ids: string[]; checkedAt: number; revision?: number }>();
const runningSessionListeners = new Set<(home: string) => void>();

export function readRunningCodexSessionIds(codexHome = resolveCodexHome(), signal?: AbortSignal, sessionIds?: string[]): Promise<string[]> {
  sessionIds?.forEach(validateSessionId);
  const key = path.resolve(codexHome);
  const snapshotKey = runningSessionSnapshotKey(codexHome, sessionIds);
  return createSharedInspection(`codex-running:${snapshotKey}`, async inspectionSignal => {
    const startedAt = Date.now();
    const ids = await inspectRunningCodexSessionIds(codexHome, inspectionSignal, sessionIds);
    inspectionSignal.throwIfAborted();
    const store = getSqliteStateStore();
    if (store && !sessionIds) {
      try { saveSessionDiscovery(store,codexHome,ids,startedAt); }
      catch (error) { console.warn("[codexManager] shared session discovery cache could not be saved",error); }
    }
    recentRunningSessions.set(snapshotKey, { ids: [...ids], checkedAt: Date.now(), revision: store?.revision("session-status") });
    if (recentRunningSessions.size > 8) recentRunningSessions.delete(recentRunningSessions.keys().next().value!);
    for (const listener of runningSessionListeners) {
      try { listener(key); } catch (error) { console.warn("[codexManager] session recovery could not be scheduled", error); }
    }
    return ids;
  }, signal);
}

function runningSessionSnapshotKey(home: string, ids?: string[]): string {
  return JSON.stringify([path.resolve(home), ids ? [...new Set(ids)].sort() : null]);
}

/** Reload recovery can reuse checks completed before quota exhaustion; safety checks stay fresh. */
export function readRecentRunningCodexSessionIds(codexHome = resolveCodexHome(), sessionIds?: string[]): string[] | undefined {
  let full = recentRunningSessions.get(runningSessionSnapshotKey(codexHome));
  const store = getSqliteStateStore();
  let revision: number | undefined;
  if (store) {
    try {
      revision = store.revision("session-status");
      if (sessionIds) {
        const statuses = readSessionStatuses(store,codexHome);
        if (sessionIds.every(id => statuses.has(id) && statuses.get(id) !== "unknown"))
          return sessionIds.filter(id => statuses.get(id) === "running" || statuses.get(id) === "starting");
      }
      const shared = readSessionDiscovery(store,codexHome);
      full = shared;
    } catch (error) { console.warn("[codexManager] shared session discovery cache could not be read",error); full = undefined; }
  }
  let scoped = sessionIds ? recentRunningSessions.get(runningSessionSnapshotKey(codexHome, sessionIds)) : undefined;
  if (store && (revision === undefined || scoped?.revision !== revision)) scoped = undefined;
  const snapshot = scoped && (!full || scoped.checkedAt >= full.checkedAt) ? scoped : full;
  const age = snapshot ? Date.now() - snapshot.checkedAt : Infinity;
  return snapshot && age >= 0 && age < 30_000 ? snapshot.ids.filter(id => !sessionIds || sessionIds.includes(id)) : undefined;
}

export function onDidInspectRunningCodexSessions(listener: (home: string) => void): vscode.Disposable {
  runningSessionListeners.add(listener);
  return { dispose: () => { runningSessionListeners.delete(listener); } };
}

async function inspectRunningCodexSessionIds(codexHome: string, signal?: AbortSignal, requestedIds?: string[]): Promise<string[]> {
  signal?.throwIfAborted();
  const lockDirectory = path.join(codexHome, SESSION_LOCK_DIRECTORY);
  const lockEntries = await fs.readdir(lockDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const lockedSessionIds = lockEntries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".lock"))
    .map((entry) => entry.name.slice(0, -".lock".length))
    .filter((sessionId) => SESSION_ID_PATTERN.test(sessionId))
    .slice(0, MAX_SESSION_SCAN_ENTRIES);
  const activeIds = path.resolve(codexHome) === path.resolve(resolveCodexHome())
    ? [...activeAppServerTurns.keys()] : [];
  const transcriptPaths = await findCliSessionTranscripts(codexHome, requestedIds ? new Set(requestedIds) : undefined, signal);
  const stateRecords = await readStateSessionRecords(codexHome);
  const sessionIds = requestedIds ? [...new Set(requestedIds)] : [...new Set([...lockedSessionIds, ...activeIds, ...transcriptPaths.keys()])];
  if (!sessionIds.length) {
    return [];
  }

  const archivedIds = await readArchivedSessionIds(codexHome, signal);
  const archiveRoot = path.join(codexHome, "archived_sessions") + path.sep;
  for (const [id, transcript] of transcriptPaths) if (transcript.startsWith(archiveRoot)) archivedIds.add(id);
  for (const record of stateRecords) { if (record.archived) archivedIds.add(record.id); else if (record.archived === false) archivedIds.delete(record.id); }
  const running = new Set<string>();
  // Native IPC may wait three seconds for an unloaded thread. Overlap bounded
  // reads so historical sessions cannot each consume the scan's deadline.
  await runWithConcurrencyLimit(sessionIds, 32, async (sessionId) => {
    signal?.throwIfAborted();
    if (archivedIds.has(sessionId)) {
      return;
    }
    const active = await isCliSessionRunning(codexHome, sessionId, transcriptPaths.get(sessionId), false, signal);
    recordNativeSessionStatus(codexHome,sessionId,active);
    if (active) {
      running.add(sessionId);
    }
  });
  return sessionIds.filter(id => running.has(id));
}

const sessionIndexCache = new Map<string, { signature: string; entries: CliSessionIndexEntry[] }>();
async function readCodexCliSessionIndex(codexHome: string): Promise<CliSessionIndexEntry[]> {
  const indexPath = path.join(codexHome, SESSION_INDEX_FILE);
  let signature: string;
  try { const stat = await waitWithin(fs.stat(indexPath), 1000, 'Session index metadata is still loading.'); signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') { sessionIndexCache.delete(indexPath); return []; } throw error; }
  const cached = sessionIndexCache.get(indexPath);
  if (cached?.signature === signature) return cached.entries;
  let snapshot;
  try {
    snapshot = await readSafeFileSnapshot(indexPath, {
      maxBytes: MAX_SESSION_INDEX_BYTES,
      rejectIfLarger: true
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    if ((error as Error)?.name === "SafeFileReadLimitError") {
      throw new Error("The session index is too large to read safely.");
    }
    throw error;
  }
  const raw = snapshot.buffer.toString("utf8");
  const entries = raw
    .split(/\r?\n/)
    .map(parseCliSessionEntry)
    .filter((entry): entry is CliSessionIndexEntry => Boolean(entry))
    .sort((left, right) => String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")));
  const unique = new Map<string, CliSessionIndexEntry>();
  for (const entry of entries) {
    if (!unique.has(entry.id)) unique.set(entry.id, entry);
  }

  const rows = [...unique.values()];
  if (sessionIndexCache.size >= 4) sessionIndexCache.delete(sessionIndexCache.keys().next().value!);
  sessionIndexCache.set(indexPath, { signature, entries: rows });
  return rows;
}

function mergeSessionIndexEntry(state: StateSessionRecord, indexed?: CliSessionIndexEntry): CliSessionIndexEntry {
  const indexTime = Date.parse(indexed?.updated_at ?? ''), stateTime = Date.parse(state.updatedAt ?? '');
  const newerIndex = Number.isFinite(indexTime) && (!Number.isFinite(stateTime) || indexTime > stateTime);
  return { id: state.id, thread_name: newerIndex ? normalizeSessionTitle(indexed?.thread_name, state.id, state.title) : normalizeSessionTitle(state.title, state.id, indexed?.thread_name), updated_at: newerIndex ? indexed?.updated_at : state.updatedAt ?? indexed?.updated_at };
}

export function getCodexSessionReadNotice(sessions: DashboardCliSessionSummary[] = []): { level: "warning"; message: string } | undefined {
  const unknown = sessions.find(session => session.status === "unknown");
  if (unknown) return { level: "warning", message: `Session history is available, but running state could not be verified. Refresh before sending. ${unknown.statusError ?? "Session inspection is unavailable."}` };
  return undefined;
}

async function toCliSessionSummary(
  codexHome: string,
  entry: CliSessionIndexEntry,
  archived: boolean,
  transcriptPath?: string,
  knownStatus?: Pick<DashboardCliSessionSummary, "status" | "statusError">
): Promise<DashboardCliSessionSummary> {
  const metadata = await readCliSessionMetadata(codexHome, entry.id, transcriptPath);
  const state = archived ? { status: "idle" as const } : knownStatus ?? await readCliSessionStatus(codexHome, entry.id, transcriptPath);
  const running = state.status === "running";
  const canStop = running && ownsSessionTurn(codexHome, entry.id);
  const startedAt = archived ? undefined : await readCliRunningSince(transcriptPath);
  const runningSince = running ? startedAt : undefined;
  const turnMetadata = transcriptPath ? cliTranscriptTurnStateCache.get(transcriptPath) : undefined;
  const turnState = transcriptPath ? cliTranscriptTurnStateCache.get(transcriptPath)?.state : undefined;
  const transcriptUpdatedAt = transcriptPath ? cliTranscriptTurnStateCache.get(transcriptPath)?.mtimeMs : undefined;
  const updatedAt = transcriptUpdatedAt && transcriptUpdatedAt > (Date.parse(entry.updated_at ?? "") || 0)
    ? new Date(transcriptUpdatedAt).toISOString() : normalizeTimestamp(entry.updated_at);
  return {
    id: entry.id,
    title: normalizeSessionTitle(entry.thread_name, entry.id),
    model: turnMetadata?.model,
    reasoningEffort: turnMetadata?.reasoningEffort,
    runningSince,
    interrupted: turnState && turnState !== "unknown" ? !running && (["active", "failed", "quota-paused"].includes(turnState) || turnMetadata?.cancelled === true) : undefined,
    updatedAt,
    ...state,
    ...(metadata.subAgent ? { subAgent: true, parentSessionId: metadata.parentSessionId, agentName: metadata.agentName } : {}),
    ...(metadata.projectPath ? { projectPath: metadata.projectPath } : {}),
    ...(metadata.sessionSurface ? { sessionSurface: metadata.sessionSurface } : {}),
    locked: running || state.status === "unknown",
    runningBy: running ? (canStop ? "Codex Manager" : "another Codex process") : undefined,
    canStop,
    archived
  };
}

async function readCliSessionMetadata(
  codexHome: string,
  sessionId: string,
  knownTranscriptPath?: string
): Promise<{ projectPath?: string; sessionSurface?: DashboardCliSessionSummary["sessionSurface"] } & SubAgentMetadata> {
  const transcriptPath = knownTranscriptPath ?? (await findCliSessionTranscript(codexHome, sessionId));
  if (!transcriptPath) return {};
  const metadataKey = path.resolve(transcriptPath);
  const cached = cliTranscriptMetadataCache.get(metadataKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }
  const raw = await readSafeFileSnapshot(transcriptPath, { maxBytes: 64 * 1024 })
    .then((snapshot) => snapshot.buffer.toString("utf8"))
    .catch(() => "");
  // The first record is normally `session_meta`, but Codex versions and
  // imported transcripts have used both nested and top-level project keys.
  // Read a small bounded prefix so a persisted project is still recoverable
  // after the dashboard is reopened without scanning the whole transcript.
  let projectPath: string | undefined;
  let sessionSurface: DashboardCliSessionSummary["sessionSurface"];
  let agentMetadata: SubAgentMetadata = {};
  for (const line of raw.split(/\r?\n/).slice(0, 12)) {
    try {
      const value = JSON.parse(line) as {
        cwd?: unknown;
        projectPath?: unknown;
        project_path?: unknown;
        workdir?: unknown;
        workspacePath?: unknown;
        originator?: unknown;
        source?: unknown;
        payload?: Record<string, unknown>;
      };
      const candidates: Array<Record<string, unknown>> = [value.payload ?? {}, value as Record<string, unknown>];
      for (const candidate of candidates) {
        agentMetadata = { ...agentMetadata, ...readSubAgentMetadata(candidate) };
        if (!sessionSurface) sessionSurface = resolveCliSessionSurface(candidate["originator"], candidate["source"]);
        for (const key of ["cwd", "projectPath", "project_path", "workdir", "workspacePath"]) {
          const candidatePath = candidate[key];
          if (!projectPath && typeof candidatePath === "string" && candidatePath.trim()) {
            projectPath = normalizeNativePath(candidatePath.trim().slice(0, 1024));
          }
        }
      }
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }
  // Session metadata can be one very large JSONL line when it embeds agent
  // instructions. Recover the early cwd field even if our bounded read ends
  // midway through that line.
  if (!projectPath) {
    const match = raw.match(/"(?:cwd|projectPath|project_path|workdir|workspacePath)"\s*:\s*("(?:\\.|[^"\\])*")/);
    if (match) {
      try { projectPath = normalizeNativePath((JSON.parse(match[1]!) as string).trim().slice(0, 1024)); } catch { /* malformed prefix */ }
    }
  }
  if (!agentMetadata.subAgent && /"source"\s*:\s*(?:\{\s*"sub[_-]?agent"|"sub[_-]?agent)/i.test(raw)) {
    const parent = raw.match(/"parent_thread_id"\s*:\s*"([0-9a-f-]{36})"/i)?.[1];
    const name = raw.match(/"agent_nickname"\s*:\s*"([^"\\]{1,160})"/)?.[1];
    agentMetadata = { subAgent: true, ...(parent ? { parentSessionId: parent } : {}), ...(name ? { agentName: name } : {}) };
  }
  const metadata = { projectPath, sessionSurface, ...agentMetadata, expiresAt: Date.now() + CLI_TRANSCRIPT_METADATA_CACHE_TTL_MS };
  cliTranscriptMetadataCache.set(metadataKey, metadata);
  while (cliTranscriptMetadataCache.size > 64) {
    const oldest = cliTranscriptMetadataCache.keys().next().value as string | undefined;
    if (!oldest) break;
    cliTranscriptMetadataCache.delete(oldest);
  }
  return metadata;
}

function resolveCliSessionSurface(originator: unknown, source: unknown): DashboardCliSessionSummary["sessionSurface"] {
  const sourceLabel = typeof source === "string" ? source.toLowerCase() : "";
  const originatorLabel = typeof originator === "string" ? originator.toLowerCase() : "";
  if (sourceLabel === "vscode" || originatorLabel.includes("vscode")) return "vscode";
  if (
    sourceLabel === "exec" ||
    sourceLabel === "cli" ||
    originatorLabel.includes("cli") ||
    originatorLabel.includes("sdk")
  )
    return "cli";
  return originatorLabel || sourceLabel ? "other" : undefined;
}

const knownProjectRoots = new Map<string, { roots: string[]; checkedAt: number }>();
const projectFolderReads = new Map<string, Promise<{ isDirectory(): boolean } | undefined>>();
async function readKnownProjectRoots(home: string, force = false): Promise<string[]> {
  const key = path.resolve(home), cached = knownProjectRoots.get(key);
  if (!force && cached && Date.now() - cached.checkedAt < 5000) return cached.roots;
  return createSharedInspection(`project-roots:${key}`, async () => {
    const deadline = Date.now() + 1500, roots: string[] = [];
    const records = await waitWithin(readStateSessionRecords(home, undefined, roots), 1500, 'Project discovery timed out. Reconnect storage and retry.');
    for (const record of records) if (record.cwd) roots.push(record.cwd);
    const unique = [...new Set(roots.filter(root => root.length <= 4096 && path.isAbsolute(root)).map(root => path.resolve(root)))];
    const available = new Set<string>();
    await runWithConcurrencyLimit(unique, 8, async root => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      let read = projectFolderReads.get(root);
      if (!read) {
        if (projectFolderReads.size >= 64) return;
        read = fs.stat(root).catch(() => undefined).finally(() => { if (projectFolderReads.get(root) === read) projectFolderReads.delete(root); });
        projectFolderReads.set(root, read);
      }
      const folder = await waitWithin(read, Math.min(400, remaining), 'Project folder is unavailable.').catch(() => undefined);
      if (folder?.isDirectory()) available.add(root);
    });
    const result = unique.filter(root => available.has(root));
    knownProjectRoots.set(key, { roots: result, checkedAt: Date.now() });
    if (knownProjectRoots.size > 8) knownProjectRoots.delete(knownProjectRoots.keys().next().value!);
    return result;
  });
}

export function readCodexCliComposerConfig(codexHome = resolveCodexHome()): Promise<DashboardCliComposerConfig> {
  const workspaces = (vscode.workspace.workspaceFolders ?? []).map(folder => [folder.uri.fsPath, folder.name]);
  return createSharedInspection(`composer-config:${JSON.stringify([path.resolve(codexHome), workspaces])}`, () => readCliComposerConfig(codexHome));
}

async function readCliComposerConfig(codexHome: string): Promise<DashboardCliComposerConfig> {
  const [modelsRaw, configRaw] = await Promise.all([
    readSmallOptionalFile(path.join(codexHome, "models_cache.json"), MAX_MODELS_CACHE_BYTES),
    readSmallOptionalFile(path.join(codexHome, "config.toml"), MAX_CONFIG_BYTES)
  ]);
  let models = parseCliModels(modelsRaw);
  // The local cache is the fast path. Newer Codex builds can expose a richer
  // live catalog through app-server (including provider-qualified IDs from
  // OpenAI-compatible routers such as 9router), so recover from that source
  // when the cache has not been created yet or contains no visible models.
  if (!models.length && path.resolve(codexHome) === path.resolve(resolveCodexHome())) {
    models = await readLiveCliModels(codexHome);
  }
  const configuredModel = readTomlString(configRaw, "model");
  const configuredEffort = readTomlString(configRaw, "model_reasoning_effort");
  const configuredSandbox = readTomlString(configRaw, "sandbox_mode");
  const projects = (vscode.workspace.workspaceFolders ?? []).map(folder => ({ id: folder.uri.fsPath, label: folder.name, path: folder.uri.fsPath }));
  for (const root of await readKnownProjectRoots(codexHome)) {
    const same = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (!projects.some(project => same(project.path) === same(root))) projects.push({ id: root, label: path.basename(root), path: root });
  }
  return {
    models,
    ...(projects.length ? { projects } : {}),
    defaultModel: models.some((model) => model.id === configuredModel) ? configuredModel : models[0]?.id,
    defaultReasoningEffort: REASONING_EFFORT_PATTERN.test(configuredEffort ?? "")
      ? configuredEffort
      : models[0]?.defaultReasoningEffort,
    defaultSandboxMode: isCliSandboxMode(configuredSandbox) ? configuredSandbox : "workspace-write"
  };
}

export async function sendCodexCliSessionMessage(options: {
  sessionId: string;
  text: string;
  attachments?: ChatAttachment[];
  model?: string;
  reasoningEffort?: string;
  sandboxMode?: DashboardCliSandboxMode;
  projectPath?: string;
  onStarted?: () => void;
  signal?: AbortSignal;
  clearManualStop?: boolean;
  interruptedOnly?: boolean;
}): Promise<void> {
  options.signal?.throwIfAborted();
  validateSessionId(options.sessionId);
  newSessionFailures.delete(options.sessionId);
  const prepared = prepareChatInput(options.text, options.attachments);
  const text = prepared.text;
  options = { ...options, ...prepared };
  if (!text) throw new Error("Write a message before sending it to Codex.");
  if (text.length > MAX_CLI_PROMPT_CHARS) {
    throw new Error(`The message is too long. Keep it under ${MAX_CLI_PROMPT_CHARS.toLocaleString()} characters.`);
  }
  if (options.model && !MODEL_ID_PATTERN.test(options.model)) throw new Error("The selected Codex model is invalid.");
  if (options.reasoningEffort && !REASONING_EFFORT_PATTERN.test(options.reasoningEffort)) {
    throw new Error("The selected reasoning effort is invalid.");
  }
  if (options.sandboxMode && !isCliSandboxMode(options.sandboxMode)) {
    throw new Error("The selected access mode is invalid.");
  }
  const cwd = await resolveRecordedSessionProject(options.sessionId, options.projectPath);
  options.signal?.throwIfAborted();
  if (options.clearManualStop) clearCodexSessionManualStop(resolveCodexHome(), options.sessionId);
  await sendAppServerSessionMessage(options, cwd);
}

async function readLiveCliModels(codexHome: string): Promise<DashboardCliComposerConfig["models"]> {
  const normalizedHome = path.resolve(codexHome);
  const now = Date.now();
  const cache = cliModelListCache;
  const cacheTtl = cache?.models.length ? CLI_MODEL_LIST_CACHE_TTL_MS : CLI_MODEL_LIST_FAILURE_TTL_MS;
  if (cache?.codexHome === normalizedHome && now - cache.fetchedAt < cacheTtl) return cache.models;
  if (cliModelListProbe && cliModelListProbeHome === normalizedHome) return cliModelListProbe;
  cliModelListProbeHome = normalizedHome;
  cliModelListProbe = (async () => {
    try {
      const response = await runCodexAppServerRequest<{ data?: unknown }>(
        "model/list",
        {
          includeHidden: false,
          limit: 100
        },
        APP_SERVER_MODEL_LIST_TIMEOUT_MS
      );
      return parseCliModels(JSON.stringify(response));
    } catch {
      // The composer can still open with an empty model list when the live
      // catalog is unavailable (for example while the CLI is signing in).
      return [];
    }
  })()
    .then((models) => {
      cliModelListCache = { codexHome: normalizedHome, models, fetchedAt: Date.now() };
      return models;
    })
    .finally(() => {
      cliModelListProbe = undefined;
      cliModelListProbeHome = undefined;
    });
  return cliModelListProbe;
}

export function startCodexCliSession(options: Parameters<typeof runNewCodexCliSession>[0]): Promise<string> {
  return new Promise((resolve, reject) => {
    let createdId: string | undefined;
    void runNewCodexCliSession(options, (id) => {
      createdId = id;
      newSessionFailures.delete(id);
      recentNewSessions.set(id, { summary: { id, title: options.text.trim().slice(0, 80) || "New Codex chat", model: options.model, reasoningEffort: options.reasoningEffort, runningSince: Date.now(), status: "running", canStop: true, runningBy: "Codex Manager", projectPath: resolveCliProjectPath(options.projectPath), updatedAt: new Date().toISOString(), archived: false }, text: options.text });
      if (recentNewSessions.size > 30) recentNewSessions.delete(recentNewSessions.keys().next().value!);
      resolve(id);
    }).then(resolve, (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!createdId) { reject(failure); return; }
      if (!(failure instanceof CodexCliTurnCancelledError)) newSessionFailures.set(createdId, failure);
      if (newSessionFailures.size > 30) newSessionFailures.delete(newSessionFailures.keys().next().value!);
      recordPersistentEvent("error", "session-start", "New session first turn failed", { sessionRef: toSessionLogRef(createdId), reason: failure.message });
    });
  });
}

export function readNewCodexCliSessionSummary(sessionId: string): DashboardCliSessionSummary | undefined {
  const summary = recentNewSessions.get(sessionId)?.summary;
  if (!summary) return undefined;
  const running = ownsSessionTurn(resolveCodexHome(), sessionId);
  return { ...summary, status: running ? "running" : "idle", canStop: running };
}

async function runNewCodexCliSession(options: {
  text: string;
  attachments?: ChatAttachment[];
  model?: string;
  reasoningEffort?: string;
  sandboxMode?: DashboardCliSandboxMode;
  projectPath?: string;
}, onStarted: (sessionId: string) => void): Promise<string> {
  const prepared = prepareChatInput(options.text, options.attachments);
  const text = prepared.text;
  options = { ...options, ...prepared };
  if (!text) throw new Error("Write a message before starting a Codex chat.");
  if (text.length > MAX_CLI_PROMPT_CHARS) {
    throw new Error(`The message is too long. Keep it under ${MAX_CLI_PROMPT_CHARS.toLocaleString()} characters.`);
  }
  if (options.model && !MODEL_ID_PATTERN.test(options.model)) throw new Error("The selected Codex model is invalid.");
  if (options.reasoningEffort && !REASONING_EFFORT_PATTERN.test(options.reasoningEffort)) {
    throw new Error("The selected reasoning effort is invalid.");
  }
  if (options.sandboxMode && !isCliSandboxMode(options.sandboxMode)) {
    throw new Error("The selected access mode is invalid.");
  }
  try { resolveCliProjectPath(options.projectPath); }
  catch { await readKnownProjectRoots(resolveCodexHome(), true); }
  return startAppServerSession(options, onStarted);
}

async function startAppServerSession(options: {
  text: string;
  attachments?: ChatAttachment[];
  model?: string;
  reasoningEffort?: string;
  sandboxMode?: DashboardCliSandboxMode;
  projectPath?: string;
}, onStarted: (sessionId: string) => void): Promise<string> {
  const cwd = resolveCliProjectPath(options.projectPath);
  await assertUsableCliProjectPath(cwd);
  const live = reserveCodexSessionLive();
  let rpc: CodexAppServerRpc | undefined;
  let detachPrompts: () => void = () => undefined;
  let threadId: string | undefined;
  try {
    rpc = await CodexAppServerRpc.open(await resolveCodexCliExecutable(), cwd);
    recordPersistentEvent("info", "session-start", "App-server thread/start requested", { transport: "app-server-stdio" });
    const result = await rpc.request<{ thread?: { id?: unknown } }>("thread/start", {
      cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.sandboxMode ? { sandbox: options.sandboxMode } : {}),
      approvalPolicy: "on-request"
    });
    const candidateThreadId = typeof result.thread?.id === "string" ? result.thread.id : undefined;
    if (!candidateThreadId || !SESSION_ID_PATTERN.test(candidateThreadId)) throw new Error("Codex app-server did not return a valid session ID.");
    threadId = candidateThreadId;
    live.attach(threadId, rpc, parseCodexAppServerThreadItems, () => activeAppServerTurns.get(threadId!)?.cancelRequested === true && !activeAppServerTurns.get(threadId!)?.turnId);
    detachPrompts = attachCodexAppServerPrompts(rpc, threadId);
    activeAppServerTurns.set(threadId, { rpc });
    await rpc.startAndWaitForTurn(threadId, {
      threadId: candidateThreadId,
      input: appServerChatInput(options.text.trim(), options.attachments),
      cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
      ...(options.sandboxMode ? { sandboxPolicy: toAppServerSandbox(options.sandboxMode, cwd) } : {})
    }, CLI_TURN_TIMEOUT_MS, (turnId) => {
      const active = activeAppServerTurns.get(candidateThreadId);
      if (active) active.turnId = turnId;
      live.started(turnId);
      onStarted(candidateThreadId);
    });
    live.finish("completed");
    return threadId;
  } catch (error) {
    const cancelled = error instanceof CodexAppServerTurnInterruptedError || (threadId !== undefined && activeAppServerTurns.get(threadId)?.cancelRequested === true && !activeAppServerTurns.get(threadId)?.turnId);
    live.finish(cancelled ? "cancelled" : error instanceof CodexAppServerDisconnectedError ? "disconnected" : "failed", error instanceof Error ? error.message : String(error));
    if (cancelled) throw new CodexCliTurnCancelledError();
    throw error;
  } finally {
    detachPrompts();
    if (threadId) activeAppServerTurns.delete(threadId);
    rpc?.close();
    live.dispose();
  }
}

async function sendAppServerSessionMessage(options: {
  sessionId: string;
  text: string;
  attachments?: ChatAttachment[];
  model?: string;
  reasoningEffort?: string;
  sandboxMode?: DashboardCliSandboxMode;
  projectPath?: string;
  onStarted?: () => void;
  signal?: AbortSignal;
  interruptedOnly?: boolean;
}, cwd: string): Promise<void> {
  return runCliSessionMutation(options.sessionId, "Codex turn", async () => {
  options.signal?.throwIfAborted();
  if (readCodexSessionPreferences(resolveCodexHome(), [options.sessionId]).get(options.sessionId)?.manualStop)
    throw new Error('This session was explicitly stopped. Resume it or send a new message to continue.');
  if (await isCliSessionRunning(resolveCodexHome(), options.sessionId)) throw new Error("Codex is already working in this session. Wait for it to finish or stop the current turn.");
  const params = {
    threadId: options.sessionId, input: appServerChatInput(options.text.trim(), options.attachments), cwd,
    ...(options.model ? { model: options.model } : {}), ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
    ...(options.sandboxMode ? { sandboxPolicy: toAppServerSandbox(options.sandboxMode, cwd) } : {})
  };
  const transcript = await findCliSessionTranscript(resolveCodexHome(), options.sessionId, options.signal);
  await readRecentTranscriptTurnState(transcript);
  const previous = transcript ? cliTranscriptTurnStateCache.get(transcript)?.turnId : undefined;
  const home = resolveCodexHome();
  const needsContinuation = async (): Promise<boolean> => {
    if (!options.interruptedOnly) return true;
    const state = await readRecentTranscriptTurnState(transcript);
    options.signal?.throwIfAborted();
    if (resolveCodexHome() !== home) throw new Error("The active account home changed. No continuation was sent.");
    if (readCodexSessionPreferences(home, [options.sessionId]).get(options.sessionId)?.manualStop)
      throw new Error("This session was explicitly stopped while starting. It was left stopped.");
    if (state === "unknown") throw new Error("Interrupted work could not be verified. No continuation was sent.");
    return state !== "terminal" || cliTranscriptTurnStateCache.get(transcript!)?.cancelled === true;
  };
  if (!await needsContinuation()) return;
  const nativeStarted = (turnId: string) => nativeTurnStarted(home, options.sessionId, turnId);
  if ((getNativeCodexSessionRunning(home, options.sessionId) !== undefined || readOpenCodexSessionIds().includes(options.sessionId.toLowerCase())) && await startNativeCodexSessionTurn(home, options.sessionId, params, options.signal, nativeStarted)) {
    options.onStarted?.();
    await waitForNativeSessionTurn(options.sessionId, transcript, previous, ownedNativeTurn(home, options.sessionId)?.turnId, home);
    return;
  }
  const live = reserveCodexSessionLive();
  let rpc: CodexAppServerRpc | undefined;
  let detachPrompts: () => void = () => undefined;
  const abort = () => rpc?.close();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    rpc = await CodexAppServerRpc.open(await resolveCodexCliExecutable(), cwd, options.signal);
    options.signal?.throwIfAborted();
    detachPrompts = attachCodexAppServerPrompts(rpc, options.sessionId);
    activeAppServerTurns.set(options.sessionId, { rpc });
    try { await rpc.request("thread/resume", { threadId: options.sessionId, cwd }); }
    catch (error) {
      if (!(error instanceof Error) || !/already has an active writer/i.test(error.message)) throw error;
      if (!await needsContinuation()) return;
      if (!await startNativeCodexSessionTurn(home, options.sessionId, params, options.signal, nativeStarted)) throw error;
      options.signal?.removeEventListener("abort", abort);
      live.dispose(true);
      activeAppServerTurns.delete(options.sessionId); rpc.close();
      options.onStarted?.();
      await waitForNativeSessionTurn(options.sessionId, transcript, previous, ownedNativeTurn(home, options.sessionId)?.turnId, home);
      live.finish("completed"); return;
    }
    options.signal?.throwIfAborted();
    if (readCodexSessionPreferences(home, [options.sessionId]).get(options.sessionId)?.manualStop)
      throw new Error('This session was explicitly stopped while starting. It was left stopped.');
    if (!await needsContinuation()) return;
    live.attach(options.sessionId, rpc, parseCodexAppServerThreadItems, () => activeAppServerTurns.get(options.sessionId)?.cancelRequested === true && !activeAppServerTurns.get(options.sessionId)?.turnId);
    await rpc.startAndWaitForTurn(options.sessionId, params, CLI_TURN_TIMEOUT_MS, (turnId) => {
      const active = activeAppServerTurns.get(options.sessionId);
      if (active) active.turnId = turnId;
      live.started(turnId);
      options.signal?.removeEventListener("abort", abort);
      options.onStarted?.();
    });
    live.finish("completed");
  } catch (error) {
    const cancelled = error instanceof CodexAppServerTurnInterruptedError || error instanceof CodexCliTurnCancelledError || (activeAppServerTurns.get(options.sessionId)?.cancelRequested === true && !activeAppServerTurns.get(options.sessionId)?.turnId);
    live.finish(cancelled ? "cancelled" : error instanceof CodexAppServerDisconnectedError ? "disconnected" : "failed", error instanceof Error ? error.message : String(error));
    if (cancelled) throw new CodexCliTurnCancelledError();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    detachPrompts();
    activeAppServerTurns.delete(options.sessionId);
    rpc?.close();
    live.dispose();
  }
  });
}

/** Resume an existing goal through Codex's lifecycle API, without adding a user message. */
export async function resumeCodexSessionGoal(session: DashboardCliSessionSummary, signal?: AbortSignal, origin: "user" | "automatic" = "automatic"): Promise<void> {
  validateSessionId(session.id);
  signal?.throwIfAborted();
  const home = resolveCodexHome();
  if (origin === "user") clearCodexSessionManualStop(home, session.id);
  const nativeStarted = (turnId: string) => nativeTurnStarted(home, session.id, turnId);
  const cwd = await resolveRecordedSessionProject(session.id, session.projectPath);
  signal?.throwIfAborted();
  const rpc = await CodexAppServerRpc.open(await resolveCodexCliExecutable(), cwd, signal);
  let live: ReturnType<typeof reserveCodexSessionLive>;
  try { live = reserveCodexSessionLive(); }
  catch (error) { rpc.close(); throw error; }
  let accepted = false;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let off = () => undefined as void;
  let detachPrompts = () => undefined as void;
  const close = (discardLive = false) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    off(); detachPrompts(); activeAppServerTurns.delete(session.id);
    if (discardLive) live.dispose(true);
    rpc.close(); live.dispose();
  };
  const abort = () => { if (!accepted) close(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await waitWithin(runCrossWindowExclusive(`codex:goal:${session.id.toLowerCase()}`, "Resume Codex goal", () => runCliSessionMutation(session.id, "Resume Codex goal", async () => {
      signal?.throwIfAborted();
      if (readCodexSessionPreferences(home, [session.id]).get(session.id)?.manualStop)
        throw new Error('This session was explicitly stopped. Resume it to continue the goal.');
      if (await isCliSessionRunning(resolveCodexHome(), session.id)) {
        observeRunningCodexSession({ ...session, status: "running" });
        return;
      }
      const current = await rpc.request<{ goal?: { status?: string; objective?: string } | null }>("thread/goal/get", { threadId: session.id });
      signal?.throwIfAborted();
      if (!current.goal || (!["active", "usageLimited", "usage_limited"].includes(current.goal.status ?? "") && !(current.goal.status === "paused" && (origin === "user" || !isExplicitSessionGoalPause(home, session.id))))) throw new Error("The goal is no longer eligible to resume. Refresh the session before retrying.");
      const transcript = await findCliSessionTranscript(resolveCodexHome(), session.id, signal);
      await readRecentTranscriptTurnState(transcript);
      const previous = transcript ? cliTranscriptTurnStateCache.get(transcript)?.turnId : undefined;
      const monitorNative = () => {
        void waitForNativeSessionTurn(session.id, transcript, previous, ownedNativeTurn(home, session.id)?.turnId, home).catch(error =>
          recordPersistentEvent("warning", "session-resume", "Native goal continuation ended without completion", { sessionRef: toSessionLogRef(session.id), title: session.title }, error));
        close(true);
      };
      if (current.goal.status !== "active") {
        try { await rpc.request("thread/goal/set", { threadId: session.id, status: "active", origin }); }
        catch (error) {
          if (!(error instanceof Error) || !/already has an active writer/i.test(error.message)) throw error;
          // Codex can commit the goal before its journal append encounters the native writer.
          let verified = await rpc.request<{ goal?: { status?: string; objective?: string } | null }>("thread/goal/get", { threadId: session.id });
          if (!current.goal.objective || verified.goal?.objective !== current.goal.objective) throw error;
          if (origin === "user" && ["usageLimited", "usage_limited"].includes(verified.goal?.status ?? "")) {
            // Recovery changes status without appending an instruction through another writer.
            verified = await rpc.request("thread/goal/set", { threadId: session.id, status: "active", origin: "automatic" });
          }
          if (verified.goal?.status !== "active" || !current.goal.objective || verified.goal.objective !== current.goal.objective) throw error;
          recordPersistentEvent("warning", "session-resume", "Goal activation verified after native writer conflict", { sessionRef: toSessionLogRef(session.id), title: session.title }, error);
        }
        clearExplicitSessionGoalPause(home, session.id);
      }
      if (getNativeCodexSessionRunning(resolveCodexHome(), session.id) === true) { monitorNative(); return; }
      if (getNativeCodexSessionRunning(home, session.id) !== undefined && await startNativeCodexSessionTurn(home, session.id, { threadId: session.id, input: [], cwd }, signal, nativeStarted)) { monitorNative(); return; }
      live.attach(session.id, rpc, parseCodexAppServerThreadItems);
      detachPrompts = attachCodexAppServerPrompts(rpc, session.id);
      activeAppServerTurns.set(session.id, { rpc });
      let started!: () => void;
      let failed!: (error: Error) => void;
      const running = new Promise<void>((resolve, reject) => { started = resolve; failed = reject; });
      void running.catch(() => undefined);
      const disconnected = rpc.onDisconnect(error => { failed(error); close(); });
      const notification = rpc.onNotification((method, raw) => {
        const params = raw as { threadId?: string; turn?: { id?: string } } | undefined;
        if (params?.threadId !== session.id) return;
        if (method === "turn/started") {
          const active = activeAppServerTurns.get(session.id);
          if (active) active.turnId = params.turn?.id;
          accepted = true;
          signal?.removeEventListener("abort", abort);
          started();
        }
        if (method === "turn/completed") {
          if (!accepted) failed(new Error("The goal ended before a resumed turn could be confirmed."));
          close();
        }
      });
      off = () => { notification(); disconnected(); };
      try { await rpc.request("thread/resume", { threadId: session.id, cwd }); }
      catch (error) {
        if (!(error instanceof Error) || !/already has an active writer/i.test(error.message) || !await startNativeCodexSessionTurn(home, session.id, { threadId: session.id, input: [], cwd }, signal, nativeStarted)) throw error;
        monitorNative(); return;
      }
      signal?.throwIfAborted();
      if (!accepted) {
        await rpc.request("turn/start", { threadId: session.id, input: [], cwd });
        await running;
      }
      if (!done) {
        timer = setTimeout(() => { live.finish("disconnected", "Goal monitoring timed out. Open Codex to check its current state."); close(); }, CLI_TURN_TIMEOUT_MS);
        timer.unref?.();
      }
    })), 25_000, "Goal resume was not confirmed. Check Codex before retrying.", signal);
  } catch (error) {
    live.finish("failed", error instanceof Error ? error.message : String(error));
    close();
    throw error;
  } finally { if (!accepted) close(); }
}

/** Observe work that Codex restored itself without taking ownership or starting another turn. */
export function observeRunningCodexSession(session: DashboardCliSessionSummary): void {
  validateSessionId(session.id);
  const home = resolveCodexHome(), key = `${home}:${session.id}`;
  if (session.status !== "running" || ownsSessionTurn(home, session.id) || nativeTurnObservers.has(key)) return;
  if (nativeTurnObservers.size >= MAX_TRACKED_CLI_TURNS) {
    recordPersistentEvent("warning", "session-resume", "Restored native turn monitoring capacity reached", { sessionRef: toSessionLogRef(session.id), title: session.title });
    return;
  }
  const work = (async () => {
    const transcript = await findCliSessionTranscript(home, session.id);
    const startedAt = Date.now(), deadline = startedAt + 5_000;
    for (;;) {
      const state = await readRecentTranscriptTurnState(transcript);
      const current = transcript ? cliTranscriptTurnStateCache.get(transcript) : undefined;
      // A loading owner can report running before its new task reaches the journal.
      if (current?.turnId && (state === "active" || (current.startedAt !== undefined &&
          (current.startedAt === session.runningSince || current.startedAt >= startedAt)))) {
        const turnId = current.turnId, streamId = randomUUID();
        publishNativeTurnState(home, session.id, "running", turnId, streamId);
        await waitForNativeSessionTurn(session.id, transcript, undefined, turnId, home, streamId);
        return;
      }
      if (!transcript || Date.now() >= deadline) throw new Error("The restored native turn could not be verified for completion monitoring.");
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  })().catch(error => {
    if (!(error instanceof CodexCliTurnCancelledError)) recordPersistentEvent("warning", "session-resume", "Restored native turn ended without confirmed completion", { sessionRef: toSessionLogRef(session.id), title: session.title }, error);
  })
    .finally(() => { if (nativeTurnObservers.get(key) === work) nativeTurnObservers.delete(key); });
  nativeTurnObservers.set(key, work);
}

async function waitForNativeSessionTurn(sessionId: string, transcript: string | undefined, previous: string | undefined, expectedTurnId?: string, home = resolveCodexHome(), streamId?: string): Promise<void> {
  const deadline = Date.now() + CLI_TURN_TIMEOUT_MS;
  let status: "completed" | "cancelled" | "failed" | "disconnected" = "disconnected";
  try {
    while (Date.now() < deadline) {
      const state = await readRecentTranscriptTurnState(transcript);
      const turn = transcript ? cliTranscriptTurnStateCache.get(transcript)?.turnId : undefined;
      if (turn && turn !== previous) {
        if (expectedTurnId && turn !== expectedTurnId) throw new Error("The native turn changed before its outcome could be verified. Refresh the conversation.");
        if (state === "failed" || state === "quota-paused") { status = "failed"; throw new Error("Codex could not finish this turn. Check the conversation before retrying."); }
        if (transcript && cliTranscriptTurnStateCache.get(transcript)?.cancelled) { status = "cancelled"; throw new CodexCliTurnCancelledError(); }
        if (state === "terminal") { status = "completed"; return; }
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error("The Codex turn outcome is unconfirmed. Check the conversation before retrying.");
  } finally {
    const owned = ownedNativeTurn(home, sessionId);
    if (!streamId || (transcript && cliTranscriptTurnStateCache.get(transcript)?.turnId === expectedTurnId))
      publishNativeTurnState(home, sessionId, status, expectedTurnId, streamId);
    if (!streamId && owned && (!expectedTurnId || owned.turnId === expectedTurnId)) activeNativeTurns.delete(sessionId);
  }
}

/** Steering uses the owned active connection, independently of the turn's mutation lock. */
export async function steerCodexCliSessionTurn(options: { sessionId: string; text: string; attachments?: ChatAttachment[]; expectedTurnId: string }): Promise<void> {
  validateSessionId(options.sessionId);
  const prepared = prepareChatInput(options.text, options.attachments);
  const active = activeAppServerTurns.get(options.sessionId);
  if (!active || !active.turnId || active.cancelRequested) throw new Error("This window does not own an active Codex turn to steer. Refresh the session.");
  if (!options.expectedTurnId || options.expectedTurnId !== active.turnId) throw new Error("The active Codex turn changed. Refresh the session before sending guidance.");
  const result = await active.rpc.request<{ turnId?: string }>("turn/steer", {
    threadId: options.sessionId, expectedTurnId: options.expectedTurnId,
    input: appServerChatInput(prepared.text, prepared.attachments)
  });
  if (result.turnId !== options.expectedTurnId) throw new Error("Codex did not confirm guidance for the expected turn. Refresh before retrying.");
}

function toAppServerSandbox(mode: DashboardCliSandboxMode, cwd: string): Record<string, unknown> {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly", networkAccess: true };
  return { type: "workspaceWrite", writableRoots: [cwd], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

export async function cancelCodexCliSessionTurn(sessionId: string): Promise<boolean> {
  validateSessionId(sessionId);
  sessionId = sessionId.toLowerCase();
  const home = resolveCodexHome();
  const suppressRecovery = (turnId?: string) => {
    try { markCodexSessionManualStop(home, sessionId, turnId); }
    catch (error) {
      recordPersistentEvent("warning", "session-stop", "Stop recovery suppression could not be saved", { sessionRef: toSessionLogRef(sessionId) }, error);
      publishDashboardRealtime({ type: "dashboard:notice", level: "warning", message: "Stop was requested, but its recovery preference could not be saved. Keep this window open until storage recovers before reloading." });
    }
  };
  const native = ownedNativeTurn(home, sessionId);
  if (native) {
    if (!native.stop) {
      suppressRecovery(native.turnId);
      native.stop = cancelNativeCodexSessionTurn(native.home, sessionId, native.turnId).finally(() => { native.stop = undefined; });
    }
    return native.stop;
  }
  const activeAppServer = activeAppServerTurns.get(sessionId);
  if (activeAppServer) {
    if (activeAppServer.stop) return activeAppServer.stop;
    suppressRecovery(activeAppServer.turnId);
    activeAppServer.cancelRequested = true;
    if (!activeAppServer.turnId) { activeAppServer.rpc.close(); return true; }
    recordPersistentEvent("info", "session-stop", "App-server turn/interrupt requested", { sessionRef: toSessionLogRef(sessionId), transport: "app-server-stdio" });
    activeAppServer.stop = activeAppServer.rpc.request("turn/interrupt", { threadId: sessionId, turnId: activeAppServer.turnId }, 10_000).then(() => {
      cancelCodexAppServerPrompts(sessionId);
      return true;
    }).catch(error => {
      activeAppServer.cancelRequested = false;
      activeAppServer.stop = undefined;
      throw error;
    });
    return activeAppServer.stop;
  }
  return false;
}

/** Open a local Codex session in the official VS Code conversation editor. */
const AUTO_RESUME_EDITOR_SETTLE_MS = 1_000;

export async function openCodexSessionInVsCode(sessionId: string, signal?: AbortSignal, focusWindow = false, readinessTimeoutMs = 40_000): Promise<void> {
  validateSessionId(sessionId);
  signal?.throwIfAborted();
  sessionId = sessionId.toLowerCase();
  if (signal && !focusWindow && readOpenCodexSessionIds(false).includes(sessionId)) return;
  const pending = editorOpens.get(sessionId);
  if (pending) {
    await pending.catch(() => undefined);
    signal?.throwIfAborted();
    return openCodexSessionInVsCode(sessionId, signal, focusWindow, readinessTimeoutMs);
  }
  const opening = (async () => {
    await activateOfficialCodexExtension();
    signal?.throwIfAborted();
    if (focusWindow) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener("abort", abort);
        const done = () => { cleanup(); resolve(); };
        const abort = () => { clearTimeout(timer); cleanup(); reject(signal?.reason instanceof Error ? signal.reason : new Error("Auto Resume was cancelled.")); };
        const timer = setTimeout(done, AUTO_RESUME_EDITOR_SETTLE_MS);
        if (signal) {
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }
      });
      signal?.throwIfAborted();
    }
    // Auto Resume runs during extension-host activation. Await the official
    // extension so its custom-editor provider is registered before openWith.
    await vscode.commands.executeCommand(
      "vscode.openWith",
      createLocalCodexConversationUri(sessionId),
      CODEX_CONVERSATION_VIEW_TYPE,
      {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: false,
        preview: false
      }
    );
    signal?.throwIfAborted();
    if (!readOpenCodexSessionIds(false).includes(sessionId)) {
      // VS Code can resolve openWith before the custom editor tab is published.
      let changed: vscode.Disposable | undefined;
      try {
        await waitWithin(new Promise<void>((resolve) => {
          const check = () => { if (readOpenCodexSessionIds(false).includes(sessionId)) resolve(); };
          changed = vscode.window.tabGroups?.onDidChangeTabs?.(check);
          check();
        }), 5_000, "VS Code did not create a Codex conversation tab. Enable the official Codex extension and retry.", signal);
      } finally {
        changed?.dispose();
      }
      signal?.throwIfAborted();
    }
    if (focusWindow) await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    const ready = await waitForNativeCodexSessionReady(resolveCodexHome(), sessionId, signal, readinessTimeoutMs);
    signal?.throwIfAborted();
    recordPersistentEvent(ready === false ? "warning" : "debug", "session-editor", "Codex conversation readiness checked", { sessionRef: toSessionLogRef(sessionId), ready: ready ?? "unavailable" });
    if (ready === false) throw new Error("The Codex tab opened but is still loading. Wait for it to finish, then retry; saved recovery was kept.");
  })();
  editorOpens.set(sessionId, opening);
  try {
    await opening;
  } finally {
    if (editorOpens.get(sessionId) === opening) editorOpens.delete(sessionId);
  }
}

/** Resolve restored custom documents before closing them to avoid provider restore races. */
export async function closeOpenCodexSessionTabs(signal?: AbortSignal, includePanels = false, resolveDocuments = true): Promise<void> {
  signal?.throwIfAborted();
  const readTabs = () => (vscode.window.tabGroups?.all ?? []).flatMap(group => group.tabs)
    .filter(tab => {
      const type = (tab.input as { viewType?: string })?.viewType;
      return type === CODEX_CONVERSATION_VIEW_TYPE || (includePanels && (type === "chatgpt.panelView" || type === "mainThreadWebview-chatgpt.panelView"));
    });
  if (!readTabs().length) return;
  const requireSavedTabs = () => {
    if (readTabs().some(tab => tab.isDirty)) throw new Error("A Codex conversation has unsaved changes. Save or close it, then retry Auto Resume.");
  };
  requireSavedTabs();
  if (resolveDocuments && readTabs().some(tab => (tab.input as { viewType?: string })?.viewType === CODEX_CONVERSATION_VIEW_TYPE)) await activateOfficialCodexExtension();
  signal?.throwIfAborted();
  const tabs = readTabs();
  for (const tab of resolveDocuments ? tabs : []) {
    signal?.throwIfAborted();
    const input = tab.input as { uri?: vscode.Uri; viewType?: string };
    if (input.viewType !== CODEX_CONVERSATION_VIEW_TYPE) continue;
    if (!input.uri) throw new Error("A restored Codex tab has no conversation address. Close it before retrying Auto Resume.");
    // openWith joins VS Code's restored-editor resolution before we dispose its document.
    try {
      await vscode.commands.executeCommand("vscode.openWith", input.uri, CODEX_CONVERSATION_VIEW_TYPE,
        { viewColumn: tab.group?.viewColumn ?? vscode.ViewColumn.Active, preserveFocus: true, preview: tab.isPreview });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("No custom document found")) throw error;
      recordPersistentEvent("warning", "auto-resume", "Closing a restored tab with a missing custom document", undefined, error);
    }
  }
  signal?.throwIfAborted();
  requireSavedTabs();
  if (readTabs().some(tab => !tabs.includes(tab))) throw new Error("Codex tabs changed during recovery. Saved sessions were retained; retry after opening finishes.");
  const closed = await vscode.window.tabGroups.close(tabs, true);
  signal?.throwIfAborted();
  if (!closed || readTabs().length) throw new Error("VS Code could not close all previous Codex conversation tabs. Saved recovery was retained; close them and retry.");
}

export function readOpenCodexSessionIds(includePreview = true): string[] {
  const ids = (vscode.window.tabGroups?.all ?? [])
    .flatMap((group) => group.tabs)
    .flatMap((tab) => {
      if (!includePreview && tab.isPreview) return [];
      const input = tab.input as { viewType?: string; uri?: vscode.Uri } | undefined;
      const uri = input?.uri;
      if (
        input?.viewType !== CODEX_CONVERSATION_VIEW_TYPE ||
        uri?.scheme !== CODEX_CONVERSATION_SCHEME ||
        uri.authority !== CODEX_CONVERSATION_AUTHORITY ||
        !uri.path.startsWith("/local/")
      )
        return [];
      const id = uri.path.slice("/local/".length);
      return SESSION_ID_PATTERN.test(id) ? [id.toLowerCase()] : [];
    });
  return [...new Set(ids)];
}

/** Open a new chat in the official Codex webview panel. */
export async function openNewCodexWebview(): Promise<void> {
  await activateOfficialCodexExtension();
  await vscode.commands.executeCommand("chatgpt.newCodexPanel");
}

async function activateOfficialCodexExtension(): Promise<vscode.Extension<unknown>> {
  const codexExtension = vscode.extensions.getExtension(CODEX_EXTENSION_ID);
  if (!codexExtension) {
    throw new Error("Install or enable the official Codex extension before opening a Webview session.");
  }
  await codexExtension.activate();
  return codexExtension;
}

export async function renameCodexCliSession(sessionId: string, name: string): Promise<void> {
  validateSessionId(sessionId);
  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("Enter a session name before saving.");
  if (normalized.length > 160) throw new Error("Keep the session name under 160 characters.");
  await runCliSessionMutation(sessionId, "Codex session rename", () =>
    runCodexAppServerRequest("thread/name/set", { threadId: sessionId, name: normalized })
  );
  const recent = recentNewSessions.get(sessionId);
  if (recent) recent.summary = { ...recent.summary, title: normalized };
  try {
    writeCodexSessionTitleOverride(resolveCodexHome(), sessionId, normalized);
  } catch (error) {
    // The native rename is already committed; Manager can reconcile the title
    // from the native transcript when its optional cache becomes available.
    recordPersistentEvent("warning", "session-list", "Native title changed but the local title cache is unavailable", { sessionRef: toSessionLogRef(sessionId) }, error);
  }
}

export function setCodexSessionAutoResume(sessionId: string, enabled: boolean): void {
  validateSessionId(sessionId);
  if (enabled) clearCodexSessionManualStop(resolveCodexHome(), sessionId);
  writeCodexSessionPreference(resolveCodexHome(), sessionId, { autoResume: enabled ? (isAutoResumeEnabled() ? undefined : true) : false });
}

export function setCodexSessionQueue(sessionId: string, enabled: boolean, priority = 3): void {
  validateSessionId(sessionId);
  if (typeof enabled !== 'boolean' || !isSessionQueuePriority(priority)) throw new Error('Choose a positive whole number for queue priority.');
  const store = getSqliteStateStore(), home = resolveCodexHome();
  if (!store) throw new Error('Session preference storage is unavailable. The queue was not changed.');
  store.transaction(() => {
    const queued = readQueuedCodexSessionPreferences(home);
    if (enabled && !queued.has(sessionId) && queued.size >= 256) throw new Error('The session queue is full. Remove an entry before adding another.');
    if (enabled) clearCodexSessionManualStop(home, sessionId);
    writeCodexSessionPreference(home, sessionId, { queue: enabled, priority: enabled ? priority : undefined, queueClaimedAt: undefined, queueClaimId: undefined, queueError: undefined, queueRevision: randomUUID() });
  });
}

export async function forkCodexCliSession(sessionId: string): Promise<string> {
  validateSessionId(sessionId);
  const result = await runCliSessionMutation(sessionId, "Codex session fork", () =>
    runCodexAppServerRequest<{ thread?: { id?: unknown } }>("thread/fork", {
      threadId: sessionId,
      excludeTurns: true
    })
  );
  const forkedId = result?.thread?.id;
  if (typeof forkedId !== "string" || !SESSION_ID_PATTERN.test(forkedId)) {
    throw new Error("Codex created the fork but did not return its session ID. Refresh the session list.");
  }
  return forkedId;
}

export async function archiveCodexCliSession(sessionId: string): Promise<void> {
  validateSessionId(sessionId);
  const home = resolveCodexHome();
  await runCliSessionMutation(sessionId, "Codex session archive", async () => {
    if (resolveCodexHome() !== home) throw new Error('Codex home changed. Refresh before archiving this session.');
    await runCodexAppServerRequest("thread/archive", { threadId: sessionId });
    try { retireCodexSessionQueue(home, sessionId); }
    catch { throw new Error('Codex archived the session, but its queue cleanup could not be saved. Review the queue before restoring it.'); }
  });
  const recent = recentNewSessions.get(sessionId);
  if (recent) recent.summary = { ...recent.summary, archived: true };
}

export async function unarchiveCodexCliSession(sessionId: string): Promise<void> {
  validateSessionId(sessionId);
  await runCliSessionMutation(sessionId, "Codex session restore", () =>
    runCodexAppServerRequest("thread/unarchive", { threadId: sessionId }).then(() => undefined)
  );
  const recent = recentNewSessions.get(sessionId);
  if (recent) recent.summary = { ...recent.summary, archived: false };
}

export async function deleteCodexCliSession(sessionId: string, options: { archivedOnly?: boolean } = {}): Promise<void> {
  validateSessionId(sessionId);
  const home = resolveCodexHome();
  if (ownsSessionTurn(home, sessionId)) throw new Error("Stop the active Codex turn before deleting this session.");
  await runCliSessionMutation(sessionId, "Codex session deletion", async () => {
    if (resolveCodexHome() !== home) throw new Error('Codex home changed. Refresh before deleting this session.');
    const archived = options.archivedOnly || maintenanceConnection.getStore()?.ids.has(sessionId) ? await readCodexArchiveMaintenanceState(sessionId, home) : undefined;
    if (options.archivedOnly && !archived?.archived) throw new Error("This conversation is no longer archived. It was kept.");
    if (archived?.archived ? archived.status !== "idle" : await isCliSessionRunning(home, sessionId)) throw new Error("Stop the active Codex turn before deleting this session.");
    if (resolveCodexHome() !== home) throw new Error('Codex home changed. Refresh before deleting this session.');
    await runCodexAppServerRequest("thread/delete", { threadId: sessionId });
    recentNewSessions.delete(sessionId);
    newSessionFailures.delete(sessionId);
    try { retireCodexSessionQueue(home, sessionId); }
    catch { throw new Error('Codex deleted the session, but its queue cleanup could not be saved. Review the saved queue; deletion must not be replayed.'); }
  });
}

/** Read a bounded history page without locking the writer or retaining the complete transcript. */
/** The initial prompt is immutable: read a bounded transcript head on demand. */
export async function readCodexCliSessionInitialPrompt(sessionId: string, home = resolveCodexHome()): Promise<string | undefined> {
  validateSessionId(sessionId);
  const value = await runCrossWindowSharedRead(sharedResourceKey('session-initial-prompt', [getCodexHomeStateKey(home), sessionId.toLowerCase()]), 'Initial session prompt', async signal => {
    const recent = home === resolveCodexHome() ? recentNewSessions.get(sessionId)?.text : undefined;
    if (recent) return withoutChatTextAttachments(recent).slice(0,32000);
    const file = await findCliSessionTranscript(home, sessionId, signal);
    signal.throwIfAborted(); if (!file) return null;
    const snapshot = await readSafeFileSnapshot(file, { maxBytes: 512 * 1024, startOffset: 0, timeoutMs: 3000 });
    const raw = snapshot.endOffset < snapshot.size ? splitCompleteJsonlRecords(snapshot.buffer).complete : snapshot.buffer;
    for (const [line] of raw.toString('utf8').matchAll(/[^\n]+/g)) {
      signal.throwIfAborted();
      const message = parseCliSessionMessage(line, 0);
      if (message?.role === 'user' && message.text.trim() && !/^(?:# AGENTS\.md instructions|<user_instructions>)/.test(message.text.trimStart())) {
        const value = JSON.parse(line) as { payload?: Record<string, unknown> };
        const payload = value.payload ?? {}, item = payload['item'] && typeof payload['item'] === 'object' ? payload['item'] as Record<string, unknown> : payload;
        const original = typeof payload['message'] === 'string' ? payload['message'] : parseUserInputs(item['content'], 32000).text || message.text;
        return withoutChatTextAttachments(original).slice(0,32000);
      }
    }
    return null;
  }, { maxAgeMs: 60000, timeoutMs: 5000 });
  return value ?? undefined;
}

export async function readCodexCliSessionMessagePage(sessionId: string, before?: string, home = resolveCodexHome()): Promise<{ messages: DashboardCliSessionMessage[]; olderThan?: string; warnings: string[] }> {
  if (!SESSION_ID_PATTERN.test(sessionId) || (before !== undefined && !/^\d{1,16}$/.test(before))) throw new Error('The session history cursor is invalid.');
  const transcript = await findCliSessionTranscript(home, sessionId);
  if (!transcript) return { messages: await readCodexCliSessionMessages(sessionId, home), warnings: [] };
  let end = 0;
  let windowBytes = 256 * 1024;
  const readPage = () => readSafeFileSnapshot(transcript, { maxBytes: windowBytes, startOffset: stat => {
    end = before === undefined ? stat.size : Number(before);
    if (end > stat.size) throw new Error('The transcript changed. Refresh history before loading older activity.');
    // Read one byte before the nominal window so an oversized JSONL record can
    // be identified instead of being mistaken for a complete suffix.
    return Math.max(0, end - windowBytes - 1);
  } });
  let page = await readPage();
  let raw = page.buffer.subarray(0, Math.max(0, end - page.startOffset));
  let boundary = page.startOffset;
  const warnings: string[] = [];
  if (page.startOffset > 0) {
    // If the extra prefix byte is not a newline, the first record began
    // before this window. Expand until its beginning is included.
    while (page.startOffset > 0 && page.buffer[0] !== 0x0a && windowBytes < MAX_SESSION_TRANSCRIPT_READ_BYTES) {
      windowBytes = Math.min(MAX_SESSION_TRANSCRIPT_READ_BYTES, windowBytes * 2);
      page = await readPage(); raw = page.buffer.subarray(0, Math.max(0, end - page.startOffset));
    }
    if (page.startOffset > 0) {
      if (page.buffer[0] === 0x0a) { boundary += 1; raw = raw.subarray(1); }
      else { raw = Buffer.alloc(0); warnings.push('A history record exceeds the 25 MB read limit. Open the native conversation to inspect that record.'); }
    }
  }
  const parsed = parseCliTranscriptLines(raw.toString('utf8'), boundary, {});
  return { messages: await hydrateSessionImages(parsed.messages), olderThan: boundary > 0 ? String(boundary) : undefined, warnings };
}

export async function readCodexCliSessionMessages(
  sessionId: string,
  codexHome = resolveCodexHome()
): Promise<DashboardCliSessionMessage[]> {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("The session identifier is invalid.");
  }
  const firstTurnFailure = newSessionFailures.get(sessionId);
  if (firstTurnFailure) return [
    { id: `initial-${sessionId}`, kind: "message", role: "user", text: recentNewSessions.get(sessionId)?.text ?? "" },
    { id: `initial-error-${sessionId}`, kind: "error", status: "failed", text: `The first response failed: ${firstTurnFailure.message}. Retry your message.` }
  ];
  let transcriptPath = await findCliSessionTranscript(codexHome, sessionId);
  if (recentNewSessions.has(sessionId) && !transcriptPath) {
    return [{ id: `initial-${sessionId}`, kind: "message", role: "user", text: recentNewSessions.get(sessionId)!.text }];
  }
  if (path.resolve(codexHome) === path.resolve(resolveCodexHome()) && !transcriptPath) {
    try {
      const projectPath = await resolveRecordedSessionProject(sessionId);
      const rpc = await CodexAppServerRpc.open(await resolveCodexCliExecutable(), projectPath);
      try {
        const result = await rpc.request("thread/read", { threadId: sessionId, includeTurns: true }, APP_SERVER_REQUEST_TIMEOUT_MS);
        const messages = parseCodexAppServerThreadItems(result);
        if (messages.length > 0) return await hydrateSessionImages(messages);
      } finally {
        rpc.close();
      }
    } catch (error) {
      recordPersistentEvent("error", "session-viewer", "App-server thread read unavailable", { sessionRef: toSessionLogRef(sessionId), reason: error instanceof Error ? error.message : String(error) });
      // Live transport failures must not prevent opening persisted messages.
    }
  }
  const sessionRef = toSessionLogRef(sessionId);
  const startedAt = Date.now();
  try {
    if (!transcriptPath && path.resolve(codexHome) === path.resolve(resolveCodexHome()))
      transcriptPath = await findCliSessionTranscript(codexHome, sessionId);
    if (!transcriptPath) {
      const recent = recentNewSessions.get(sessionId);
      if (recent) return [{ id: `initial-${sessionId}`, kind: "message", role: "user", text: recent.text }];
      throw new Error("The session transcript was not found on this PC.");
    }
    const result = await readCachedCliTranscriptMessages(transcriptPath);
    return await hydrateSessionImages(result.messages);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    recordPersistentEvent(
      "error",
      "session-viewer",
      "Workspace session read failed",
      {
        sessionRef,
        reader: "direct-jsonl",
        reason,
        durationMs: Date.now() - startedAt
      },
      error
    );
    throw error;
  }
}

type AppServerThreadReadResponse = {
  thread?: {
    turns?: Array<{
      id?: unknown;
      status?: unknown;
      error?: { message?: unknown } | null;
      startedAt?: unknown;
      completedAt?: unknown;
      durationMs?: unknown;
      items?: Array<Record<string, unknown>>;
    }>;
  };
};

export function parseCodexAppServerThreadItems(value: unknown): DashboardCliSessionMessage[] {
  const response = value as AppServerThreadReadResponse;
  const output: DashboardCliSessionMessage[] = [];
  for (const [turnIndex, turn] of (response.thread?.turns ?? []).entries()) {
    const status = normalizeCliItemStatus(turn.status);
    const timestamp = unixSecondsToIso(turn.startedAt);
    for (const [itemIndex, item] of (turn.items ?? []).entries()) {
      const parsed = parseAppServerThreadItem(item, `${turnIndex}-${itemIndex}`, status, timestamp);
      if (parsed) output.push({ ...parsed, ...(typeof turn.id === "string" ? { turnId: turn.id } : {}) });
    }
    if (turn.error?.message && typeof turn.error.message === "string") {
      const turnId = typeof turn.id === "string" || typeof turn.id === "number" ? String(turn.id) : String(turnIndex);
      output.push({
        id: `${turnId}-error`,
        kind: "error",
        text: turn.error.message.slice(0, MAX_SESSION_MESSAGE_CHARS),
        title: "Turn failed",
        status: "failed",
        ...(typeof turn.id === "string" ? { turnId: turn.id } : {}),
        timestamp: unixSecondsToIso(turn.completedAt) ?? timestamp
      });
    }
  }
  return output;
}

function parseAppServerThreadItem(
  item: Record<string, unknown>,
  fallbackId: string,
  turnStatus: DashboardCliSessionMessage["status"],
  timestamp: string | undefined
): DashboardCliSessionMessage | undefined {
  const type = typeof item["type"] === "string" ? item["type"] : "";
  const id = typeof item["id"] === "string" ? item["id"] : fallbackId;
  // App-server marks the turn as failed when the turn-level request failed,
  // but historical child items are still completed unless they explicitly
  // carry their own status. Only an in-progress turn should inherit its
  // status; otherwise completed activities were incorrectly rendered as
  // "Failed" throughout a readable transcript.
  const inheritedStatus = turnStatus === "inProgress" ? "inProgress" : "completed";
  const status = normalizeCliItemStatus(item["status"] ?? inheritedStatus);
  const durationMs = typeof item["durationMs"] === "number" ? item["durationMs"] : undefined;
  if (type === "userMessage") {
    const content = parseUserInputs(item["content"]);
    return content.text || content.images.length
      ? { id, kind: "message", role: "user", text: content.text, images: content.images, ...(content.textAttachments?.length ? { textAttachments: content.textAttachments } : {}), timestamp }
      : undefined;
  }
  if (type === "agentMessage") {
    const content = parseUserInputs(item["content"]);
    const text = (
      typeof item["text"] === "string" ? item["text"] : content.text || readHumanText(item["content"]) || ""
    ).trim();
    return text || content.images.length
      ? {
          id,
          kind: "message",
          role: "assistant",
          text: text.slice(0, MAX_SESSION_MESSAGE_CHARS),
          ...(content.images.length ? { images: content.images } : {}),
          timestamp
        }
      : undefined;
  }
  if (type === "reasoning") {
    const summary = readStringArray(item["summary"]);
    const content = readStringArray(item["content"]);
    return {
      id,
      kind: "reasoning",
      title: "Reasoning",
      text: (summary.join("\n\n") || content.join("\n\n") || "Codex reasoned about the next step.").slice(
        0,
        MAX_SESSION_MESSAGE_CHARS
      ),
      status,
      timestamp
    };
  }
  if (type === "plan") {
    const planText = readHumanText(item["text"] ?? item["plan"] ?? item["steps"]);
    return {
      id,
      kind: "plan",
      title: "Plan",
      text: (planText ?? "Codex prepared a plan.").slice(0, MAX_SESSION_MESSAGE_CHARS),
      status,
      timestamp
    };
  }
  if (type === "commandExecution") {
    const command = readCommandText(item["command"] ?? item["cmd"] ?? item["argv"]);
    const output =
      typeof item["aggregatedOutput"] === "string"
        ? item["aggregatedOutput"].slice(0, MAX_SESSION_MESSAGE_CHARS)
        : undefined;
    return {
      id,
      kind: "command",
      title: status === "inProgress" ? "Running command" : status === "failed" ? "Command failed" : "Ran command",
      text: command,
      command,
      cwd: typeof item["cwd"] === "string" ? item["cwd"] : undefined,
      output,
      exitCode: typeof item["exitCode"] === "number" ? item["exitCode"] : undefined,
      durationMs,
      status,
      timestamp
    };
  }
  if (type === "fileChange") {
    const changes = parseCliFileChanges(item["changes"]);
    return {
      id,
      kind: "file-change",
      title:
        status === "inProgress"
          ? "Editing files"
          : `Edited ${changes.length} ${changes.length === 1 ? "file" : "files"}`,
      text: changes.map((change) => change.path).join("\n") || "File changes",
      changes,
      status,
      timestamp
    };
  }
  if (type === "customToolCall" || type === "custom_tool_call") {
    const name = typeof item["name"] === "string" ? item["name"] : "tool";
    const input = typeof item["input"] === "string" ? item["input"].trim() : safeDisplayJson(item["input"]);
    const images = readImageSources(item);
    const error = readHumanError(item["error"]);
    if (images.length)
      return {
        id,
        kind: "image",
        title: "Generated image",
        text: `${images.length} image${images.length === 1 ? "" : "s"} generated.`,
        images: images.map((src) => ({ src, alt: "Generated image" })),
        status: error ? "failed" : status,
        timestamp
      };
    const result = readHumanText(item["result"] ?? item["output"]) ?? safeDisplayJson(item["result"] ?? item["output"]);
    const failed = Boolean(error) || status === "failed";
    return {
      id,
      kind: "tool-call",
      title: status === "inProgress" ? `Using ${name}` : failed ? `${name} failed` : `Used ${name}`,
      subtitle: name,
      text: status === "inProgress" ? `${name} is running.` : (error ?? result ?? `${name} completed.`),
      arguments: input,
      result: error ?? result,
      debug: safeDisplayJson(item),
      status: failed ? "failed" : status,
      timestamp
    };
  }
  if (type === "mcpToolCall" || type === "dynamicToolCall" || type === "toolCall" || type === "ToolCall" || type === "functionCall" || type === "FunctionCall" || type === "toolSearchCall" || type === "ToolSearchCall") {
    const server =
      typeof item["server"] === "string"
        ? item["server"]
        : typeof item["namespace"] === "string"
          ? item["namespace"]
          : typeof item["source"] === "string"
            ? item["source"]
            : "Tool";
    const tool = typeof item["tool"] === "string" ? item["tool"] : typeof item["name"] === "string" ? item["name"] : "call";
    const rawArguments = item["arguments"] ?? item["input"];
    const error = readHumanError(item["error"]);
    const debug = safeDisplayJson({
      arguments: rawArguments,
      error: item["error"],
      result: item["result"] ?? item["contentItems"] ?? item["success"]
    });
    const failed = Boolean(error) || status === "failed";
    return {
      id,
      kind: "tool-call",
      title: status === "inProgress" ? `Using ${tool}` : failed ? `${tool} failed` : `Used ${tool}`,
      subtitle: server,
      text: error ?? (typeof item["progress"] === "string" ? item["progress"] : `${server} used ${tool}.`),
      arguments: safeDisplayJson(rawArguments),
      result: error ?? readHumanText(item["result"] ?? item["contentItems"] ?? item["success"]) ?? safeDisplayJson(item["result"] ?? item["contentItems"] ?? item["success"]),
      debug,
      durationMs,
      status: failed ? "failed" : status,
      timestamp
    };
  }
  if (type === "collabToolCall" || type === "collabAgentToolCall" || type === "subAgentActivity") {
    const tool =
      typeof item["tool"] === "string"
        ? item["tool"]
        : typeof item["kind"] === "string"
          ? item["kind"]
          : "Agent activity";
    const name = [item["agentName"], item["agentNickname"], item["name"]].find((value) => typeof value === "string" && value.trim()) as string | undefined;
    const states = item["agentsStates"];
    const agentStates = states && typeof states === "object" ? Object.values(states) : [];
    const finished = agentStates.length > 0 && agentStates.every((state) => {
      if (state === "completed") return true;
      return state && typeof state === "object" && ("completed" in state || (state as Record<string, unknown>)["status"] === "completed");
    });
    const lifecycle = status === "completed" ? /spawn|start/i.test(tool) ? "started working" : /close/i.test(tool) ? "closed" : finished ? "finished" : undefined : undefined;
    const title = status === "failed" ? (name ? name + " failed" : "Agent action failed")
      : name ? name + (status === "inProgress" ? " working" : lifecycle ? " " + lifecycle : " updated")
      : lifecycle ? "Agent " + lifecycle : status === "inProgress" ? "Working with an agent" : "Agent activity";
    return {
      id,
      kind: "collaboration",
      title,
      text: typeof item["prompt"] === "string" ? item["prompt"].slice(0, MAX_SESSION_MESSAGE_CHARS) : tool,
      subtitle: tool,
      arguments: safeDisplayJson(item["arguments"]),
      result: readHumanText(item["agentsStates"] ?? item["result"] ?? item["output"]) ?? safeDisplayJson(item["agentsStates"] ?? item["result"] ?? item["output"]),
      debug: safeDisplayJson(item),
      status,
      timestamp
    };
  }
  if (type === "webSearch" || type === "web_search" || type === "webSearchCall") {
    const query = typeof item["query"] === "string" ? item["query"] : safeDisplayJson(item["action"]);
    return {
      id,
      kind: "web-search",
      title: "Searched the web",
      text: query || "Web search",
      result: readHumanText(item["result"] ?? item["output"] ?? item["sources"]),
      arguments: safeDisplayJson(item["action"] ?? item["query"]),
      status: status === "unknown" ? "completed" : status,
      timestamp
    };
  }
  if (type === "imageView" || type === "ImageView" || type === "imageGeneration" || type === "ImageGeneration") {
    const viewed = type === "imageView" || type === "ImageView";
    const images = readImageSources(item).map((src) => ({ src, alt: viewed ? "Viewed image" : "Generated image" }));
    return {
      id,
      kind: "image",
      title: viewed ? "Viewed image" : "Generated image",
      text: images.length
        ? mediaDisplayLabel(images[0]!.src)
        : readDisplayText(item["path"], viewed ? "Image" : "Image generation"),
      ...(images.length ? { images } : {}),
      status,
      timestamp
    };
  }
  if (type === "enteredReviewMode" || type === "exitedReviewMode") {
    return {
      id,
      kind: "review",
      title: type === "enteredReviewMode" ? "Started review" : "Completed review",
      text: readDisplayText(item["review"], "Code review"),
      status,
      timestamp
    };
  }
  if (type === "contextCompaction") {
    const compacting = status === "inProgress";
    return {
      id,
      kind: "compaction",
      title: compacting ? "Compacting context" : "Context compacted",
      text: compacting ? "Codex is condensing earlier context before continuing." : "Codex condensed earlier context to continue working.",
      status,
      timestamp
    };
  }
  if (type === "error" || type === "Error") {
    return {
      id,
      kind: "error",
      title: "Tool error",
      text: readHumanError(item["error"] ?? item["message"] ?? item["text"]) ?? "Codex reported an error.",
      debug: safeDisplayJson(item),
      status: "failed",
      timestamp
    };
  }
  if (type === "sleep") {
    return {
      id,
      kind: "tool-call",
      title: "Waited",
      text: `Waited ${formatDuration(typeof item["durationMs"] === "number" ? item["durationMs"] : 0)}.`,
      durationMs,
      status,
      timestamp
    };
  }
  return undefined;
}

function parseCliFileChanges(value: unknown): NonNullable<DashboardCliSessionMessage["changes"]> {
  if (Array.isArray(value)) {
    return value.flatMap((change) => {
      if (!change || typeof change !== "object") return [];
      const detail = change as Record<string, unknown>;
      if (typeof detail["path"] !== "string") return [];
      return [
        {
          path: detail["path"],
          kind: typeof detail["kind"] === "string" ? detail["kind"] : "update",
          diff: typeof detail["diff"] === "string" ? detail["diff"].slice(0, MAX_SESSION_MESSAGE_CHARS) : undefined
        }
      ];
    });
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).map(([filePath, change]) => {
    const detail = change && typeof change === "object" ? (change as Record<string, unknown>) : {};
    const diff = detail["diff"] ?? detail["unified_diff"];
    return {
      path: filePath,
      kind:
        typeof detail["kind"] === "string"
          ? detail["kind"]
          : typeof detail["type"] === "string"
            ? detail["type"]
            : "update",
      diff: typeof diff === "string" ? diff.slice(0, MAX_SESSION_MESSAGE_CHARS) : undefined
    };
  });
}

function parseUserInputs(value: unknown, maxChars = MAX_SESSION_MESSAGE_CHARS): { text: string; images: Array<{ src: string; alt?: string }>; textAttachments?: DashboardCliSessionMessage['textAttachments'] } {
  const parts: string[] = [];
  const images: Array<{ src: string; alt?: string }> = [];
  if (!Array.isArray(value)) return { text: "", images };
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (
      (item["type"] === "text" ||
        item["type"] === "Text" ||
        item["type"] === "input_text" ||
        item["type"] === "output_text") &&
      typeof item["text"] === "string"
    )
      parts.push(item["text"]);
    else if (
      item["type"] === "image" ||
      item["type"] === "Image" ||
      item["type"] === "localImage" ||
      item["type"] === "input_image" ||
      item["type"] === "output_image"
    ) {
      const src = readSafeImageSource(item);
      if (src)
        images.push({ src, alt: typeof item["alt"] === "string" ? item["alt"].slice(0, 200) : "Attached image" });
      else parts.push("[Image unavailable]");
    } else if (item["type"] === "skill" && typeof item["name"] === "string") parts.push(`[Skill: ${item["name"]}]`);
  }
  const text = parts.join("\n\n").trim(), textAttachments = readChatTextAttachments(text);
  return { text: text.slice(0, maxChars), images: images.slice(0, 20), ...(textAttachments.length ? { textAttachments } : {}) };
}

function readSafeImageSource(item: Record<string, unknown>): string | undefined {
  const nested =
    item["image"] && typeof item["image"] === "object" ? (item["image"] as Record<string, unknown>) : undefined;
  // MCP and Responses image content commonly carries raw base64 in `data`
  // alongside an image MIME type rather than a complete data URL.
  const rawData = item["data"];
  const rawMime = typeof item["mimeType"] === "string" ? item["mimeType"].trim().toLowerCase() : "";
  if (typeof rawData === "string" && rawMime.startsWith("image/") && /^[a-z0-9+/=\r\n]+$/i.test(rawData.trim())) {
    const compact = rawData.replace(/\s+/g, "");
    if (compact.length > 0 && compact.length <= Math.ceil(MAX_SESSION_IMAGE_BYTES / 3) * 4) {
      return `data:${rawMime};base64,${compact}`;
    }
  }
  for (const candidate of [
    item["image_url"],
    item["imageUrl"],
    item["url"],
    item["data"],
    item["path"],
    item["output_path"],
    nested?.["url"],
    nested?.["path"]
  ]) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim();
    if (
      /^(?:https?:\/\/|file:\/\/|data:image\/(?:png|jpeg|jpg|gif|webp);base64,)/i.test(value) ||
      path.isAbsolute(value)
    )
      return value;
  }
  return undefined;
}

function readImageSources(item: Record<string, unknown>): string[] {
  const sources: string[] = [];
  const visited = new Set<unknown>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const source = readSafeImageSource({ url: value });
    if (source && !sources.includes(source)) sources.push(source);
  };
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 4 || sources.length >= 20 || value === null || value === undefined) return;
    if (typeof value === "string") {
      add(value);
      return;
    }
    if (typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    add(readSafeImageSource(record));
    for (const key of ["image", "images", "result", "output", "content", "contentItems", "content_items", "data"])
      visit(record[key], depth + 1);
  };
  visit(item);
  return sources.slice(0, 20);
}

function mediaDisplayLabel(source: string): string {
  try {
    const parsed = source.startsWith("file:")
      ? localPathFromSource(source)
      : source.startsWith("http")
        ? new URL(source).pathname
        : source;
    return path.basename(parsed) || "Image";
  } catch {
    return "Image";
  }
}

async function hydrateSessionImages(messages: DashboardCliSessionMessage[]): Promise<DashboardCliSessionMessage[]> {
  let totalBytes = 0;
  const hydrated: DashboardCliSessionMessage[] = [];
  // Keep in-flight local image buffers bounded while applying the page budget.
  for (const message of messages) {
    if (!message.images?.length) { hydrated.push(message); continue; }
    const images: Array<{ src: string; alt?: string }> = [];
    for (const image of message.images) {
      if (/^(?:https?:\/\/|data:image\/)/i.test(image.src)) {
        images.push(image);
        continue;
      }
      if (totalBytes >= MAX_SESSION_IMAGE_TOTAL_BYTES) continue;
      let localPath: string;
      try {
        localPath = image.src.startsWith("file:") ? localPathFromSource(image.src) : image.src;
      } catch {
        continue;
      }
      try {
        const snapshot = await readSafeFileSnapshot(localPath, {
          maxBytes: MAX_SESSION_IMAGE_BYTES,
          rejectIfLarger: true
        });
        totalBytes += snapshot.size;
        if (totalBytes > MAX_SESSION_IMAGE_TOTAL_BYTES) continue;
        const buffer = snapshot.buffer;
        const mimeType = sniffImageMime(buffer);
        if (!mimeType) continue;
        images.push({
          src: `data:${mimeType};base64,${buffer.toString("base64")}`,
          alt: image.alt ?? mediaDisplayLabel(image.src)
        });
      } catch {
        /* A deleted temp image is a normal unavailable preview. */
      }
    }
    hydrated.push(images.length ? { ...message, images } : message);
  }
  return hydrated;
}

function localPathFromSource(source: string): string {
  const url = new URL(source);
  let pathname = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
  return pathname.replace(/\//g, path.sep);
}

function sniffImageMime(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "image/jpeg";
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")
  )
    return "image/gif";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  if (buffer.length >= 4 && buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 1 && buffer[3] === 0)
    return "image/x-icon";
  return undefined;
}

function readStringArray(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    : [];
}

function readDisplayText(value: unknown, fallback: string): string {
  return (typeof value === "string" && value.trim() ? value.trim() : fallback).slice(0, MAX_SESSION_MESSAGE_CHARS);
}

function readCommandText(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, MAX_SESSION_MESSAGE_CHARS);
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()));
    if (parts.length) return parts.join(" ").slice(0, MAX_SESSION_MESSAGE_CHARS);
  }
  if (value && typeof value === "object") {
    const command = value as Record<string, unknown>;
    const executable = readCommandText(
      command["command"] ?? command["cmd"] ?? command["program"] ?? command["executable"]
    );
    const args = readStringArray(command["args"] ?? command["arguments"] ?? command["argv"]);
    const combined = [executable === "Command" ? "" : executable, ...args].filter(Boolean).join(" ").trim();
    if (combined) return combined.slice(0, MAX_SESSION_MESSAGE_CHARS);
  }
  return "Command";
}

function safeDisplayJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.slice(0, MAX_SESSION_MESSAGE_CHARS);
  try {
    const serialized = JSON.stringify(value, null, 2);
    return typeof serialized === "string" ? serialized.slice(0, MAX_SESSION_MESSAGE_CHARS) : undefined;
  } catch {
    return "[Unserializable value]";
  }
}

function readHumanError(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, MAX_SESSION_MESSAGE_CHARS);
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  for (const key of ["message", "error", "text"]) {
    if (typeof candidate[key] === "string" && candidate[key].trim())
      return candidate[key].trim().slice(0, MAX_SESSION_MESSAGE_CHARS);
  }
  const content = candidate["content"];
  if (Array.isArray(content)) {
    const text = content.find(
      (entry) => entry && typeof entry === "object" && typeof (entry as Record<string, unknown>)["text"] === "string"
    ) as Record<string, unknown> | undefined;
    if (typeof text?.["text"] === "string" && text["text"].trim())
      return text["text"].trim().slice(0, MAX_SESSION_MESSAGE_CHARS);
  }
  return undefined;
}

function readHumanText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, MAX_SESSION_MESSAGE_CHARS);
  if (Array.isArray(value)) {
    const parts = value.map((entry) => readHumanText(entry)).filter((entry): entry is string => Boolean(entry));
    return parts.length ? parts.join("\n\n").slice(0, MAX_SESSION_MESSAGE_CHARS) : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["message"] === "string" && candidate["message"].trim())
    return candidate["message"].trim().slice(0, MAX_SESSION_MESSAGE_CHARS);
  if (typeof candidate["text"] === "string" && candidate["text"].trim())
    return candidate["text"].trim().slice(0, MAX_SESSION_MESSAGE_CHARS);
  if (candidate["content"] !== undefined) return readHumanText(candidate["content"]);
  return readHumanError(value);
}

function isLegacyToolOutputFailure(value: unknown): boolean {
  if (!value) return false;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (normalizeCliItemStatus(record["status"]) === "failed" || record["error"] !== undefined) return true;
    const type = typeof record["type"] === "string" ? record["type"].toLowerCase() : "";
    if (type.includes("error") || type.includes("failure")) return true;
    return false;
  }
  if (typeof value !== "string") return false;
  const text = value.trim();
  return (
    /^(?:execution\s+)?error\s*:/i.test(text) ||
    /^error\b/i.test(text) ||
    /^tool\s+(?:call\s+)?failed\b/i.test(text) ||
    /^command\s+failed\b/i.test(text)
  );
}

function normalizeCliItemStatus(value: unknown): DashboardCliSessionMessage["status"] {
  if (value === "inProgress" || value === "in_progress") return "inProgress";
  if (value === "completed" || value === "complete") return "completed";
  if (value === "failed" || value === "error") return "failed";
  if (value === "declined") return "declined";
  if (value === "interrupted" || value === "cancelled" || value === "canceled") return "interrupted";
  return "unknown";
}

function unixSecondsToIso(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`;
}

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("The session identifier is invalid.");
}

function runCliSessionMutation<T>(sessionId: string, operationLabel: string, task: () => Promise<T>): Promise<T> {
  const home = resolveCodexHome();
  return runCrossWindowExclusive(`codex:session:${sessionId.toLowerCase()}`, operationLabel, async () => {
    if (resolveCodexHome() !== home) throw new Error('Codex home changed. Refresh before retrying this action.');
    try { return await task(); }
    finally {
      // A native mutation can succeed before its local bookkeeping fails.
      try { const store = getSqliteStateStore(); if (store) invalidateSessionCatalogue(store, home); }
      catch (error) { recordPersistentEvent("warning", "session-list", "Changed history will refresh when storage recovers", undefined, error); }
    }
  });
}

export async function resolveRecordedSessionProject(sessionId: string, requestedProject?: string, requireAvailable = true): Promise<string> {
  validateSessionId(sessionId);
  const home = resolveCodexHome();
  const recorded = (await readCliSessionMetadata(home, sessionId)).projectPath
    ?? (await readStateSessionRecords(home, sessionId))[0]?.cwd
    ?? recentNewSessions.get(sessionId)?.summary.projectPath;
  let cwd: string;
  if (recorded) {
    if (!path.isAbsolute(recorded)) throw new Error("The session's recorded project folder is invalid. Open it in Codex and select its project before retrying.");
    const canonical = async (value: string): Promise<string> => {
      const normalized = path.resolve(normalizeNativePath(value));
      const resolved = await fs.realpath(normalized).catch(() => normalized);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    if (requestedProject && await canonical(requestedProject) !== await canonical(recorded)) throw new Error("This session belongs to a different project. Refresh its project details before retrying.");
    cwd = path.resolve(recorded);
  } else {
    if (!requestedProject || !path.isAbsolute(requestedProject)) throw new Error("This session has no project folder. Open it in Codex and select its project before retrying.");
    try { cwd = resolveCliProjectPath(requestedProject); }
    catch { await readKnownProjectRoots(home, true); cwd = resolveCliProjectPath(requestedProject); }
  }
  if (requireAvailable) await assertUsableCliProjectPath(cwd);
  return cwd;
}

function resolveCliProjectPath(projectPath: string | undefined): string {
  const fallback = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  if (!projectPath) return fallback;
  const requested = path.resolve(normalizeNativePath(projectPath));
  const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((folder) => path.resolve(normalizeNativePath(folder.uri.fsPath)));
  const allowed = [...workspaceRoots, ...(knownProjectRoots.get(path.resolve(resolveCodexHome()))?.roots ?? [])];
  if (
    workspaceRoots.length === 0 ||
    allowed.some((root) => {
      const relative = path.relative(root, requested);
      return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    })
  ) {
    return requested;
  }
  throw new Error("The selected project is not an open workspace folder.");
}

function isCliSandboxMode(value: string | undefined): value is DashboardCliSandboxMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

async function readSmallOptionalFile(filePath: string, maxBytes: number): Promise<string | undefined> {
  return readSafeFileSnapshot(filePath, { maxBytes, rejectIfLarger: true })
    .then((snapshot) => snapshot.buffer.toString("utf8"))
    .catch(() => undefined);
}

/**
 * Validate the working directory before spawning Codex. A session can retain
 * a cwd that was deleted, moved to an offline drive, or replaced by a file;
 * letting the CLI discover that itself can block resume for a long time.
 */
async function assertUsableCliProjectPath(projectPath: string): Promise<void> {
  try {
    const stat = await fs.stat(projectPath);
    if (!stat.isDirectory()) throw new Error("The selected project path is not a folder.");
  } catch (error) {
    if (error instanceof Error && error.message === "The selected project path is not a folder.") throw error;
    throw new Error(
      "The selected project folder is unavailable. Choose an open, accessible workspace folder and try again."
    );
  }
}

function parseCliModels(raw: string | undefined): DashboardCliComposerConfig["models"] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as {
      models?: unknown;
      data?: unknown;
    };
    const source = Array.isArray(parsed) ? parsed : Array.isArray(parsed.models) ? parsed.models : parsed.data;
    if (!Array.isArray(source)) return [];
    const models = source
      .map((value) => value as Record<string, unknown>)
      .map((model) => {
        const id = [model["slug"], model["id"], model["model"]]
          .find(
            (candidate): candidate is string => typeof candidate === "string" && MODEL_ID_PATTERN.test(candidate.trim())
          )
          ?.trim();
        if (!id) return undefined;
        const hidden = model["hidden"] === true || model["visibility"] === "hide" || model["visibility"] === "hidden";
        const visibility = model["visibility"];
        if (hidden || (visibility !== undefined && visibility !== "list")) return undefined;
        const reasoningLevels = Array.isArray(model["supported_reasoning_levels"])
          ? model["supported_reasoning_levels"]
          : Array.isArray(model["supportedReasoningEfforts"])
            ? model["supportedReasoningEfforts"]
            : [];
        const defaultReasoning = [model["default_reasoning_level"], model["defaultReasoningEffort"]].find(
          (candidate): candidate is string => typeof candidate === "string" && REASONING_EFFORT_PATTERN.test(candidate)
        );
        const label = [model["display_name"], model["displayName"], model["name"]].find(
          (candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0
        );
        return {
          id,
          label: label?.trim() ?? id,
          description: typeof model["description"] === "string" ? model["description"] : undefined,
          defaultReasoningEffort: defaultReasoning,
          reasoningEfforts: reasoningLevels
            .map((level) => {
              if (!level || typeof level !== "object") return undefined;
              const value = level as Record<string, unknown>;
              return [value["effort"], value["reasoningEffort"]].find(
                (candidate): candidate is string =>
                  typeof candidate === "string" && REASONING_EFFORT_PATTERN.test(candidate)
              );
            })
            .filter((effort): effort is string => Boolean(effort))
        };
      })
      .filter((model): model is NonNullable<typeof model> => Boolean(model))
      .map((model) => ({
        ...model,
        defaultReasoningEffort: model.defaultReasoningEffort ?? model.reasoningEfforts[0]
      }));
    // Routers commonly merge static, live, alias and custom catalogs. Keep the
    // first visible definition for a model ID so the picker remains stable.
    const uniqueModels = new Map<string, (typeof models)[number]>();
    for (const model of models) {
      if (!uniqueModels.has(model.id)) uniqueModels.set(model.id, model);
    }
    return [...uniqueModels.values()];
  } catch {
    return [];
  }
}

function readTomlString(raw: string | undefined, key: string): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*[\"']([^\"']+)[\"']\\s*(?:#.*)?$`, "m"));
  return match?.[1]?.trim();
}

type CodexCliExecutable = { command: string; prefixArgs: string[]; shell?: boolean };

/**
 * Return the executable locations that are commonly available to a user but
 * not necessarily visible in the environment of an already-running VS Code
 * process. In particular, the desktop Codex installer puts the CLI under
 * %LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin.
 */
export function getCodexCliPathCandidates(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const candidates: Array<string | undefined> = [environment["CODEX_CLI_PATH"]];
  if (platform === "win32") {
    const localAppData = environment["LOCALAPPDATA"] ?? pathApi.join(os.homedir(), "AppData", "Local");
    const appData = environment["APPDATA"] ?? pathApi.join(os.homedir(), "AppData", "Roaming");
    const programFiles = environment["ProgramFiles"];
    const programFilesX86 = environment["ProgramFiles(x86)"];
    for (const root of [localAppData, programFiles, programFilesX86]) {
      if (!root) continue;
      candidates.push(
        pathApi.join(root, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
        pathApi.join(root, "OpenAI", "Codex", "bin", "codex.exe"),
        pathApi.join(root, "OpenAI Codex", "bin", "codex.exe")
      );
    }
    if (appData) {
      candidates.push(
        pathApi.join(appData, "npm", "codex.exe"),
        pathApi.join(appData, "npm", "codex.cmd"),
        pathApi.join(appData, "npm", "codex.bat"),
        pathApi.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
      );
    }
  }
  const pathEntries = (environment["PATH"] ?? "").split(pathDelimiter).filter(Boolean);
  for (const entry of pathEntries) {
    candidates.push(
      pathApi.join(entry, platform === "win32" ? "codex.exe" : "codex"),
      ...(platform === "win32" ? [pathApi.join(entry, "codex.cmd"), pathApi.join(entry, "codex.bat")] : [])
    );
  }
  return candidates.filter(
    (candidate, index, all): candidate is string => Boolean(candidate) && all.indexOf(candidate) === index
  );
}

async function resolveCodexCliExecutable(): Promise<CodexCliExecutable> {
  const configuredPath = (
    sqliteConfiguration(vscode.workspace.getConfiguration("codexManager")).get<string>("codexCliPath", "") ?? ""
  ).trim();
  const bundledExtensionPath = vscode.extensions?.getExtension(CODEX_EXTENSION_ID)?.extensionPath;
  const signature = JSON.stringify({
    configuredPath,
    codexCliPath: process.env["CODEX_CLI_PATH"],
    localAppData: process.env["LOCALAPPDATA"],
    appData: process.env["APPDATA"],
    path: process.env["PATH"],
    bundledExtensionPath
  });
  if (
    cliExecutableCache?.signature === signature &&
    Date.now() - cliExecutableCache.resolvedAt < CLI_AVAILABILITY_CACHE_TTL_MS
  ) {
    const cachedCandidate = cliExecutableCache.executable.prefixArgs[0] ?? cliExecutableCache.executable.command;
    if (
      cachedCandidate === process.execPath ||
      (await fs
        .stat(cachedCandidate)
        .then((stat) => stat.isFile())
        .catch(() => false))
    ) {
      return cliExecutableCache.executable;
    }
    cliExecutableCache = undefined;
  }
  const candidates = [
    configuredPath || undefined,
    ...getCodexCliPathCandidates(),
    bundledExtensionPath
      ? path.join(
          bundledExtensionPath,
          "bin",
          process.platform === "win32"
            ? process.arch === "arm64"
              ? "windows-arm64"
              : "windows-x86_64"
            : process.platform === "darwin"
              ? process.arch === "arm64"
                ? "macos-aarch64"
                : "macos-x86_64"
              : process.arch === "arm64"
                ? "linux-aarch64"
                : "linux-x86_64",
          process.platform === "win32" ? "codex.exe" : "codex"
        )
      : undefined
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (
      await fs
        .stat(candidate)
        .then((stat) => stat.isFile())
        .catch(() => false)
    ) {
      const extension = path.extname(candidate).toLowerCase();
      const executable =
        extension === ".js" || extension === ".cjs" || extension === ".mjs"
          ? { command: process.execPath, prefixArgs: [candidate] }
          : { command: candidate, prefixArgs: [], shell: extension === ".cmd" || extension === ".bat" };
      cliExecutableCache = { signature, executable, resolvedAt: Date.now() };
      return executable;
    }
  }
  if (process.platform === "win32") {
    const npmScript = process.env["APPDATA"]
      ? path.join(process.env["APPDATA"], "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
      : undefined;
    if (
      npmScript &&
      (await fs
        .stat(npmScript)
        .then((stat) => stat.isFile())
        .catch(() => false))
    ) {
      const executable = { command: process.execPath, prefixArgs: [npmScript] };
      cliExecutableCache = { signature, executable, resolvedAt: Date.now() };
      return executable;
    }
  }
  return { command: "codex", prefixArgs: [] };
}

/** Check whether the Codex CLI can be launched on this PC without changing state. */
export async function isCodexCliAvailable(): Promise<boolean> {
  let executable: CodexCliExecutable;
  try {
    executable = await resolveCodexCliExecutable();
  } catch {
    return false;
  }
  const cacheKey = `${executable.command}\u0000${executable.prefixArgs.join("\u0000")}\u0000${executable.shell ? "shell" : "direct"}`;
  const now = Date.now();
  const cacheTtl = cliAvailabilityCache?.available ? CLI_AVAILABILITY_CACHE_TTL_MS : CLI_UNAVAILABLE_CACHE_TTL_MS;
  if (cliAvailabilityCache?.key === cacheKey && now - cliAvailabilityCache.checkedAt < cacheTtl) {
    return cliAvailabilityCache.available;
  }
  if (cliAvailabilityProbe && cliAvailabilityProbeKey === cacheKey) return cliAvailabilityProbe;
  cliAvailabilityProbe = probeCodexCliAvailability(executable)
    .then((available) => {
      cliAvailabilityCache = { key: cacheKey, available, checkedAt: Date.now() };
      return available;
    })
    .finally(() => {
      cliAvailabilityProbe = undefined;
      cliAvailabilityProbeKey = undefined;
    });
  cliAvailabilityProbeKey = cacheKey;
  return cliAvailabilityProbe;
}

function probeCodexCliAvailability(executable: CodexCliExecutable): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(available);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable.command, [...executable.prefixArgs, "--version"], {
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        env: { ...process.env, ...(executable.command === process.execPath ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
        windowsHide: true,
        shell: executable.shell,
        stdio: "ignore"
      });
    } catch {
      resolve(false);
      return;
    }
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, CLI_AVAILABILITY_TIMEOUT_MS);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

async function runCodexAppServerRequest<T = unknown>(
  method: string,
  params: unknown,
  timeoutMs = APP_SERVER_REQUEST_TIMEOUT_MS
): Promise<T> {
  const maintenance = maintenanceConnection.getStore();
  if (maintenance && ["thread/delete", "thread/unarchive", "thread/goal/clear"].includes(method)) {
    const id = (params as { threadId?: string } | null)?.threadId;
    if (!id || !maintenance.ids.has(id) || maintenance.home !== resolveCodexHome()) throw new Error("The cleanup context changed. Remaining conversations were kept.");
    maintenance.rpc ??= (async () => {
      await assertUsableCliProjectPath(maintenance.home);
      const executable = await resolveCodexCliExecutable();
      if (maintenance.home !== resolveCodexHome()) throw new Error("The cleanup context changed. Remaining conversations were kept.");
      return CodexAppServerRpc.open(executable, maintenance.home);
    })();
    const rpc = await maintenance.rpc;
    if (maintenance.home !== resolveCodexHome()) throw new Error("The cleanup context changed. Remaining conversations were kept.");
    return rpc.request<T>(method, params, timeoutMs);
  }
  const executable = await resolveCodexCliExecutable();
  const sessionId = (params as { threadId?: unknown } | null)?.threadId;
  let cwd: string;
  try { cwd = typeof sessionId === "string" ? await resolveRecordedSessionProject(sessionId) : resolveCliProjectPath(undefined); }
  catch (error) {
    if (typeof sessionId !== "string" || !["thread/name/set", "thread/archive", "thread/unarchive", "thread/delete", "thread/goal/clear"].includes(method)) throw error;
    const home = resolveCodexHome();
    const [records, index, transcript, goals] = await Promise.all([
      readStateSessionRecords(home, sessionId, undefined, 2000, true), readCodexCliSessionIndex(home), findCliSessionTranscript(home, sessionId),
      method === "thread/goal/clear" ? readCodexSessionGoals(home, [sessionId]) : undefined
    ]);
    if (!records.length && !index.some(row => row.id === sessionId) && !transcript && !goals?.has(sessionId)) throw error;
    // Storage cleanup needs no project tools; a deleted project must not trap its archived data.
    cwd = home;
    await assertUsableCliProjectPath(cwd);
    recordPersistentEvent("debug", "session-maintenance", "Using Codex storage for an unavailable session project", { sessionRef: toSessionLogRef(sessionId), method });
  }
  const rpc = await CodexAppServerRpc.open(executable, cwd);
  try { return await rpc.request<T>(method, params, timeoutMs); }
  finally { rpc.close(); }
}

function parseCliSessionEntry(line: string): CliSessionIndexEntry | undefined {
  try {
    const value = JSON.parse(line) as Partial<CliSessionIndexEntry>;
    return typeof value.id === "string" && value.id.length > 0
      ? { id: value.id, thread_name: value.thread_name, updated_at: value.updated_at }
      : undefined;
  } catch {
    return undefined;
  }
}

export function resolveCodexHome(): string {
  const configured = process.env["CODEX_HOME"]?.trim().replace(/^['"]|['"]$/g, "");
  return configured ? path.resolve(normalizeNativePath(configured)) : path.join(os.homedir(), ".codex");
}

function normalizeSessionTitle(value: string | undefined, id: string, fallback?: string): string {
  const title = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return title && title !== id && title !== `Codex session ${id.slice(0, 8)}` ? title.slice(0, 160) : fallback ? normalizeSessionTitle(fallback, id) : "Untitled conversation";
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

/** Read the local journal of dashboard-started CLI turns interrupted by a reload. */
export async function readTrackedCliTurns(storageRoot?: string, legacyPathOverride?: string): Promise<TrackedCliTurn[]> {
  const canonicalRoot = storageRoot ?? getCodexManagerStorageRoot();
  const legacyPath = legacyPathOverride ?? (storageRoot ? undefined : path.join(resolveCodexHome(), RUNNING_TURNS_FILE));
  return (await readTrackedCliTurnsWithDiagnostics(canonicalRoot, legacyPath)).turns;
}

async function readTrackedCliTurnsWithDiagnostics(
  storageRoot: string,
  legacyPath?: string
): Promise<{
  turns: TrackedCliTurn[];
  failure?: string;
  sourcePath?: string;
}> {
  const canonicalPath = path.join(storageRoot, RUNNING_TURNS_FILE);
  const store = sqliteStoreForFile(canonicalPath);
  if (store?.get("migrations","running-turn-rows-v1") && store.get("files",RUNNING_TURNS_FILE) === undefined) {
    try { return { turns:readRunningTurnRows(store).filter(isTrackedCliTurn),sourcePath:canonicalPath }; }
    catch (error) { return { turns:[],failure:`recovery rows could not be read: ${error instanceof Error ? error.message : String(error)}` }; }
  }
  let filePath = canonicalPath;
  let raw: string | undefined;
  if (sqliteStoreForFile(canonicalPath)) {
    try { raw = readSqliteStateFile(canonicalPath, MAX_RUNNING_TURNS_BYTES); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (!hasSqliteStateFile(canonicalPath) && legacyPath && legacyPath !== canonicalPath)
          return readTrackedCliTurnsWithDiagnostics(path.dirname(legacyPath));
        return { turns: [] };
      }
      return { turns: [], failure: `recovery journal could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }
  } else {
  let stat: Awaited<ReturnType<typeof fs.stat>> | undefined;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && legacyPath && legacyPath !== canonicalPath) {
      filePath = legacyPath;
      try {
        stat = await fs.stat(filePath);
      } catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException)?.code === "ENOENT") return { turns: [] };
        return {
          turns: [],
          failure: `recovery journal could not be inspected: ${legacyError instanceof Error ? legacyError.message : String(legacyError)}`
        };
      }
    } else if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { turns: [] };
    } else {
      return {
        turns: [],
        failure: `recovery journal could not be inspected: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  if (!stat) return { turns: [] };
  if (!stat.isFile()) return { turns: [], failure: "recovery journal path is not a file" };
  if (stat.size > MAX_RUNNING_TURNS_BYTES)
    return { turns: [], failure: "recovery journal is too large to read safely" };
  raw = await fs.readFile(filePath, "utf8").catch(() => undefined);
  }
  if (raw === undefined) return { turns: [], failure: "recovery journal could not be read" };
  if (!raw.trim()) return { turns: [] };
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return { turns: [], failure: "recovery journal does not contain an array" };
    const unique = new Map<string, TrackedCliTurn>();
    for (const entry of value) {
      if (isTrackedCliTurn(entry) && !unique.has(entry.id)) unique.set(entry.id, entry);
    }
    const turns = [...unique.values()].slice(0, MAX_TRACKED_CLI_TURNS);
    if (store) saveRunningTurnRows(store,turns);
    return { turns, sourcePath: filePath };
  } catch (error) {
    return {
      turns: [],
      failure: `recovery journal contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function isTrackedCliTurn(value: unknown): value is TrackedCliTurn {
  if (!value || typeof value !== "object") return false;
  const turn = value as Partial<TrackedCliTurn>;
  return (
    typeof turn.id === "string" &&
    SESSION_ID_PATTERN.test(turn.id) &&
    typeof turn.projectPath === "string" &&
    turn.projectPath.length > 0 &&
    typeof turn.startedAt === "number" &&
    Number.isFinite(turn.startedAt) &&
    turn.startedAt > 0 &&
    turn.startedAt <= Date.now() + 5 * 60 * 1000 &&
    (turn.ownerPid === undefined || isValidPid(turn.ownerPid)) &&
    (turn.childPid === undefined || isValidPid(turn.childPid)) &&
    (turn.observedRunning === undefined || typeof turn.observedRunning === "boolean")
  );
}

function isValidPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function toSessionLogRef(sessionIdOrUri: string): string {
  return createHash("sha256").update(sessionIdOrUri).digest("hex").slice(0, 12);
}

async function readCliSessionStatus(
  codexHome: string,
  sessionId: string,
  transcriptPath?: string,
  liveRunning = false
): Promise<Pick<DashboardCliSessionSummary, "status" | "statusError">> {
  try {
    return { status: await isCliSessionRunning(codexHome, sessionId, transcriptPath, liveRunning) ? "running" : "idle" };
  } catch (error) {
    return { status: "unknown", statusError: error instanceof Error ? error.message : String(error) };
  }
}

async function isCliSessionRunning(
  codexHome: string,
  sessionId: string,
  knownTranscriptPath?: string,
  liveRunning = false,
  signal?: AbortSignal
): Promise<boolean> {
  return createSharedInspection(
    `codex-session-status:${path.resolve(codexHome)}:${sessionId}:${liveRunning ? "live" : "disk"}`,
    (inspectionSignal) => inspectCliSessionRunning(codexHome, sessionId, knownTranscriptPath, liveRunning, inspectionSignal),
    signal,
    // Allow the bounded file reads, native IPC, and Windows probe to finish.
    25_000
  );
}

async function inspectCliSessionRunning(
  codexHome: string,
  sessionId: string,
  knownTranscriptPath?: string,
  liveRunning = false,
  signal?: AbortSignal
): Promise<boolean> {
  signal?.throwIfAborted();
  if (path.resolve(codexHome) === path.resolve(resolveCodexHome()) &&
      ownsSessionTurn(codexHome, sessionId)) return true;
  const cachedNative = getNativeCodexSessionRunning(codexHome, sessionId);
  if (cachedNative !== undefined) return cachedNative;
  const lockPath = path.join(codexHome, SESSION_LOCK_DIRECTORY, `${sessionId}.lock`);
  const stat = await fs.lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const transcript = knownTranscriptPath ?? await findCliSessionTranscript(codexHome, sessionId, signal);
  const turnState = await readRecentTranscriptTurnState(transcript);
  // A loaded conversation can retain its writer lock after its turn finishes.
  if (turnState === "terminal" || turnState === "stopped" || turnState === "failed" || turnState === "quota-paused") return false;
  const nativeRunning = await readNativeCodexSessionRunning(codexHome, sessionId, signal);
  signal?.throwIfAborted();
  if (nativeRunning !== undefined) return nativeRunning;
  if (liveRunning) return true;
  const hasLock = Boolean(stat?.isFile() && !stat.isSymbolicLink());
  // A writer lock can survive an interrupted/stopped Codex process. Treat it
  // as live only for a short lease, then require recent transcript activity
  // as corroboration instead of blocking resume for 15 minutes.
  const lockLeaseWindow = 2 * 60 * 1000;
  const lockAge = stat ? Date.now() - stat.mtimeMs : Infinity;
  const bootTime = Date.now() - os.uptime() * 1_000;
  if (turnState === "active" && hasLock && lockAge >= -60_000 && lockAge < lockLeaseWindow && stat!.mtimeMs >= bootTime) {
    return true;
  }
  const activeWindow = 5 * 60 * 1000;
  // Some CLI versions keep the lock mtime fixed while the transcript is
  // actively appended. Use a recent transcript write as a secondary signal.
  const transcriptStat = transcript ? await fs.lstat(transcript).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }) : undefined;
  const transcriptAge = transcriptStat ? Date.now() - transcriptStat.mtimeMs : Infinity;
  if (turnState === "active" && transcriptStat?.isFile() && !transcriptStat.isSymbolicLink() && transcriptStat.mtimeMs >= bootTime && transcriptAge >= -60_000 && transcriptAge < activeWindow) return true;
  return hasLock && await isWriterLockHeld(lockPath);
}

const writerLockProbes = new Map<string, { expiresAt: number; paths: Promise<Set<string>> }>();
async function isWriterLockHeld(lockPath: string): Promise<boolean> {
  if (process.platform === "win32") {
    const directory = path.dirname(lockPath);
    let cached = writerLockProbes.get(directory);
    if (!cached || cached.expiresAt <= Date.now()) {
      const directoryData = Buffer.from(directory, "utf8").toString("base64");
      // Node permits shared reads of Windows byte-range locks. FileShare.None detects the live writer handle.
      const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${directoryData}')); $held=@(); foreach($p in [IO.Directory]::EnumerateFiles($d,'*.lock')) { try { $f=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None); $f.Dispose() } catch { $e=$_.Exception; while($e.InnerException) { $e=$e.InnerException }; $code=$e.HResult -band 65535; if($code -eq 32 -or $code -eq 33) { $held+=,$p } elseif($code -ne 2 -and $code -ne 3) { throw } } }; ConvertTo-Json -InputObject @($held) -Compress`;
      const entry = { expiresAt: Infinity, paths: Promise.resolve(new Set<string>()) };
      entry.paths = new Promise<Set<string>>((resolve, reject) => {
        // CREATE_NO_WINDOW can prevent Windows PowerShell's runtime from
        // initializing on some Windows hosts (STATUS_DLL_INIT_FAILED).
        // Let PowerShell hide its own window instead on that specific failure.
        const args = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
        const deadline = Date.now() + 15_000;
        const inspect = (windowsHide: boolean): void => {
          const completed = (error: unknown, stdout?: string | Buffer): void => {
            const code = (error as NodeJS.ErrnoException | undefined)?.code;
            if (windowsHide && (code === "EPERM" || code === "EAGAIN" || (Number(code) >>> 0) === 0xc0000142) && Date.now() < deadline) {
              inspect(false);
              return;
            }
            entry.expiresAt = error ? 0 : Date.now() + 2000;
            if (error) { reject(new Error(`Windows session writer inspection failed. Retry after the PC responds. ${error instanceof Error ? error.message : code ?? "Unknown process failure"}`)); return; }
            try {
              const values: unknown = JSON.parse(String(stdout).replace(/^\uFEFF/, "").trim() || "[]");
              if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) throw new Error("Invalid lock response");
              resolve(new Set(values.map(value => path.resolve(value).toLowerCase())));
            } catch { entry.expiresAt = 0; reject(new Error("Windows session writer inspection returned incomplete data. Retry after the PC responds.")); }
          };
          try {
            execFile("powershell.exe", args,
              { timeout: Math.max(1, deadline - Date.now()), maxBuffer: 256 * 1024, windowsHide }, completed);
          } catch (error) { completed(error); }
        };
        inspect(true);
      });
      cached = entry;
      writerLockProbes.set(directory, cached);
      if (writerLockProbes.size > 8) writerLockProbes.delete(writerLockProbes.keys().next().value!);
    }
    if ((await cached.paths).has(path.resolve(lockPath).toLowerCase())) return true;
  }
  if (process.platform === "linux") {
    try {
      const [stat, raw] = await Promise.all([fs.stat(lockPath, { bigint: true }), fs.readFile("/proc/locks", "utf8")]);
      const major = ((stat.dev >> 8n) & 0xfffn) | ((stat.dev >> 32n) & 0xfffff000n);
      const minor = (stat.dev & 0xffn) | ((stat.dev >> 12n) & 0xffffff00n);
      if (raw.split("\n").some((line) => {
        const key = /\b([0-9a-f]+):([0-9a-f]+):(\d+)\b/i.exec(line);
        return key && /\bWRITE\b/.test(line) && BigInt(`0x${key[1]}`) === major && BigInt(`0x${key[2]}`) === minor && BigInt(key[3]!) === stat.ino;
      })) return true;
    } catch { /* Restricted procfs and older kernels use the portable probe below. */ }
  }
  if (process.platform !== "win32") {
    const directory = path.dirname(lockPath);
    let cached = writerLockProbes.get(directory);
    if (!cached || cached.expiresAt <= Date.now()) {
      const paths = new Promise<Set<string>>((resolve) => {
        execFile("lsof", ["-Fn", "+D", directory], { timeout: 1500, maxBuffer: 256 * 1024 }, (_error, stdout) => {
          resolve(new Set(String(stdout ?? "").split(/\r?\n/).filter((line) => line.startsWith("n")).map((line) => line.slice(1))));
        });
      });
      cached = { paths, expiresAt: Date.now() + 2000 };
      writerLockProbes.set(directory, cached);
      if (writerLockProbes.size > 8) writerLockProbes.delete(writerLockProbes.keys().next().value!);
    }
    if ((await cached.paths).has(lockPath)) return true;
  }

  try {
    const handle = await fs.open(lockPath, "r");
    await handle.close();
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EBUSY") return true;
    if (code === "ENOENT") return false;
    throw error;
  }
}

type RecentTranscriptTurnState = "active" | "terminal" | "stopped" | "failed" | "quota-paused" | "unknown";
const cliTranscriptTurnStateCache = new Map<string, {
  size: number; mtimeMs: number; offset: number;
  state: RecentTranscriptTurnState; resumeState: RecentTranscriptTurnState;
  turnId?: string; resumeTurnId?: string;
  cancelled?: boolean; resumeCancelled?: boolean;
  startedAt?: number; resumeStartedAt?: number;
  model?: string; reasoningEffort?: string; resumeModel?: string; resumeReasoningEffort?: string;
}>();

async function readCliRunningSince(transcriptPath: string | undefined): Promise<number | undefined> {
  if (!transcriptPath) return undefined;
  try {
    if (await readRecentTranscriptTurnState(transcriptPath) !== "active") return undefined;
    return cliTranscriptTurnStateCache.get(transcriptPath)?.startedAt;
  } catch { return undefined; } // Optional timing must not make the session unreadable.
}

async function readRecentTranscriptTurnState(transcriptPath: string | undefined): Promise<RecentTranscriptTurnState> {
  if (!transcriptPath) return "unknown";
  const previous = cliTranscriptTurnStateCache.get(transcriptPath);
  let maxBytes = previous ? MAX_SESSION_TRANSCRIPT_READ_BYTES : 128 * 1024;
  for (;;) {
    let incremental = false;
    const snapshot = await readSafeFileSnapshot(transcriptPath, {
      maxBytes,
      startOffset: (stat) => {
        if (previous?.size === stat.size && previous.mtimeMs === stat.mtimeMs) return stat.size;
        incremental = Boolean(previous && stat.size > previous.size && stat.size - previous.offset <= MAX_SESSION_TRANSCRIPT_READ_BYTES);
        return incremental ? previous!.offset : Math.max(0, stat.size - maxBytes);
      }
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!snapshot) { cliTranscriptTurnStateCache.delete(transcriptPath); return "unknown"; }
    if (previous?.size === snapshot.size && previous.mtimeMs === snapshot.mtimeMs) return previous.state;
    let state: RecentTranscriptTurnState = incremental ? previous!.resumeState : "unknown";
    let turnId = incremental ? previous!.resumeTurnId : undefined;
    let turnCancelled = incremental ? previous!.resumeCancelled : false;
    let startedAt = incremental ? previous!.resumeStartedAt : undefined;
    let model = incremental ? previous!.resumeModel : undefined;
    let reasoningEffort = incremental ? previous!.resumeReasoningEffort : undefined;
    const lines = snapshot.buffer.toString("utf8").split("\n");
    // A bounded initial read may begin in the middle of a JSON record.
    if (!incremental && snapshot.startOffset > 0) lines.shift();
    let resumeState = state;
    let resumeTurnId = turnId;
    let resumeCancelled = turnCancelled;
    let resumeStartedAt = startedAt;
    let resumeModel = model, resumeReasoningEffort = reasoningEffort;
    for (const [index, line] of lines.entries()) {
      if (index === lines.length - 1) { resumeState = state; resumeTurnId = turnId; resumeCancelled = turnCancelled; resumeStartedAt = startedAt; resumeModel = model; resumeReasoningEffort = reasoningEffort; }
      try {
        const record = JSON.parse(line) as { type?: string; timestamp?: string; turn_id?: string; error?: unknown; payload?: { type?: string; turn_id?: string; error?: unknown; message?: unknown; reason?: unknown; model?: unknown; effort?: unknown; reasoning_effort?: unknown } };
        if (record?.type === "turn_context") {
          if (typeof record.payload?.model === "string" && record.payload.model.trim()) model = record.payload.model.slice(0, 256);
          const effort = record.payload?.effort ?? record.payload?.reasoning_effort;
          if (typeof effort === "string" && effort.trim()) reasoningEffort = effort.slice(0, 64);
        }
        const type = record?.type === "event_msg" ? record.payload?.type : record?.type;
        const eventTurnId = record?.type === "event_msg" ? record.payload?.turn_id : record?.turn_id;
        if (["task_complete", "task_completed", "task_failed", "turn_aborted", "turn_failed", "turn/completed", "turn.completed"].includes(type ?? "")) {
          if (!eventTurnId || !turnId || eventTurnId === turnId) {
            const quota = isCodexQuotaInterruption(JSON.stringify([record.error,record.payload?.error, /failed|aborted/.test(type ?? "") ? record.payload?.message : undefined]));
            const capacity = isCodexCapacityInterruption(JSON.stringify([record.error, record.payload?.error, record.payload?.message]));
            const cancelled = typeof record.payload?.reason === "string" && /user|cancel/i.test(record.payload.reason);
            turnCancelled = cancelled || type === "turn_aborted";
            // Native task_complete can carry a provider error; it is unfinished work, not success.
            const failed = capacity || /failed/.test(type ?? "") || Boolean(record.error ?? record.payload?.error) || state === "failed";
            state = cancelled && !quota && !capacity ? "stopped" : quota || (state === "quota-paused" && !cancelled) ? "quota-paused" : failed && !cancelled ? "failed" : "terminal";
            turnId = eventTurnId ?? turnId;
          }
        } else if (type === "error" && (!eventTurnId || !turnId || eventTurnId === turnId)) {
          if (isCodexQuotaInterruption(JSON.stringify(record))) {
            state = "quota-paused";
            turnId = eventTurnId ?? turnId;
          } else if (isCodexCapacityInterruption(JSON.stringify(record))) {
            state = "failed";
            turnId = eventTurnId ?? turnId;
          }
        } else if (["task_started", "turn_started", "turn/started", "turn.started"].includes(type ?? "")) {
          if (!["terminal","stopped","failed","quota-paused"].includes(state) || !eventTurnId || eventTurnId !== turnId) {
            if (eventTurnId !== turnId || state !== "active") startedAt = undefined;
            const timestamp = Date.parse(typeof record.timestamp === "string" ? record.timestamp : "");
            if (startedAt === undefined && Number.isFinite(timestamp) && timestamp > 0 && timestamp <= Date.now() + 5 * 60_000) startedAt = timestamp;
            state = "active"; turnId = eventTurnId;
            turnCancelled = false;
          }
        }
      } catch { /* Ignore partial records and quoted event text. */ }
    }
    if (state === "unknown" && !incremental && snapshot.startOffset > 0 && maxBytes < MAX_SESSION_TRANSCRIPT_READ_BYTES) {
      maxBytes = Math.min(MAX_SESSION_TRANSCRIPT_READ_BYTES, maxBytes * 8);
      continue;
    }
    cliTranscriptTurnStateCache.set(transcriptPath, {
      size: snapshot.size, mtimeMs: snapshot.mtimeMs,
      offset: snapshot.startOffset + snapshot.buffer.lastIndexOf(0x0a) + 1, state, resumeState, turnId, resumeTurnId, cancelled: turnCancelled, resumeCancelled, startedAt, resumeStartedAt, model, reasoningEffort, resumeModel, resumeReasoningEffort
    });
    if (cliTranscriptTurnStateCache.size > MAX_VISIBLE_CLI_SESSIONS * 3) cliTranscriptTurnStateCache.delete(cliTranscriptTurnStateCache.keys().next().value!);
    return state;
  }
}

/** A user cancellation is terminal intent, even when the native goal remains active. */
export async function readManuallyStoppedCodexSessionIds(home: string, ids: readonly string[], signal?: AbortSignal): Promise<string[]> {
  const preferences = readCodexSessionPreferences(home, ids);
  const transcripts = await findCliSessionTranscripts(home, new Set(ids), signal);
  const stopped: string[] = [];
  for (const id of ids) {
    signal?.throwIfAborted();
    const transcript = transcripts.get(id);
    const state = await readRecentTranscriptTurnState(transcript);
    const turn = transcript ? cliTranscriptTurnStateCache.get(transcript) : undefined;
    const preference = preferences.get(id);
    if (preference?.manualStop && turn?.turnId && turn.turnId !== preference.manualStopTurnId &&
        turn.startedAt !== undefined && preference.manualStoppedAt !== undefined && turn.startedAt >= preference.manualStoppedAt && state !== "unknown") {
      clearCodexSessionManualStop(home, id);
    } else if (preference?.manualStop) { stopped.push(id); continue; }
    if (state === "stopped") stopped.push(id);
  }
  return stopped;
}

/** Successful native completion makes an old recovery entry ineligible for replay. */
export async function readCompletedCodexSessionIds(home: string, ids: readonly string[], signal?: AbortSignal): Promise<string[]> {
  const transcripts = await findCliSessionTranscripts(home, new Set(ids), signal);
  const completed: string[] = [];
  for (const [id, transcript] of transcripts) {
    signal?.throwIfAborted();
    if (await readRecentTranscriptTurnState(transcript) === "terminal" && !cliTranscriptTurnStateCache.get(transcript)?.cancelled) completed.push(id);
  }
  return completed;
}

/** Optionally include all interrupted turns; discovery never changes native writer locks. */
export async function readQuotaInterruptedCodexSessionIds(home = resolveCodexHome(), ids?: readonly string[], signal?: AbortSignal, limitedGoalIds: readonly string[] = [], includeInterrupted = false): Promise<string[]> {
  signal?.throwIfAborted();
  const transcripts = await findCliSessionTranscripts(home, ids ? new Set(ids) : undefined, signal);
  const preferences = readCodexSessionPreferences(home, ids ? [...ids] : [...transcripts.keys(), ...limitedGoalIds]);
  const interrupted = new Set(limitedGoalIds.filter(id => (!ids || ids.includes(id)) && preferences.get(id)?.manualStop !== true));
  for (const [id, transcript] of transcripts) {
    const state = await readRecentTranscriptTurnState(transcript);
    const modifiedAt = cliTranscriptTurnStateCache.get(transcript)?.mtimeMs;
    if (modifiedAt && modifiedAt > Date.now() + 60_000) {
      interrupted.delete(id);
      recordPersistentEvent("debug", "auto-resume", "Future-dated recovery skipped", { sessionId: id });
      continue;
    }
    if (preferences.get(id)?.manualStop === true) { interrupted.delete(id); continue; }
    if (state === "quota-paused" || (includeInterrupted && (state === "active" || state === "failed" || cliTranscriptTurnStateCache.get(transcript)?.cancelled))) interrupted.add(id);
    else if (state === "terminal") interrupted.delete(id);
  }
  return [...interrupted];
}

/** Locate all visible session transcripts in one bounded walk. The previous
 * implementation repeated the recursive walk once per session, which made a
 * large session history turn a dashboard refresh into O(sessions * files).
 */
export async function findCliSessionTranscripts(
  codexHome: string,
  sessionIds?: ReadonlySet<string>,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (sessionIds?.size === 0) return found;
  const cacheKey = path.resolve(codexHome);
  const stateRecords = await readStateSessionRecords(codexHome, sessionIds && sessionIds.size <= 30_000 ? [...sessionIds] : undefined);
  const canonical = new Map(stateRecords.flatMap((record) =>
    record.rolloutPath && path.isAbsolute(record.rolloutPath) ? [[record.id, path.resolve(record.rolloutPath)] as const] : []));
  const canonicalSignature = JSON.stringify([...canonical.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const cachedPaths = cliTranscriptPathCache.get(cacheKey);
  const cacheFresh = cachedPaths && cachedPaths.signature === canonicalSignature && Date.now() - cachedPaths.checkedAt >= 0 && Date.now() - cachedPaths.checkedAt < CLI_TRANSCRIPT_PATH_CACHE_TTL_MS;
  const cacheCoversRequest = cachedPaths?.complete || Boolean(sessionIds && [...sessionIds].every(id => cachedPaths?.covered.has(id)));
  if (!signal?.aborted && cacheFresh && cacheCoversRequest) {
    for (const [id, transcript] of cachedPaths.paths) if (!sessionIds || sessionIds.has(id)) found.set(id, transcript);
    return found;
  }
  if (sessionIds && [...sessionIds].every(id => canonical.has(id))) {
    const direct = new Map<string, string>();
    const roots = [path.resolve(codexHome, SESSION_DIRECTORY), path.resolve(codexHome, "archived_sessions")];
    await runWithConcurrencyLimit([...sessionIds], 32, async id => {
      signal?.throwIfAborted();
      const transcript = canonical.get(id)!;
      if (!roots.some(root => { const relative = path.relative(root, transcript); return relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`); })) return;
      const stat = await fs.lstat(transcript).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (!stat?.isFile() || stat.isSymbolicLink()) return;
      const [actual, actualHome] = await Promise.all([fs.realpath(transcript), fs.realpath(codexHome)]);
      const relative = path.relative(actualHome, actual);
      if (relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)) direct.set(id, transcript);
    });
    if (direct.size === sessionIds.size) return direct;
  }
  const selected = new Map<string, { mtimeMs: number; active: boolean; canonical: boolean }>();
  const activeRoot = path.resolve(codexHome, SESSION_DIRECTORY) + path.sep;
  const pending = [path.join(codexHome, "archived_sessions"), path.join(codexHome, SESSION_DIRECTORY)];
  let scanned = 0;
  while (pending.length && scanned < MAX_SESSION_SCAN_ENTRIES) {
    signal?.throwIfAborted();
    const directory = pending.pop()!;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (++scanned > MAX_SESSION_SCAN_ENTRIES) break;
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) { pending.push(candidate); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const id = entry.name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]?.toLowerCase();
      if (!id || (sessionIds && !sessionIds.has(id))) continue;
      const stat = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      const active = path.resolve(candidate).startsWith(activeRoot);
      const previous = selected.get(id);
      const isCanonical = canonical.get(id) === path.resolve(candidate);
      if (!previous || (isCanonical && !previous.canonical) || (!previous.canonical && !isCanonical &&
          ((active && !previous.active) || (active === previous.active && stat.mtimeMs > previous.mtimeMs)))) {
        found.set(id, candidate);
        selected.set(id, { mtimeMs: stat.mtimeMs, active, canonical: isCanonical });
      }
    }
  }
  if (pending.length || scanned > MAX_SESSION_SCAN_ENTRIES)
    throw new Error("Session discovery reached its safety limit. Running state could not be fully verified; retry after reducing local session history.");
  const reusable = cachedPaths && cachedPaths.signature === canonicalSignature && Date.now() - cachedPaths.checkedAt >= 0 && Date.now() - cachedPaths.checkedAt < CLI_TRANSCRIPT_PATH_CACHE_TTL_MS
    ? cachedPaths
    : undefined;
  const paths = reusable ? new Map(reusable.paths) : new Map<string, string>();
  for (const [id, transcript] of found) paths.set(id, transcript);
  const covered = new Set<string>();
  if (sessionIds) {
    for (const id of reusable?.covered ?? []) covered.add(id);
    for (const id of sessionIds) covered.add(id);
  }
  cliTranscriptPathCache.set(cacheKey, {
    checkedAt: Date.now(),
    signature: canonicalSignature,
    complete: !sessionIds || Boolean(reusable?.complete),
    covered,
    paths
  });
  if (cliTranscriptPathCache.size > 8) cliTranscriptPathCache.delete(cliTranscriptPathCache.keys().next().value!);
  return found;
}

async function findCliSessionTranscript(codexHome: string, sessionId: string, signal?: AbortSignal): Promise<string | undefined> {
  return (await findCliSessionTranscripts(codexHome, new Set([sessionId]), signal)).get(sessionId);
}

async function readArchivedSessionIds(codexHome: string, signal?: AbortSignal): Promise<Set<string>> {
  const ids = new Set<string>();
  const pending = [path.join(codexHome, "archived_sessions")];
  let scanned = 0;
  while (pending.length && scanned < MAX_SESSION_SCAN_ENTRIES) {
    signal?.throwIfAborted();
    const directory = pending.pop()!;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      scanned += 1;
      if (scanned > MAX_SESSION_SCAN_ENTRIES || entry.isSymbolicLink()) break;
      if (entry.isDirectory()) {
        pending.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const match = entry.name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (match) ids.add(match[0]);
    }
  }
  return ids;
}

function readCachedCliTranscriptMessages(transcriptPath: string): Promise<CliTranscriptReadResult> {
  return createSharedInspection(`cli-transcript:${path.resolve(transcriptPath)}`, () => readCliTranscriptSnapshot(transcriptPath));
}

async function readCliTranscriptSnapshot(transcriptPath: string): Promise<CliTranscriptReadResult> {
  const cacheKey = path.resolve(transcriptPath);
  const cached = cliTranscriptMessageCache.get(cacheKey);
  let readMode: "cached" | "appended" | "window" = "window";
  const snapshot = await readSafeFileSnapshot(transcriptPath, {
    maxBytes: MAX_SESSION_TRANSCRIPT_READ_BYTES,
    startOffset: (stat) => {
      if (cached && stat.size === cached.size && stat.mtimeMs === cached.mtimeMs) {
        readMode = "cached";
        return stat.size;
      }
      if (
        cached &&
        stat.size >= cached.size &&
        stat.mtimeMs >= cached.mtimeMs &&
        stat.size - cached.offset <= MAX_SESSION_TRANSCRIPT_READ_BYTES
      ) {
        readMode = "appended";
        return cached.offset;
      }
      readMode = "window";
      return Math.max(0, stat.size - MAX_SESSION_TRANSCRIPT_READ_BYTES);
    }
  });
  if ((readMode as string) === "cached" && cached) {
    return {
      messages: cached.messages,
      transcriptBytes: snapshot.size,
      bytesRead: 0,
      cacheHit: true,
      partialLine: cached.remainder.length > 0,
      windowed: cached.windowed
    };
  }

  let next: CliTranscriptMessageCache;
  if ((readMode as string) === "appended" && cached) {
    const combined = Buffer.concat([cached.remainder, snapshot.buffer]);
    const split = splitCompleteJsonlRecords(combined);
    let remainder = split.remainder;
    const turnContext = { turnId: cached.currentTurnId };
    const parsed = parseCliTranscriptLines(split.complete.toString("utf8"), cached.nextSequence, turnContext);
    const addedMessages = parsed.messages;
    let nextSequence = parsed.nextSequence;
    const trailingText = remainder.toString("utf8");
    const trailingMessage = trailingText.trim()
      ? parseTaggedCliSessionMessage(trailingText, nextSequence, turnContext)
      : undefined;
    if (trailingMessage) {
      if (mergeCliTranscriptMessage(addedMessages, trailingMessage)) nextSequence += 1;
      remainder = Buffer.alloc(0);
    }
    const mergedMessages = [...cached.messages];
    for (const message of addedMessages) mergeCliTranscriptMessage(mergedMessages, message);
    next = {
      size: snapshot.endOffset,
      mtimeMs: snapshot.mtimeMs,
      offset: snapshot.endOffset,
      remainder,
      nextSequence,
      messages: mergedMessages.slice(-MAX_VISIBLE_SESSION_MESSAGES),
      windowed: cached.windowed,
      currentTurnId: turnContext.turnId
    };
  } else {
    let raw = snapshot.buffer;
    if (snapshot.startOffset > 0) {
      const firstNewline = raw.indexOf(0x0a);
      raw = firstNewline >= 0 ? raw.subarray(firstNewline + 1) : Buffer.alloc(0);
    }
    const split = splitCompleteJsonlRecords(raw);
    let remainder = split.remainder;
    const turnContext: { turnId?: string } = {};
    const parsed = parseCliTranscriptLines(split.complete.toString("utf8"), 0, turnContext);
    const messages = parsed.messages;
    let nextSequence = parsed.nextSequence;
    const trailingText = remainder.toString("utf8");
    const trailingMessage = trailingText.trim() ? parseTaggedCliSessionMessage(trailingText, nextSequence, turnContext) : undefined;
    if (trailingMessage) {
      if (mergeCliTranscriptMessage(messages, trailingMessage)) nextSequence += 1;
      remainder = Buffer.alloc(0);
    }
    next = {
      size: snapshot.endOffset,
      mtimeMs: snapshot.mtimeMs,
      offset: snapshot.endOffset,
      remainder,
      nextSequence,
      messages: messages.slice(-MAX_VISIBLE_SESSION_MESSAGES),
      windowed: snapshot.startOffset > 0,
      currentTurnId: turnContext.turnId
    };
  }
  cliTranscriptMessageCache.delete(cacheKey);
  // A subarray can retain the complete 25 MB read window for a tiny partial record.
  next.remainder = Buffer.from(next.remainder);
  const retainedBytes = next.remainder.byteLength + JSON.stringify(next.messages).length * 2;
  cliTranscriptMessageCache.set(cacheKey, { ...next, retainedBytes });
  let totalBytes = [...cliTranscriptMessageCache.values()].reduce((sum, entry) => sum + entry.retainedBytes, 0);
  while (cliTranscriptMessageCache.size > 32 || totalBytes > MAX_TRANSCRIPT_CACHE_BYTES) {
    const oldest = cliTranscriptMessageCache.keys().next().value as string | undefined;
    if (!oldest) break;
    totalBytes -= cliTranscriptMessageCache.get(oldest)!.retainedBytes;
    cliTranscriptMessageCache.delete(oldest);
  }
  return {
    messages: next.messages,
    transcriptBytes: snapshot.size,
    bytesRead: snapshot.bytesRead,
    cacheHit: false,
    partialLine: next.remainder.length > 0,
    windowed: next.windowed
  };
}

function splitCompleteJsonlRecords(buffer: Buffer): { complete: Buffer; remainder: Buffer } {
  const newline = buffer.lastIndexOf(0x0a);
  return newline >= 0
    ? { complete: buffer.subarray(0, newline + 1), remainder: buffer.subarray(newline + 1) }
    : { complete: Buffer.alloc(0), remainder: buffer };
}

function parseCliTranscriptLines(raw: string, startingSequence: number, turnContext: { turnId?: string }): { messages: DashboardCliSessionMessage[]; nextSequence: number } {
  const messages: DashboardCliSessionMessage[] = [];
  let sequence = startingSequence;
  for (const [line] of raw.matchAll(/[^\n]+/g)) {
    const message = parseTaggedCliSessionMessage(line, sequence, turnContext);
    if (!message) continue;
    if (mergeCliTranscriptMessage(messages, message)) sequence += 1;
  }
  return { messages, nextSequence: sequence };
}

function parseTaggedCliSessionMessage(line: string, sequence: number, context: { turnId?: string }): DashboardCliSessionMessage | undefined {
  let endsTurn = false;
  try {
    const value = JSON.parse(line) as { type?: string; payload?: { type?: string; turn_id?: string; turnId?: string; id?: string } };
    const payload = value.payload;
    const id = payload?.turn_id ?? payload?.turnId;
    if (typeof id === "string" && id.length <= 256 && (value.type === "turn_context" || payload?.type === "task_started")) context.turnId = id;
    endsTurn = value.type === "event_msg" && ["task_complete", "task_completed", "turn_aborted"].includes(payload?.type ?? "");
  } catch { /* Partial and malformed JSON records do not change turn ownership. */ }
  const message = parseCliSessionMessage(line, sequence);
  const tagged = message && context.turnId ? { ...message, turnId: context.turnId } : message;
  if (endsTurn) context.turnId = undefined;
  return tagged;
}

function mergeCliTranscriptMessage(
  messages: DashboardCliSessionMessage[],
  message: DashboardCliSessionMessage
): boolean {
  // The JSON event stream reports an activity more than once (for example
  // item_started followed by item_completed). Replace the earlier snapshot
  // in place so the workspace shows the live command/reasoning without
  // duplicating it when the final result arrives.
  let existingIndex =
    message.kind && message.kind !== "message"
      ? messages.findIndex(
          (candidate) =>
            candidate.id === message.id &&
            candidate.turnId === message.turnId &&
            candidate.kind !== "message" &&
            (candidate.kind === message.kind || message.kind === "image" || message.kind === "tool-call")
        )
      : -1;
  if (
    existingIndex < 0 &&
    message.kind &&
    message.kind !== "message" &&
    message.kind !== "reasoning" &&
    message.kind !== "tool-call"
  ) {
    for (let index = messages.length - 1; index >= Math.max(0, messages.length - 2); index -= 1) {
      const candidate = messages[index]!;
      if (candidate.kind === "tool-call" && candidate.status === "inProgress" && candidate.turnId === message.turnId) {
        existingIndex = index;
        break;
      }
    }
  }
  if (existingIndex < 0 && (!message.kind || message.kind === "message")) {
    for (let index = messages.length - 1; index >= Math.max(0, messages.length - 3); index -= 1) {
      const candidate = messages[index]!;
      if (candidate.role === message.role && candidate.turnId === message.turnId && candidate.text.trim() === message.text.trim()) {
        existingIndex = index;
        break;
      }
    }
  }
  if (existingIndex >= 0) {
    const existing = messages[existingIndex]!;
    const images = [...(existing.images ?? [])];
    for (const image of message.images ?? [])
      if (!images.some((candidate) => candidate.src === image.src)) images.push(image);
    const keepConcreteActivity = existing.kind && existing.kind !== "tool-call" && message.kind === "tool-call";
    const terminalStatus =
      existing.status === "failed" || existing.status === "declined" || existing.status === "interrupted"
        ? existing.status
        : message.status;
    // Legacy response_item streams emit a named `function_call` first and a
    // generic `function_call_output` later. Keep the tool identity from the
    // start event so the browser shows “Used exec” / “exec failed” instead of
    // flattening every completed call to “Tool completed”.
    const genericToolCompletion =
      existing.kind === "tool-call" &&
      message.kind === "tool-call" &&
      (message.title === "Tool completed" || message.title === "Tool failed");
    const existingToolName = existing.title?.match(/^Using (.+)$/)?.[1];
    const mergedToolTitle = genericToolCompletion && existingToolName
      ? terminalStatus === "failed"
        ? `${existingToolName} failed`
        : `Used ${existingToolName}`
      : undefined;
    messages[existingIndex] = keepConcreteActivity
      ? {
          ...message,
          ...existing,
          id: existing.id,
          status: terminalStatus,
          result: message.result ?? existing.result,
          debug: existing.debug ?? message.debug,
          ...(mergedToolTitle ? { title: mergedToolTitle } : {}),
          ...(images.length ? { images: images.slice(0, 20) } : {})
        }
      : {
          ...existing,
          ...message,
          id: existing.id,
          ...(mergedToolTitle ? { title: mergedToolTitle } : {}),
          ...(images.length ? { images: images.slice(0, 20) } : {})
        };
    return false;
  }
  messages.push(message);
  if (messages.length > MAX_VISIBLE_SESSION_MESSAGES) messages.splice(0, messages.length - MAX_VISIBLE_SESSION_MESSAGES);
  return true;
}

function parseCliSessionMessage(line: string, sequence: number): DashboardCliSessionMessage | undefined {
  try {
    const value = JSON.parse(line) as {
      timestamp?: unknown;
      type?: unknown;
      payload?: Record<string, unknown>;
    };
    const timestamp = typeof value.timestamp === "string" ? normalizeTimestamp(value.timestamp) : undefined;
    const eventPayload = value.type === "event_msg" ? value.payload : undefined;
    const eventType = value.type === "event_msg" ? eventPayload?.["type"] : value.type;
    if (["error", "task_complete", "task_completed", "task_failed", "turn_failed", "turn/completed", "turn.completed"].includes(String(eventType)) && isCodexCapacityInterruption(JSON.stringify(eventPayload ?? value))) {
      return { id: `${sequence}-${typeof value.timestamp === "string" ? value.timestamp : "capacity"}`, kind: "error", title: "Model at capacity", text: "Selected model is at capacity. Try a different model, then retry.", status: "failed", timestamp };
    }
    if (eventPayload?.["type"] === "user_message") {
      return parsePersistedUserMessage(
        eventPayload,
        `${sequence}-${typeof value.timestamp === "string" ? value.timestamp : "user"}`,
        timestamp
      );
    }
    if (eventPayload && ["item_started", "item_updated", "item_completed"].includes(String(eventPayload["type"]))) {
      const item = normalizePersistedActivity(eventPayload["item"]);
      const activityTimestamp = typeof value.timestamp === "string" ? value.timestamp : "activity";
      if (!item) return undefined;
      const eventType = String(eventPayload["type"]);
      const status =
        eventType === "item_started"
          ? "inProgress"
          : eventType === "item_completed"
            ? "completed"
            : normalizeCliItemStatus(item["status"]) === "unknown"
              ? "inProgress"
              : normalizeCliItemStatus(item["status"]);
      return parseAppServerThreadItem(item, `${sequence}-${activityTimestamp}`, status, timestamp);
    }
    const payload = value.type === "response_item" ? value.payload : undefined;
    if (
      payload?.["type"] === "custom_tool_call" ||
      payload?.["type"] === "function_call" ||
      payload?.["type"] === "tool_search_call"
    ) {
      const callId =
        typeof payload["call_id"] === "string"
          ? payload["call_id"]
          : typeof payload["id"] === "string"
            ? payload["id"]
            : `${sequence}-tool`;
      const name = typeof payload["name"] === "string" ? payload["name"] : "tool";
      const rawInput = payload["input"] ?? payload["arguments"];
      const input = typeof rawInput === "string" ? rawInput.trim() : safeDisplayJson(rawInput);
      return {
        id: callId,
        kind: "tool-call",
        title: `Using ${name}`,
        subtitle: name,
        text: input ? `${name} is running.` : `${name} is running…`,
        arguments: input,
        debug: safeDisplayJson({ name, input: rawInput, callId }),
        status: "inProgress",
        timestamp
      };
    }
    if (
      payload?.["type"] === "custom_tool_call_output" ||
      payload?.["type"] === "function_call_output" ||
      payload?.["type"] === "tool_search_output"
    ) {
      const callId =
        typeof payload["call_id"] === "string"
          ? payload["call_id"]
          : typeof payload["id"] === "string"
            ? payload["id"]
            : `${sequence}-tool`;
      const output = payload["output"];
      const images = readImageSources({ output });
      const outputStatus = normalizeCliItemStatus(payload["status"]);
      const failure = outputStatus === "failed" || Boolean(payload["error"]) || isLegacyToolOutputFailure(output);
      if (images.length) {
        return {
          id: callId,
          kind: "image",
          title: "Generated image",
          text: `${images.length} image${images.length === 1 ? "" : "s"} generated.`,
          images: images.map((src) => ({ src, alt: "Generated image" })),
          status: failure ? "failed" : "completed",
          timestamp
        };
      }
      const result = readHumanText(output) ?? safeDisplayJson(output) ?? "Tool completed.";
      return {
        id: callId,
        kind: "tool-call",
        title: failure ? "Tool failed" : "Tool completed",
        text: result.slice(0, MAX_SESSION_MESSAGE_CHARS),
        result: result.slice(0, MAX_SESSION_MESSAGE_CHARS),
        status: failure ? "failed" : "completed",
        timestamp
      };
    }
    const role = payload?.["role"];
    if (payload?.["type"] !== "message" || (role !== "user" && role !== "assistant")) return undefined;
    if (
      role === "assistant" &&
      payload["phase"] &&
      payload["phase"] !== "commentary" &&
      payload["phase"] !== "final_answer"
    ) {
      return undefined;
    }
    if (!Array.isArray(payload["content"])) return undefined;
    const parts: string[] = [];
    const images: Array<{ src: string; alt?: string }> = [];
    for (const item of payload["content"]) {
      if (!item || typeof item !== "object") continue;
      const content = item as {
        type?: unknown;
        text?: unknown;
        image_url?: unknown;
        imageUrl?: unknown;
        url?: unknown;
        data?: unknown;
        path?: unknown;
      };
      if ((content.type === "input_text" || content.type === "output_text") && typeof content.text === "string") {
        const text = content.text.trim();
        if (text) parts.push(text);
      } else if (content.type === "input_image" || content.type === "output_image" || content.type === "image") {
        const src = readSafeImageSource(content as Record<string, unknown>);
        if (src) images.push({ src, alt: "Attached image" });
        else parts.push("[Image unavailable]");
      }
    }
    const text = parts.join("\n\n").trim();
    if (!text && images.length === 0) return undefined;
    if (role === "user" && isInternalSessionContext(text, payload)) return undefined;
    const textAttachments = role === 'user' ? readChatTextAttachments(text) : [];
    return {
      id: `${sequence}-${typeof value.timestamp === "string" ? value.timestamp : "message"}`,
      role,
      text: text.slice(0, MAX_SESSION_MESSAGE_CHARS),
      ...(images.length ? { images: images.slice(0, 20) } : {}),
      ...(textAttachments.length ? { textAttachments } : {}),
      timestamp
    };
  } catch {
    return undefined;
  }
}

function isInternalSessionContext(text: string, payload: Record<string, unknown>): boolean {
  const metadata = payload["internal_chat_message_metadata_passthrough"];
  if (metadata && typeof metadata === "object") {
    const kinds = (metadata as Record<string, unknown>)["content_item_kinds"];
    if (Array.isArray(kinds) && kinds.length > 0 && !kinds.includes("user.text") && !kinds.includes("user.image"))
      return true;
  }
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<recommended_plugins>") ||
    trimmed.startsWith("<skills_instructions>") ||
    trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("The following is the Codex agent history whose request action you are assessing.") ||
    trimmed.startsWith("The following is the Codex agent history added since your last approval assessment.")
  );
}

function parsePersistedUserMessage(
  payload: Record<string, unknown>,
  id: string,
  timestamp?: string
): DashboardCliSessionMessage | undefined {
  const item =
    payload["item"] && typeof payload["item"] === "object" ? (payload["item"] as Record<string, unknown>) : payload;
  const content = parseUserInputs(item["content"] ?? payload["content"]);
  const directImages: unknown[] = [
    ...(Array.isArray(payload["images"]) ? (payload["images"] as unknown[]) : []),
    ...(Array.isArray(payload["local_images"]) ? (payload["local_images"] as unknown[]) : [])
  ];
  for (const image of directImages) {
    const src =
      typeof image === "string"
        ? readSafeImageSource({ url: image })
        : image && typeof image === "object"
          ? readSafeImageSource(image as Record<string, unknown>)
          : undefined;
    if (src && !content.images.some((candidate) => candidate.src === src))
      content.images.push({ src, alt: "Attached image" });
  }
  const text = content.text || (typeof payload["message"] === "string" ? payload["message"].trim() : "");
  const textAttachments = content.textAttachments ?? readChatTextAttachments(typeof payload['message'] === 'string' ? payload['message'] : '');
  return text || content.images.length
    ? {
        id,
        kind: "message",
        role: "user",
        text: text.slice(0, MAX_SESSION_MESSAGE_CHARS),
        ...(content.images.length ? { images: content.images.slice(0, 20) } : {}),
        ...(textAttachments.length ? { textAttachments } : {}),
        timestamp
      }
    : undefined;
}

function normalizePersistedActivity(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const persistedType = typeof item["type"] === "string" ? item["type"] : "";
  const type = (
    {
      Reasoning: "reasoning",
      reasoning: "reasoning",
      Plan: "plan",
      plan: "plan",
      CommandExecution: "commandExecution",
      commandExecution: "commandExecution",
      command_execution: "commandExecution",
      FileChange: "fileChange",
      fileChange: "fileChange",
      file_change: "fileChange",
      McpToolCall: "mcpToolCall",
      mcpToolCall: "mcpToolCall",
      mcp_tool_call: "mcpToolCall",
      CustomToolCall: "customToolCall",
      customToolCall: "customToolCall",
      custom_tool_call: "customToolCall",
      ToolCall: "dynamicToolCall",
      toolCall: "dynamicToolCall",
      tool_call: "dynamicToolCall",
      FunctionCall: "dynamicToolCall",
      functionCall: "dynamicToolCall",
      function_call: "dynamicToolCall",
      ToolSearchCall: "dynamicToolCall",
      toolSearchCall: "dynamicToolCall",
      tool_search_call: "dynamicToolCall",
      CollabAgentToolCall: "collabAgentToolCall",
      collabAgentToolCall: "collabAgentToolCall",
      SubAgentActivity: "subAgentActivity",
      subAgentActivity: "subAgentActivity",
      ImageView: "imageView",
      imageView: "imageView",
      ContextCompaction: "contextCompaction",
      contextCompaction: "contextCompaction",
      UserMessage: "userMessage",
      userMessage: "userMessage",
      user_message: "userMessage",
      AgentMessage: "agentMessage",
      agentMessage: "agentMessage",
      agent_message: "agentMessage",
      ImageGeneration: "imageGeneration",
      imageGeneration: "imageGeneration",
      image_generation: "imageGeneration",
      GeneratedImage: "imageGeneration",
      generatedImage: "imageGeneration",
      dynamicToolCall: "dynamicToolCall",
      DynamicToolCall: "dynamicToolCall",
      WebSearch: "webSearch",
      webSearch: "webSearch",
      web_search: "webSearch",
      web_search_call: "webSearch",
      EnteredReviewMode: "enteredReviewMode",
      enteredReviewMode: "enteredReviewMode",
      ExitedReviewMode: "exitedReviewMode",
      exitedReviewMode: "exitedReviewMode",
      Review: "enteredReviewMode",
      review: "enteredReviewMode",
      Error: "error",
      error: "error",
      Sleep: "sleep",
      sleep: "sleep",
      Extension: item["kind"] === "web.search" ? "webSearch" : ""
    } as Record<string, string>
  )[persistedType];
  // New Codex providers occasionally introduce a tool event name before the
  // dashboard knows its exact spelling. Preserve it as a dynamic tool call so
  // the transcript still shows the invocation, arguments, and result instead
  // of silently dropping the activity.
  const inferredType = type || (
    /(?:tool|function|search|mcp|call)/i.test(persistedType) &&
    ("name" in item || "tool" in item || "arguments" in item || "input" in item || "result" in item || "output" in item)
      ? "dynamicToolCall"
      : ""
  );
  if (!inferredType) return undefined;
  const changes =
    item["changes"] && typeof item["changes"] === "object" && !Array.isArray(item["changes"])
      ? Object.entries(item["changes"] as Record<string, unknown>).map(([filePath, change]) => {
          const detail = change && typeof change === "object" ? (change as Record<string, unknown>) : {};
          return { path: filePath, kind: detail["type"] ?? "update", diff: detail["unified_diff"] };
        })
      : item["changes"];
  return {
    ...item,
    type: inferredType,
    summary: item["summary"] ?? item["summary_text"],
    content: item["content"] ?? item["raw_content"],
    aggregatedOutput: item["aggregatedOutput"] ?? item["aggregated_output"] ?? item["formatted_output"],
    exitCode: item["exitCode"] ?? item["exit_code"],
    durationMs: item["durationMs"] ?? item["duration"],
    changes,
    query: item["query"] ?? item["action"]
  };
}

function createLocalCodexConversationUri(sessionId: string): vscode.Uri {
  return vscode.Uri.file(`/local/${sessionId}`).with({
    scheme: CODEX_CONVERSATION_SCHEME,
    authority: CODEX_CONVERSATION_AUTHORITY
  });
}
