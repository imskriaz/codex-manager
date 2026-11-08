import { afterEach, beforeEach, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), dispose: vi.fn(), repoInit: vi.fn(), repoDispose: vi.fn(),
  readPid: vi.fn(), writePid: vi.fn(), deletePid: vi.fn(), close: vi.fn(), coordinate: vi.fn(), registerLogs: vi.fn(), closeLogs: vi.fn(), log: vi.fn()
}));
vi.mock("../src/storage/sqliteContext", () => ({ initializeSqliteContextWithRetry: async (context: unknown) => context }));
vi.mock("../src/storage", () => ({ AccountsRepository: class { init = host.repoInit; dispose = host.repoDispose; } }));
vi.mock("../src/services/webDashboardServer", () => ({ WebDashboardServer: class { start = host.start; stop = host.stop; dispose = host.dispose; getUrl() { return "http://127.0.0.1:39875"; } } }));
vi.mock("../src/storage/sqliteState", () => ({
  getSqliteStateStore: () => ({ close: host.close }), readSqliteStateFile: host.readPid,
  writeSqliteStateFile: host.writePid, deleteSqliteStateFile: host.deletePid
}));
vi.mock("../src/utils/crossWindowOperations", () => ({ configureCrossWindowOperationCoordinator: host.coordinate }));
vi.mock("../src/utils/persistentLog", () => ({ registerPersistentLogging: host.registerLogs, disposePersistentLogging: host.closeLogs, recordPersistentEvent: host.log }));
import { startNodeHost } from "../src/node";

let signals: Set<(...args: any[]) => void>;
beforeEach(() => {
  vi.resetAllMocks();
  signals = new Set([...process.listeners("SIGINT"), ...process.listeners("SIGTERM")]);
  vi.stubEnv("CODEX_MANAGER_PID_FILE", "always-online-relay.pid");
  host.readPid.mockReturnValue(String(process.pid));
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.listeners(signal)) if (!signals.has(listener)) process.removeListener(signal, listener);
  }
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

it("waits for VS Code's port release, writes the SQLite PID only after bind, and shuts down once", async () => {
  vi.useFakeTimers(); vi.stubEnv("CODEX_MANAGER_HANDOFF", "1");
  host.start.mockRejectedValueOnce(new Error("port already owned by another host")).mockResolvedValue(undefined);
  const launch = startNodeHost();
  await vi.advanceTimersByTimeAsync(0);
  expect(host.writePid).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(150); await launch;
  expect(host.start).toHaveBeenCalledTimes(2);
  expect(host.coordinate).toHaveBeenCalledOnce();
  expect(host.registerLogs).toHaveBeenCalledOnce();
  expect(host.log).toHaveBeenCalledWith("info", "node-host", "Standalone ready", expect.any(Object));
  expect(host.writePid).toHaveBeenCalledWith("always-online-relay.pid", String(process.pid));
  const stop = process.listeners("SIGTERM").find(listener => !signals.has(listener))!;
  stop(); stop();
  await vi.advanceTimersByTimeAsync(0);
  expect(host.stop).toHaveBeenCalledOnce();
  expect(host.deletePid).toHaveBeenCalledWith("always-online-relay.pid");
  expect(host.close).toHaveBeenCalledOnce();
  expect(host.closeLogs).toHaveBeenCalledWith(true);
});

it("refuses a competing direct launch and leaves the active owner's PID intact", async () => {
  vi.stubEnv("CODEX_MANAGER_HANDOFF", "");
  host.start.mockRejectedValue(new Error("port already owned by another host"));
  host.readPid.mockReturnValue("999999");
  await expect(startNodeHost()).rejects.toThrow("already owned");
  expect(host.start).toHaveBeenCalledOnce();
  expect(host.log).toHaveBeenCalledWith("error", "node-host", "Standalone startup failed", expect.any(Object), expect.any(Error));
  expect(host.writePid).not.toHaveBeenCalled();
  expect(host.deletePid).not.toHaveBeenCalled();
  expect(host.repoDispose).toHaveBeenCalledOnce();
  expect(host.close).toHaveBeenCalledOnce();
});

it("bounds handoff retries and immediately preserves non-port startup errors", async () => {
  vi.useFakeTimers(); vi.stubEnv("CODEX_MANAGER_HANDOFF", "1");
  host.start.mockRejectedValue(new Error("port already owned by another host"));
  const launch = expect(startNodeHost()).rejects.toThrow("already owned");
  await vi.advanceTimersByTimeAsync(8_200); await launch;
  expect(host.writePid).not.toHaveBeenCalled();
  host.start.mockClear().mockRejectedValue(new Error("authentication storage unavailable"));
  await expect(startNodeHost()).rejects.toThrow("authentication storage unavailable");
  expect(host.start).toHaveBeenCalledOnce();
});

it("closes storage and the repository when repository initialization fails", async () => {
  host.repoInit.mockRejectedValueOnce(new Error("SQLITE_FULL"));
  await expect(startNodeHost()).rejects.toThrow("SQLITE_FULL");
  expect(host.start).not.toHaveBeenCalled();
  expect(host.close).toHaveBeenCalledOnce();
});
