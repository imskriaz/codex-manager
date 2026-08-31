import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { redactDebugText } from "./debug";

export const PERSISTENT_LOG_RETENTION_DAYS = 3;
const LOG_FILE_PREFIX = "codex-manager-";
const LOG_FILE_PATTERN = /^codex-manager-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.jsonl$/;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_PERSISTENT_LOG_RECORD_BYTES = 64 * 1024;

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

/** A small JSONL logger so diagnostics do not depend on an external runtime or native module. */
export class PersistentFileLogger {
  private writeChain: Promise<void> = Promise.resolve();
  private writeError: unknown;
  private writeFailureReported = false;
  private activeUtcDate: string | undefined;

  constructor(
    readonly logDirectory: string,
    private readonly retentionDays = PERSISTENT_LOG_RETENTION_DAYS,
    private readonly now: () => Date = () => new Date(),
    private readonly onWriteFailure?: (error: unknown) => void
  ) {}

  get currentLogPath(): string {
    return path.join(this.logDirectory, `${LOG_FILE_PREFIX}${toUtcDate(this.now())}.jsonl`);
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
    const utcDate = toUtcDate(recordTime);
    const targetPath = path.join(this.logDirectory, `${LOG_FILE_PREFIX}${utcDate}.jsonl`);
    const dayChanged = this.activeUtcDate !== undefined && this.activeUtcDate !== utcDate;
    this.activeUtcDate = utcDate;
    this.writeChain = this.writeChain
      .then(async () => {
        if (dayChanged) {
          await this.pruneExpiredLogs();
        }
        await fs.appendFile(targetPath, line, "utf8");
        this.writeError = undefined;
        this.writeFailureReported = false;
      })
      .catch((caught: unknown) => {
        this.writeError = caught;
        if (!this.writeFailureReported) {
          this.writeFailureReported = true;
          this.onWriteFailure?.(caught);
        }
      });
  }

  async flush(): Promise<void> {
    await this.writeChain;
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

export async function registerPersistentLogging(context: vscode.ExtensionContext): Promise<void> {
  await disposePersistentLogging();
  const logger = new PersistentFileLogger(
    path.join(context.globalStorageUri.fsPath, "logs"),
    PERSISTENT_LOG_RETENTION_DAYS,
    () => new Date(),
    (error) => {
      void vscode.window.showWarningMessage(
        `Codex Manager could not continue writing its diagnostic log: ${toErrorMessage(error)}. ` +
          "Run “Codex Manager: Open Persistent Logs” to inspect the log location."
      );
    }
  );
  await logger.initialize();
  persistentLogger = logger;
  restoreGlobalCapture = installGlobalFailureCapture(logger, context.extensionPath);

  context.subscriptions.push(
    vscode.commands.registerCommand("codexManager.openPersistentLogs", async () => {
      try {
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
    scope: record.scope,
    message: record.message,
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
