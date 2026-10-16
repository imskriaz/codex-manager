import { AsyncLocalStorage } from "async_hooks";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { readSqliteStateFile, sqliteStoreForFile, writeSqliteStateFile } from "../storage/sqliteState";

const LOCK_DIRECTORY_NAME = "cross-window-operations-v1";
const OWNER_FILE_NAME = "owner.json";
const CLEANUP_LOCK_NAME = ".cleanup.lock";
const YIELD_FILE_NAME = "yield";
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 30_000;
const activeOwners = new Map<string, { instanceId: string; controller: AbortController; background: boolean }>();
type OperationOptions = { waitMs?: number; background?: boolean };
const STARTUP_COOLDOWN_FILE = "startup-sync-cooldown.json";
export const CENTRAL_ACCOUNT_OPERATION_KEY = "accounts:central-operation";
/**
 * Encrypted Settings Sync has its own single-flight lock.  It must not share
 * the account-operation lock: a sync in another window should never prevent a
 * user from changing a local account setting.
 */
export const ENCRYPTED_SYNC_OPERATION_KEY = "accounts:encrypted-sync";

type LockOwner = {
  instanceId: string;
  pid: number;
  startedAt: number;
  heartbeatAt: number;
  background?: boolean;
};

type OperationLease = { active: boolean };

export class CrossWindowOperationBusyError extends Error {
  constructor(public readonly operationLabel: string) {
    super(`${operationLabel} is still in progress. The new request was not started; retry after the current operation finishes.`);
    this.name = "CrossWindowOperationBusyError";
  }
}

/**
 * A process-safe single-flight guard shared by every VS Code extension host.
 * Atomic directory creation elects exactly one executor for an operation key.
 */
export class CrossWindowOperationCoordinator {
  private readonly lockRoot: string;
  private readonly instanceId = crypto.randomUUID();
  private readonly operationContext = new AsyncLocalStorage<ReadonlyMap<string, OperationLease>>();
  private pendingRequests = 0;
  private initializeTask: Promise<void> | undefined;

  constructor(
    storageRootPath: string,
    private readonly heartbeatMs = DEFAULT_HEARTBEAT_MS,
    private readonly staleAfterMs = DEFAULT_STALE_AFTER_MS
  ) {
    this.lockRoot = path.resolve(storageRootPath, LOCK_DIRECTORY_NAME);
  }

  initialize(): Promise<void> {
    this.initializeTask ??= fs.mkdir(this.lockRoot, { recursive: true }).then(() =>
      this.cleanupAbandonedLocks().catch((error: unknown) => {
        console.warn("[codexManager] cross-window operation cleanup skipped:", error);
      })
    ).catch((error: unknown) => {
      this.initializeTask = undefined;
      throw error;
    });
    return this.initializeTask;
  }

  async runExclusive<T>(operationKey: string, operationLabel: string, task: (signal: AbortSignal) => Promise<T>, options: OperationOptions = {}): Promise<T> {
    const normalizedKey = operationKey.trim();
    if (!normalizedKey) {
      throw new Error("A cross-window operation key is required.");
    }

    const inherited = this.operationContext.getStore();
    if (inherited?.get(normalizedKey)?.active) {
      return task(new AbortController().signal);
    }

    await this.initialize();
    const lockPath = this.resolveLockPath(normalizedKey);
    if (this.pendingRequests >= 32) throw new CrossWindowOperationBusyError(operationLabel);
    const deadline = Date.now() + Math.min(2_000, Math.max(0, options.waitMs ?? 0));
    let acquired = false;
    this.pendingRequests += 1;
    try {
      do {
        acquired = await this.tryAcquire(lockPath);
        if (acquired || Date.now() >= deadline) break;
        if (!options.background) await this.requestBackgroundYield(lockPath);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
    } finally {
      this.pendingRequests -= 1;
    }
    if (!acquired) {
      throw new CrossWindowOperationBusyError(operationLabel);
    }

    const owner: LockOwner = {
      instanceId: this.instanceId,
      pid: process.pid,
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
      background: options.background === true
    };
    const controller = new AbortController();
    activeOwners.set(lockPath, { instanceId: this.instanceId, controller, background: options.background === true });
    try {
      await this.writeOwner(lockPath, owner);
    } catch (error) {
      await fs.rm(lockPath, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }).catch(() => undefined);
      activeOwners.delete(lockPath);
      throw error;
    }
    let heartbeatInFlight = false;
    let heartbeatTask: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight) {
        return;
      }
      heartbeatInFlight = true;
      owner.heartbeatAt = Date.now();
      heartbeatTask = this.writeOwner(lockPath, owner)
        .catch(() => undefined)
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, this.heartbeatMs);
    heartbeat.unref?.();
    let yieldReadInFlight = false;
    const yieldTimer = options.background ? setInterval(() => {
      if (yieldReadInFlight || controller.signal.aborted) return;
      yieldReadInFlight = true;
      void fs.stat(path.join(lockPath, YIELD_FILE_NAME)).then(() => {
        controller.abort(new Error("Background ownership renewal yielded to an account switch."));
      }, () => undefined).finally(() => { yieldReadInFlight = false; });
    }, 50) : undefined;
    yieldTimer?.unref?.();

    const lease: OperationLease = { active: true };
    const nextContext = new Map(inherited ?? []);
    nextContext.set(normalizedKey, lease);
    try {
      return await this.operationContext.run(nextContext, () => task(controller.signal));
    } finally {
      lease.active = false;
      clearInterval(heartbeat);
      if (yieldTimer) clearInterval(yieldTimer);
      await heartbeatTask;
      await this.release(lockPath, owner);
      activeOwners.delete(lockPath);
    }
  }

  private resolveLockPath(operationKey: string): string {
    const digest = crypto.createHash("sha256").update(operationKey).digest("hex");
    return path.join(this.lockRoot, digest);
  }

  private async tryAcquire(lockPath: string): Promise<boolean> {
    if (activeOwners.has(lockPath)) return false;
    try {
      await fs.mkdir(lockPath);
      return true;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }

    if (!(await this.isStale(lockPath))) {
      return false;
    }

    const abandonedPath = `${lockPath}.abandoned-${this.instanceId}`;
    try {
      await fs.rename(lockPath, abandonedPath);
    } catch (error) {
      if (isNotFoundError(error) || isAlreadyExistsError(error)) {
        return this.tryAcquire(lockPath);
      }
      return false;
    }
    await fs.rm(abandonedPath, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    return this.tryAcquire(lockPath);
  }

  private async isStale(lockPath: string): Promise<boolean> {
    try {
      const owner = JSON.parse(await fs.readFile(path.join(lockPath, OWNER_FILE_NAME), "utf8")) as Partial<LockOwner>;
      if (
        !Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0 ||
        typeof owner.heartbeatAt !== "number" || !Number.isFinite(owner.heartbeatAt) ||
        typeof owner.instanceId !== "string" ||
        typeof owner.startedAt !== "number" || !Number.isFinite(owner.startedAt)
      ) {
        throw new Error("Invalid cross-window lock owner metadata");
      }
      if (!isProcessAlive(owner.pid!)) return true;
      if (owner.startedAt < Date.now() - os.uptime() * 1_000 - 60_000) return true;
      if (activeOwners.has(lockPath)) return false;
      if (Date.now() - owner.heartbeatAt <= this.staleAfterMs) {
        return false;
      }
      // Multiple extension instances can briefly coexist in one VS Code
      // process during reload. A stale lock from that process is abandoned,
      // even though the PID itself is still alive.
      return owner.pid === process.pid;
    } catch {
      // A freshly-created lock can briefly exist before owner.json is written.
      try {
        const stat = await fs.stat(path.join(lockPath, OWNER_FILE_NAME)).catch(() => fs.stat(lockPath));
        return Date.now() - stat.mtimeMs > this.staleAfterMs;
      } catch {
        return false;
      }
    }
  }

  private async requestBackgroundYield(lockPath: string): Promise<void> {
    const local = activeOwners.get(lockPath);
    if (local?.background) local.controller.abort(new Error("Background ownership renewal yielded to an account switch."));
    try {
      const owner = JSON.parse(await fs.readFile(path.join(lockPath, OWNER_FILE_NAME), "utf8")) as Partial<LockOwner>;
      if (owner.background) await fs.writeFile(path.join(lockPath, YIELD_FILE_NAME), "", { flag: "wx" });
    } catch { /* The owner may have finished; retry atomic acquisition. */ }
  }

  private async writeOwner(lockPath: string, owner: LockOwner): Promise<void> {
    await fs.writeFile(path.join(lockPath, OWNER_FILE_NAME), JSON.stringify(owner), "utf8");
  }

  private async release(lockPath: string, owner: LockOwner): Promise<void> {
    try {
      const current = JSON.parse(await fs.readFile(path.join(lockPath, OWNER_FILE_NAME), "utf8")) as Partial<LockOwner>;
      if (current.instanceId !== owner.instanceId || current.startedAt !== owner.startedAt) {
        return;
      }
      await fs.rm(lockPath, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
    } catch (error) {
      if (!isNotFoundError(error)) {
        console.warn("[codexManager] failed to release a cross-window operation lock:", error);
      }
    }
  }

  private async cleanupAbandonedLocks(): Promise<void> {
    const cleanupLockPath = path.join(this.lockRoot, CLEANUP_LOCK_NAME);
    let cleanupHandle: fs.FileHandle | undefined;
    try {
      cleanupHandle = await fs.open(cleanupLockPath, "wx");
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      try {
        const stat = await fs.stat(cleanupLockPath);
        if (Date.now() - stat.mtimeMs <= this.staleAfterMs) {
          return;
        }
        await fs.unlink(cleanupLockPath);
        cleanupHandle = await fs.open(cleanupLockPath, "wx");
      } catch {
        // Another window may still own the cleanup claim, or the stale file
        // may be held open by a crashed host while Windows releases it.
        // Cleanup is best-effort and must never prevent extension activation.
        return;
      }
    }

    try {
      const entries = await fs.readdir(this.lockRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const entryPath = path.join(this.lockRoot, entry.name);
        if (entry.name.includes(".abandoned-")) {
          await fs.rm(entryPath, { recursive: true, force: true });
          continue;
        }
        if (/^[a-f0-9]{64}$/.test(entry.name) && (await this.isStale(entryPath))) {
          const abandonedPath = `${entryPath}.abandoned-cleanup-${this.instanceId}`;
          try {
            await fs.rename(entryPath, abandonedPath);
            await fs.rm(abandonedPath, { recursive: true, force: true });
          } catch (error) {
            if (!isNotFoundError(error)) {
              console.warn("[codexManager] failed to clean a stale cross-window operation lock:", error);
            }
          }
        }
      }
    } finally {
      await cleanupHandle.close();
      await fs.unlink(cleanupLockPath).catch((error: unknown) => {
        if (!isNotFoundError(error)) {
          console.warn("[codexManager] failed to release the cross-window cleanup lock:", error);
        }
      });
    }
  }
}

let sharedCoordinator: CrossWindowOperationCoordinator | undefined;
let sharedStorageRootPath: string | undefined;

export async function runCentralAccountOperationWithCooldown<T>(
  operationLabel: string,
  cooldownMs: number,
  task: () => Promise<T>
): Promise<{ ran: boolean; value?: T }> {
  return runCentralAccountOperation(operationLabel, async () => {
    const markerPath = sharedStorageRootPath ? path.join(sharedStorageRootPath, STARTUP_COOLDOWN_FILE) : undefined;
    if (markerPath) {
      try {
        const marker = JSON.parse(sqliteStoreForFile(markerPath) ? readSqliteStateFile(markerPath) : await fs.readFile(markerPath, "utf8")) as { completedAt?: unknown };
        const age = typeof marker.completedAt === "number" ? Date.now() - marker.completedAt : Infinity;
        if (age >= 0 && age < cooldownMs) {
          return { ran: false };
        }
      } catch {
        // Missing/corrupt cooldown state is safe: the central lock serializes
        // the first repair and the next successful run rewrites it.
      }
    }

    const value = await task();
    if (markerPath) {
      await Promise.resolve().then(async () => {
        if (sqliteStoreForFile(markerPath)) writeSqliteStateFile(markerPath, JSON.stringify({ completedAt: Date.now() }));
        else await fs.writeFile(markerPath, JSON.stringify({ completedAt: Date.now() }), "utf8");
      })
        .catch((error: unknown) => console.warn("[codexManager] startup sync cooldown marker update skipped:", error));
    }
    return { ran: true, value };
  });
}

export async function configureCrossWindowOperationCoordinator(storageRootPath: string): Promise<void> {
  const coordinator = new CrossWindowOperationCoordinator(storageRootPath);
  try {
    await coordinator.initialize();
    sharedCoordinator = coordinator;
    sharedStorageRootPath = storageRootPath;
  } catch (error) {
    // Do not retain a rejected singleton. A later activation can retry cleanly
    // while this window continues in read/local mode.
    sharedCoordinator = undefined;
    sharedStorageRootPath = undefined;
    throw error;
  }
}

export function runCrossWindowExclusive<T>(
  operationKey: string,
  operationLabel: string,
  task: (signal: AbortSignal) => Promise<T>,
  options: OperationOptions = {}
): Promise<T> {
  return sharedCoordinator ? sharedCoordinator.runExclusive(operationKey, operationLabel, task, options) : task(new AbortController().signal);
}

export function runCentralAccountOperation<T>(operationLabel: string, task: () => Promise<T>): Promise<T> {
  return runCrossWindowExclusive(CENTRAL_ACCOUNT_OPERATION_KEY, operationLabel, task);
}

export function runEncryptedSyncOperation<T>(operationLabel: string, task: () => Promise<T>): Promise<T> {
  return runCrossWindowExclusive(ENCRYPTED_SYNC_OPERATION_KEY, operationLabel, task);
}

/** A completed maintenance request is shared even when window timers differ.
 * Only successful work writes the marker; failures remain retryable. */
export async function runSharedMaintenance<T>(
  operationKey: string,
  operationLabel: string,
  cooldownMs: number,
  task: () => Promise<T>
): Promise<{ ran: boolean; value?: T }> {
  return runCrossWindowExclusive(operationKey, operationLabel, async () => {
    const marker = sharedStorageRootPath
      ? path.join(sharedStorageRootPath, `maintenance-${crypto.createHash("sha256").update(operationKey).digest("hex")}.json`)
      : undefined;
    if (marker) {
      try {
        const { completedAt } = JSON.parse(sqliteStoreForFile(marker) ? readSqliteStateFile(marker) : await fs.readFile(marker, "utf8")) as { completedAt?: unknown };
        const age = typeof completedAt === "number" ? Date.now() - completedAt : Infinity;
        if (age >= 0 && age < cooldownMs) return { ran: false };
      } catch { /* Missing or interrupted marker: retry under the shared lease. */ }
    }
    const value = await task();
    if (marker) {
      const temporary = `${marker}.tmp-${process.pid}-${crypto.randomUUID()}`;
      try {
        if (sqliteStoreForFile(marker)) writeSqliteStateFile(marker, JSON.stringify({ completedAt: Date.now() }));
        else {
          await fs.writeFile(temporary, JSON.stringify({ completedAt: Date.now() }), { mode: 0o600 });
          await fs.rename(temporary, marker);
        }
      } catch (error) {
        console.warn("[codexManager] maintenance cooldown could not be persisted", error);
      } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
    }
    return { ran: true, value };
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST";
}

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
