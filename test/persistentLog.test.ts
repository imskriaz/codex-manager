import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { disposePersistentLogging, PersistentSqliteLogger, registerPersistentLogging, runWithPersistentOperation } from "../src/utils/persistentLog";
import { configureSqliteStateStore, SqliteStateStore } from "../src/storage/sqliteState";
import { removeTestDirectory } from "./testFilesystem";
import { EncryptedSyncManager } from "../src/services/encryptedSync";

vi.mock("fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("fs/promises")>() }));

const temporaryDirectories: string[] = [];
const loggers: PersistentSqliteLogger[] = [];
afterEach(async () => {
  await disposePersistentLogging(true);
  for (const logger of loggers.splice(0)) await logger.close().catch(() => undefined);
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(directory => removeTestDirectory(directory)));
});
async function root() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "manager-log-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
function logger(directory: string, ...args: ConstructorParameters<typeof PersistentSqliteLogger> extends [string, ...infer Rest] ? Rest : never) {
  const result = new PersistentSqliteLogger(path.join(directory, "manager_logs.sqlite"), ...args);
  loggers.push(result);
  return result;
}
async function records(directory: string) {
  const store = await SqliteStateStore.open(path.join(directory, "manager_logs.sqlite"));
  try { return store.recent<Record<string, any>>("logs", 10_000); } finally { store.close(); }
}
async function enable(directory: string) {
  const store = await SqliteStateStore.open(path.join(directory, "manager.sqlite"));
  store.set("files", "logging-settings.json", { text: JSON.stringify({ enabled: true, retentionDays: 3 }) });
  store.close();
}
async function register(directory: string) {
  (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = vi.fn(() => ({ dispose: vi.fn() }));
  await registerPersistentLogging({ extensionPath: path.join(directory, "extension"), subscriptions: [] } as never, directory);
}

describe("SQLite persistent diagnostics", () => {
  it.each([false, true].flatMap(enabled => ["missing", "empty-temp", "empty-canonical", "damaged", "vanished-temp", "denied-temp", "backup-full"].map(vault => ({ enabled, vault }))))(
    "respects System Log for startup recovery without notifications ($enabled, $vault)", async ({ enabled, vault }) => {
      const directory = await root();
      if (enabled) await enable(directory);
      await register(directory);
      vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
        get: (key: string, fallback?: unknown) => key === "encryptedSyncEnabled" ? false : fallback
      } as unknown as vscode.WorkspaceConfiguration);
      const accountsDirectory = path.join(directory, "accounts");
      const temporary = vault.endsWith("temp");
      const file = path.join(accountsDirectory, `saved@example.com.json${temporary ? ".tmp-interrupted" : ""}`);
      if (vault !== "missing" && vault !== "backup-full") {
        await fs.mkdir(accountsDirectory);
        await fs.writeFile(file, vault === "damaged" ? "damaged" : "");
      }
      if (vault === "vanished-temp" || vault === "denied-temp") {
        const stat = fs.stat;
        vi.spyOn(fs, "stat").mockImplementation(((target: Parameters<typeof stat>[0], ...args: unknown[]) => {
          if (target === file) return Promise.reject(Object.assign(new Error(vault), { code: vault === "vanished-temp" ? "ENOENT" : "EPERM" }));
          return Reflect.apply(stat, fs, [target, ...args]);
        }) as typeof stat);
      }
      const context = {
        subscriptions: [],
        globalState: { get: (_key: string, fallback?: unknown) => fallback, update: vi.fn(), setKeysForSync: vi.fn() },
        secrets: { get: async (key: string) => key.endsWith("passphrase") ? "test shared password" : "device-one", store: vi.fn(), delete: vi.fn() }
      } as unknown as vscode.ExtensionContext;
      const repo = {
        listAccounts: vi.fn(async () => {
          if (vault === "backup-full") throw Object.assign(new Error("backup storage full"), { code: "ENOSPC" });
          return [];
        }),
        exportSharedAccounts: vi.fn(async () => []),
        invalidateCachedIndex: vi.fn()
      };
      const warning = vi.spyOn(vscode.window, "showWarningMessage").mockClear();
      const information = vi.spyOn(vscode.window, "showInformationMessage").mockClear();
      const consoleWarning = vi.spyOn(console, "warn");
      const manager = new EncryptedSyncManager(context, repo as never, path.join(directory, "encrypted-accounts-vault.json"));
      try {
        await manager.start();
        await (manager as unknown as { durableVaultWriteChain: Promise<void> }).durableVaultWriteChain.catch(() => undefined);
        expect(warning).not.toHaveBeenCalled();
        expect(information).not.toHaveBeenCalled();
        expect(consoleWarning).not.toHaveBeenCalled();
        if (vault !== "missing" && vault !== "backup-full") {
          expect(await fs.readFile(file, "utf8")).toBe(vault === "damaged" ? "damaged" : "");
        }
        await disposePersistentLogging();
        if (enabled) {
          const saved = await records(directory);
          const startup = saved.find(record => record.scope === "startup");
          expect(startup).toBeDefined();
          const failed = ["empty-canonical", "damaged"].includes(vault);
          expect(startup?.level).toBe(failed ? "warning" : "info");
          if (failed) expect(startup?.error).toBeDefined();
          else expect(startup?.details).toMatchObject({ unreadableVaultCount: 0 });
          if (vault === "denied-temp") expect(saved).toContainEqual(expect.objectContaining({ scope: "account-vault", level: "warning", error: expect.objectContaining({ code: "EPERM" }) }));
          if (vault === "backup-full") expect(saved).toContainEqual(expect.objectContaining({ scope: "account-vault", level: "warning", error: expect.objectContaining({ message: "backup storage full" }) }));
          expect(JSON.stringify(saved)).not.toContain("saved@example.com");
          expect(JSON.stringify(saved)).not.toContain("test shared password");
        } else await expect(fs.access(path.join(directory, "manager_logs.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
        if (vault === "empty-canonical" || vault === "damaged") {
          await manager.configure({ passphrase: "test shared password", confirmation: "test shared password", deferSync: true });
          expect(warning).toHaveBeenCalledWith(expect.stringContaining("durable account recovery did not complete"));
        }
      } finally { manager.dispose(); }
    }
  );

  it("starts without waiting for old-log cleanup and cancels its background timer on close", async () => {
    vi.useFakeTimers();
    try {
      const directory = await root(), log = logger(directory);
      const cleanup = vi.spyOn(log, "pruneExpiredLogs").mockImplementation(() => new Promise(() => undefined));
      await log.initialize(); expect(cleanup).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000); expect(cleanup).toHaveBeenCalledOnce();
      await log.close();
    } finally { vi.useRealTimers(); }
  });
  it("filters expired records before background cleanup and removes them when cleanup is requested", async () => {
    const directory = await root(), file = path.join(directory, "manager_logs.sqlite");
    const seed = await SqliteStateStore.open(file);
    seed.set("logs", "2026-10-01T12:00:00.000Z:old", { message: "expired" });
    seed.set("unrelated", "keep", true); seed.close();
    const log = logger(directory, 3, () => new Date("2026-10-18T12:00:00Z")); await log.initialize();
    expect((await log.readExport()).records).not.toEqual(expect.arrayContaining([expect.objectContaining({ message: "expired" })]));
    await log.pruneExpiredLogs();
    const check = await SqliteStateStore.open(file);
    try { expect(check.get("logs", "2026-10-01T12:00:00.000Z:old")).toBeUndefined(); expect(check.get("unrelated", "keep")).toBe(true); }
    finally { check.close(); }
  });
  it("applies logging preferences committed by another window",async()=>{
    const directory=await root(),store=await SqliteStateStore.open(path.join(directory,"manager.sqlite"));
    const peer=await SqliteStateStore.open(store.file);configureSqliteStateStore(store);
    const {isPersistentLoggingEnabled,getPersistentLogRetentionDays,getPersistentLogLevel}=await import("../src/utils/persistentLog");
    try {
      await register(directory);
      peer.set("files","logging-settings.json",{text:JSON.stringify({enabled:true,retentionDays:7,level:"debug"})});
      await vi.waitFor(()=>{expect(isPersistentLoggingEnabled()).toBe(true);expect(getPersistentLogRetentionDays()).toBe(7);expect(getPersistentLogLevel()).toBe("debug");});
      peer.set("files","logging-settings.json",{text:JSON.stringify({enabled:false,retentionDays:3})});
      await vi.waitFor(()=>expect(isPersistentLoggingEnabled()).toBe(false));
    } finally {await disposePersistentLogging(true);configureSqliteStateStore(undefined);peer.close();store.close();}
  });

  it("does not install a late logger after the owning host shuts down",async()=>{
    const directory=await root();await register(directory);
    const {setPersistentLoggingEnabled,isPersistentLoggingEnabled}=await import("../src/utils/persistentLog");
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    const initialize=PersistentSqliteLogger.prototype.initialize;
    const paused=vi.spyOn(PersistentSqliteLogger.prototype,"initialize").mockImplementationOnce(async function(){await gate;await initialize.call(this);});
    const enabling=setPersistentLoggingEnabled(true);
    const failed=expect(enabling).rejects.toThrow("interrupted");
    await vi.waitFor(()=>expect(paused).toHaveBeenCalledOnce());await disposePersistentLogging(true);release();
    await failed;expect(isPersistentLoggingEnabled()).toBe(false);
  });

  it("bounds queued records during slow storage and records skipped events", async () => {
    const directory = await root();
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const append = vi.fn(async (store: SqliteStateStore, key: string, record: unknown) => { await paused; store.set("logs", key, record); });
    const log = logger(directory, 3, () => new Date(), undefined, append);
    const readDetail = vi.fn(() => "value");
    for (let i = 0; i < 500; i++) log.write("info", "test", "queued", { get detail() { return readDetail(); } });
    expect(readDetail).toHaveBeenCalledTimes(128);
    await vi.waitFor(() => expect(append).toHaveBeenCalledOnce());
    resume();
    await log.flush();
    expect(append).toHaveBeenCalledTimes(129);
    expect(await log.readRecent()).toContain('"droppedRecords":372');
    log.write("info", "test", "recovered");
    expect(await log.readRecent()).toContain("recovered");
  });

  it("caps queued bytes and bounds oversized records", async () => {
    const directory = await root();
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const append = vi.fn(async (store: SqliteStateStore, key: string, record: unknown) => { await paused; store.set("logs", key, record); });
    const log = logger(directory, 3, () => new Date(), undefined, append);
    for (let i = 0; i < 128; i++) log.write("info", "test", "queued bytes", { value: "x".repeat(30_000) });
    resume();
    await log.flush();
    expect(append.mock.calls.reduce((sum, args) => sum + Buffer.byteLength(JSON.stringify(args[2])), 0)).toBeLessThan(2 * 1024 * 1024 + 1024);
    log.write("info", "test", "x".repeat(100_000));
    await log.flush();
    const last = JSON.stringify(append.mock.calls.at(-1)?.[2]);
    expect(Buffer.byteLength(last)).toBeLessThan(64 * 1024);
    expect(last).toContain('"truncated":true');
  });

  it("keeps three UTC days, redacts private data, and retains unrelated state", async () => {
    const directory = await root();
    const seed = await SqliteStateStore.open(path.join(directory, "manager_logs.sqlite"));
    for (const day of ["2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"])
      seed.set("logs", `${day}T12:00:00.000Z:seed`, { timestamp: `${day}T12:00:00.000Z`, message: day });
    seed.set("unrelated", "keep", true);
    seed.close();
    let now = new Date("2026-08-29T12:00:00.000Z");
    const log = logger(directory, 3, () => now);
    await log.initialize();
    log.write("error", "test", "Request for dev@example.com failed", { accessToken: "secret-token-value", accountId: "account-123", safe: "visible" }, new Error("outer failure", { cause: new Error("Bearer secret-token-value") }));
    const content = await log.readRecent();
    expect(content).not.toContain("2026-08-25");
    expect(content).not.toContain("2026-08-26");
    expect(content).toContain("2026-08-27");
    expect(content).toContain("2026-08-28");
    expect(content).toContain("Request for [redacted-email] failed");
    expect(content).toContain('"accessToken":"[redacted]"');
    expect(content).toContain('"accountId":"[redacted]"');
    expect(content).toContain('"safe":"visible"');
    expect(content).toContain("outer failure");
    expect(content).toContain("cause");
    expect(content).not.toContain("secret-token-value");
    expect(content).not.toContain("dev@example.com");
    now = new Date("2026-08-30T00:01:00.000Z");
    log.write("info", "test", "next day");
    expect(await log.readRecent()).not.toContain("2026-08-27");
    const check = await SqliteStateStore.open(log.databasePath);
    expect(check.get("unrelated", "keep")).toBe(true);
    check.close();
    expect((await fs.readdir(directory)).every(name => name.startsWith("manager_logs.sqlite"))).toBe(true);
  });

  it("persists operation failures, duration, and nested correlation across reopen", async () => {
    const directory = await root();
    await enable(directory); await register(directory);
    await expect(runWithPersistentOperation("dashboard:refresh", () => runWithPersistentOperation("command:Refresh quota", async () => { throw new Error("network unavailable"); }))).rejects.toThrow("network unavailable");
    await disposePersistentLogging();
    const saved = await records(directory);
    const parent = saved.find(record => record.message === "dashboard:refresh started");
    const child = saved.find(record => record.message === "command:Refresh quota started");
    const failed = saved.find(record => record.message === "command:Refresh quota failed");
    expect(child?.traceId).toBe(parent?.traceId);
    expect(child?.parentOperationId).toBe(parent?.operationId);
    expect(failed?.operationId).toBe(child?.operationId);
    expect(failed?.durationMs).toEqual(expect.any(Number));
    expect(failed?.error).toMatchObject({ message: "network unavailable" });
  });

  it("keeps logs opt-in and preferences in the manager database", async () => {
    const directory = await root(); await register(directory);
    const { isPersistentLoggingEnabled, getPersistentLogRetentionDays, setPersistentLogRetentionDays, setPersistentLoggingEnabled } = await import("../src/utils/persistentLog");
    expect(isPersistentLoggingEnabled()).toBe(false);
    expect(await fs.readdir(directory)).toEqual(["manager.sqlite"]);
    await setPersistentLogRetentionDays(30); await setPersistentLoggingEnabled(true);
    expect(isPersistentLoggingEnabled()).toBe(true);
    expect(getPersistentLogRetentionDays()).toBe(30);
    const store = await SqliteStateStore.open(path.join(directory, "manager.sqlite"));
    expect(JSON.parse(store.get<{ text: string }>("files", "logging-settings.json")!.text)).toEqual({ enabled: true, retentionDays: 30, level: "info" });
    expect(store.keys("logs")).toEqual([]);
    store.close();
    await expect(setPersistentLogRetentionDays(31)).rejects.toThrow("1 to 30 days");
    await setPersistentLoggingEnabled(false);
    expect(isPersistentLoggingEnabled()).toBe(false);
    await setPersistentLoggingEnabled(true);
    expect(isPersistentLoggingEnabled()).toBe(true);
    expect((await fs.readdir(directory)).some(name => /\.jsonl?$/.test(name))).toBe(false);
  });

  it("reports locked and full storage, preserves committed logs, and retries", async () => {
    const directory = await root(), failure = vi.fn();
    const log = logger(directory, 3, () => new Date(), failure);
    await log.initialize();
    const peer = new DatabaseSync(log.databasePath);
    try {
      peer.exec("BEGIN IMMEDIATE");
      log.write("error", "test", "blocked");
      await expect(log.flush()).rejects.toThrow(/locked|busy/i);
      expect(failure).toHaveBeenCalledOnce();
      peer.exec("ROLLBACK");
      const native = (log as unknown as { store: { database: DatabaseSync } }).store.database;
      native.exec(`PRAGMA max_page_count = ${native.prepare("PRAGMA page_count").get()!.page_count}`);
      log.write("info", "test", "x".repeat(60_000));
      await expect(log.flush()).rejects.toThrow(/full/i);
      native.exec("PRAGMA max_page_count = 100000");
      log.write("info", "test", "retried");
      const content = await log.readRecent();
      expect(content).toContain("Persistent logging initialized");
      expect(content).toContain("retried");
      expect(content).not.toContain('"message":"blocked"');
    } finally { peer.close(); }
  });

  it("reports retention cleanup failure to the initiating action and allows retry", async () => {
    const directory = await root(); await enable(directory); await register(directory);
    const { setPersistentLogRetentionDays } = await import("../src/utils/persistentLog");
    const failure = vi.spyOn(PersistentSqliteLogger.prototype, "pruneExpiredLogs").mockRejectedValueOnce(new Error("retention disk failure"));
    await expect(setPersistentLogRetentionDays(7)).rejects.toThrow("retention disk failure");
    failure.mockRestore();
    await expect(setPersistentLogRetentionDays(7)).resolves.toBeUndefined();
  });

  it("retains corrupt and future log databases without enabling logging", async () => {
    const directory = await root(); await enable(directory);
    const file = path.join(directory, "manager_logs.sqlite");
    await fs.writeFile(file, "damaged database");
    await register(directory);
    const { isPersistentLoggingEnabled, setPersistentLoggingEnabled } = await import("../src/utils/persistentLog");
    expect(isPersistentLoggingEnabled()).toBe(false);
    await expect(setPersistentLoggingEnabled(true)).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe("damaged database");
    await fs.unlink(file);
    const future = new DatabaseSync(file); future.exec("PRAGMA user_version = 2"); future.close();
    await expect(setPersistentLoggingEnabled(true)).rejects.toThrow("newer Codex Manager");
  });

  it("opens an in-memory diagnostic view and reports command failures", async () => {
    const directory = await root(); await enable(directory); await register(directory);
    const callback = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([command]) => command === "codexManager.openPersistentLogs")![1];
    const open = vi.fn(async () => ({ document: true }));
    const show = vi.fn();
    Object.assign(vscode.workspace, { openTextDocument: open });
    Object.assign(vscode.window, { showTextDocument: show });
    await callback();
    expect(open).toHaveBeenCalledWith({ content: expect.stringContaining("Persistent logging initialized"), language: "jsonl" });
    expect(show).toHaveBeenCalledOnce();
    open.mockRejectedValueOnce(new Error("viewer unavailable"));
    await expect(callback()).rejects.toThrow("viewer unavailable");
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("viewer unavailable"));
    expect((await fs.readdir(directory)).some(name => name.endsWith(".jsonl"))).toBe(false);
  });

  it("handles bigint and oversized diagnostic details", async () => {
    const directory = await root(); const log = logger(directory);
    await log.initialize();
    log.write("info", "test", "safe bigint", { sequence: BigInt("9007199254740993") });
    log.write("info", "test", "oversized", { huge: "x".repeat(70_000) });
    const content = await log.readRecent();
    expect(content).toContain('"truncated":true');
    expect(content).toContain("[bigint:9007199254740993]");
  });
});

it("filters before reading details and changes levels immediately without losing existing records", async () => {
  const directory = await root(); const log = logger(directory);
  await log.initialize();
  const detail = vi.fn(() => "expensive");
  log.write("debug", "test", "hidden debug", { get detail() { return detail(); } });
  expect(detail).not.toHaveBeenCalled();
  log.setLevel("debug"); log.write("debug", "test", "visible debug");
  log.setLevel("warning"); log.write("info", "test", "hidden info");
  log.write("warning", "test", "visible warning");
  log.setLevel("error"); log.write("warning", "test", "hidden warning");
  log.write("error", "test", "visible error");
  const saved = await log.readRecent();
  for (const value of ["hidden debug", "hidden info", "hidden warning"]) expect(saved).not.toContain(value);
  for (const value of ["visible debug", "visible warning", "visible error", "hostRunId", "sequence"]) expect(saved).toContain(value);
});

it("persists a validated log level, retains it across disable and restart, and supports dashboard updates", async () => {
  const directory = await root(); await register(directory);
  const { getPersistentLogLevel, setPersistentLogLevel, setPersistentLoggingEnabled } = await import("../src/utils/persistentLog");
  const { handleDashboardSettingUpdate } = await import("../src/presentation/dashboard/settings");
  expect(getPersistentLogLevel()).toBe("info");
  await expect(setPersistentLogLevel("verbose")).rejects.toThrow("Choose");
  await expect(handleDashboardSettingUpdate("persistentLogLevel", true)).resolves.toBe(false);
  await expect(handleDashboardSettingUpdate("persistentLogLevel", "debug")).resolves.toBe(true);
  await setPersistentLoggingEnabled(true); await setPersistentLoggingEnabled(false);
  await disposePersistentLogging(true); await register(directory);
  expect(getPersistentLogLevel()).toBe("debug");
});

it("clears saved logs when disabled and bounds redacted exports", async () => {
  const directory = await root(); await register(directory);
  const { exportPersistentLogs, setPersistentLoggingEnabled, recordPersistentEvent } = await import("../src/utils/persistentLog");
  await expect(exportPersistentLogs()).rejects.toThrow("No saved logs");
  await setPersistentLoggingEnabled(true);
  recordPersistentEvent("error", "test", "failure for dev@example.com", { accessToken: "secret-value" });
  await setPersistentLoggingEnabled(false);
  const exported = await exportPersistentLogs();
  expect(exported.filename).toMatch(/^codex-manager-logs-.*\.json$/);
  expect(exported.text).not.toContain("secret-value"); expect(exported.text).not.toContain("dev@example.com");
  expect(JSON.parse(exported.text)).toMatchObject({ format: "codex-manager-logs", level: "info", limited: false, records: [] });
  await logRecordingEnabled(directory);
  let eventTime = Date.now();
  const log = logger(directory, 3, () => new Date(eventTime++));
  for (let i = 0; i < 1050; i++) { log.write("info", "test", `event-${i}`); if (i % 100 === 0) await log.flush(); }
  const result = await log.readExport();
  expect(result.limited).toBe(true); expect(result.records).toHaveLength(1000);
  expect(result.records[0]).toMatchObject({ message: "event-50" });
  expect(result.records.at(-1)).toMatchObject({ message: "event-1049" });
  for (let i = 0; i < 20; i++) log.write("info", "test", "x".repeat(60000));
  const large = await log.readExport();
  expect(large.limited).toBe(true); expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(600000);
  expect(large.records.at(-1)).toMatchObject({ message: "x".repeat(60000) });
});

it("reports export storage errors and bounds an unresponsive flush", async () => {
  const directory = await root(); await enable(directory); await register(directory);
  const { exportPersistentLogs } = await import("../src/utils/persistentLog");
  const read = vi.spyOn(PersistentSqliteLogger.prototype, "readExport").mockRejectedValueOnce(new Error("locked logs"));
  await expect(exportPersistentLogs()).rejects.toThrow("locked logs");
  vi.useFakeTimers();
  try {
    read.mockImplementationOnce(() => new Promise(() => {}));
    const result = expect(exportPersistentLogs()).rejects.toThrow("5 seconds");
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(5001); await result;
  } finally { vi.useRealTimers(); read.mockRestore(); }
});

it("finishes a download if logging is disabled while the export is reading", async () => {
  const directory = await root(); await enable(directory); await register(directory);
  const { exportPersistentLogs, setPersistentLoggingEnabled } = await import("../src/utils/persistentLog");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = PersistentSqliteLogger.prototype.readExport;
  const read = vi.spyOn(PersistentSqliteLogger.prototype, "readExport").mockImplementationOnce(async function() {
    await gate; return original.call(this);
  });
  const download = exportPersistentLogs();
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  await setPersistentLoggingEnabled(false); release();
  expect(JSON.parse((await download).text).records).toEqual([]);
});

async function logRecordingEnabled(directory: string) { const log = logger(directory); await log.setRecordingEnabled(true); }

it("clears System Log across active writers and rejects queued stale records while disabled", async () => {
  const directory = await root(); await enable(directory); await register(directory);
  const { clearPersistentLogs, exportPersistentLogs, recordPersistentEvent, setPersistentLoggingEnabled } = await import("../src/utils/persistentLog");
  recordPersistentEvent("info", "test", "old entry");
  const peer = logger(directory); peer.write("info", "test", "peer old entry"); await peer.flush();
  await clearPersistentLogs();
  expect(JSON.parse((await exportPersistentLogs()).text).records).toEqual([]);
  recordPersistentEvent("info", "test", "new entry"); await peer.setRecordingEnabled(true);
  expect(JSON.parse((await exportPersistentLogs()).text).records).toEqual(expect.arrayContaining([expect.objectContaining({ message: "new entry" })]));
  await setPersistentLoggingEnabled(false); peer.write("info", "test", "stale peer entry"); await peer.flush();
  expect(JSON.parse((await exportPersistentLogs()).text).records).toEqual([]);
});

it("keeps post-clear records written in the same millisecond and drops another writer's queued generation", async () => {
  const directory = await root(); await enable(directory); await register(directory);
  const { clearPersistentLogs, exportPersistentLogs } = await import("../src/utils/persistentLog");
  const instant = new Date();
  const peer = logger(directory, 3, () => instant); await peer.initialize();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  (peer as unknown as { writeChain: Promise<void> }).writeChain = gate;
  peer.write("info", "test", "queued before clear");
  await clearPersistentLogs(); release(); await peer.flush();
  expect(JSON.parse((await exportPersistentLogs()).text).records).toEqual([]);
  peer.write("info", "test", "written after clear"); await peer.flush();
  expect(JSON.parse((await exportPersistentLogs()).text).records).toEqual([expect.objectContaining({ message: "written after clear" })]);
});
