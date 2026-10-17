import { CodexDailyUsageBreakdown, CodexDailyUsagePoint, CodexTokens } from "../core/types";
import { APIError } from "../core/errors";
import { DAILY_USAGE_BREAKDOWN_URL } from "../infrastructure/config/apiEndpoints";
import { extractClaims } from "../utils/jwt";
import { logNetworkEvent } from "../utils/debug";
import { fetchWithTimeout, summarizeNetworkBody } from "../utils/network";

type UnknownRecord = Record<string, unknown>;

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
    throw new APIError(`Daily usage breakdown API returned ${response.status}: ${raw.slice(0, 200)}`, {
      statusCode: response.status,
      responseBody: raw.slice(0, 200),
      context: Number.isFinite(retryAt) && retryAt > Date.now() ? { retryAt } : undefined
    });
  }

  const payload = parseJson(raw);
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
  }

  return undefined;
}

function parseUsagePoint(value: UnknownRecord): CodexDailyUsagePoint | undefined {
  const date =
    readString(value, ["date", "day", "usage_date", "bucket_date", "time_bucket_start"]) ??
    normalizeTimestamp(readNumber(value, ["timestamp", "start_time", "bucket_start", "epoch_seconds"]));
  const totals = isRecord(value["totals"]) ? value["totals"] : value;
  const totalTokens = readNumber(totals, ["text_total_tokens", "total_tokens", "token_count", "total_token_count", "num_tokens"]);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || !Number.isSafeInteger(totalTokens) || totalTokens! < 0) return undefined;
  const clients = value["clients"];
  const surfaceValues: Record<string, number> = Object.create(null) as Record<string, number>;
  if (clients !== undefined) {
    if (!Array.isArray(clients) || clients.length > 64) return undefined;
    for (const client of clients) {
      if (!isRecord(client) || typeof client["client_id"] !== "string" || client["client_id"].length > 128) return undefined;
      const used = readNumber(client, ["text_total_tokens", "total_tokens"]);
      if (!Number.isSafeInteger(used) || used! < 0) return undefined;
      const id = client["client_id"].toLowerCase();
      if (["__proto__", "constructor", "prototype"].includes(id)) return undefined;
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
  const extensionTokens = clients === undefined || classified !== totalTokens ? undefined : surfaceValues["vscode"] ?? 0;
  return { date, unit: "tokens", totalTokens: totalTokens!, extensionTokens,
    otherTokens: extensionTokens === undefined ? undefined : totalTokens! - extensionTokens,
    surfaceValues: clients === undefined ? undefined : surfaceValues,
    inputTokens, outputTokens, cachedTokens };
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

function parseJson(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw);
  return parsed;
}
