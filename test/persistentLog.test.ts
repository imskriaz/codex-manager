import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { disposePersistentLogging, PersistentSqliteLogger, registerPersistentLogging, runWithPersistentOperation } from "../src/utils/persistentLog";
import { SqliteStateStore } from "../src/storage/sqliteState";
import { removeTestDirectory } from "./testFilesystem";

const temporaryDirectories: string[] = [];
const loggers: PersistentSqliteLogger[] = [];
afterEach(async () => {
  await disposePersistentLogging();
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
    expect(JSON.parse(store.get<{ text: string }>("files", "logging-settings.json")!.text)).toEqual({ enabled: true, retentionDays: 30 });
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
