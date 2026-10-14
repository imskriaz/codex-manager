import { NetworkError, ErrorCode } from "../core/errors";
import { fetch as undiciFetch } from "undici";
import { setTimeout as realSetTimeout } from "node:timers";
import { AsyncLocalStorage } from "node:async_hooks";
import { getCodexProxyDispatcher } from "../infrastructure/config/proxyEnvironment";

const DEFAULT_FETCH_TIMEOUT_MS = 15000;
const DEFAULT_RETRY_DELAYS_MS = [1000, 3000, 7000] as const;
const PROVIDER_MIN_REQUEST_SPACING_MS = 250;
const PROVIDER_MAX_CONCURRENCY = 2;
const PROVIDER_COOLDOWN_MS = 30_000;
const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;

let providerInFlight = 0;
let providerNextRequestAt = 0;
let providerCooldownUntil = 0;
let providerLastObservedAt = 0;
let providerBulkInFlight = 0;
const providerRequestContext = new AsyncLocalStorage<boolean>();
const providerWaiters: Array<{ bulk: boolean; wake: () => void }> = [];

/** Mark provider calls made by a batch so foreground requests keep one slot. */
export function runWithBulkProviderRequests<T>(task: () => T): T {
  return providerRequestContext.run(true, task);
}

export interface RetryWithBackoffOptions<T> {
  delaysMs?: readonly number[];
  shouldRetryError?: (error: unknown) => boolean;
  shouldRetryResult?: (result: T) => boolean;
}

export async function fetchWithTimeout(
  input: string | URL | globalThis.Request,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  timeoutLabel = "Request"
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init.signal;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) {
    onCallerAbort();
  } else {
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let acquired = false;
  const bulk = providerRequestContext.getStore() === true;

  try {
    await acquireProviderRequestSlot(controller.signal, bulk);
    acquired = true;
    const dispatcher = getCodexProxyDispatcher();
    if (dispatcher) {
      const response = (await undiciFetch(
        input as Parameters<typeof undiciFetch>[0],
        {
          ...init,
          signal: controller.signal,
          dispatcher
        } as Parameters<typeof undiciFetch>[1]
      )) as unknown as Response;
      noteProviderResponse(response);
      return await bufferProviderResponse(response, controller.signal);
    }
    const response = await fetch(input, {
      ...init,
      signal: controller.signal
    });
    noteProviderResponse(response);
    return await bufferProviderResponse(response, controller.signal);
  } catch (error) {
    if (timedOut) {
      throw new NetworkError(`${timeoutLabel} timed out after ${Math.round(timeoutMs / 1000)}s`, {
        code: ErrorCode.NETWORK_ERROR,
        cause: error,
        context: { timeoutMs, timeoutLabel }
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
    if (acquired) releaseProviderRequestSlot(bulk);
  }
}

// Keep the deadline and provider slot until the body arrives, not just headers.
async function bufferProviderResponse(response: Response, signal: AbortSignal): Promise<Response> {
  if (!response.body) return response;
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfAborted(signal);
    while (true) {
      const chunk = await reader.read();
      throwIfAborted(signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_PROVIDER_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new Error("The provider response exceeds the safe 8 MB limit. Try again later.");
      }
      chunks.push(chunk.value);
    }
    const buffered = new Response(Buffer.concat(chunks, bytes), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
    Object.defineProperties(buffered, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type }
    });
    return buffered;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

async function acquireProviderRequestSlot(signal: AbortSignal, bulk: boolean): Promise<void> {
  while (!canStartProviderRequest(bulk)) {
    await waitForProviderSlot(signal, bulk);
  }
  throwIfAborted(signal);
  const now = Date.now();
  if (providerLastObservedAt > 0 && now + 1000 < providerLastObservedAt) {
    // Test clocks and system clock corrections can move backwards. Do not
    // carry a stale cooldown into the new time base.
    providerNextRequestAt = now;
    providerCooldownUntil = now;
  }
  providerLastObservedAt = now;
  const requestAt = Math.max(now, providerNextRequestAt, providerCooldownUntil);
  providerInFlight += 1;
  if (bulk) providerBulkInFlight += 1;
  providerNextRequestAt = requestAt + PROVIDER_MIN_REQUEST_SPACING_MS;
  try {
    let readyAt = requestAt;
    while (true) {
      const observedAt = Date.now();
      const waitMs = Math.min(10 * 60_000, Math.max(readyAt - observedAt, 0));
      if (waitMs > 0) {
        await waitForProviderDelay(waitMs, signal);
      }
      throwIfAborted(signal);
      providerLastObservedAt = Date.now();
      if (providerLastObservedAt >= providerCooldownUntil) {
        break;
      }
      // A request already waiting for its spacing slot may observe a 429 from
      // another request. Recheck the shared cooldown before it reaches the provider.
      readyAt = providerCooldownUntil;
    }
  } catch (error) {
    releaseProviderRequestSlot(bulk);
    throw error;
  }
}

function waitForProviderSlot(signal: AbortSignal, bulk: boolean): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const entry: { bulk: boolean; wake: () => void } = { bulk, wake: () => undefined };
    const waiter = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    entry.wake = waiter;
    const onAbort = () => {
      const index = providerWaiters.indexOf(entry);
      if (index >= 0) providerWaiters.splice(index, 1);
      reject(abortReason(signal));
    };
    providerWaiters.push(entry);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function waitForProviderDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = realSetTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The request was aborted", "AbortError");
}

function releaseProviderRequestSlot(bulk: boolean): void {
  providerInFlight = Math.max(0, providerInFlight - 1);
  if (bulk) providerBulkInFlight = Math.max(0, providerBulkInFlight - 1);
  const foreground = providerWaiters.findIndex((waiter) => !waiter.bulk && canStartProviderRequest(false));
  const fallback = providerWaiters.findIndex((waiter) => canStartProviderRequest(waiter.bulk));
  const index = foreground >= 0 ? foreground : fallback;
  if (index >= 0) providerWaiters.splice(index, 1)[0]?.wake();
}

function canStartProviderRequest(bulk: boolean): boolean {
  return providerInFlight < PROVIDER_MAX_CONCURRENCY && (!bulk || providerBulkInFlight < 1);
}

function noteProviderResponse(response: Response): void {
  if (response.status !== 429) {
    return;
  }
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  providerCooldownUntil = Math.max(providerCooldownUntil, Date.now() + (retryAfter ?? PROVIDER_COOLDOWN_MS));
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10 * 60_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 10 * 60_000)) : undefined;
}

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryWithBackoffOptions<T> = {}
): Promise<T> {
  const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const result = await operation();
      if (attempt < delays.length && options.shouldRetryResult?.(result)) {
        await sleep(withJitter(delays[attempt]!));
        continue;
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt >= delays.length || !options.shouldRetryError?.(error)) {
        throw error;
      }
      await sleep(withJitter(delays[attempt]!));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Retry operation failed");
}

export function isRetriableHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function isRetriableNetworkError(error: unknown): boolean {
  if (error instanceof NetworkError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const normalized = error.message.toLowerCase();
  return (
    error.name === "TypeError" ||
    normalized.includes("network") ||
    normalized.includes("fetch failed") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("econnreset") ||
    normalized.includes("socket") ||
    normalized.includes("enotfound") ||
    normalized.includes("temporarily unavailable")
  );
}

/** Keep provider diagnostics bounded and free of credential-shaped values. */
export function summarizeNetworkBody(raw: string): string {
  const compact = raw
    .replace(/(["'](?:access|refresh|id)_token["']\s*:\s*["'])[^"']*(["'])/gi, "$1[redacted]$2")
    .replace(
      /(["'](?:authorization|api[_-]?key|secret|credential|code)["']\s*:\s*["'])[^"']*(["'])/gi,
      "$1[redacted]$2"
    )
    .replace(
      /((?:access|refresh|id)_token|authorization|api[_-]?key|secret|credential|code)\s*[=:]\s*[^\s&,}]+/gi,
      "$1=[redacted]"
    )
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > 240 ? `${compact.slice(0, 240)}…` : compact || "(empty response)";
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function withJitter(delayMs: number): number {
  if (delayMs <= 0) {
    return 0;
  }
  return Math.round(delayMs * (0.8 + Math.random() * 0.4));
}
