import { AsyncLocalStorage } from "async_hooks";
import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";
import { getSqliteStateStore, SqliteStateStore } from "../storage/sqliteState";

const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 30_000;
const activeOwners = new Map<string, { token: string; controller: AbortController; background: boolean }>();
type OperationOptions = { waitMs?: number; background?: boolean };
export const CENTRAL_ACCOUNT_OPERATION_KEY = "accounts:central-operation";
// Settings Sync must never block an unrelated manual account change.
export const ENCRYPTED_SYNC_OPERATION_KEY = "accounts:encrypted-sync";
type LockOwner = { token: string; pid: number; startedAt: number; heartbeatAt: number; background: boolean; yieldRequested?: boolean };
type OperationLease = { active: boolean; signal: AbortSignal };

export class CrossWindowOperationBusyError extends Error {
  constructor(public readonly operationLabel: string) {
    super(`${operationLabel} is still in progress. The new request was not started; retry after the current operation finishes.`);
    this.name = "CrossWindowOperationBusyError";
  }
}

/** Short SQLite transactions elect an owner; no transaction spans the action itself. */
export class CrossWindowOperationCoordinator {
  private readonly databasePath: string;
  private readonly operationContext = new AsyncLocalStorage<ReadonlyMap<string, OperationLease>>();
  private pendingRequests = 0;

  constructor(storageRootPath: string, private readonly heartbeatMs = DEFAULT_HEARTBEAT_MS, private readonly staleAfterMs = DEFAULT_STALE_AFTER_MS) {
    this.databasePath = path.resolve(storageRootPath, "manager.sqlite");
  }

  async initialize(): Promise<void> { await this.withStore(() => undefined); }

  private async withStore<T>(task: (store: SqliteStateStore) => T | Promise<T>): Promise<T> {
    const shared = getSqliteStateStore();
    const store = shared?.file === this.databasePath ? shared : await SqliteStateStore.open(this.databasePath);
    try { return await task(store); } finally { if (store !== shared) store.close(); }
  }

  async runExclusive<T>(operationKey: string, operationLabel: string, task: (signal: AbortSignal) => Promise<T>, options: OperationOptions = {}): Promise<T> {
    const key = operationKey.trim();
    if (!key) throw new Error("A cross-window operation key is required.");
    const inherited = this.operationContext.getStore();
    const parentLease = inherited?.get(key);
    if (parentLease?.active) return task(parentLease.signal);
    if (this.pendingRequests >= 32) throw new CrossWindowOperationBusyError(operationLabel);
    this.pendingRequests++;
    let pending = true;
    try {
      return await this.withStore(async store => {
        const localKey = `${this.databasePath}:${key}`;
        const owner: LockOwner = { token: crypto.randomUUID(), pid: process.pid, startedAt: Date.now(), heartbeatAt: Date.now(), background: options.background === true };
        const startedAt = Date.now();
        let deadline = startedAt + Math.min(2_000, Math.max(0, options.waitMs ?? 0));
        let acquired = false;
        do {
          acquired = store.transaction(() => {
            const current = store.get<LockOwner>("operation-leases", key);
            if (current && !this.isStale(current, localKey)) {
              if (!options.background && current.background) {
                if (options.waitMs === undefined) deadline = startedAt + 500;
                store.set("operation-leases", key, { ...current, yieldRequested: true });
                activeOwners.get(localKey)?.controller.abort(new Error("Background ownership renewal yielded to an account switch."));
              }
              return false;
            }
            store.set("operation-leases", key, owner);
            return true;
          });
          if (acquired || Date.now() >= deadline) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        if (!acquired) throw new CrossWindowOperationBusyError(operationLabel);
        this.pendingRequests--;
        pending = false;
        const controller = new AbortController();
        activeOwners.set(localKey, { token: owner.token, controller, background: owner.background });
        let leaseError: unknown;
        const renew = (): void => {
          try {
            store.transaction(() => {
              const current = store.get<LockOwner>("operation-leases", key);
              if (current?.token !== owner.token) throw new Error(`${operationLabel} lost its operation lease. Retry after checking the outcome.`);
              if (current.yieldRequested) controller.abort(new Error("Background ownership renewal yielded to an account switch."));
              store.set("operation-leases", key, { ...current, heartbeatAt: Date.now() });
            });
          } catch (error) { leaseError = error; controller.abort(error); }
        };
        const heartbeat = setInterval(renew, owner.background ? Math.min(50, this.heartbeatMs) : this.heartbeatMs);
        heartbeat.unref?.();
        const lease: OperationLease = { active: true, signal: controller.signal };
        const nextContext = new Map(inherited ?? []);
        nextContext.set(key, lease);
        let taskError: unknown;
        try {
          const value = await this.operationContext.run(nextContext, () => task(controller.signal));
          if (leaseError !== undefined) throw leaseError instanceof Error ? leaseError : new Error("Operation lease renewal failed.", { cause: leaseError });
          return value;
        } catch (error) { taskError = error; throw error;
        } finally {
          lease.active = false;
          clearInterval(heartbeat);
          activeOwners.delete(localKey);
          try {
            store.transaction(() => {
              if (store.get<LockOwner>("operation-leases", key)?.token !== owner.token) throw new Error("The operation lease changed unexpectedly.");
              store.set("operation-leases", key, undefined);
            });
          } catch (releaseError) {
            if (taskError !== undefined) throw new AggregateError([taskError, releaseError], `${operationLabel} failed: ${taskError instanceof Error ? taskError.message : typeof taskError === "string" ? taskError : "Unknown operation failure"}. Its lease could not be released.`);
            throw new Error(`${operationLabel} finished, but its lease could not be released. Check the outcome before retrying.`, { cause: releaseError });
          }
        }
      });
    } finally { if (pending) this.pendingRequests--; }
  }

  private isStale(owner: LockOwner, localKey: string): boolean {
    if (activeOwners.get(localKey)?.token === owner.token) return false;
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !Number.isFinite(owner.startedAt) || !Number.isFinite(owner.heartbeatAt) || typeof owner.token !== "string") return true;
    if (owner.startedAt < Date.now() - os.uptime() * 1_000 - 60_000) return true;
    try { process.kill(owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
    // A live foreign process keeps ownership even when temporarily unresponsive.
    return owner.pid === process.pid && Date.now() - owner.heartbeatAt > this.staleAfterMs;
  }

  async readMarker(key: string): Promise<number | undefined> {
    return this.withStore(store => {
      const value = store.get<{ text: string | null }>("files", key);
      try { return value?.text ? (JSON.parse(value.text) as { completedAt?: number }).completedAt : undefined; } catch { return undefined; }
    });
  }

  async writeMarker(key: string): Promise<void> {
    await this.withStore(store => store.set("files", key, { text: JSON.stringify({ completedAt: Date.now() }) }));
  }
}

let sharedCoordinator: CrossWindowOperationCoordinator | undefined;

export async function configureCrossWindowOperationCoordinator(storageRootPath: string): Promise<void> {
  const coordinator = new CrossWindowOperationCoordinator(storageRootPath);
  sharedCoordinator = undefined;
  await coordinator.initialize();
  sharedCoordinator = coordinator;
}

export function runCrossWindowExclusive<T>(operationKey: string, operationLabel: string, task: (signal: AbortSignal) => Promise<T>, options: OperationOptions = {}): Promise<T> {
  return sharedCoordinator ? sharedCoordinator.runExclusive(operationKey, operationLabel, task, options) : task(new AbortController().signal);
}

export function runCentralAccountOperation<T>(operationLabel: string, task: () => Promise<T>): Promise<T> {
  return runCrossWindowExclusive(CENTRAL_ACCOUNT_OPERATION_KEY, operationLabel, task);
}

export function runEncryptedSyncOperation<T>(operationLabel: string, task: () => Promise<T>): Promise<T> {
  return runCrossWindowExclusive(ENCRYPTED_SYNC_OPERATION_KEY, operationLabel, task);
}

export function runCentralAccountOperationWithCooldown<T>(operationLabel: string, cooldownMs: number, task: () => Promise<T>): Promise<{ ran: boolean; value?: T }> {
  return runSharedMaintenance(CENTRAL_ACCOUNT_OPERATION_KEY, operationLabel, cooldownMs, task, "startup-sync-cooldown.json");
}

/** Only completed maintenance updates its marker; offline and failed work remains retryable. */
export function runSharedMaintenance<T>(operationKey: string, operationLabel: string, cooldownMs: number, task: (signal: AbortSignal) => Promise<T>, markerKey = `maintenance-${crypto.createHash("sha256").update(operationKey).digest("hex")}.json`): Promise<{ ran: boolean; value?: T }> {
  return runCrossWindowExclusive(operationKey, operationLabel, async signal => {
    const completedAt = await sharedCoordinator?.readMarker(markerKey);
    const age = typeof completedAt === "number" ? Date.now() - completedAt : Infinity;
    if (age >= 0 && age < cooldownMs) return { ran: false };
    signal.throwIfAborted();
    const value = await task(signal);
    signal.throwIfAborted();
    await sharedCoordinator?.writeMarker(markerKey).catch(error => console.warn("[codexManager] maintenance cooldown could not be persisted", error));
    return { ran: true, value };
  }, { background: true });
}
