import { AsyncLocalStorage } from "async_hooks";
import * as crypto from "crypto";
import * as os from "os";
import * as path from "path";
import { getSqliteStateStore, SqliteStateStore } from "../storage/sqliteState";
import { createSharedInspection } from "./concurrency";
import { peekManagerCacheId, readManagerCacheEntry, writeManagerCacheEntry } from '../storage/managerCache';

const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 30_000;
const activeOwners = new Map<string, { token: string; controller: AbortController; background: boolean }>();
type OperationOptions = { waitMs?: number; background?: boolean };
type SharedResult<T> = { id: string; completedAt: number; value?: T };
const joinedOperations = new Map<string, Promise<unknown>>();
const localGenerations = new Map<string, number>();
const onceOperations = new Map<string, { expiresAt: number; result: Promise<unknown> }>();
let coordinatorRevision = 0;

export function sharedResourceKey(kind: string, identity: unknown): string {
  const serialized = JSON.stringify(identity, (_key: string, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value);
  return `${kind}:${crypto.createHash("sha256").update(serialized).digest("hex")}`;
}

export function sharedPathKey(kind: string, file: string): string {
  const absolute = path.resolve(file);
  return sharedResourceKey(kind, process.platform === "win32" ? absolute.toLowerCase() : absolute);
}
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
        let deadline = startedAt + Math.min(120_000, Math.max(0, options.waitMs ?? 0));
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

  /** Only non-secret, JSON-compatible read results belong in this cache. */
  async shareRead<T>(key: string, label: string, task: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, maxAgeMs: number): Promise<T> {
    const startedAt = Date.now();
    const cacheKey = sharedResourceKey("read", key);
    return this.withStore(async store => {
      let cacheAvailable = true;
      const cacheFailed = (error: unknown): void => {
        if (cacheAvailable) console.warn('[codexManager] optional read cache unavailable; using source data', error);
        cacheAvailable = false;
      };
      let seenId: string | undefined;
      try { seenId = peekManagerCacheId(store, cacheKey); } catch (error) { cacheFailed(error); }
      const cached = (): SharedResult<T> | undefined => {
        if (!cacheAvailable) return;
        try { return readManagerCacheEntry<T>(store, cacheKey, seenId, startedAt, maxAgeMs); }
        catch (error) { cacheFailed(error); return; }
      };
      while (true) {
        signal.throwIfAborted();
        const previous = cached();
        if (previous) return previous.value as T;
        let completed: { value: T } | undefined;
        try {
          return await this.runExclusive(cacheKey, label, async () => {
            signal.throwIfAborted();
            const ready = cached();
            if (ready) return ready.value as T;
            const value = await task(signal);
            signal.throwIfAborted();
            completed = { value };
            const result = { id: crypto.randomUUID(), completedAt: Date.now(), value };
            if (cacheAvailable) {
              try { writeManagerCacheEntry(store, cacheKey, result); }
              catch (error) { cacheFailed(error); }
            }
            return value;
          });
        } catch (error) {
          if (completed) {
            console.warn("[codexManager] shared read cache failed; preserving the completed response", error);
            return completed.value;
          }
          if (!(error instanceof CrossWindowOperationBusyError)) throw error;
          await pause(50, signal);
        }
      }
    });
  }

  async providerRequest<T>(signal: AbortSignal, bulk: boolean, task: () => Promise<T>): Promise<T> {
    return this.withStore(async store => {
      const owner: LockOwner = { token: crypto.randomUUID(), pid: process.pid, startedAt: Date.now(), heartbeatAt: Date.now(), background: bulk };
      let slot: string | undefined;
      while (!slot) {
        signal.throwIfAborted();
        slot = store.transaction(() => {
          const now = Date.now();
          let budget = store.get<{ nextAt: number; cooldownUntil: number; observedAt?: number }>("provider-budget", "timing");
          if (budget?.observedAt && now + 1_000 < budget.observedAt) budget = undefined;
          if (budget && Math.max(budget.nextAt, budget.cooldownUntil) > now) return undefined;
          const occupied = ["0", "1"].filter(key => {
            const current = store.get<LockOwner>("provider-budget", key);
            // Admission slots can expire; account mutation leases still protect their actual writes.
            if (current && now - current.heartbeatAt < DEFAULT_STALE_AFTER_MS && !this.isStale(current, `${this.databasePath}:provider:${key}`)) return true;
            store.set("provider-budget", key, undefined);
            return false;
          });
          if (occupied.length >= 2 || (bulk && occupied.some(key => store.get<LockOwner>("provider-budget", key)?.background))) return undefined;
          const key = occupied.includes("0") ? "1" : "0";
          store.set("provider-budget", key, owner);
          store.set("provider-budget", "timing", { nextAt: now + 250, cooldownUntil: budget?.cooldownUntil ?? 0, observedAt: now });
          return key;
        });
        if (!slot) await pause(50, signal);
      }
      const key = slot;
      const localKey = `${this.databasePath}:provider:${key}`;
      const controller = new AbortController();
      activeOwners.set(localKey, { token: owner.token, controller, background: bulk });
      let leaseError: unknown;
      const heartbeat = setInterval(() => {
        try {
          store.transaction(() => {
            if (store.get<LockOwner>("provider-budget", key)?.token !== owner.token) throw new Error("Provider request lost its slot.");
            store.set("provider-budget", key, { ...owner, heartbeatAt: Date.now() });
          });
        } catch (error) { leaseError = error; }
      }, this.heartbeatMs);
      heartbeat.unref?.();
      let taskError: unknown;
      try {
        signal.throwIfAborted();
        const value = await task();
        if (leaseError) console.warn("[codexManager] provider admission renewal failed; preserving the completed response", leaseError);
        return value;
      } catch (error) {
        taskError = error;
        throw error;
      } finally {
        clearInterval(heartbeat);
        activeOwners.delete(localKey);
        try {
          store.transaction(() => {
            if (store.get<LockOwner>("provider-budget", key)?.token === owner.token) store.set("provider-budget", key, undefined);
          });
        } catch (error) {
          if (taskError) throw new AggregateError([taskError, error], "The provider request failed and its slot could not be released.");
          console.warn("[codexManager] completed provider slot cleanup will recover after expiry", error);
        }
      }
    });
  }

  async noteProviderCooldown(until: number): Promise<void> {
    await this.withStore(store => store.transaction(() => {
      const timing = store.get<{ nextAt: number; cooldownUntil: number }>("provider-budget", "timing");
      store.set("provider-budget", "timing", { nextAt: timing?.nextAt ?? 0, cooldownUntil: Math.max(timing?.cooldownUntil ?? 0, until), observedAt: Date.now() });
    }));
  }

  generation(key: string, advance = false): Promise<number> {
    return this.withStore(store => store.transaction(() => {
      const value = store.get<number>("read-generations", key) ?? 0;
      if (advance) store.set("read-generations", key, value + 1);
      return value + (advance ? 1 : 0);
    }));
  }

  once<T>(key: string, label: string, task: () => Promise<T>): Promise<T> {
    return this.runExclusive(key, label, () => this.withStore(async store => {
      store.transaction(() => {
        const now = Date.now();
        for (const oldKey of store.keys("once-operations")) {
          const at = store.get<number>("once-operations", oldKey) ?? 0;
          if (at < now - 10 * 60_000 || at > now + 60_000) store.set("once-operations", oldKey, undefined);
        }
        if (store.get("once-operations", key) !== undefined) throw new Error(`${label} was already attempted in another window. Check the saved account or start a new authorization.`);
        if (store.keys("once-operations").length >= 64) throw new Error("The authorization request queue is full. Retry after older authorizations expire.");
        store.set("once-operations", key, now);
      });
      return task();
    }), { waitMs: 120_000 });
  }
}

let sharedCoordinator: CrossWindowOperationCoordinator | undefined;

export async function configureCrossWindowOperationCoordinator(storageRootPath: string): Promise<void> {
  coordinatorRevision++;
  localGenerations.clear();
  const coordinator = new CrossWindowOperationCoordinator(storageRootPath);
  sharedCoordinator = undefined;
  await coordinator.initialize();
  sharedCoordinator = coordinator;
}

export function runCrossWindowExclusive<T>(operationKey: string, operationLabel: string, task: (signal: AbortSignal) => Promise<T>, options: OperationOptions = {}): Promise<T> {
  return sharedCoordinator ? sharedCoordinator.runExclusive(operationKey, operationLabel, task, options) : task(new AbortController().signal);
}

/** Join compatible local callers; the task rereads its durable result after a foreign owner finishes. */
export function runCrossWindowJoined<T>(key: string, label: string, task: () => Promise<T>): Promise<T> {
  const localKey = `${coordinatorRevision}:${key}`;
  const current = joinedOperations.get(localKey) as Promise<T> | undefined;
  if (current) return current;
  if (joinedOperations.size >= 128) return Promise.reject(new CrossWindowOperationBusyError(label));
  const work = runCrossWindowExclusive(key, label, task, { waitMs: 120_000 }).finally(() => {
    if (joinedOperations.get(localKey) === work) joinedOperations.delete(localKey);
  });
  joinedOperations.set(localKey, work);
  return work;
}

export function runCrossWindowSharedRead<T>(key: string, label: string, task: (signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal; maxAgeMs?: number; timeoutMs?: number } = {}): Promise<T> {
  const localKey = `${coordinatorRevision}:${key}`;
  return createSharedInspection(localKey, signal => sharedCoordinator
    ? sharedCoordinator.shareRead(key, label, task, signal, options.maxAgeMs ?? 0)
    : task(signal), options.signal, options.timeoutMs ?? 120_000);
}

export function runWithSharedProviderSlot<T>(signal: AbortSignal, bulk: boolean, task: () => Promise<T>): Promise<T> {
  return sharedCoordinator ? sharedCoordinator.providerRequest(signal, bulk, task) : task();
}

export async function noteSharedProviderCooldown(until: number): Promise<void> {
  await sharedCoordinator?.noteProviderCooldown(until);
}

export async function sharedReadGeneration(key: string, advance = false): Promise<number> {
  if (sharedCoordinator) return sharedCoordinator.generation(key, advance);
  const value = (localGenerations.get(key) ?? 0) + (advance ? 1 : 0);
  if (advance) localGenerations.set(key, value);
  return value;
}

/** Retain single-use outcomes in memory; SQLite holds only the attempted marker, never credentials. */
export function runCrossWindowOnce<T>(key: string, label: string, task: () => Promise<T>): Promise<T> {
  const localKey = `${coordinatorRevision}:${key}`;
  for (const [oldKey, value] of onceOperations) if (value.expiresAt <= Date.now()) onceOperations.delete(oldKey);
  const current = onceOperations.get(localKey);
  if (current) return current.result as Promise<T>;
  if (onceOperations.size >= 64) return Promise.reject(new CrossWindowOperationBusyError(label));
  const result = sharedCoordinator ? sharedCoordinator.once(key, label, task) : Promise.resolve().then(task);
  onceOperations.set(localKey, { expiresAt: Date.now() + 10 * 60_000, result });
  return result;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled.")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
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
