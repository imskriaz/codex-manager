import type * as vscode from "vscode";
import type { CodexDailyUsageBreakdown } from "../core/types";
import { APIError } from "../core/errors";
import type { DashboardDailyUsageCacheEntry } from "../domain/dashboard/types";
import { getSqliteStateStore } from "../storage/sqliteState";
import { CrossWindowOperationBusyError, runCrossWindowExclusive } from "../utils/crossWindowOperations";
import { isDailyUsageBreakdown, readDashboardDailyUsage, upsertDashboardDailyUsageCache } from "./dashboardUsageHistory";

const DAY_MS = 86_400_000;
type Check = { at: number; error?: string; retryAt?: number };
const inFlight = new WeakMap<vscode.Memento, Map<string, Promise<DashboardDailyUsageCacheEntry>>>();

function readCheck(context: vscode.ExtensionContext, accountId: string): Check | undefined {
  const store = getSqliteStateStore();
  const value = store ? store.get<Check>("daily-usage-checks", accountId)
    : context.globalState.get<Check>(`codexManager.dailyUsageCheck.v1.${accountId}`);
  if (value === undefined) return;
  if (!value || !Number.isFinite(value.at) || value.at <= 0 || (value.error !== undefined && typeof value.error !== "string") ||
    (value.retryAt !== undefined && (!Number.isFinite(value.retryAt) || value.retryAt < value.at))) {
    throw new Error("The saved usage check is invalid. Existing history was preserved.");
  }
  return value;
}

async function saveCheck(context: vscode.ExtensionContext, accountId: string, check: Check): Promise<void> {
  const store = getSqliteStateStore();
  if (store) store.set("daily-usage-checks", accountId, check);
  else await context.globalState.update(`codexManager.dailyUsageCheck.v1.${accountId}`, check);
}

/** Called on account load only; persist attempts before I/O to survive reloads and crashes. */
export function loadDailyTokenUsage(
  context: vscode.ExtensionContext,
  accountId: string,
  fetchUsage: (signal: AbortSignal) => Promise<CodexDailyUsageBreakdown | undefined>
): Promise<DashboardDailyUsageCacheEntry> {
  let requests = inFlight.get(context.globalState);
  if (!requests) { requests = new Map(); inFlight.set(context.globalState, requests); }
  const pending = requests.get(accountId);
  if (pending) return pending;
  if (!accountId.trim() || accountId.length > 4096) return Promise.reject(new Error("Invalid usage account identity."));
  if (requests.size >= 32) return Promise.reject(new CrossWindowOperationBusyError("Daily usage request queue"));
  const request = runCrossWindowExclusive(`usage:daily:${accountId}`, "Daily usage check", async signal => {
    const previous = readDashboardDailyUsage(context, accountId);
    const check = readCheck(context, accountId);
    const at = Date.now();
    const lastCheckedAt = Math.max(check?.at ?? 0, previous?.fetchedAt ?? 0);
    if (lastCheckedAt > at + 5 * 60_000) throw new Error("The system clock changed. Saved usage was preserved; check the clock before retrying.");
    if (at < Math.max(lastCheckedAt + DAY_MS, check?.retryAt ?? 0)) {
      if (check?.error) throw new Error(`${check.error} Automatic usage checks wait at least 24 hours and respect server retry delays.`);
      if (previous) return previous;
      throw new Error("A recent usage check did not produce saved data. The next automatic check is available after 24 hours.");
    }
    await saveCheck(context, accountId, { at, error: "The previous daily usage check did not complete." });
    try {
      signal.throwIfAborted();
      const usage = await fetchUsage(signal);
      signal.throwIfAborted();
      if (!isDailyUsageBreakdown(usage)) throw new Error("The usage endpoint returned no readable daily data.");
      const entries = await upsertDashboardDailyUsageCache(context, accountId, usage, at);
      const entry = entries.find(entry => entry.accountId === accountId);
      if (!entry) throw new Error("Daily usage could not be saved.");
      await saveCheck(context, accountId, { at });
      return entry;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryAt = error instanceof APIError && typeof error.context?.["retryAt"] === "number" ? error.context["retryAt"] : undefined;
      try { await saveCheck(context, accountId, { at, error: message.slice(0, 1000), ...(retryAt !== undefined ? { retryAt } : {}) }); }
      catch (saveError) { throw new AggregateError([error, saveError], `${message} The usage check outcome could not be saved; existing history was preserved.`); }
      throw error;
    }
  }, { waitMs: 0 }).finally(() => { requests!.delete(accountId); });
  requests.set(accountId, request);
  return request;
}
