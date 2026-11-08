import { expect, it, vi } from "vitest";
import { AccountsWorkbench } from "../src/presentation/workbench/accountsWorkbench";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStateStore } from "../src/storage/sqliteState";
import { AlwaysOnlineServer } from "../src/services/alwaysOnlineServer";
import { removeTestDirectory } from "./testFilesystem";

const handoff = () => ({ alwaysOnlineServer: { prepareForShutdown: vi.fn(async () => undefined), dispose: vi.fn() }, webDashboard: { stop: vi.fn(async () => undefined) } });

it("commits pending account metadata before disposing the repository", async () => {
  let finish!: () => void;
  const flush = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const dispose = vi.fn();
  const workbench = { ...handoff(), autoResumeTracking: { dispose: vi.fn() }, encryptedSync: { shutdown: vi.fn() }, repo: { flush }, dispose };
  const shutdown = AccountsWorkbench.prototype.shutdown.call(workbench as never);
  expect(flush).toHaveBeenCalledOnce();
  expect(dispose).not.toHaveBeenCalled();
  finish();
  await shutdown;
  expect(dispose).toHaveBeenCalledOnce();
});

it("still disposes after a final save fails and preserves the error", async () => {
  const dispose = vi.fn();
  const workbench = { ...handoff(), encryptedSync: { shutdown: vi.fn() }, repo: { flush: vi.fn().mockRejectedValue(new Error("Storage full")) }, dispose };
  await expect(AccountsWorkbench.prototype.shutdown.call(workbench as never)).rejects.toThrow("Storage full");
  expect(dispose).toHaveBeenCalledOnce();
});

it("bounds a stalled shutdown write and disposes without claiming success", async () => {
  vi.useFakeTimers();
  try {
    const dispose = vi.fn();
    const workbench = { ...handoff(), encryptedSync: { shutdown: vi.fn() }, repo: { flush: vi.fn(() => new Promise<void>(() => undefined)) }, dispose };
    const shutdown = AccountsWorkbench.prototype.shutdown.call(workbench as never);
    const failed = expect(shutdown).rejects.toThrow("did not finish before shutdown");
    await vi.advanceTimersByTimeAsync(1500);
    await failed;
    expect(dispose).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("hands off while SQLite configuration is still open, before VS Code disposes context subscriptions", async () => {
  const root = await mkdtemp(join(tmpdir(), "manager-shutdown-"));
  const store = await SqliteStateStore.open(join(root, "manager.sqlite"));
  const relay = new AlwaysOnlineServer({} as never) as any;
  store.set("settings", "alwaysActive", "armed");
  const configuration = vi.spyOn(relay, "configurationKey").mockImplementation(() => store.get("settings", "alwaysActive"));
  const spawn = vi.spyOn(relay, "spawnPreparedRelay").mockImplementation(() => undefined);
  relay.preparedRelay = {}; relay.verifiedConfiguration = "armed";
  const stop = vi.fn(async () => { expect(spawn).toHaveBeenCalledOnce(); });
  const workbench = { encryptedSync: { shutdown: vi.fn() }, repo: { flush: vi.fn(async () => undefined) }, alwaysOnlineServer: relay, webDashboard: { stop }, dispose: vi.fn() };
  try {
    await AccountsWorkbench.prototype.shutdown.call(workbench as never);
    expect(configuration).toHaveBeenCalledTimes(2);
    store.close();
    expect(() => relay.dispose()).not.toThrow();
    expect(spawn).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  } finally { store.close(); vi.restoreAllMocks(); await removeTestDirectory(root); }
});

it("still disposes local services when the handoff fails", async () => {
  const workbench = { ...handoff(), encryptedSync: { shutdown: vi.fn() }, repo: { flush: vi.fn(async () => undefined) }, dispose: vi.fn() };
  workbench.alwaysOnlineServer.dispose.mockImplementation(() => { throw new Error("configuration unavailable"); });
  await expect(AccountsWorkbench.prototype.shutdown.call(workbench as never)).rejects.toThrow("configuration unavailable");
  expect(workbench.dispose).toHaveBeenCalledOnce();
});

it("bounds unfinished preparation after an immediate Always Active change", async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const workbench = { ...handoff(), encryptedSync: { shutdown: vi.fn() }, repo: { flush: vi.fn(async () => undefined) }, dispose: vi.fn() };
  workbench.alwaysOnlineServer.prepareForShutdown.mockImplementation(() => new Promise(() => undefined));
  try {
    const shutdown = AccountsWorkbench.prototype.shutdown.call(workbench as never);
    await vi.advanceTimersByTimeAsync(3_000); await shutdown;
    expect(workbench.alwaysOnlineServer.dispose).toHaveBeenCalledOnce();
    expect(workbench.dispose).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("preparation unconfirmed"), expect.any(Error));
  } finally { warning.mockRestore(); vi.useRealTimers(); }
});
