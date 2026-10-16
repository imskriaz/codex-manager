import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { SqliteStateStore } from "../src/storage/sqliteState";
import { removeTestDirectory } from "./testFilesystem";
import {
  CrossWindowOperationBusyError,
  CrossWindowOperationCoordinator,
  CENTRAL_ACCOUNT_OPERATION_KEY,
  ENCRYPTED_SYNC_OPERATION_KEY,
  configureCrossWindowOperationCoordinator,
  runCentralAccountOperationWithCooldown,
  runSharedMaintenance
} from "../src/utils/crossWindowOperations";

describe("CrossWindowOperationCoordinator", () => {
  it("lets a manual switch interrupt optional renewal before taking the same lease", async () => {
    const directory = await createTestDirectory("switch-yield");
    const background = new CrossWindowOperationCoordinator(directory);
    const manual = new CrossWindowOperationCoordinator(directory);
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const renewal = background.runExclusive("account:switch:home", "Renewal", async signal => {
      await background.runExclusive("account:switch:home", "Nested renewal", async nestedSignal => {
        expect(nestedSignal).toBe(signal);
        started();
        await new Promise<void>(resolve => nestedSignal.addEventListener("abort", () => resolve(), { once: true }));
        expect(nestedSignal.aborted).toBe(true);
      });
    }, { background: true });
    await ready;
    await expect(manual.runExclusive("account:switch:home", "Account switch", async () => "switched")).resolves.toBe("switched");
    await renewal;
    await expectReleased(directory);
    await removeTestDirectory(directory);
  });

  it("recovers a dead owner immediately even when its heartbeat is fresh", async () => {
    const directory = await createTestDirectory("switch-dead-owner");
    const key = "account:switch:dead";
    await seed(directory, "operation-leases", key, { token: "dead", pid: 999999999, startedAt: Date.now(), heartbeatAt: Date.now() });
    await expect(new CrossWindowOperationCoordinator(directory).runExclusive(key, "Account switch", async () => "recovered")).resolves.toBe("recovered");
    await removeTestDirectory(directory);
  });

  it("reports a bounded conflict while a real mutation retains its lease", async () => {
    const directory = await createTestDirectory("switch-live-owner");
    const first = new CrossWindowOperationCoordinator(directory, 100_000, 1);
    const second = new CrossWindowOperationCoordinator(directory, 100_000, 1);
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const mutation = first.runExclusive("switch", "Switch", async () => {
      started();
      await new Promise<void>(resolve => { finish = resolve; });
    });
    await ready;
    const task = vi.fn(async () => undefined);
    try {
      await expect(second.runExclusive("switch", "Switch", task, { waitMs: 100 })).rejects.toThrow("still in progress");
      expect(task).not.toHaveBeenCalled();
    } finally { finish(); await mutation; await removeTestDirectory(directory); }
  });
  it("retries initialization after unavailable storage recovers", async () => {
    const directory = await createTestDirectory("cross-window-init-retry");
    const lockRoot = path.join(directory, "manager.sqlite");
    await fs.writeFile(lockRoot, "storage blocker");
    const coordinator = new CrossWindowOperationCoordinator(directory);
    await expect(coordinator.initialize()).rejects.toThrow();
    await fs.unlink(lockRoot);
    await expect(coordinator.runExclusive("retry", "Retry", async () => "recovered")).resolves.toBe("recovered");
    await removeTestDirectory(directory);
  });

  it("does not suppress startup recovery after a backwards clock correction", async () => {
    const directory = await createTestDirectory("cross-window-clock-recovery");
    await configureCrossWindowOperationCoordinator(directory);
    await seed(directory, "files", "startup-sync-cooldown.json", { text: JSON.stringify({ completedAt: Date.now() + 86_400_000 }) });
    const task = vi.fn(async () => "recovered");
    expect(await runCentralAccountOperationWithCooldown("Recovery", 60_000, task)).toEqual({ ran: true, value: "recovered" });
    expect(task).toHaveBeenCalledOnce();
    await removeTestDirectory(directory);
  });
  it("shares completed maintenance across coordinator restarts and retries failures", async () => {
    const directory = await createTestDirectory("shared-maintenance");
    await configureCrossWindowOperationCoordinator(directory);
    let calls = 0;
    const task = async () => ++calls;
    expect(await runSharedMaintenance("network:quota:one", "Quota", 60_000, task)).toEqual({ ran: true, value: 1 });
    await configureCrossWindowOperationCoordinator(directory);
    expect(await runSharedMaintenance("network:quota:one", "Quota", 60_000, task)).toEqual({ ran: false });
    expect(await runSharedMaintenance("network:quota:two", "Quota", 60_000, task)).toEqual({ ran: true, value: 2 });
    await expect(runSharedMaintenance("network:failed", "Sync", 60_000, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(await runSharedMaintenance("network:failed", "Sync", 60_000, task)).toEqual({ ran: true, value: 3 });
    await removeTestDirectory(directory);
  });
  it("runs deferred startup sync once per five-minute cooldown across windows", async () => {
    const directory = await createTestDirectory("cross-window-startup-cooldown");
    await configureCrossWindowOperationCoordinator(directory);
    let executions = 0;

    const first = await runCentralAccountOperationWithCooldown("Deferred startup sync", 5 * 60 * 1000, async () => {
      executions += 1;
    });
    const second = await runCentralAccountOperationWithCooldown("Deferred startup sync", 5 * 60 * 1000, async () => {
      executions += 1;
    });

    expect(first.ran).toBe(true);
    expect(second.ran).toBe(false);
    expect(executions).toBe(1);
    await removeTestDirectory(directory);
  });

  it("allows only one coordinator to execute the same operation", async () => {
    const directory = await createTestDirectory("cross-window-operation");
    const first = new CrossWindowOperationCoordinator(directory);
    const second = new CrossWindowOperationCoordinator(directory);
    let release!: () => void;
    let markStarted!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let executions = 0;

    const firstRun = first.runExclusive("quota:refresh:account-1", "Quota refresh", async () => {
      executions += 1;
      markStarted();
      await pending;
    });
    await started;

    await expect(
      second.runExclusive("quota:refresh:account-1", "Quota refresh", async () => {
        executions += 1;
      })
    ).rejects.toEqual(expect.any(CrossWindowOperationBusyError));

    release();
    await firstRun;
    expect(executions).toBe(1);
    await expectReleased(directory);
    await removeTestDirectory(directory);
  });

  it("lets unrelated operations run concurrently", async () => {
    const directory = await createTestDirectory("cross-window-operation-keys");
    const first = new CrossWindowOperationCoordinator(directory);
    const second = new CrossWindowOperationCoordinator(directory);

    const values = await Promise.all([
      first.runExclusive("quota:refresh:a", "Refresh A", async () => "a"),
      second.runExclusive("quota:refresh:b", "Refresh B", async () => "b")
    ]);

    expect(values).toEqual(["a", "b"]);
    await removeTestDirectory(directory);
  });

  it("does not block a manual account operation while another window is syncing", async () => {
    const directory = await createTestDirectory("cross-window-sync-and-manual");
    const syncingWindow = new CrossWindowOperationCoordinator(directory);
    const manualWindow = new CrossWindowOperationCoordinator(directory);
    let releaseSync!: () => void;
    let markSyncStarted!: () => void;
    const syncPending = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    const syncStarted = new Promise<void>((resolve) => {
      markSyncStarted = resolve;
    });

    const sync = syncingWindow.runExclusive(ENCRYPTED_SYNC_OPERATION_KEY, "Encrypted account sync", async () => {
      markSyncStarted();
      await syncPending;
    });
    await syncStarted;

    await expect(
      manualWindow.runExclusive(CENTRAL_ACCOUNT_OPERATION_KEY, "Toggle account", async () => "updated")
    ).resolves.toBe("updated");

    releaseSync();
    await sync;
    await removeTestDirectory(directory);
  });

  it("supports a nested call for the same operation in one action", async () => {
    const directory = await createTestDirectory("cross-window-operation-nested");
    const coordinator = new CrossWindowOperationCoordinator(directory);
    let executions = 0;

    await coordinator.runExclusive("sync:now", "Sync", async () => {
      await coordinator.runExclusive("sync:now", "Sync", async () => {
        executions += 1;
      });
    });

    expect(executions).toBe(1);
    await removeTestDirectory(directory);
  });

  it("releases the lock when the operation fails", async () => {
    const directory = await createTestDirectory("cross-window-operation-failure");
    const first = new CrossWindowOperationCoordinator(directory);
    const second = new CrossWindowOperationCoordinator(directory);

    await expect(
      first.runExclusive("quota:refresh:failed", "Quota refresh", async () => {
        throw new Error("network unavailable");
      })
    ).rejects.toThrow("network unavailable");

    await expect(
      second.runExclusive("quota:refresh:failed", "Quota refresh", async () => "retried")
    ).resolves.toBe("retried");
    await expectReleased(directory);
    await removeTestDirectory(directory);
  });

  it("reclaims a stale lock left by another coordinator in this process", async () => {
    const directory = await createTestDirectory("cross-window-operation-live-owner");
    const key = "quota:refresh:live";
    await seed(directory, "operation-leases", key, { token: "live", pid: process.pid, startedAt: Date.now(), heartbeatAt: 1 });

    const coordinator = new CrossWindowOperationCoordinator(directory, 5, 10);
    await expect(coordinator.runExclusive(key, "Quota refresh", async () => "recovered")).resolves.toBe("recovered");
    await removeTestDirectory(directory);
  });

  it("recovers abandoned SQLite leases without recreating file locks", async () => {
    const directory = await createTestDirectory("sqlite-abandoned-lease");
    await seed(directory, "operation-leases", "abandoned", { token: "old", pid: 999999999, startedAt: 1, heartbeatAt: 1 });
    const first = new CrossWindowOperationCoordinator(directory);
    const second = new CrossWindowOperationCoordinator(directory);
    await Promise.all([first.initialize(), second.initialize()]);
    await expect(first.runExclusive("abandoned", "Recovery", async () => "recovered")).resolves.toBe("recovered");
    await expectReleased(directory);
    await removeTestDirectory(directory);
  });

  it("bounds pending requests and recovers after the owner finishes", async () => {
    const directory = await createTestDirectory("sqlite-full-queue");
    const coordinator = new CrossWindowOperationCoordinator(directory);
    let finish!: () => void, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const owner = coordinator.runExclusive("busy", "Owner", async () => { started(); await new Promise<void>(resolve => { finish = resolve; }); });
    await ready;
    const queued = Array.from({ length: 32 }, () => coordinator.runExclusive("busy", "Queued", async () => undefined, { waitMs: 100 }).catch(error => error));
    await expect(coordinator.runExclusive("busy", "Overflow", async () => undefined)).rejects.toThrow("still in progress");
    const outcomes = await Promise.all(queued);
    expect(outcomes.every(error => error instanceof CrossWindowOperationBusyError)).toBe(true);
    finish(); await owner;
    await expect(coordinator.runExclusive("busy", "Retry", async () => "retried")).resolves.toBe("retried");
    await expectReleased(directory);
    await removeTestDirectory(directory);
  });

  it("does not start actions when lease storage is full and permits a later retry", async () => {
    const directory = await createTestDirectory("sqlite-lease-full");
    const coordinator = new CrossWindowOperationCoordinator(directory);
    const task = vi.fn(async () => "completed");
    const set = SqliteStateStore.prototype.set;
    const failure = vi.spyOn(SqliteStateStore.prototype, "set").mockImplementation(function(namespace, key, value) {
      if (namespace === "operation-leases") throw new Error("database or disk is full");
      return set.call(this, namespace, key, value);
    });
    await expect(coordinator.runExclusive("full", "Action", task)).rejects.toThrow("full");
    expect(task).not.toHaveBeenCalled();
    failure.mockRestore();
    await expect(coordinator.runExclusive("full", "Action", task)).resolves.toBe("completed");
    await expectReleased(directory);
    await removeTestDirectory(directory);
  });
});

async function seed(directory: string, namespace: string, key: string, value: unknown) {
  const store = await SqliteStateStore.open(path.join(directory, "manager.sqlite"));
  try { store.set(namespace, key, value); } finally { store.close(); }
}
async function expectReleased(directory: string) {
  const store = await SqliteStateStore.open(path.join(directory, "manager.sqlite"));
  try { expect(store.keys("operation-leases")).toEqual([]); } finally { store.close(); }
  expect(await fs.readdir(directory)).toEqual(["manager.sqlite"]);
}
function createTestDirectory(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}
