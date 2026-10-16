import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { redactDebugText } from "./debug";
import { getCodexManagerStorageRoot } from "./storageRoot";
import { readSafeFileSnapshot } from "./safeFileReads";
import { sqliteStoreForFile, writeSqliteStateFile } from "../storage/sqliteState";
import { runCrossWindowExclusive } from "./crossWindowOperations";

export const PERSISTENT_LOG_RETENTION_DAYS = 3;
const LOG_FILE_PREFIX = "codex-manager-";
const LOG_FILE_PATTERN = /^codex-manager-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.jsonl$/;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_PERSISTENT_LOG_RECORD_BYTES = 64 * 1024;
const MAX_PENDING_LOG_RECORDS = 128;
const MAX_PENDING_LOG_BYTES = 2 * 1024 * 1024;

type PersistentLogLevel = "debug" | "info" | "warning" | "error";
type OperationStatus = "completed" | "cancelled" | "failed";
type OperationResult = { status: OperationStatus; errorMessage?: string };

type OperationContext = {
  operationId: string;
  traceId: string;
};

type PersistentLogRecord = {
  timestamp: string;
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

const operationContext = new AsyncLocalStorage<OperationContext>();
let persistentLogger: PersistentFileLogger | undefined;
let restoreGlobalCapture: (() => void) | undefined;
let loggingRegistration: { context: vscode.ExtensionContext; storageRoot: string } | undefined;
let loggingUpdate: Promise<void> | undefined;
let loggingUpdateRequest = "";
let persistentLogRetentionDays = PERSISTENT_LOG_RETENTION_DAYS;

/** A small JSONL logger so diagnostics do not depend on an external runtime or native module. */
export class PersistentFileLogger {
  private writeChain: Promise<void> = Promise.resolve();
  private writeError: unknown;
  private writeFailureReported = false;
  private activeUtcDate: string | undefined;
  private pendingWrites = 0;
  private pendingBytes = 0;
  private droppedRecords = 0;

  constructor(
    readonly logDirectory: string,
    private retentionDays = PERSISTENT_LOG_RETENTION_DAYS,
    private readonly now: () => Date = () => new Date(),
    private readonly onWriteFailure?: (error: unknown) => void,
    private readonly appendFile: typeof fs.appendFile = fs.appendFile
  ) {}

  get currentLogPath(): string {
    return path.join(this.logDirectory, `${LOG_FILE_PREFIX}${toUtcDate(this.now())}.jsonl`);
  }

  setRetentionDays(days: number): void {
    this.retentionDays = days;
  }

  async ensureCurrentLog(): Promise<void> {
    await fs.mkdir(this.logDirectory, { recursive: true });
    if (this.writeError !== undefined || !(await fs.stat(this.currentLogPath).catch(() => undefined))) {
      this.write("info", "lifecycle", "Persistent log file opened after date rollover");
      await this.flush();
    }
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.logDirectory, { recursive: true });
    await this.pruneExpiredLogs();
    this.activeUtcDate = toUtcDate(this.now());
    this.write("info", "lifecycle", "Persistent logging initialized", {
      retentionDays: this.retentionDays,
      logFile: this.currentLogPath
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
    const targetPath = path.join(this.logDirectory, `${LOG_FILE_PREFIX}${utcDate}.jsonl`);
    const dayChanged = this.activeUtcDate !== undefined && this.activeUtcDate !== utcDate;
    this.activeUtcDate = utcDate;
    this.writeChain = this.writeChain
      .then(async () => {
        if (dayChanged) {
          await this.pruneExpiredLogs();
        }
        await this.appendFile(targetPath, line, "utf8");
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
    const entries = await fs.readdir(this.logDirectory, { withFileTypes: true });
    const currentDay = startOfUtcDay(this.now());
    const oldestRetainedDay = currentDay - (this.retentionDays - 1) * MILLISECONDS_PER_DAY;
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) {
          return;
        }
        const match = LOG_FILE_PATTERN.exec(entry.name);
        if (!match?.[1]) {
          return;
        }
        const fileDay = Date.parse(`${match[1]}T00:00:00.000Z`);
        if (Number.isNaN(fileDay) || fileDay >= oldestRetainedDay) {
          return;
        }
        await fs.unlink(path.join(this.logDirectory, entry.name));
      })
    );
  }
}

export async function registerPersistentLogging(
  context: vscode.ExtensionContext,
  storageRoot = getCodexManagerStorageRoot()
): Promise<void> {
  await disposePersistentLogging();
  loggingRegistration = { context, storageRoot };
  persistentLogRetentionDays = PERSISTENT_LOG_RETENTION_DAYS;
  try {
    const settings = await readLoggingSettings(storageRoot);
    persistentLogRetentionDays = settings.retentionDays;
    if (settings.enabled) {
      persistentLogger = await createPersistentLogger(storageRoot, settings.retentionDays);
      restoreGlobalCapture = installGlobalFailureCapture(persistentLogger, context.extensionPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") console.warn("[codexManager] file logging unavailable; disabled", error);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("codexManager.openPersistentLogs", async () => {
      try {
        const logger = persistentLogger;
        if (!logger) {
          void vscode.window.showInformationMessage("File logging is disabled. Enable it in Data & sync before opening logs.");
          return;
        }
        await logger.ensureCurrentLog();
        await logger.flush();
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(logger.currentLogPath));
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

export function getPersistentLogRetentionDays(): number {
  return persistentLogRetentionDays;
}

export function setPersistentLogRetentionDays(days: number): Promise<void> {
  if (!Number.isInteger(days) || days < 1 || days > 30) return Promise.reject(new Error("Choose a log retention from 1 to 30 days."));
  return updatePersistentLoggingSettings({ retentionDays: days });
}

export function setPersistentLoggingEnabled(enabled: boolean): Promise<void> {
  if (typeof enabled !== "boolean") return Promise.reject(new Error("Choose whether file logging is enabled."));
  return updatePersistentLoggingSettings({ enabled });
}

type LoggingSettings = { enabled: boolean; retentionDays: number };

async function readLoggingSettings(storageRoot: string): Promise<LoggingSettings> {
  const snapshot = await readSafeFileSnapshot(path.join(storageRoot, "logging-settings.json"), { maxBytes: 1024, rejectIfLarger: true })
    .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  let value: Partial<LoggingSettings> | undefined;
  try { value = snapshot ? JSON.parse(snapshot.buffer.toString("utf8")) as Partial<LoggingSettings> : undefined; }
  catch { /* An explicit settings update can repair a partial preference file. */ }
  return { enabled: value?.enabled === true, retentionDays: Number.isInteger(value?.retentionDays) && value!.retentionDays! >= 1 && value!.retentionDays! <= 30 ? value!.retentionDays! : PERSISTENT_LOG_RETENTION_DAYS };
}

/** Commit the preference atomically before replacing the active logger. */
async function updatePersistentLoggingSettings(patch: Partial<LoggingSettings>): Promise<void> {
  const request = JSON.stringify(patch);
  if (loggingUpdate) {
    if (loggingUpdateRequest === request) return loggingUpdate;
    throw new Error("File logging is still updating. Retry after the current update finishes.");
  }
  loggingUpdateRequest = request;
  loggingUpdate = runCrossWindowExclusive("preferences:file-logging", "File logging update", async () => {
    if (!loggingRegistration) throw new Error("File logging is still initializing. Retry shortly.");
    const { context, storageRoot } = loggingRegistration;
    const settings = { ...await readLoggingSettings(storageRoot), ...patch };
    const candidate = settings.enabled && !persistentLogger ? await createPersistentLogger(storageRoot, settings.retentionDays) : undefined;
    const file = path.join(storageRoot, "logging-settings.json");
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      if (sqliteStoreForFile(file)) writeSqliteStateFile(file, JSON.stringify(settings));
      else {
        await fs.mkdir(storageRoot, { recursive: true });
        await fs.writeFile(temporary, JSON.stringify(settings), { mode: 0o600, flag: "wx" });
        await fs.rename(temporary, file);
      }
    } catch (error) {
      await candidate?.flush().catch(() => undefined);
      throw error;
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
    if (!settings.enabled) await disposePersistentLogging();
    else if (candidate) {
      persistentLogger = candidate;
      restoreGlobalCapture = installGlobalFailureCapture(candidate, context.extensionPath);
    }
    persistentLogRetentionDays = settings.retentionDays;
    persistentLogger?.setRetentionDays(settings.retentionDays);
    if (patch.retentionDays && persistentLogger)
      await persistentLogger.pruneExpiredLogs().catch(error => console.warn("[codexManager] log retention cleanup delayed", error));
  }).finally(() => { loggingUpdate = undefined; loggingUpdateRequest = ""; });
  return loggingUpdate;
}

async function createPersistentLogger(storageRoot: string, retentionDays: number): Promise<PersistentFileLogger> {
  const logger = new PersistentFileLogger(path.join(storageRoot, "logs"), retentionDays, () => new Date(),
    error => console.warn("[codexManager] diagnostic log write failed; retrying on the next event", toErrorMessage(error)));
  await logger.initialize();
  return logger;
}

export async function disposePersistentLogging(): Promise<void> {
  restoreGlobalCapture?.();
  restoreGlobalCapture = undefined;
  const logger = persistentLogger;
  persistentLogger = undefined;
  if (!logger) {
    return;
  }
  logger.write("info", "lifecycle", "Persistent logging stopped");
  await logger.flush().catch(() => undefined);
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

function installGlobalFailureCapture(logger: PersistentFileLogger, extensionPath: string): () => void {
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
  logger: PersistentFileLogger,
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

function startOfUtcDay(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function toErrorMessage(error: unknown): string {
  return redactDebugText(error instanceof Error ? error.message : String(error));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
