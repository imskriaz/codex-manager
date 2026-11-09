import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import type * as vscode from "vscode";
import { fetch as upstreamFetch } from "undici";
import type { AccountsRepository } from "../storage";
import { needsTokenRefresh } from "../auth/oauth";
import { CODEX_API_BASE } from "../infrastructure/config/apiEndpoints";
import { getCodexProxyDispatcher } from "../infrastructure/config/proxyEnvironment";
import { readDashboardApiToken, hasApiPermission } from "./dashboardApiToken";
import { apiTokenProjects } from "../domain/dashboard/apiActions";
import { maybeAutoSwitchForActiveQuota, refreshSingleQuota } from "../application/accounts/quota";
import { createSharedInspection, waitWithin } from "../utils/concurrency";
import {
  AiProxyError,
  AiStream,
  completedAiResponse,
  normalizeAiRequest,
  object,
  type AiProtocol
} from "./aiProxyProtocol";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// shortcut: advertise the supported Codex wire version; raise this when adopting newer wire features.
const CODEX_WIRE_VERSION = "0.160.0";
type Json = Record<string, unknown>;
type Model = { id: string; name: string };
export const isAiProxyPath = (path: string): boolean => path === "/v1" || path.startsWith("/v1/");

/** Parse complete SSE records across arbitrary UTF-8/chunk boundaries. */
export async function* aiEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<Json> {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let pending = "",
    bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await waitWithin(reader.read(), 90_000, "The AI backend stopped responding.", signal);
      if (!next.done) {
        bytes += next.value.byteLength;
        if (bytes > MAX_OUTPUT_BYTES)
          throw new AiProxyError(502, "The AI response exceeded the size limit.", "api_error");
      }
      pending += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
      pending = pending.replace(/\r\n/g, "\n");
      let end: number;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const record = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (record.length > 1024 * 1024)
          throw new AiProxyError(502, "The AI backend returned an oversized stream record.", "api_error");
        const data = record
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data && data !== "[DONE]") {
          let event: unknown;
          try {
            event = JSON.parse(data);
          } catch {
            throw new AiProxyError(502, "The AI backend returned an invalid stream.", "api_error");
          }
          yield object(event, "backend event");
        }
      }
      if (pending.length > 1024 * 1024)
        throw new AiProxyError(502, "The AI backend returned an oversized stream record.", "api_error");
      if (next.done) {
        if (pending.trim() && !pending.trim().startsWith(":"))
          throw new AiProxyError(502, "The AI stream ended with a partial record.", "api_error");
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readBody(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? ""))
    throw new AiProxyError(415, "Use Content-Type: application/json.");
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")
    throw new AiProxyError(415, "Compressed request bodies are not supported.");
  if (Number(request.headers["content-length"]) > MAX_BYTES)
    throw new AiProxyError(413, "The AI request exceeds 8 MiB.");
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      request.off("data", data);
      request.off("end", end);
      request.off("error", fail);
      signal.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      cleanup();
      request.pause();
      reject(error instanceof Error ? error : new Error("The request body could not be read."));
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        fail(new AiProxyError(413, "The AI request exceeds 8 MiB."));
        return;
      }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new AiProxyError(400, "The request body is not valid JSON."));
      }
    };
    const abort = () => fail(signal.reason);
    if (signal.aborted) {
      abort();
      return;
    }
    request.on("data", data);
    request.once("end", end);
    request.once("error", fail);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class AiProxy {
  private readonly running = new Set<AbortController>();
  private stopped = false;
  private models?: { key: string; at: number; data: Model[] };
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repo: AccountsRepository,
    private readonly enabled: () => boolean,
    private readonly canUseAccount: (id: string) => boolean = () => true,
    private readonly refresh: () => void = () => undefined
  ) {}
  stop(): void {
    this.stopped = true;
    for (const controller of this.running)
      controller.abort(new AiProxyError(503, "The host is restarting. Retry after reconnecting.", "api_error"));
    this.models = undefined;
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const protocol: AiProtocol =
      url.pathname === "/v1/messages"
        ? "claude"
        : url.pathname === "/v1/responses"
          ? "responses"
          : url.pathname.startsWith("/v1/models") &&
              (request.headers["anthropic-version"] || request.headers["x-api-key"])
            ? "claude"
            : "chat";
    const controller = new AbortController(),
      signal = controller.signal;
    const requestId = randomUUID();
    response.setHeader("x-request-id", requestId);
    response.setHeader("request-id", requestId);
    response.setHeader("Cache-Control", "no-store");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let acceptedGeneration = false;
    const disconnect = () => {
      if (!response.writableEnded) controller.abort(new Error("The API client disconnected."));
    };
    request.once("aborted", disconnect);
    response.once("close", disconnect);
    try {
      if (this.stopped) throw new AiProxyError(503, "The host is restarting. Retry after reconnecting.", "api_error");
      if (!this.enabled()) throw new AiProxyError(401, "Dashboard API access is disabled.", "authentication_error");
      const auth = request.headers.authorization;
      const bearer = auth?.match(/^Bearer (cm_[a-f0-9]{64})$/i)?.[1];
      const apiKey = typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : undefined;
      if ((auth && !bearer) || (bearer && apiKey && bearer !== apiKey))
        throw new AiProxyError(401, "Supply one valid Manager API key.", "authentication_error");
      const candidate = bearer ?? apiKey;
      const token = await readDashboardApiToken(this.context, candidate);
      if (!token) throw new AiProxyError(401, "Invalid or revoked Manager API key.", "authentication_error");
      if (apiTokenProjects(token).length || !hasApiPermission(token, "aiProxy"))
        throw new AiProxyError(
          403,
          "This key needs host-wide aiProxy permission or all operations.",
          "permission_error"
        );
      if (this.stopped) throw new AiProxyError(503, "The host is restarting. Retry after reconnecting.", "api_error");
      if (this.running.size >= 8) {
        response.setHeader("Retry-After", "1");
        throw new AiProxyError(429, "The AI proxy is busy. Retry shortly.", "rate_limit_error");
      }
      this.running.add(controller);
      timer = setTimeout(
        () => controller.abort(new AiProxyError(504, "The AI request timed out.", "api_error")),
        180_000
      );
      const path = url.pathname;
      if (request.method === "GET" && (path === "/v1/models" || path.startsWith("/v1/models/"))) {
        const models = await this.listModels(signal);
        const format = (model: Model): Json =>
          protocol === "claude"
            ? { id: model.id, type: "model", display_name: model.name, created_at: "1970-01-01T00:00:00Z" }
            : { id: model.id, object: "model", created: 0, owned_by: "openai" };
        if (path !== "/v1/models") {
          const model = models.find((item) => item.id === decodeURIComponent(path.slice("/v1/models/".length)));
          if (!model) throw new AiProxyError(404, "Model not found. Use GET /v1/models.", "not_found_error");
          this.json(response, format(model));
        } else if (protocol === "claude") {
          const limit = Number(url.searchParams.get("limit") ?? 20),
            after = url.searchParams.get("after_id"),
            before = url.searchParams.get("before_id");
          if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || (after && before))
            throw new AiProxyError(400, "Use limit=1..1000 and at most one model cursor.");
          const cursor = after ?? before,
            index = cursor ? models.findIndex((item) => item.id === cursor) : -1;
          if (cursor && index < 0) throw new AiProxyError(400, "Unknown model cursor.");
          const available = after ? models.slice(index + 1) : before ? models.slice(0, index).reverse() : models;
          const page = available.slice(0, limit);
          this.json(response, {
            data: page.map(format),
            has_more: available.length > limit,
            first_id: page[0]?.id ?? null,
            last_id: page.at(-1)?.id ?? null
          });
        } else this.json(response, { object: "list", data: models.map(format) });
        return;
      }
      if (!["/v1/chat/completions", "/v1/responses", "/v1/messages"].includes(path))
        throw new AiProxyError(404, "Unknown AI endpoint.", "not_found_error");
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        throw new AiProxyError(405, "Use POST for generation.");
      }
      const body = await waitWithin(readBody(request, signal), 30_000, "The request body timed out.", signal).catch(
        (error) => {
          throw error instanceof AiProxyError || signal.aborted
            ? error
            : new AiProxyError(408, "The request body timed out.");
        }
      );
      const generationProtocol: AiProtocol =
        path === "/v1/messages" ? "claude" : path === "/v1/responses" ? "responses" : "chat";
      const normalized = normalizeAiRequest(body, generationProtocol);
      signal.throwIfAborted();
      const upstream = await this.fetchBackend("/responses", normalized.body, signal);
      acceptedGeneration = true;
      const contentType = upstream.headers.get("content-type");
      if (!upstream.body || (contentType && !contentType.includes("text/event-stream"))) {
        await upstream.body?.cancel();
        throw new AiProxyError(502, "The AI backend did not return an event stream.", "api_error");
      }
      const stream = new AiStream(generationProtocol, String(normalized.body["model"]), normalized.includeUsage);
      let completed = false;
      for await (const event of aiEvents(upstream.body as unknown as ReadableStream<Uint8Array>, signal)) {
        signal.throwIfAborted();
        const type = event["type"];
        if (type === "error" || type === "response.failed")
          throw new AiProxyError(
            502,
            "The AI backend could not complete the response. No retry was attempted.",
            "api_error"
          );
        const final =
          type === "response.completed" || type === "response.incomplete"
            ? completedAiResponse(
                object(event["response"], "AI response"),
                generationProtocol,
                String(normalized.body["model"])
              )
            : undefined;
        if (normalized.stream) {
          const wire = stream.event(event);
          if (wire) {
            if (!response.headersSent) {
              response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
              response.setHeader("X-Accel-Buffering", "no");
            }
            if (!response.write(wire)) await once(response, "drain", { signal });
          }
        }
        if (type === "response.completed" || type === "response.incomplete") {
          if (!normalized.stream) this.json(response, final);
          completed = true;
          break;
        }
      }
      if (!completed)
        throw new AiProxyError(
          502,
          "The AI connection ended before completion. No automatic retry was attempted.",
          "api_error"
        );
      if (!response.writableEnded) response.end();
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) {
        const reason = signal.aborted && signal.reason instanceof AiProxyError ? signal.reason : error;
        const failure =
          reason instanceof AiProxyError && !(acceptedGeneration && reason.status === 400)
            ? reason
            : new AiProxyError(
                502,
                "The AI backend is unavailable. Check the account and connection, then retry.",
                "api_error"
              );
        const envelope =
          protocol === "claude"
            ? { type: "error", error: { type: failure.code, message: failure.message }, request_id: requestId }
            : { error: { message: failure.message, type: failure.code, code: failure.code, param: null } };
        if (response.headersSent) response.end(`event: error\ndata: ${JSON.stringify(envelope)}\n\n`);
        else {
          response.statusCode = failure.status;
          this.json(response, envelope);
        }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      this.running.delete(controller);
      request.off("aborted", disconnect);
      response.off("close", disconnect);
      if (!request.complete) {
        response.shouldKeepAlive = false;
        request.resume();
      }
    }
  }

  private json(response: ServerResponse, value: unknown): void {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(value));
  }
  private async fetchBackend(
    path: string,
    body: Json | undefined,
    signal: AbortSignal
  ): Promise<Awaited<ReturnType<typeof upstreamFetch>>> {
    const tried = new Set<string>();
    const view = { refresh: this.refresh, deferHostReload: true };
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      const accounts = await waitWithin(this.repo.listAccounts(), 5000, "Accounts could not be read.", signal);
      const account = accounts.find((item) => item.isActive);
      if (!account || account.enabled === false || !this.canUseAccount(account.id))
        throw new AiProxyError(
          503,
          "Select an enabled account available on this device in Account Center.",
          "api_error"
        );
      let tokens = await waitWithin(
        this.repo.getTokens(account.id, { bypassCache: true }),
        5000,
        "Account credentials could not be read.",
        signal
      );
      if (!tokens)
        throw new AiProxyError(
          503,
          "The active account has no saved credentials. Reauthorize it in Account Center.",
          "api_error"
        );
      if (needsTokenRefresh(tokens) && account.tokenRefreshEnabled === true)
        tokens = await waitWithin(
          this.repo.refreshAccountTokens(account.id),
          15_000,
          "Account token renewal is still pending. Retry shortly.",
          signal
        );
      for (let renewal = 0; renewal < 2; renewal++) {
        signal.throwIfAborted();
        const latest = await this.repo.getAccount(account.id);
        if (!latest?.isActive || latest.enabled === false || !this.canUseAccount(account.id))
          throw new AiProxyError(409, "The active account changed. Retry the request.", "api_error");
        const dispatcher = getCodexProxyDispatcher();
        const result = await upstreamFetch(`${CODEX_API_BASE}/backend-api/codex${path}`, {
          method: body ? "POST" : "GET",
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            ...((tokens.accountId ?? account.accountId)
              ? { "ChatGPT-Account-Id": (tokens.accountId ?? account.accountId)! }
              : {}),
            "Content-Type": "application/json",
            Accept: body ? "text/event-stream" : "application/json",
            originator: "codex_cli_rs"
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal,
          ...(dispatcher ? { dispatcher } : {}),
          redirect: "error"
        });
        if (result.ok) return result;
        const status = result.status;
        await result.body?.cancel();
        if (status === 401 && renewal === 0 && account.tokenRefreshEnabled === true && tokens.refreshToken) {
          tokens = await waitWithin(
            this.repo.refreshAccountTokens(account.id, { force: true }),
            15_000,
            "Account token renewal is still pending. Retry shortly.",
            signal
          );
          continue;
        }
        if ((status === 401 || status === 429) && !tried.has(account.id) && attempt < 2) {
          tried.add(account.id);
          await waitWithin(
            refreshSingleQuota(this.repo, view, account.id, {
              forceRefresh: true,
              announce: false,
              warnQuota: false,
              allowTokenRefresh: false,
              canUseAccount: (id) => !signal.aborted && this.canUseAccount(id)
            }),
            15_000,
            "Quota verification is still pending. Retry shortly.",
            signal
          );
          const switched = await waitWithin(
            maybeAutoSwitchForActiveQuota(this.repo, view, {
              canUseAccount: (id) => !signal.aborted && (id === account.id || !tried.has(id)) && this.canUseAccount(id)
            }),
            15_000,
            "Account selection is still pending. Retry shortly.",
            signal
          );
          if (switched) break;
        }
        if (status === 429)
          throw new AiProxyError(
            429,
            "The active account is rate limited. Account switching was unavailable or blocked by its normal rules.",
            "rate_limit_error"
          );
        throw new AiProxyError(
          status === 400 || status === 404 ? status : status === 401 || status === 403 ? 503 : 502,
          status === 400
            ? "The Codex backend rejected this model or request parameter."
            : status === 404
              ? "The requested model or backend endpoint is unavailable."
              : status === 401 || status === 403
                ? "The saved account was rejected. Reauthorize it in Account Center."
                : "The Codex backend is unavailable. Retry later.",
          status === 400 ? "invalid_request_error" : "api_error"
        );
      }
    }
    throw new AiProxyError(503, "No account could complete this request.", "api_error");
  }

  private async listModels(signal: AbortSignal): Promise<Model[]> {
    const account = (await this.repo.listAccounts()).find((item) => item.isActive);
    if (!account || account.enabled === false || !this.canUseAccount(account.id))
      throw new AiProxyError(503, "Select an enabled account available on this device in Account Center.", "api_error");
    const tokens = await this.repo.getTokens(account.id, { bypassCache: true });
    const key = `${account.id}:${createHash("sha256")
      .update(tokens?.accessToken ?? "")
      .digest("hex")}`;
    if (this.models?.key === key && Date.now() - this.models.at < 60_000) return this.models.data;
    return createSharedInspection(
      `ai-models:${key}`,
      async (discoverySignal) => {
        const response = await this.fetchBackend(
          `/models?client_version=${CODEX_WIRE_VERSION}`,
          undefined,
          discoverySignal
        );
        let text = "",
          bytes = 0;
        const decoder = new TextDecoder();
        if (!response.body) throw new AiProxyError(502, "The model catalogue could not be read.", "api_error");
        for await (const raw of response.body) {
          const chunk = raw as Uint8Array;
          discoverySignal.throwIfAborted();
          bytes += chunk.byteLength;
          if (bytes > MAX_BYTES)
            throw new AiProxyError(502, "The model catalogue exceeds the size limit.", "api_error");
          text += decoder.decode(chunk, { stream: true });
        }
        text += decoder.decode();
        let payload: Json;
        try {
          payload = object(JSON.parse(text));
        } catch {
          throw new AiProxyError(502, "The model catalogue could not be read.", "api_error");
        }
        const rows = payload["models"] ?? payload["data"];
        if (!Array.isArray(rows)) throw new AiProxyError(502, "The backend returned no model catalogue.", "api_error");
        const data: Model[] = [],
          seen = new Set<string>();
        for (const raw of rows.slice(0, 1000)) {
          const row = object(raw, "model"),
            id = row["slug"] ?? row["id"];
          if (row["visibility"] === "hide") continue;
          if (typeof id === "string" && /^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(id) && !seen.has(id)) {
            data.push({ id, name: typeof row["display_name"] === "string" ? row["display_name"] : id });
            seen.add(id);
          }
        }
        if (!data.length)
          throw new AiProxyError(503, "No API models are available for the active account.", "api_error");
        const current = (await this.repo.listAccounts()).find((item) => item.isActive);
        if (current?.id === account.id) this.models = { key, at: Date.now(), data };
        return data;
      },
      signal,
      15_000
    );
  }
}
