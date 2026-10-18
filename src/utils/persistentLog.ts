import * as fs from "fs/promises";
import { waitWithin } from "./concurrency";
import { fireSqliteConfigurationChanges } from "../storage/configurationEvents";
import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { redactDebugText } from "./debug";
import { getCodexManagerStorageRoot } from "./storageRoot";
import { SqliteStateStore, sqliteStoreForFile } from "../storage/sqliteState";
import { runCrossWindowExclusive } from "./crossWindowOperations";
import { logRetentionCutoff } from "../storage/logRetention";
import { compactManagerDatabase, waitForManagerDatabaseMaintenance } from "../storage/databaseMaintenance";

export const PERSISTENT_LOG_RETENTION_DAYS = 3;
const MAX_PERSISTENT_LOG_RECORD_BYTES = 64 * 1024;
const MAX_PENDING_LOG_RECORDS = 128;
const MAX_PENDING_LOG_BYTES = 2 * 1024 * 1024;

export type PersistentLogLevel = "debug" | "info" | "warning" | "error";
type OperationStatus = "completed" | "cancelled" | "failed";
type OperationResult = { status: OperationStatus; errorMessage?: string };

type OperationContext = {
  operationId: string;
  traceId: string;
};

type PersistentLogRecord = {
  timestamp: string;
  hostRunId?: string;
  sequence?: number;
  level: PersistentLogLevel;
  scope: string;
  message: string;
  operationId?: string;
  traceId?: string;
  parentOperationId?: string;
  durationMs?: number;
  details?: unknown;
  error?: unknown;
};

const LOG_LEVELS: Record<PersistentLogLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };
const hostRunId = randomUUID();
let persistentLogLevel: PersistentLogLevel = "info";

export function isPersistentLogLevel(value: unknown): value is PersistentLogLevel {
  return typeof value === "string" && Object.hasOwn(LOG_LEVELS, value);
}

const operationContext = new AsyncLocalStorage<OperationContext>();
let persistentLogger: PersistentSqliteLogger | undefined;
let restoreGlobalCapture: (() => void) | undefined;
let loggingRegistration: { context: vscode.ExtensionContext; storageRoot: string } | undefined;
let loggingUpdate: Promise<void> | undefined;
let loggingUpdateRequest = "";
let persistentLogRetentionDays = PERSISTENT_LOG_RETENTION_DAYS;
let loggingEpoch = 0;
let stopLoggingSettings: (() => void) | undefined;

/** Diagnostics use their own WAL database so log volume cannot bloat manager state. */
export class PersistentSqliteLogger {
  private writesSincePrune = 0;
  private maintenanceTimer: NodeJS.Timeout | undefined;
  private maintenanceStarted = false;
  private writeChain: Promise<void> = Promise.resolve();
  private writeError: unknown;
  private writeFailureReported = false;
  private activeUtcDate: string | undefined;
  private pendingWrites = 0;
  private pendingBytes = 0;
  private droppedRecords = 0;
  private minimumLevel: PersistentLogLevel = "info";
  private sequence = 0;
  private store: SqliteStateStore | undefined;
  private opening: Promise<SqliteStateStore> | undefined;

  constructor(
    readonly databasePath: string,
    private retentionDays = PERSISTENT_LOG_RETENTION_DAYS,
    private readonly now: () => Date = () => new Date(),
    private readonly onWriteFailure?: (error: unknown) => void,
    private readonly appendRecord = (store: SqliteStateStore, key: string, record: unknown, generation?: string): Promise<void> => {
      store.transaction(() => {
        const control = store.get<{ enabled?: boolean; generation?: string }>("log-control", "state");
        if (control?.enabled === false || (control?.generation ?? "") !== (generation ?? "")) return;
        store.set("logs", key, record);
      });
      return Promise.resolve();
    }
  ) {}

  private async database(): Promise<SqliteStateStore> {
    if (this.store) return this.store;
    this.opening ??= SqliteStateStore.open(this.databasePath).then(store => { this.store = store; return store; }).finally(() => { this.opening = undefined; });
    return this.opening;
  }

  setLevel(level: PersistentLogLevel): void { this.minimumLevel = level; }

  setRetentionDays(days: number): void {
    this.retentionDays = days;
  }

  async ensureCurrentLog(): Promise<void> {
    await this.database();
    if (this.writeError !== undefined) {
      this.write("info", "lifecycle", "Persistent logging retry");
      await this.flush();
    }
  }

  async initialize(): Promise<void> {
    await this.database();
    if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer);
    this.maintenanceTimer = setTimeout(() => {
      this.maintenanceTimer = undefined;
      void this.pruneExpiredLogs().catch(error => this.onWriteFailure?.(error));
    }, 30_000);
    this.maintenanceTimer.unref?.();
    this.activeUtcDate = toUtcDate(this.now());
    this.write("info", "lifecycle", "Persistent logging initialized", {
      retentionDays: this.retentionDays,
      database: this.databasePath
    });
    await this.flush();
  }

  write(
    level: PersistentLogLevel,
    scope: string,
    message: string,
    details?: unknown,
    error?: unknown,
    correlation?: Partial<Pick<PersistentLogRecord, "operationId" | "traceId" | "parentOperationId" | "durationMs">>
  ): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.minimumLevel]) return;
    if (this.pendingWrites >= MAX_PENDING_LOG_RECORDS || this.pendingBytes >= MAX_PENDING_LOG_BYTES) {
      this.droppedRecords += 1;
      return;
    }
    const context = operationContext.getStore();
    const recordTime = this.now();
    let line: string;
    try {
      const record: PersistentLogRecord = {
        timestamp: recordTime.toISOString(),
        hostRunId,
        sequence: ++this.sequence,
        level,
        scope: redactDebugText(scope),
        message: redactDebugText(message),
        operationId: correlation?.operationId ?? context?.operationId,
        traceId: correlation?.traceId ?? context?.traceId,
        parentOperationId: correlation?.parentOperationId,
        durationMs: correlation?.durationMs,
        details: details === undefined ? undefined : sanitizeLogValue(details),
        error: error === undefined ? undefined : serializeError(error)
      };
      line = serializeLogRecord(record);
    } catch (serializationError) {
      line = `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        scope: "persistent-log",
        message: "Diagnostic event could not be serialized",
        error: { message: toErrorMessage(serializationError) }
      })}\n`;
    }
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (this.pendingBytes + lineBytes > MAX_PENDING_LOG_BYTES) {
      this.droppedRecords += 1;
      return;
    }
    this.pendingWrites += 1;
    this.pendingBytes += lineBytes;
    const utcDate = toUtcDate(recordTime);
    const key = `${recordTime.toISOString()}:${randomUUID()}`;
    const generation = this.database().then(store => store.get<{ generation?: string }>("log-control", "state")?.generation).catch(() => undefined);
    const dayChanged = this.activeUtcDate !== undefined && this.activeUtcDate !== utcDate;
    this.activeUtcDate = utcDate;
    this.writeChain = this.writeChain
      .then(async () => {
        if (dayChanged || ++this.writesSincePrune >= 128) {
          await this.pruneExpiredLogs();
          this.writesSincePrune = 0;
        }
        await this.appendRecord(await this.database(), key, JSON.parse(line), await generation);
        this.writeError = undefined;
        this.writeFailureReported = false;
      })
      .catch((caught: unknown) => {
        this.writeError = caught;
        if (!this.writeFailureReported) {
          this.writeFailureReported = true;
          this.onWriteFailure?.(caught);
        }
      })
      .finally(() => {
        this.pendingWrites -= 1;
        this.pendingBytes -= lineBytes;
      });
  }

  async flush(): Promise<void> {
    do {
      await this.writeChain;
      if (this.pendingWrites === 0 && this.droppedRecords > 0) {
        const droppedRecords = this.droppedRecords;
        this.droppedRecords = 0;
        this.write("warning", "persistent-log", "Diagnostic records were skipped while storage was busy", { droppedRecords });
      }
    } while (this.pendingWrites > 0);
    if (this.writeError !== undefined) {
      throw toError(this.writeError);
    }
  }

  async pruneExpiredLogs(): Promise<void> {
    await this.database();
    this.maintenanceStarted = true;
    const outcome = await compactManagerDatabase(this.databasePath, { days: this.retentionDays, now: this.now() });
    if (outcome === "deferred") throw new Error("Log cleanup was deferred because storage is busy. The retention policy is saved; retry after storage responds.");
  }

  async readRecent(): Promise<string> {
    return (await this.readExport()).records.map(record => JSON.stringify(record)).join("\n");
  }

  async readExport(): Promise<{ records: unknown[]; limited: boolean }> {
    await this.flush();
    const store = await this.database();
    const cutoff = logRetentionCutoff(this.retentionDays, this.now());
    const rows = store.prepare(`SELECT state.value FROM state JOIN (
      SELECT key FROM (SELECT key,SUM(record_bytes) OVER (ORDER BY key DESC ROWS UNBOUNDED PRECEDING) AS bytes
        FROM (SELECT key,length(CAST(value AS BLOB)) AS record_bytes FROM state WHERE namespace='logs' AND key>=? ORDER BY key DESC LIMIT 1000)
      ) WHERE bytes<=524288
    ) AS selected ON state.namespace='logs' AND state.key=selected.key ORDER BY state.key DESC`).all(cutoff);
    const count = Number(store.prepare("SELECT COUNT(*) AS count FROM (SELECT key FROM state WHERE namespace='logs' AND key>=? LIMIT 1001)").get(cutoff)?.["count"] ?? 0);
    const records: unknown[] = [];
    let bytes = 0;
    for (const row of rows) {
      const record = sanitizeLogValue(JSON.parse(String(row["value"])));
      bytes += Buffer.byteLength(JSON.stringify(record));
      if (bytes > 512 * 1024) break;
      records.push(record);
    }
    return { records: records.reverse(), limited: records.length < count };
  }

  async close(): Promise<void> {
    if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer);
    this.maintenanceTimer = undefined;
    try { await this.flush(); if (this.maintenanceStarted) await waitForManagerDatabaseMaintenance(this.databasePath); } finally { this.store?.close(); this.store = undefined; }
  }

  async setRecordingEnabled(enabled: boolean): Promise<void> {
    const store = await this.database();
    store.transaction(() => store.set("log-control", "state", { ...store.get<Record<string, unknown>>("log-control", "state"), enabled }));
  }

  async clear(disable = false): Promise<void> {
    const clearing = this.writeChain.then(async () => {
      const store = await this.database();
      store.transaction(() => {
        store.set("log-control", "state", { enabled: !disable, generation: randomUUID(), clearedAt: this.now().toISOString() });
        store.prepare("DELETE FROM state WHERE namespace='logs' OR (namespace='legacy-files' AND key LIKE 'logs/%')").run();
      });
      this.droppedRecords = 0;
      this.writeError = undefined;
      this.compactLater(store);
    });
    this.writeChain = clearing.catch(() => undefined);
    await clearing;
  }

  private compactLater(store: SqliteStateStore): void {
    if (this.pendingWrites > 1) return;
    const free = Number(store.prepare("PRAGMA freelist_count").get()?.["freelist_count"] ?? 0);
    if (free < 512) return;
    this.maintenanceStarted = true;
    void compactManagerDatabase(this.databasePath).catch(error => this.onWriteFailure?.(error));
  }
}

export async function registerPersistentLogging(
  context: vscode.ExtensionContext,
  storageRoot = getCodexManagerStorageRoot()
): Promise<void> {
  stopLoggingSettings?.();
  await disposePersistentLogging();
  const epoch = loggingEpoch;
  loggingRegistration = { context, storageRoot };
  persistentLogRetentionDays = PERSISTENT_LOG_RETENTION_DAYS;
  persistentLogLevel = "info";
  try {
    const settings = await readLoggingSettings(storageRoot);
    if (epoch !== loggingEpoch) return;
    persistentLogRetentionDays = settings.retentionDays;
    persistentLogLevel = settings.level;
    if (settings.enabled) {
      const candidate = await createPersistentLogger(storageRoot, settings.retentionDays);
      if (epoch !== loggingEpoch) { await candidate.close(); return; }
      try {
        await runCrossWindowExclusive("preferences:file-logging", "Initialize System Log", async () => {
          if (epoch !== loggingEpoch || !(await readLoggingSettings(storageRoot)).enabled) { await candidate.close(); return; }
          await candidate.setRecordingEnabled(true);
          persistentLogger = candidate;
          restoreGlobalCapture = installGlobalFailureCapture(candidate, context.extensionPath);
        });
      } catch (error) { await candidate.close(); throw error; }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") console.warn("[codexManager] persistent logging unavailable; disabled", error);
  }

  const registration = loggingRegistration;
  let cancelled = false, needsRetry = false, refreshTimer: NodeJS.Timeout | undefined;
  const refresh = ():void => {
    refreshTimer = undefined;
    if (cancelled || registration !== loggingRegistration) return;
    void readLoggingSettings(storageRoot).then(settings => {
      if (cancelled || registration !== loggingRegistration ||
          (!needsRetry && settings.enabled === isPersistentLoggingEnabled() && settings.retentionDays === persistentLogRetentionDays && settings.level === persistentLogLevel)) return;
      needsRetry = false;
      return updatePersistentLoggingSettings({}).then(() => {
        if (!cancelled && !refreshTimer) { refreshTimer = setTimeout(refresh, 0); refreshTimer.unref?.(); }
      });
    }).catch(error => {
      if (cancelled) return;
      needsRetry = true;
      console.warn("[codexManager] shared logging preference refresh delayed",toErrorMessage(error));
      refreshTimer = setTimeout(refresh,2_000); refreshTimer.unref?.();
    });
  };
  const stop = sqliteStoreForFile(path.join(storageRoot,"logging-settings.json"))?.subscribe(["state"],()=>{
    if (!cancelled && !refreshTimer) { refreshTimer=setTimeout(refresh,0); refreshTimer.unref?.(); }
  });
  const dispose = ():void => {
    cancelled = true; if (refreshTimer) clearTimeout(refreshTimer); stop?.();
    if (stopLoggingSettings === dispose) stopLoggingSettings = undefined;
  };
  stopLoggingSettings = dispose;
  context.subscriptions.push({dispose});
  context.subscriptions.push(
    vscode.commands.registerCommand("codexManager.openPersistentLogs", async () => {
      try {
        const logger = persistentLogger;
        if (!logger) {
          void vscode.window.showInformationMessage("Persistent logging is disabled. Enable it in Data & sync before opening logs.");
          return;
        }
        await logger.ensureCurrentLog();
        await logger.flush();
        const document = await vscode.workspace.openTextDocument({ content: await logger.readRecent(), language: "jsonl" });
        await vscode.window.showTextDocument(document, { preview: false });
      } catch (error) {
        const detail = toErrorMessage(error);
        void vscode.window.showErrorMessage(`Open persistent logs failed: ${detail}`);
        throw error;
      }
    })
  );
}

export function isPersistentLoggingEnabled(): boolean {
  return persistentLogger !== undefined;
}

export function getPersistentLogLevel(): PersistentLogLevel { return persistentLogLevel; }

export function setPersistentLogLevel(level: string): Promise<void> {
  if (!isPersistentLogLevel(level)) return Promise.reject(new Error("Choose Debug, Info, Warnings, or Errors."));
  return updatePersistentLoggingSettings({ level });
}

/** Recent redacted records only; a slow log store never blocks other actions. */
export async function exportPersistentLogs(): Promise<{ filename: string; text: string; limited: boolean }> {
  if (!loggingRegistration) throw new Error("Logging is still initializing. Retry shortly.");
  const file = path.join(loggingRegistration.storageRoot, "manager_logs.sqlite");
  await fs.access(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("No saved logs yet. Enable logging in Data & sync, then retry.");
    throw error;
  });
  const active = persistentLogger;
  const reading = (async () => {
    await active?.flush();
    const reader = new PersistentSqliteLogger(file, persistentLogRetentionDays);
    try { return await reader.readExport(); } finally { await reader.close(); }
  })();
  const result = await waitWithin(reading, 5_000, "Logs did not respond within 5 seconds. Retry after storage responds.");
  return {
    filename: `codex-manager-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    text: JSON.stringify({ format: "codex-manager-logs", version: 1, exportedAt: new Date().toISOString(),
      level: persistentLogLevel, retentionDays: persistentLogRetentionDays, ...result }),
    limited: result.limited
  };
}

export function getPersistentLogRetentionDays(): number {
  return persistentLogRetentionDays;
}

export function setPersistentLogRetentionDays(days: number): Promise<void> {
  if (!Number.isInteger(days) || days < 1 || days > 30) return Promise.reject(new Error("Choose a log retention from 1 to 30 days."));
  return updatePersistentLoggingSettings({ retentionDays: days });
}

export function setPersistentLoggingEnabled(enabled: boolean): Promise<void> {
  if (typeof enabled !== "boolean") return Promise.reject(new Error("Choose whether persistent logging is enabled."));
  return updatePersistentLoggingSettings({ enabled });
}

export function clearPersistentLogs(): Promise<void> {
  return runCrossWindowExclusive("preferences:file-logging", "Clear system log", async () => {
    if (!loggingRegistration) throw new Error("System Log is still initializing. Retry shortly.");
    await clearLogStorage(loggingRegistration.storageRoot, !isPersistentLoggingEnabled());
  });
}

async function clearLogStorage(storageRoot: string, disable: boolean): Promise<void> {
  const logger = persistentLogger ?? new PersistentSqliteLogger(path.join(storageRoot, "manager_logs.sqlite"));
  try {
    await logger.clear(disable);
    await withLoggingSettingsStore(storageRoot, store => {
      store.prepare("DELETE FROM state WHERE namespace='legacy-files' AND key LIKE 'logs/%'").run();
    });
  } finally { if (logger !== persistentLogger) await logger.close(); }
}

type LoggingSettings = { enabled: boolean; retentionDays: number; level: PersistentLogLevel };

async function readLoggingSettings(storageRoot: string): Promise<LoggingSettings> {
  const text = await withLoggingSettingsStore(storageRoot, store => store.get<{ text: string | null }>("files", "logging-settings.json")?.text);
  let value: Partial<LoggingSettings> | undefined;
  try { value = text ? JSON.parse(text) as Partial<LoggingSettings> : undefined; }
  catch { /* An explicit settings update can repair a partial preference file. */ }
  return { enabled: value?.enabled === true, level: isPersistentLogLevel(value?.level) ? value.level : "info", retentionDays: Number.isInteger(value?.retentionDays) && value!.retentionDays! >= 1 && value!.retentionDays! <= 30 ? value!.retentionDays! : PERSISTENT_LOG_RETENTION_DAYS };
}

async function withLoggingSettingsStore<T>(storageRoot: string, task: (store: SqliteStateStore) => T): Promise<T> {
  const shared = sqliteStoreForFile(path.join(storageRoot, "logging-settings.json"));
  const store = shared ?? await SqliteStateStore.open(path.join(storageRoot, "manager.sqlite"));
  try { return task(store); } finally { if (!shared) store.close(); }
}

/** Commit the preference atomically before replacing the active logger. */
async function updatePersistentLoggingSettings(patch: Partial<LoggingSettings>): Promise<void> {
  const request = JSON.stringify(patch);
  if (loggingUpdate) {
    if (loggingUpdateRequest === request) return loggingUpdate;
    throw new Error("Persistent logging is still updating. Retry after the current update finishes.");
  }
  loggingUpdateRequest = request;
  const update:Promise<void> = runCrossWindowExclusive("preferences:file-logging", "Persistent logging update", async () => {
    if (!loggingRegistration) throw new Error("Persistent logging is still initializing. Retry shortly.");
    const { context, storageRoot } = loggingRegistration;
    const epoch = loggingEpoch;
    const settings = { ...await readLoggingSettings(storageRoot), ...patch };
    const candidate = settings.enabled && !persistentLogger ? await createPersistentLogger(storageRoot, settings.retentionDays) : undefined;
    const retentionChanged = persistentLogRetentionDays !== settings.retentionDays;
    try {
      if (epoch !== loggingEpoch) throw new Error("Logging update was interrupted because the host stopped.");
      if (Object.keys(patch).length > 0)
        await withLoggingSettingsStore(storageRoot, store => store.set("files", "logging-settings.json", { text: JSON.stringify(settings) }));
      if (epoch !== loggingEpoch) throw new Error("Logging settings were saved; reload the window to apply them.");
    } catch (error) {
      await candidate?.close().catch(() => undefined);
      throw error;
    }
    if (!settings.enabled) {
      await disposePersistentLogging();
      if (patch.enabled === false) await clearLogStorage(storageRoot, true);
    }
    else if (candidate) {
      await candidate.setRecordingEnabled(true);
      persistentLogger = candidate;
      restoreGlobalCapture = installGlobalFailureCapture(candidate, context.extensionPath);
    }
    persistentLogRetentionDays = settings.retentionDays;
    persistentLogLevel = settings.level;
    persistentLogger?.setLevel(settings.level);
    persistentLogger?.setRetentionDays(settings.retentionDays);
    if ((patch.retentionDays || (retentionChanged && Object.keys(patch).length > 0)) && persistentLogger)
      await persistentLogger.pruneExpiredLogs();
    fireSqliteConfigurationChanges(["persistentLoggingEnabled","persistentLogRetentionDays","persistentLogLevel"]);
  }).finally(() => { if (loggingUpdate === update) { loggingUpdate = undefined; loggingUpdateRequest = ""; } });
  loggingUpdate = update;
  return update;
}

async function createPersistentLogger(storageRoot: string, retentionDays: number): Promise<PersistentSqliteLogger> {
  const logger = new PersistentSqliteLogger(path.join(storageRoot, "manager_logs.sqlite"), retentionDays, () => new Date(),
    error => console.warn("[codexManager] diagnostic log write failed; retrying on the next event", toErrorMessage(error)));
  logger.setLevel(persistentLogLevel);
  try { await logger.initialize(); } catch (error) { await logger.close().catch(() => undefined); throw error; }
  return logger;
}

export async function disposePersistentLogging(stopWatching = false): Promise<void> {
  loggingEpoch++;
  if (stopWatching) {
    stopLoggingSettings?.(); loggingRegistration = undefined;
    loggingUpdate = undefined; loggingUpdateRequest = "";
  }
  restoreGlobalCapture?.();
  restoreGlobalCapture = undefined;
  const logger = persistentLogger;
  persistentLogger = undefined;
  if (!logger) {
    return;
  }
  logger.write("info", "lifecycle", "Persistent logging stopped");
  await logger.close().catch(() => undefined);
}

export function recordPersistentEvent(
  level: PersistentLogLevel,
  scope: string,
  message: string,
  details?: unknown,
  error?: unknown
): void {
  persistentLogger?.write(level, scope, message, details, error);
}

export async function runWithPersistentOperation<T>(
  name: string,
  action: () => T | Thenable<T>,
  details?: Record<string, unknown>,
  classifyResult?: (result: T) => OperationResult
): Promise<T> {
  const parent = operationContext.getStore();
  const operationId = randomUUID();
  const traceId = parent?.traceId ?? operationId;
  const startedAt = Date.now();
  const correlation = {
    operationId,
    traceId,
    parentOperationId: parent?.operationId
  };
  persistentLogger?.write("info", "operation", `${name} started`, details, undefined, correlation);

  return operationContext.run({ operationId, traceId }, async () => {
    try {
      const result = await action();
      const outcome = classifyResult?.(result) ?? { status: "completed" as const };
      persistentLogger?.write(
        outcome.status === "completed" ? "info" : outcome.status === "cancelled" ? "warning" : "error",
        "operation",
        `${name} ${outcome.status}`,
        outcome.errorMessage ? { ...details, errorMessage: outcome.errorMessage } : details,
        undefined,
        { ...correlation, durationMs: Date.now() - startedAt }
      );
      return result;
    } catch (error) {
      const cancelled = /cancel(?:led|lation)/i.test(toErrorMessage(error));
      persistentLogger?.write(
        cancelled ? "warning" : "error",
        "operation",
        `${name} ${cancelled ? "cancelled" : "failed"}`,
        details,
        error,
        { ...correlation, durationMs: Date.now() - startedAt }
      );
      throw error;
    }
  });
}

function installGlobalFailureCapture(logger: PersistentSqliteLogger, extensionPath: string): () => void {
  const original = {
    debug: console.debug,
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error
  };

  console.debug = (...args: unknown[]): void => {
    original.debug(...args);
    captureOwnedConsoleCall(logger, "debug", args, extensionPath);
  };
  console.log = (...args: unknown[]): void => {
    original.log(...args);
    captureOwnedConsoleCall(logger, "info", args, extensionPath);
  };
  console.info = (...args: unknown[]): void => {
    original.info(...args);
    captureOwnedConsoleCall(logger, "info", args, extensionPath);
  };
  console.warn = (...args: unknown[]): void => {
    original.warn(...args);
    captureOwnedConsoleCall(logger, "warning", args, extensionPath);
  };
  console.error = (...args: unknown[]): void => {
    original.error(...args);
    captureOwnedConsoleCall(logger, "error", args, extensionPath);
  };

  const onUnhandledRejection = (reason: unknown): void => {
    if (isOwnedRuntimeFailure(reason, extensionPath)) {
      logger.write("error", "runtime", "Unhandled promise rejection", undefined, reason);
    }
  };
  const onUncaughtExceptionMonitor = (error: Error, origin: NodeJS.UncaughtExceptionOrigin): void => {
    if (isOwnedRuntimeFailure(error, extensionPath)) {
      logger.write("error", "runtime", `Uncaught exception (${origin})`, undefined, error);
    }
  };
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);

  return () => {
    console.debug = original.debug;
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);
  };
}

function captureOwnedConsoleCall(
  logger: PersistentSqliteLogger,
  level: PersistentLogLevel,
  args: readonly unknown[],
  extensionPath: string
): void {
  const callStack = new Error().stack ?? "";
  if (!isOwnedConsoleCall(callStack, extensionPath)) {
    return;
  }
  const error = args.find((value): value is Error => value instanceof Error);
  logger.write(level, "console", formatConsoleArguments(args), undefined, error);
}

function isOwnedConsoleCall(stack: string, extensionPath: string): boolean {
  const normalizedRoot = normalizePathForComparison(extensionPath);
  return stack
    .split("\n")
    .filter((line) => !line.toLowerCase().includes("persistentlog"))
    .some((line) => normalizePathForComparison(line).includes(normalizedRoot));
}

function isOwnedRuntimeFailure(error: unknown, extensionPath: string): boolean {
  const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return normalizePathForComparison(stack).includes(normalizePathForComparison(extensionPath));
}

function formatConsoleArguments(args: readonly unknown[]): string {
  return args
    .map((value) => {
      if (typeof value === "string") {
        return redactDebugText(value);
      }
      if (value instanceof Error) {
        return `${value.name}: ${redactDebugText(value.message)}`;
      }
      try {
        return JSON.stringify(sanitizeLogValue(value));
      } catch {
        return redactDebugText(String(value));
      }
    })
    .join(" ");
}

function serializeError(error: unknown, seen = new WeakSet<object>()): unknown {
  if (!(error instanceof Error)) {
    return sanitizeLogValue(error, seen);
  }
  if (seen.has(error)) {
    return "[circular error]";
  }
  seen.add(error);
  const withMetadata = error as Error & { code?: unknown; cause?: unknown };
  const serialized = {
    name: error.name,
    message: redactDebugText(error.message),
    stack: error.stack ? redactDebugText(error.stack) : undefined,
    code: sanitizeLogValue(withMetadata.code, seen),
    cause: withMetadata.cause === undefined ? undefined : serializeError(withMetadata.cause, seen)
  };
  seen.delete(error);
  return serialized;
}

function sanitizeLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return redactDebugText(value);
  }
  if (value instanceof Error) {
    return serializeError(value);
  }
  if (typeof value === "bigint") {
    return `[bigint:${value.toString()}]`;
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const sanitizedArray = value.map((entry) => sanitizeLogValue(entry, seen));
    seen.delete(value);
    return sanitizedArray;
  }
  const sanitized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      isSensitiveField(key) ? "[redacted]" : sanitizeLogValue(entry, seen)
    ])
  );
  seen.delete(value);
  return sanitized;
}

function serializeLogRecord(record: PersistentLogRecord): string {
  const serialized = JSON.stringify(record);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= MAX_PERSISTENT_LOG_RECORD_BYTES) {
    return `${serialized}\n`;
  }
  return `${JSON.stringify({
    timestamp: record.timestamp,
    hostRunId: record.hostRunId,
    sequence: record.sequence,
    level: record.level,
    scope: record.scope.slice(0, 512),
    message: record.message.slice(0, 4096),
    operationId: record.operationId,
    traceId: record.traceId,
    parentOperationId: record.parentOperationId,
    durationMs: record.durationMs,
    details: { truncated: true, originalBytes: bytes },
    error: record.error === undefined ? undefined : { message: "Oversized error detail was truncated" }
  })}\n`;
}

function isSensitiveField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
  return (
    normalized.includes("token") ||
    normalized.includes("authorization") ||
    normalized.includes("apikey") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("cookie") ||
    normalized === "email" ||
    normalized.endsWith("email") ||
    normalized.endsWith("userid") ||
    normalized.endsWith("accountid") ||
    normalized.endsWith("organizationid") ||
    normalized.endsWith("workspaceid")
  );
}

function normalizePathForComparison(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function toUtcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function toErrorMessage(error: unknown): string {
  return redactDebugText(error instanceof Error ? error.message : String(error));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
