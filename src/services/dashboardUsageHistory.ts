import type * as vscode from "vscode";
import type { DashboardDailyUsageCacheEntry, DashboardState, DashboardUsageSample, DashboardUsageGraphQuery, DashboardUsageGraphData, DashboardUsageSummary } from "../domain/dashboard/types";
import type { CodexDailyUsageBreakdown } from "../core/types";
import { getSqliteStateStore } from "../storage/sqliteState";
import { runCrossWindowExclusive } from "../utils/crossWindowOperations";
import { readUsageRows, replaceUsageRows, readDailyUsageRows, replaceDailyUsageRows, readDailyUsageRow, upsertDailyUsageRow, appendUsageRows, readUsageSummary, queryUsageRows, mergeUsageRows } from "../storage/sqliteUsage";

const STORAGE_KEY = "codexManager.dashboardUsageHistory.v1";
const MAX_SAMPLES = 10_000;
const DAILY_USAGE_CACHE_KEY = "codexManager.dashboardDailyUsageCache.v1";
const MAX_FUTURE_TIMESTAMP_SKEW_MS = 5 * 60_000;

export function initializeDashboardUsageStorage(context: vscode.ExtensionContext): void {
  const store = getSqliteStateStore();
  if (!store) return;
  if (!store.get("migrations", "usage-rows-v1")) replaceUsageRows(store, normalizeDashboardUsageHistory(context.globalState.get<unknown>(STORAGE_KEY)), STORAGE_KEY, true);
  if (!store.get("migrations", "daily-usage-rows-v1")) replaceDailyUsageRows(store, normalizeDashboardDailyUsageCache(context.globalState.get<unknown>(DAILY_USAGE_CACHE_KEY)), DAILY_USAGE_CACHE_KEY, true);
}

export function readDashboardUsageSummary(context: vscode.ExtensionContext): DashboardUsageSummary {
  initializeDashboardUsageStorage(context);
  const store = getSqliteStateStore();
  const history = store ? undefined : readDashboardUsageHistory(context);
  return store ? readUsageSummary(store) : { revision: history!.at(-1)?.at ?? 0, count: history!.length };
}

function tokenHistoryCutoff(): number {
  return 0;
}

export function queryDashboardUsage(context: vscode.ExtensionContext, query: DashboardUsageGraphQuery | undefined): DashboardUsageGraphData {
  if (!query || !["quota", "tokens"].includes(query.mode) || !Number.isFinite(query.from) || !Number.isFinite(query.to) ||
    query.from <= 0 || query.to <= query.from || query.to - query.from > 31 * 86_400_000 || query.to > Date.now() + 86_400_000) {
    throw new Error("The usage graph range is invalid. Choose a range of up to 30 days.");
  }
  initializeDashboardUsageStorage(context);
  const store = getSqliteStateStore();
  if (store) {
    const result = queryUsageRows(store, query, tokenHistoryCutoff());
    if (normalizeDashboardDailyUsageCache(result.dailyUsageCache).length !== result.dailyUsageCache.length) {
      throw new Error("Saved token history could not be read. Existing records were preserved.");
    }
    result.history = normalizeDashboardUsageHistory(result.history);
    return result;
  }
  const result: DashboardUsageGraphData = { ...query, history: [], dailyUsageCache: [], truncated: false };
  if (query.mode === "quota") {
    const previous = new Map<string, DashboardUsageSample>();
    const history = readDashboardUsageHistory(context);
    for (const sample of history) if (sample.at < query.from) previous.set(sample.accountId, sample);
    result.history = [...previous.values(), ...history.filter(sample => sample.at >= query.from && sample.at <= query.to)];
    result.oldestAt = history[0]?.at;
  } else {
    const cutoff = tokenHistoryCutoff();
    const entries = readDashboardDailyUsageCache(context).map(entry => ({ ...entry, usage: { ...entry.usage, points: entry.usage.points.filter(point => Date.parse(`${point.date}T00:00:00Z`) >= cutoff) } }));
    result.dailyUsageCache = entries.map(entry => ({ ...entry, usage: { ...entry.usage,
      points: entry.usage.points.filter(point => {
        const at = Date.parse(`${point.date}T00:00:00Z`);
        return at >= query.from && at < query.to;
      }) } }));
    for (const entry of entries) for (const point of entry.usage.points) {
      const at = Date.parse(`${point.date}T00:00:00Z`);
      if (result.oldestAt === undefined || at < result.oldestAt) result.oldestAt = at;
    }
  }
  return result;
}

export function readDashboardDailyUsage(context: vscode.ExtensionContext, accountId: string): DashboardDailyUsageCacheEntry | undefined {
  initializeDashboardUsageStorage(context);
  const store = getSqliteStateStore();
  const entries = store ? [readDailyUsageRow(store, accountId)].filter(Boolean) : readDashboardDailyUsageCache(context).filter(entry => entry.accountId === accountId);
  return normalizeDashboardDailyUsageCache(entries)[0];
}

// Serialize shared panel/browser storage reads and writes to prevent lost updates.
const usageHistoryWriteQueues = new WeakMap<vscode.Memento, Promise<void>>();

function enqueueUsageHistoryWrite<T>(context: vscode.ExtensionContext, task: () => Promise<T>): Promise<T> {
  const run = (usageHistoryWriteQueues.get(context.globalState) ?? Promise.resolve()).then(() =>
    getSqliteStateStore()
      ? runCrossWindowExclusive("state:dashboard-usage", "Usage history update", task, { waitMs: 500, background: true })
      : task()
  );
  usageHistoryWriteQueues.set(context.globalState, run.then(
    () => undefined,
    () => undefined
  ));
  return run;
}

export function readDashboardUsageHistory(context: vscode.ExtensionContext): DashboardUsageSample[] {
  const store = getSqliteStateStore();
  if (store) {
    if (!store.get("migrations","usage-rows-v1")) replaceUsageRows(store,normalizeDashboardUsageHistory(context.globalState.get<unknown>(STORAGE_KEY)),STORAGE_KEY,true);
    return normalizeDashboardUsageHistory(readUsageRows(store));
  }
  return normalizeDashboardUsageHistory(context.globalState.get<unknown>(STORAGE_KEY));
}

export function readDashboardDailyUsageCache(context: vscode.ExtensionContext): DashboardDailyUsageCacheEntry[] {
  const store = getSqliteStateStore();
  if (store) {
    if (!store.get("migrations","daily-usage-rows-v1")) replaceDailyUsageRows(store,normalizeDashboardDailyUsageCache(context.globalState.get<unknown>(DAILY_USAGE_CACHE_KEY)),DAILY_USAGE_CACHE_KEY,true);
    return normalizeDashboardDailyUsageCache(readDailyUsageRows(store));
  }
  return normalizeDashboardDailyUsageCache(context.globalState.get<unknown>(DAILY_USAGE_CACHE_KEY));
}

async function persistUsageHistory(context:vscode.ExtensionContext,samples:readonly DashboardUsageSample[]):Promise<void> {
  const store = getSqliteStateStore();
  if (store) replaceUsageRows(store,samples,STORAGE_KEY);
  else await context.globalState.update(STORAGE_KEY,samples);
}

export async function upsertDashboardDailyUsageCache(
  context: vscode.ExtensionContext,
  accountId: string,
  usage: CodexDailyUsageBreakdown,
  fetchedAt = Date.now(),
  accountLabel?: string
): Promise<DashboardDailyUsageCacheEntry[]> {
  if (!normalizeDashboardDailyUsageCache([{ accountId, fetchedAt, usage, accountLabel }]).length) {
    throw new Error("The daily usage cache entry is invalid.");
  }
  return enqueueUsageHistoryWrite(context, async () => {
    const store = getSqliteStateStore();
    const previous = readDashboardDailyUsage(context, accountId);
    if (previous && previous.fetchedAt > fetchedAt) return store ? [previous] : readDashboardDailyUsageCache(context);
    const points = new Map(previous?.usage.points.map(point => [point.date, point]));
    for (const point of usage.points) points.set(point.date, point);
    const entry = { accountId, fetchedAt, ...((accountLabel ?? previous?.accountLabel) ? { accountLabel: accountLabel ?? previous?.accountLabel } : {}), usage: { days: Math.max(previous?.usage.days ?? 1, usage.days),
      points: [...points.values()].filter(point => Date.parse(`${point.date}T00:00:00Z`) >= tokenHistoryCutoff()).sort((a, b) => a.date.localeCompare(b.date)).slice(-90) } };
    if (store) {
      upsertDailyUsageRow(store, entry, '');
      return [entry];
    }
    const current = readDashboardDailyUsageCache(context);
    const entries = current.filter((entry) => entry.accountId !== accountId);
    entries.push(entry);
    const normalized = normalizeDashboardDailyUsageCache(entries);
    await context.globalState.update(DAILY_USAGE_CACHE_KEY, normalized);
    return normalized;
  });
}

export function normalizeDashboardDailyUsageCache(value: unknown): DashboardDailyUsageCacheEntry[] {
  if (!Array.isArray(value)) return [];
  const latestAllowedTimestamp = Date.now() + MAX_FUTURE_TIMESTAMP_SKEW_MS;
  const seen = new Set<string>();
  return value
    .filter((item): item is DashboardDailyUsageCacheEntry => {
      if (!item || typeof item !== "object") return false;
      const entry = item as Partial<DashboardDailyUsageCacheEntry>;
      return (
        typeof entry.accountId === "string" &&
        entry.accountId.length > 0 &&
        entry.accountId.length <= 4096 &&
        (entry.accountLabel === undefined || (typeof entry.accountLabel === "string" && entry.accountLabel.trim().length > 0 && entry.accountLabel.length <= 320 && !/[\u0000-\u001f\u007f]/.test(entry.accountLabel))) &&
        typeof entry.fetchedAt === "number" &&
        Number.isFinite(entry.fetchedAt) &&
        entry.fetchedAt > 0 &&
        entry.fetchedAt <= latestAllowedTimestamp &&
        isDailyUsageBreakdown(entry.usage, 91)
      );
    })
    .sort((left, right) => right.fetchedAt - left.fetchedAt)
    .filter((entry) => {
      if (seen.has(entry.accountId)) return false;
      seen.add(entry.accountId);
      return true;
    });
}

export function isDailyUsageBreakdown(value: unknown, maxPoints = 31): value is CodexDailyUsageBreakdown {
  if (!value || typeof value !== "object") return false;
  const usage = value as Partial<CodexDailyUsageBreakdown>;
  return (
    typeof usage.days === "number" &&
    Number.isFinite(usage.days) &&
    usage.days >= 1 &&
    usage.days <= 30 &&
    Array.isArray(usage.points) &&
    usage.points.length <= maxPoints &&
    usage.points.every(
      (point) =>
        point &&
        (point.unit === undefined || point.unit === "tokens") &&
        typeof point.date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(point.date) &&
        Number.isFinite(Date.parse(`${point.date}T00:00:00Z`)) &&
        new Date(`${point.date}T00:00:00Z`).toISOString().slice(0, 10) === point.date &&
        typeof point.totalTokens === "number" &&
        Number.isFinite(point.totalTokens) &&
        (point.unit !== "tokens" || Number.isSafeInteger(point.totalTokens)) &&
        point.totalTokens >= 0 &&
        (point.unit !== "tokens" || point.extensionTokens === undefined || (point.extensionTokens <= point.totalTokens &&
          (point.otherTokens === undefined || point.extensionTokens + point.otherTokens === point.totalTokens))) &&
        [point.extensionTokens, point.otherTokens, point.inputTokens, point.outputTokens, point.cachedTokens]
          .every(value => value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0 && (point.unit !== "tokens" || Number.isSafeInteger(value)))) &&
        (point.surfaceValues === undefined || (point.surfaceValues && typeof point.surfaceValues === "object" &&
          !Array.isArray(point.surfaceValues) && Object.keys(point.surfaceValues).length <= 64 &&
          Object.entries(point.surfaceValues).every(([key, value]) => key.length <= 128 && typeof value === "number" && Number.isFinite(value) && value >= 0 && (point.unit !== "tokens" || Number.isSafeInteger(value)))))
    )
  );
}

export async function saveDashboardUsageHistory(
  context: vscode.ExtensionContext,
  samples: readonly DashboardUsageSample[]
): Promise<void> {
  const normalized = normalizeDashboardUsageHistory(samples);
  await enqueueUsageHistoryWrite(context, async () => {
    initializeDashboardUsageStorage(context);
    const store = getSqliteStateStore();
    if (store) {
      if (!samples.length) store.prepare("DELETE FROM usage_samples").run();
      else mergeUsageRows(store, normalized);
      return;
    }
    if (samples.length === 0) {
      await persistUsageHistory(context, []);
      return;
    }
    const current = readDashboardUsageHistory(context);
    const merged = new Map(current.map((sample) => [`${sample.accountId}:${sample.at}`, sample]));
    for (const sample of normalized) merged.set(`${sample.accountId}:${sample.at}`, sample);
    await persistUsageHistory(context, normalizeDashboardUsageHistory([...merged.values()]));
  });
}

export async function appendDashboardUsageSnapshot(
  context: vscode.ExtensionContext,
  state: DashboardState,
  at = Date.now()
): Promise<DashboardUsageSample[]> {
  if (!Number.isFinite(at) || at <= 0 || at > Date.now() + MAX_FUTURE_TIMESTAMP_SKEW_MS) {
    throw new Error("The usage snapshot timestamp is invalid.");
  }
  return enqueueUsageHistoryWrite(context, async () => {
    const retentionDays = state.settings.usageHistoryRetentionDays;
    const cutoff = retentionDays > 0 ? at - retentionDays * 86_400_000 : Number.NEGATIVE_INFINITY;
    initializeDashboardUsageStorage(context);
    const store = getSqliteStateStore();
    if (store) {
      const samples = state.accounts.map(account => ({ at, accountId: account.id,
        hourly: account.metrics.find(metric => metric.period === "hourly")?.percentage,
        weekly: account.metrics.find(metric => metric.period === "weekly" || metric.period === "monthly")?.percentage,
        review: account.metrics.find(metric => metric.key.includes("review"))?.percentage }));
      appendUsageRows(store, normalizeDashboardUsageHistory(samples), cutoff);
      return samples;
    }
    const stored = readDashboardUsageHistory(context);
    const current = stored.filter((sample) => sample.at >= cutoff);
    const previousByAccount = new Map<string, DashboardUsageSample>();
    for (const sample of current) previousByAccount.set(sample.accountId, sample);
    let changed = current.length !== stored.length;
    for (const account of state.accounts) {
      const sample: DashboardUsageSample = {
        at,
        accountId: account.id,
        hourly: account.metrics.find((metric) => metric.period === "hourly")?.percentage,
        weekly: account.metrics.find((metric) => metric.period === "weekly" || metric.period === "monthly")?.percentage,
        review: account.metrics.find((metric) => metric.key.includes("review"))?.percentage
      };
      const previous = previousByAccount.get(account.id);
      if (previous && previous.at > at) continue;
      if (
        previous &&
        previous.hourly === sample.hourly &&
        previous.weekly === sample.weekly &&
        previous.review === sample.review
      ) {
        continue;
      }
      current.push(sample);
      previousByAccount.set(account.id, sample);
      changed = true;
    }
    if (!changed) return current;
    const normalized = normalizeDashboardUsageHistory(current);
    await persistUsageHistory(context, normalized);
    return normalized;
  });
}

export function normalizeDashboardUsageHistory(value: unknown): DashboardUsageSample[] {
  if (!Array.isArray(value)) return [];
  const latestAllowedTimestamp = Date.now() + MAX_FUTURE_TIMESTAMP_SKEW_MS;
  const normalized = new Map<string, DashboardUsageSample>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const sample = item as Partial<DashboardUsageSample>;
    if (
      typeof sample.at !== "number" ||
      !Number.isFinite(sample.at) ||
      sample.at <= 0 ||
      sample.at > latestAllowedTimestamp ||
      typeof sample.accountId !== "string" ||
      !sample.accountId.trim() ||
      sample.accountId.length > 4096
    ) {
      continue;
    }
    const hourly = normalizePercentage(sample.hourly);
    const weekly = normalizePercentage(sample.weekly);
    const review = normalizePercentage(sample.review);
    normalized.set(`${sample.accountId}:${sample.at}`, {
      at: sample.at,
      accountId: sample.accountId,
      ...(hourly !== undefined ? { hourly } : {}),
      ...(weekly !== undefined ? { weekly } : {}),
      ...(review !== undefined ? { review } : {})
    });
  }
  return [...normalized.values()].sort((left, right) => left.at - right.at).slice(-MAX_SAMPLES);
}

function normalizePercentage(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}
