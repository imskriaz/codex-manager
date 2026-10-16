export async function runWithConcurrencyLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  options: { delayMs?: number } = {}
): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("The concurrency limit must be a positive integer.");
  }
  if (items.length === 0) {
    return;
  }

  let cursor = 0;
  const runnerCount = Math.min(limit, items.length);
  const delayMs = Math.max(0, options.delayMs ?? 0);

  let failed = false;
  const results = await Promise.allSettled(
    Array.from({ length: runnerCount }, async () => {
      while (!failed && cursor < items.length) {
        const index = cursor++;
        const item = items[index];
        if (item === undefined) {
          return;
        }

        if (delayMs > 0 && index >= runnerCount) {
          await sleep(delayMs);
        }
        if (failed) return;
        try {
          await worker(item, index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    })
  );
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}

/** Bound optional reads without cancelling or releasing an in-flight mutation. */
export async function waitWithin<T>(work: Promise<T>, timeoutMs: number, message: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation cancelled."));
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

type SharedInspection<T> = {
  controller: AbortController;
  task: Promise<T>;
  users: number;
};

const sharedInspections = new Map<string, SharedInspection<unknown>>();

/** Share bounded read-only inspections while keeping cancellation local to each caller. */
export async function createSharedInspection<T>(
  key: string,
  inspect: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = 30_000
): Promise<T> {
  signal?.throwIfAborted();
  let shared = sharedInspections.get(key) as SharedInspection<T> | undefined;
  if (!shared) {
    if (sharedInspections.size >= 256) throw new Error("Session inspection is busy. Retry shortly.");
    const controller = new AbortController();
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("Session inspection cancelled.")), { once: true });
    });
    const task = waitWithin(Promise.race([cancelled, Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return inspect(controller.signal);
    })]), 300_000, "Shared inspection timed out.").finally(() => {
      controller.abort();
      if (sharedInspections.get(key)?.task === task) sharedInspections.delete(key);
    });
    shared = { controller, task, users: 0 };
    sharedInspections.set(key, shared);
  }
  shared.users += 1;
  const current = shared;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      current.task,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error("Session inspection cancelled."));
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new Error("Session inspection timed out.")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    current.users -= 1;
    if (current.users <= 0) {
      current.controller.abort(new Error("No session inspection consumers remain."));
      if (sharedInspections.get(key) === current) sharedInspections.delete(key);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 创建一个异步互斥锁，保证同一 key 的任务串行执行。
 *
 * 用于切号/刷新 token 等需要按账号串行化的场景，避免切号与后台续期并发刷新同一账号 token。
 */
export function createKeyedMutex(): {
  runExclusive<T>(key: string, task: () => Promise<T>): Promise<T>;
} {
  const tails = new Map<string, Promise<unknown>>();

  return {
    runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
      const tail = tails.get(key) ?? Promise.resolve();
      const next = tail.then(() => task());
      // 失败不阻断后续排队
      const settled = next.then(() => undefined, () => undefined).then(() => {
        if (tails.get(key) === settled) tails.delete(key);
      });
      tails.set(key, settled);
      return next;
    }
  };
}
