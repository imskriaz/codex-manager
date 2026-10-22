import { CodexDailyUsageBreakdown, CodexDailyUsagePoint, CodexTokens, CodexManagerAccountRecord } from "../core/types";
import type { AccountsRepository } from "../storage/accounts";
import { needsTokenRefresh } from "../auth/oauth";
import { waitWithin } from "../utils/concurrency";
import { APIError } from "../core/errors";
import { DAILY_USAGE_BREAKDOWN_URL } from "../infrastructure/config/apiEndpoints";
import { extractClaims } from "../utils/jwt";
import { logNetworkEvent } from "../utils/debug";
import { fetchWithTimeout, summarizeNetworkBody } from "../utils/network";

type UnknownRecord = Record<string, unknown>;

/** Both details views use the selected account and the repository's guarded token rotation. */
export async function fetchAccountDailyUsage(
  repo: AccountsRepository, account: CodexManagerAccountRecord, days = 30, signal?: AbortSignal
): Promise<CodexDailyUsageBreakdown | undefined> {
  signal?.throwIfAborted();
  let tokens = await repo.getTokens(account.id, { bypassCache: true });
  if (!tokens?.accessToken) throw new Error("No access token is available for usage history. Reauthorize this account.");
  const scopedTokens = () => {
    if (account.accountId && tokens!.accountId && account.accountId !== tokens!.accountId) {
      throw new Error("The saved usage credentials belong to a different account. Reauthorize this account before retrying.");
    }
    return { ...tokens!, accountId: account.accountId ?? tokens!.accountId };
  };
  scopedTokens();
  let renewed = false;
  const renew = async (force: boolean) => {
    signal?.throwIfAborted();
    tokens = await waitWithin(repo.refreshAccountTokens(account.id, { force }), 5_000,
      "Usage credentials are still refreshing. Saved history was kept; retry shortly without refreshing the token again.", signal);
    renewed = true;
    scopedTokens();
  };
  const mayRenew = account.tokenRefreshEnabled === true && Boolean(tokens.refreshToken);
  if (mayRenew && needsTokenRefresh(tokens)) await renew(false);
  let usage;
  try { usage = await fetchDailyUsageBreakdown(scopedTokens(), days, signal); }
  catch (error) {
    if (!(error instanceof APIError) || error.statusCode !== 401 || !mayRenew || renewed) throw error;
    await renew(true);
    usage = await fetchDailyUsageBreakdown(scopedTokens(), days, signal);
  }
  // Usage already read belongs in the log even if its saved account was removed meanwhile.
  if (!usage) return usage;
  const projected = toVSCodeDailyUsage(usage);
  if (usage.points.length && !projected.points.length) throw new Error("The provider returned no verified VS Code token counts. Saved history was kept; retry when client usage is available.");
  return projected;
}

export function toVSCodeDailyUsage(usage: CodexDailyUsageBreakdown): CodexDailyUsageBreakdown {
  const points = usage.points.flatMap(point => {
    const count = point.extensionTokens ?? point.surfaceValues?.['vscode'];
    return point.unit !== 'tokens' || !Number.isSafeInteger(count) || count! < 0 ? [] : [{ date: point.date, unit: 'tokens' as const, totalTokens: count!, extensionTokens: count! }];
  });
  return { days: usage.days, points };
}

export async function fetchDailyUsageBreakdown(
  tokens: CodexTokens,
  days = 30,
  signal?: AbortSignal
): Promise<CodexDailyUsageBreakdown | undefined> {
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("Choose a daily usage range from 1 to 30 days.");
  const claims = extractClaims(tokens.idToken, tokens.accessToken);
  const headers = new Headers({
    Authorization: `Bearer ${tokens.accessToken}`,
    Accept: "application/json"
  });

  const accountId = tokens.accountId ?? claims.accountId;
  if (accountId) {
    headers.set("ChatGPT-Account-Id", accountId);
  }

  const url = new URL(DAILY_USAGE_BREAKDOWN_URL);
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() + 1);
  url.searchParams.set("start_date", new Date(end.getTime() - days * 86_400_000).toISOString().slice(0, 10));
  url.searchParams.set("end_date", end.toISOString().slice(0, 10));
  url.searchParams.set("group_by", "day");
  url.searchParams.set("workspace_user", "true");

  const response = await fetchWithTimeout(
    url.toString(),
    {
      method: "GET",
      headers,
      signal
    },
    15000,
    "Daily usage request"
  );

  const raw = await response.text();
  logNetworkEvent("daily-usage", {
    accountId,
    days,
    status: response.status,
    ok: response.ok,
    url: url.toString(),
    bodyPreview: summarizeNetworkBody(raw)
  });
  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    const retryAt = retryAfter === null ? NaN : /^\d+$/.test(retryAfter.trim()) ? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter);
    const hint = response.status === 401 ? "The saved credentials were rejected. Refresh the token or reauthorize this account."
      : response.status === 403 ? "Usage history is not permitted for this account or workspace. Check its access and reauthorize if needed."
      : response.status === 429 ? "The usage provider is rate limiting requests. Retry after its cooldown."
      : "The usage provider could not complete the request. Check the connection and retry.";
    throw new APIError(`Daily usage breakdown API returned ${response.status}. ${hint}`, {
      statusCode: response.status,
      responseBody: raw.slice(0, 200),
      context: Number.isFinite(retryAt) && retryAt > Date.now() ? { retryAt } : undefined
    });
  }

  let payload: unknown;
  try { payload = JSON.parse(raw) as unknown; }
  catch { throw new Error("The usage provider returned an unreadable response. Saved history was kept; check the connection and retry."); }
  return parseDailyUsageBreakdown(payload, days);
}

function parseDailyUsageBreakdown(payload: unknown, fallbackDays: number): CodexDailyUsageBreakdown | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  if (payload["units"] !== undefined && payload["units"] !== "tokens") return undefined;

  const records = collectUsageRecords(payload);
  if (!records) return undefined;
  const parsedPoints = records.map((record) => parseUsagePoint(record));
  const points = parsedPoints.filter(isUsagePoint);
  if (points.length !== records.length || new Set(points.map(point => point.date)).size !== points.length) return undefined;
  points.sort((a, b) => a.date.localeCompare(b.date));

  const days = readNumber(payload, ["days", "range_days", "window_days"]) ?? fallbackDays;

  return {
    days,
    points
  };
}

function collectUsageRecords(payload: UnknownRecord): UnknownRecord[] | undefined {
  const candidates = [
    payload["daily_usage"],
    payload["daily_token_usage_breakdown"],
    payload["breakdown"],
    payload["data"],
    payload["items"],
    payload["results"]
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.length <= 31 && candidate.every(isRecord) ? candidate : undefined;
    }
    if (isRecord(candidate)) {
      const rows: Array<UnknownRecord | undefined> = Object.entries(candidate).map(([date, value]) =>
        isRecord(value) ? { date, ...value } : undefined
      );
      if (rows.length > 0 && rows.length <= 31 && rows.every((row): row is UnknownRecord => isRecord(row))) return rows;
    }
  }

  if (readDate(payload) && (isRecord(payload["totals"]) || payload["total_tokens"] !== undefined)) return [payload];

  return undefined;
}

function parseUsagePoint(value: UnknownRecord): CodexDailyUsagePoint | undefined {
  const date =
    readDate(value) ??
    normalizeTimestamp(readNumber(value, ["timestamp", "start_time", "bucket_start", "epoch_seconds"]));
  const totals = isRecord(value["totals"]) ? value["totals"] : value;
  const reportedTotal = readNumber(totals, ["text_total_tokens", "total_tokens", "token_count", "total_token_count", "num_tokens"]);
  const components = [
    readNumber(totals, ["uncached_text_input_tokens"]),
    readNumber(totals, ["cached_text_input_tokens"]),
    readNumber(totals, ["text_output_tokens"])
  ];
  const totalTokens = reportedTotal ?? (components.every(value => value !== undefined) ? components.reduce((sum, value) => sum + value!, 0) : undefined);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || !Number.isSafeInteger(totalTokens) || totalTokens! < 0) return undefined;
  const clients = value["clients"];
  const surfaceValues: Record<string, number> = Object.create(null) as Record<string, number>;
  let completeClients = clients !== undefined;
  if (clients !== undefined) {
    if (!Array.isArray(clients) || clients.length > 64) return undefined;
    for (const client of clients) {
      if (!isRecord(client) || typeof client["client_id"] !== "string" || client["client_id"].length > 128) return undefined;
      const id = client["client_id"].toLowerCase();
      if (["__proto__", "constructor", "prototype"].includes(id)) return undefined;
      const used = readNumber(client, ["text_total_tokens", "total_tokens"]);
      // Some credit-only clients omit token counts; the day's verified total remains usable.
      if (client["text_total_tokens"] == null && client["total_tokens"] == null) { completeClients = false; continue; }
      if (!Number.isSafeInteger(used) || used! < 0) return undefined;
      const key = ["codex_ide_vscode", "vscode", "vs_code", "visual_studio_code"].includes(id) ? "vscode" : id;
      surfaceValues[key] = (surfaceValues[key] ?? 0) + used!;
    }
  }
  const classified = Object.values(surfaceValues).reduce((sum, used) => sum + used, 0);
  if (!Number.isSafeInteger(classified) || classified > totalTokens!) return undefined;
  const inputTokens = readNumber(totals, ["uncached_text_input_tokens", "input_tokens", "prompt_tokens"]);
  const outputTokens = readNumber(totals, ["text_output_tokens", "output_tokens", "completion_tokens"]);
  const cachedTokens = readNumber(totals, ["cached_text_input_tokens", "cached_tokens", "cache_tokens"]);
  if (![inputTokens, outputTokens, cachedTokens].every(count => count === undefined || (Number.isSafeInteger(count) && count >= 0))) return undefined;
  // Incomplete client attribution cannot safely establish VS Code's share.
  const extensionTokens = !completeClients || classified !== totalTokens ? undefined : surfaceValues["vscode"] ?? 0;
  return { date, unit: "tokens", totalTokens: totalTokens!, extensionTokens,
    otherTokens: extensionTokens === undefined ? undefined : totalTokens! - extensionTokens,
    surfaceValues: clients === undefined ? undefined : surfaceValues,
    inputTokens, outputTokens, cachedTokens };
}

function readDate(record: UnknownRecord): string | undefined {
  const raw = readString(record, ["date", "day", "usage_date", "bucket_date", "time_bucket_start"]);
  if (!raw) return undefined;
  const date = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
}

function normalizeTimestamp(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const epochMs = value > 1_000_000_000_000 ? value : value * 1000;
  if (!Number.isFinite(epochMs) || Math.abs(epochMs) > 8_640_000_000_000_000) return undefined;
  return new Date(epochMs).toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUsagePoint(value: CodexDailyUsagePoint | undefined): value is CodexDailyUsagePoint {
  return value !== undefined;
}

function readString(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readNumber(record: UnknownRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}
