import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type * as vscode from "vscode";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { AiProxy, aiEvents } from "../src/services/aiProxy";
import { AiStream, normalizeAiRequest, completedAiResponse } from "../src/services/aiProxyProtocol";
import { WebDashboardServer } from "../src/services/webDashboardServer";
import { createDashboardApiToken, revokeDashboardApiToken } from "../src/services/dashboardApiToken";
import { configureCrossWindowOperationCoordinator } from "../src/utils/crossWindowOperations";
import { removeTestDirectory } from "./testFilesystem";
import { fetch as upstream } from "undici";
import { maybeAutoSwitchForActiveQuota, refreshSingleQuota } from "../src/application/accounts/quota";
import type { AccountsRepository } from "../src/storage";
import { readApiProxyHistory } from '../src/services/aiProxyHistory';

vi.mock("undici", async (original) => ({ ...(await original<typeof import("undici")>()), fetch: vi.fn() }));
vi.mock("../src/application/accounts/quota", () => ({
  maybeAutoSwitchForActiveQuota: vi.fn(async () => false),
  refreshSingleQuota: vi.fn(async () => ({}))
}));
let root: string,
  context: vscode.ExtensionContext,
  server: Server,
  origin: string,
  key: string,
  proxy: AiProxy,
  enabled: boolean,
  allowed: boolean;
const active = { id: "account-a", email: "fixture-account@example.test", isActive: true, enabled: true, tokenRefreshEnabled: false };
const repo = {
  listAccounts: vi.fn(async () => [active]),
  getAccount: vi.fn(async () => active),
  getTokens: vi.fn(async () => ({ idToken: "", accessToken: "saved-access", accountId: "workspace-a" })),
  refreshAccountTokens: vi.fn(async () => ({ idToken: "", accessToken: "renewed-access", accountId: "workspace-a" }))
};
const completed = {
  id: "resp-one",
  model: "codex-test",
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "Hello 🌍" }] }],
  usage: { input_tokens: 11, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } }
};
const events = (...values: unknown[]) =>
  new Response(values.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join(""), {
    headers: { "content-type": "text/event-stream" }
  });
const generation = () =>
  events(
    { type: "response.created", response: { id: "resp-one" } },
    { type: "response.output_text.delta", delta: "Hello 🌍", output_index: 0 },
    { type: "response.completed", response: completed }
  );
const post = (path: string, value: unknown, credential = key, extra: Record<string, string> = {}) =>
  fetch(origin + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json", ...extra },
    body: JSON.stringify(value)
  });
const chat = (extra = {}) => ({ model: "codex-test", messages: [{ role: "user", content: "Hello" }], ...extra });
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(join(tmpdir(), "manager-ai-test-"));
  await configureCrossWindowOperationCoordinator(root);
  active.isActive = true;
  active.enabled = true;
  active.tokenRefreshEnabled = false;
  enabled = allowed = true;
  repo.listAccounts.mockImplementation(async () => [active]);
  repo.getAccount.mockImplementation(async () => active);
  repo.getTokens.mockImplementation(async () => ({
    idToken: "",
    accessToken: "saved-access",
    accountId: "workspace-a"
  }));
  repo.refreshAccountTokens.mockImplementation(async () => ({
    idToken: "",
    accessToken: "renewed-access",
    accountId: "workspace-a"
  }));
  vi.mocked(maybeAutoSwitchForActiveQuota).mockResolvedValue(false);
  vi.mocked(refreshSingleQuota).mockResolvedValue({});
  vi.mocked(upstream).mockImplementation(async () => generation() as never);
  const secrets = new Map<string, string>();
  context = {
    secrets: {
      get: async (name: string) => secrets.get(name),
      store: async (name: string, value: string) => {
        secrets.set(name, value);
      }
    }
  } as unknown as vscode.ExtensionContext;
  key = (await createDashboardApiToken(context, { name: "AI", permissions: ["aiProxy"] })).token;
  proxy = new AiProxy(
    context,
    repo as unknown as AccountsRepository,
    () => enabled,
    () => allowed
  );
  server = createServer((request, response) => {
    void proxy.handle(request, response, new URL(request.url!, origin));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  proxy.stop();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  vi.restoreAllMocks();
  await removeTestDirectory(root);
});

it('records real proxy usage and safe failure metadata without credentials or bodies', async () => {
  const response = await post('/v1/chat/completions', chat());
  await response.text();
  const entry = readApiProxyHistory().requests.find(row => row.id === response.headers.get('x-request-id'))!;
  expect(entry).toMatchObject({ status: 'completed', httpStatus: 200, model: 'codex-test', inputTokens: 11, outputTokens: 4, cachedInputTokens: 3, apiKeyName: 'AI', accountId: 'account-a', accountEmail: 'fixture-account@example.test' });
  expect(entry.apiKeyId).toBeTruthy();
  expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(entry)).not.toContain('Hello');
  expect(JSON.stringify(entry)).not.toContain(key);
  const failed = await post('/v1/chat/completions', chat(), 'secret-invalid-key');
  await failed.text();
  expect(readApiProxyHistory().requests.find(row => row.id === failed.headers.get('x-request-id'))).toMatchObject({ status: 'failed', httpStatus: 401, error: 'Proxy request failed: authentication_error (401). Check the API response for details.' });
  const invalid = await post('/v1/responses', { model: 'codex-test', input: 'private prompt', 'secret-body-field': 'private value' });
  await invalid.text();
  const invalidLog = readApiProxyHistory().requests.find(row => row.id === invalid.headers.get('x-request-id'));
  expect(invalidLog?.status).toBe('failed');
  expect(JSON.stringify(invalidLog)).not.toMatch(/secret-body-field|private prompt|private value/);
});

it('records incomplete streams separately from successful completion', async () => {
  vi.mocked(upstream).mockResolvedValue(events({ type: 'response.incomplete', response: { ...completed, status: 'incomplete' } }) as never);
  const response = await post('/v1/responses', { model: 'codex-test', input: 'private prompt', stream: true });
  await response.text();
  expect(readApiProxyHistory().requests.find(row => row.id === response.headers.get('x-request-id'))).toMatchObject({ status: 'incomplete', inputTokens: 11, outputTokens: 4 });
});

it("routes the shared dashboard /v1 endpoints without browser login or a second port", async () => {
  const host = Object.assign(Object.create(WebDashboardServer.prototype), {
    context,
    repo,
    getUrl: () => origin,
    settingsStore: { getDashboardSettings: () => ({ apiAccessEnabled: enabled }) },
    publishLocalStateChange: vi.fn()
  });
  const result = await new Promise<{ status: number; value: unknown }>((resolve) => {
    const response = {
      setHeader: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      end(text: string) {
        resolve({ status: this.statusCode, value: JSON.parse(text) });
      },
      statusCode: 200
    };
    void host.handle(
      {
        url: "/v1/chat/completions",
        method: "GET",
        headers: { authorization: `Bearer ${key}` },
        once: vi.fn(),
        off: vi.fn(),
        complete: true
      },
      response
    );
  });
  expect(result.status).toBe(405);
  expect(upstream).not.toHaveBeenCalled();
});

it.each(["/v1/chat/completions", "/v1/responses", "/v1/messages"])(
  "returns a complete non-streaming response for %s",
  async (path) => {
    const body = path.endsWith("responses")
      ? { model: "codex-test", input: "Hello" }
      : path.endsWith("messages")
        ? { ...chat(), max_tokens: 100 }
        : chat();
    const response = await post(path, body),
      result = await response.json();
    expect(response.status).toBe(200);
    expect(JSON.stringify(result)).toContain("Hello 🌍");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    const init = vi.mocked(upstream).mock.calls[0]![1]!;
    expect(JSON.parse(String(init.body))).toMatchObject({ stream: true, store: false, input: [{ role: "user" }] });
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer saved-access");
    expect(JSON.stringify(result)).not.toContain("saved-access");
  }
);

it("counts Claude input locally without contacting the saved-account backend", async () => {
  const result = await post("/v1/messages/count_tokens", {
    model: "codex-test",
    system: "Be concise",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [{ name: "lookup", description: "Find a value", input_schema: { type: "object" } }]
  });
  expect(result.status).toBe(200);
  expect(result.headers.get("x-manager-token-count")).toBe("estimate");
  expect(await result.json()).toMatchObject({ input_tokens: expect.any(Number) });
  expect(readApiProxyHistory().requests.find(row => row.id === result.headers.get("x-request-id"))).toMatchObject({
    path: "/v1/messages/count_tokens",
    model: "codex-test",
    status: "completed",
    httpStatus: 200
  });
  expect(upstream).not.toHaveBeenCalled();
  expect((await fetch(origin + "/v1/messages/count_tokens", { headers: { Authorization: `Bearer ${key}` } })).status).toBe(405);
  const thinkingCount = await post("/v1/messages/count_tokens", {
    model: "codex-test",
    thinking: { type: "enabled", budget_tokens: 1024 },
    output_config: { effort: "high", format: { type: "json_schema", schema: { type: "object" } } },
    messages: [{ role: "user", content: "Think" }]
  });
  expect(thinkingCount.status).toBe(200);
  const log = readApiProxyHistory().requests.find(row => row.id === result.headers.get("x-request-id"));
  expect(log?.estimatedInputTokens).toBeGreaterThan(0);
  expect(log?.inputTokens).toBeUndefined();
});

it.each(["/v1/chat/completions", "/v1/responses", "/v1/messages"])(
  "streams %s exactly once and includes usage",
  async (path) => {
    const body = path.endsWith("responses")
      ? { model: "codex-test", input: "Hello", stream: true }
      : path.endsWith("messages")
        ? { ...chat(), max_tokens: 100, stream: true }
        : chat({ stream: true, stream_options: { include_usage: true } });
    const response = await post(path, body),
      text = await response.text();
    expect(response.status).toBe(200);
    expect(text.match(/Hello 🌍/g)).toHaveLength(path.endsWith("responses") ? 2 : 1);
    expect(text).toContain(
      path.endsWith("messages") ? "message_stop" : path.endsWith("responses") ? "response.completed" : "[DONE]"
    );
    expect(text).toContain(
      path.endsWith("messages")
        ? "cache_read_input_tokens"
        : path.endsWith("responses")
          ? "input_tokens"
          : "prompt_tokens"
    );
  }
);

it("accepts Claude key authentication and denies disabled, revoked, scoped, missing and ungranted keys", async () => {
  const headers = { "x-api-key": key, "content-type": "application/json", "anthropic-version": "2023-06-01" };
  expect(
    (
      await fetch(origin + "/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...chat(), max_tokens: 100 })
      })
    ).status
  ).toBe(200);
  const ungranted = await createDashboardApiToken(context, { name: "Read", permissions: ["state"] });
  const scoped = await createDashboardApiToken(context, { name: "Project", projectPath: root, permissions: ["*"] });
  for (const token of [ungranted.token, scoped.token])
    expect((await post("/v1/chat/completions", chat(), token)).status).toBe(403);
  expect((await fetch(origin + "/v1/models")).status).toBe(401);
  expect((await post("/v1/chat/completions", chat(), key, { "x-api-key": "different" })).status).toBe(401);
  enabled = false;
  expect((await post("/v1/chat/completions", chat())).status).toBe(401);
  enabled = true;
  const token = await createDashboardApiToken(context, { name: "Revoke", permissions: ["*"] });
  await revokeDashboardApiToken(context, token.record.id);
  expect((await post("/v1/chat/completions", chat(), token.token)).status).toBe(401);
  expect(upstream).toHaveBeenCalledOnce();
});

it("discovers models in both schemas, caches by credentials, retrieves one and paginates Claude models", async () => {
  vi.mocked(upstream).mockImplementation(
    async () =>
      Response.json({
        models: [
          { slug: "a", display_name: "A", supported_in_api: false },
          null,
          "malformed row",
          { slug: "hidden", visibility: "hide" },
        { slug: "hidden-flag", hidden: true },
        { slug: "hidden-word", visibility: "hidden" },
          { slug: "b", display_name: "B" }
        ]
      }) as never
  );
  const models = await fetch(origin + "/v1/models", { headers: { Authorization: `Bearer ${key}` } }).then((r) =>
    r.json()
  );
  expect(models.data.map((item: { id: string }) => item.id)).toEqual(["a", "b"]);
  const first = await fetch(origin + "/v1/models?limit=1", { headers: { "x-api-key": key } }).then((r) => r.json());
  expect(first).toMatchObject({ has_more: true, first_id: "a", data: [{ type: "model", display_name: "A" }] });
  const next = await fetch(origin + "/v1/models?limit=1&after_id=a", { headers: { "x-api-key": key } }).then((r) =>
    r.json()
  );
  expect(next).toMatchObject({ has_more: false, first_id: "b" });
  expect(
    (await fetch(origin + "/v1/models/a", { headers: { Authorization: `Bearer ${key}` } }).then((r) => r.json())).id
  ).toBe("a");
  expect(upstream).toHaveBeenCalledOnce();
  expect((await fetch(origin + "/v1/models/no", { headers: { Authorization: `Bearer ${key}` } })).status).toBe(404);
  const cachedModelLog = readApiProxyHistory().requests[0];
  expect(cachedModelLog).toMatchObject({accountId:'account-a',accountEmail:'fixture-account@example.test',apiKeyName:'AI'});
  repo.getTokens.mockResolvedValue({ idToken: "", accessToken: "changed", accountId: "workspace-a" });
  await fetch(origin + "/v1/models", { headers: { Authorization: `Bearer ${key}` } });
  expect(upstream).toHaveBeenCalledTimes(2);
});

it("verifies model credentials and active ownership concurrently", async () => {
  vi.mocked(upstream).mockResolvedValueOnce(Response.json({ models: [{ slug: "fixture-model" }] }) as never);
  let releaseTokens!: () => void;
  let releaseAccount!: () => void;
  repo.getTokens.mockImplementationOnce(() => new Promise(resolve => { releaseTokens = () => resolve({ idToken: "", accessToken: "saved-access", accountId: "workspace-a" }); }));
  repo.getAccount.mockImplementationOnce(() => new Promise(resolve => { releaseAccount = () => resolve(active); }));
  const pending = fetch(origin + "/v1/models", { headers: { Authorization: `Bearer ${key}` } });
  await vi.waitFor(() => { expect(repo.getTokens).toHaveBeenCalledOnce(); expect(repo.getAccount).toHaveBeenCalledOnce(); });
  releaseTokens(); releaseAccount();
  expect((await pending).status).toBe(200);
});

it("refreshes rejected credentials once through the shared token repository", async () => {
  active.tokenRefreshEnabled = true;
  repo.getTokens.mockResolvedValue({
    idToken: "",
    accessToken: "saved-access",
    accountId: "workspace-a",
    refreshToken: "refresh"
  } as never);
  vi.mocked(upstream)
    .mockResolvedValueOnce(new Response("", { status: 401 }) as never)
    .mockResolvedValueOnce(generation() as never);
  expect((await post("/v1/chat/completions", chat())).status).toBe(200);
  expect(repo.refreshAccountTokens).toHaveBeenCalledWith("account-a", { force: true });
  expect(upstream).toHaveBeenCalledTimes(2);
});

it('releases model discovery on disconnect while a credential read is stuck', async () => {
  repo.getTokens.mockImplementationOnce(() => new Promise(() => undefined));
  const controller = new AbortController();
  const pending = fetch(origin + '/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal }).catch(() => undefined);
  await vi.waitFor(() => expect(repo.getTokens).toHaveBeenCalledOnce());
  controller.abort();
  await pending;
  await vi.waitFor(() => expect(readApiProxyHistory().requests[0]?.status).toBe('cancelled'));
  expect(upstream).not.toHaveBeenCalled();
  expect((await post('/v1/messages/count_tokens', chat())).status).toBe(200);
});

it('reports model method errors and stale ownership explicitly', async () => {
  expect((await post('/v1/models', {})).status).toBe(405);
  expect(upstream).not.toHaveBeenCalled();
  repo.getAccount.mockResolvedValueOnce({ ...active, isActive: false });
  expect((await fetch(origin + '/v1/models', { headers: { Authorization: `Bearer ${key}` } })).status).toBe(409);
  expect(upstream).not.toHaveBeenCalled();
});

it("accepts the native backend event stream when it omits Content-Type", async () => {
  const source = generation();
  source.headers.delete("content-type");
  vi.mocked(upstream).mockResolvedValueOnce(source as never);
  const result = await post("/v1/chat/completions", chat());
  expect(result.status).toBe(200);
  expect(await result.text()).toContain("Hello 🌍");
});

it('forwards normal API calls without quota checks or account selection', async () => {
  expect((await post('/v1/chat/completions', chat())).status).toBe(200);
  expect(refreshSingleQuota).not.toHaveBeenCalled(); expect(maybeAutoSwitchForActiveQuota).not.toHaveBeenCalled();
  expect(upstream).toHaveBeenCalledOnce();
});

it.each([401, 429])("checks rejected upstream status %s and retries only after a confirmed account switch", async status => {
  vi.mocked(upstream)
    .mockResolvedValueOnce(new Response("", { status }) as never)
    .mockResolvedValueOnce(generation() as never);
  const replacement = { ...active, id: 'account-b', email: 'replacement@example.test' };
  vi.mocked(maybeAutoSwitchForActiveQuota).mockImplementationOnce(async (_repo, view, options) => {
    expect(view.deferHostReload).toBe(true);
    expect(options?.quotaRejectedAccountId).toBe(status === 429 ? active.id : undefined);
    repo.listAccounts.mockResolvedValue([replacement]); repo.getAccount.mockResolvedValue(replacement);
    repo.getTokens.mockResolvedValue({ idToken: '', accessToken: 'next-access', accountId: 'workspace-b' });
    return true;
  });
  const response = await post("/v1/chat/completions", chat());
  expect(response.status).toBe(200);
  await response.text();
  expect(readApiProxyHistory().requests.find(row=>row.id===response.headers.get('x-request-id'))).toMatchObject({accountId:'account-b',accountEmail:'replacement@example.test',apiKeyName:'AI'});
  expect(refreshSingleQuota).toHaveBeenCalledOnce(); expect(maybeAutoSwitchForActiveQuota).toHaveBeenCalledOnce();
  expect(upstream).toHaveBeenCalledTimes(2);
  expect(vi.mocked(upstream).mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer next-access', 'ChatGPT-Account-Id': 'workspace-b' });
});
it('still selects a replacement after a confirmed 429 when quota inspection fails', async () => {
  const replacement = {...active,id:'account-b'};
  vi.mocked(upstream).mockResolvedValueOnce(new Response('',{status:429}) as never).mockResolvedValueOnce(generation() as never);
  vi.mocked(refreshSingleQuota).mockRejectedValueOnce(new Error('Quota service offline'));
  vi.mocked(maybeAutoSwitchForActiveQuota).mockImplementationOnce(async (_repo,_view,options)=>{
    expect(options?.quotaRejectedAccountId).toBe(active.id);
    repo.listAccounts.mockResolvedValue([replacement]);repo.getAccount.mockResolvedValue(replacement);return true;
  });
  expect((await post('/v1/chat/completions',chat())).status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(2);
});

it('does not replay the same rejected account when a switch reports success before active state confirms it', async () => {
  vi.mocked(upstream).mockResolvedValueOnce(new Response('', { status: 429 }) as never);
  vi.mocked(maybeAutoSwitchForActiveQuota).mockResolvedValueOnce(true);
  const result = await post('/v1/chat/completions', chat());
  expect(result.status).toBe(503); expect(await result.text()).toContain('switch is not confirmed');
  expect(upstream).toHaveBeenCalledOnce();
});
it('uses a replacement selected by the main runtime while the error quota check was in progress', async () => {
  const replacement = { ...active, id: 'account-b' };
  vi.mocked(upstream).mockResolvedValueOnce(new Response('', { status: 429 }) as never).mockResolvedValueOnce(generation() as never);
  vi.mocked(refreshSingleQuota).mockImplementationOnce(async () => {
    repo.listAccounts.mockResolvedValue([replacement]);
    repo.getAccount.mockResolvedValueOnce({ ...active, isActive: false }).mockResolvedValue(replacement);
    return {};
  });
  expect((await post('/v1/chat/completions', chat())).status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(2); expect(refreshSingleQuota).toHaveBeenCalledOnce();
});

it("does not replay blocked quota, network uncertainty or accepted partial failures", async () => {
  vi.mocked(upstream).mockResolvedValueOnce(new Response("", { status: 429 }) as never);
  expect((await post("/v1/chat/completions", chat())).status).toBe(429);
  expect(upstream).toHaveBeenCalledOnce();
  vi.mocked(upstream).mockClear().mockRejectedValueOnce(new Error("saved-access"));
  const failure = await post("/v1/chat/completions", chat());
  expect(failure.status).toBe(502);
  expect(await failure.text()).not.toContain("saved-access");
  expect(upstream).toHaveBeenCalledOnce();
  vi.mocked(upstream)
    .mockClear()
    .mockResolvedValueOnce(
      events({ type: "response.output_text.delta", delta: "Partial" }, { type: "response.failed" }) as never
    );
  const partial = await post("/v1/messages", { ...chat(), max_tokens: 100, stream: true });
  const text = await partial.text();
  expect(text).toContain("Partial");
  expect(text).toContain("event: error");
  expect(text).not.toContain("message_stop");
  expect(upstream).toHaveBeenCalledOnce();
});

it("rejects missing, disabled and foreign-owned accounts without upstream access", async () => {
  allowed = false;
  expect((await post("/v1/chat/completions", chat())).status).toBe(503);
  allowed = true;
  active.enabled = false;
  expect((await post("/v1/chat/completions", chat())).status).toBe(503);
  active.enabled = true;
  repo.listAccounts.mockResolvedValue([]);
  expect((await post("/v1/chat/completions", chat())).status).toBe(503);
  expect(upstream).not.toHaveBeenCalled();
});

it("cancels disconnects and shutdown, rejects concurrency overflow, and releases capacity", async () => {
  let cancelled = 0;
  vi.mocked(upstream).mockImplementation(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          }
        }),
        { headers: { "content-type": "text/event-stream" } }
      ) as never
  );
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const pending = controllers.map((controller) =>
    fetch(origin + "/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(chat()),
      signal: controller.signal
    }).catch(() => undefined)
  );
  await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(8));
  expect((await post("/v1/chat/completions", chat())).status).toBe(429);
  controllers[0]!.abort();
  await vi.waitFor(() => expect(cancelled).toBe(1));
  proxy.stop();
  await Promise.all(pending);
  await vi.waitFor(() => expect(cancelled).toBe(8));
  expect((await post("/v1/chat/completions", chat())).status).toBe(503);
});

it.each([
  { tools: [{ type: "web_search" }] },
  { n: 2 },
  { stream: "yes" },
  { store: true },
  { temperature: 0.1 },
  { bogus: true },
  { max_tokens: 0 }
])("rejects unsupported options before upstream work: %j", async (extra) => {
  expect((await post("/v1/chat/completions", chat(extra))).status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
});

it("handles UTF-8 split between bytes, CRLF, invalid JSON and truncated streams", async () => {
  const bytes = new TextEncoder().encode('data: {"type":"text","delta":"🌍"}\r\n\r\n');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    }
  });
  const result = [];
  for await (const event of aiEvents(body, new AbortController().signal)) result.push(event);
  expect(result).toEqual([{ type: "text", delta: "🌍" }]);
  const collect = async (text: string) => {
    for await (const _ of aiEvents(new Response(text).body!, new AbortController().signal)) {
      /* Read to terminal. */
    }
  };
  await expect(collect("data: {bad}\n\n")).rejects.toThrow(/invalid stream/);
  await expect(collect("data: {}")).rejects.toThrow(/partial/);
});

it("translates function calls, results, image inputs and provider-reported usage without local tools", () => {
  const claude = normalizeAiRequest(
    {
      model: "codex-test",
      max_tokens: 100,
      system: "Instructions",
      tools: [{ name: "weather", input_schema: { type: "object" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } }]
        },
        { role: "assistant", content: [{ type: "tool_use", id: "call-a", name: "weather", input: { city: "Dhaka" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call-a", content: "Sunny" }] }
      ]
    },
    "claude"
  );
  expect(claude.body).toMatchObject({
    instructions: "Instructions",
    input: [
      { content: [{ type: "input_image", image_url: "data:image/png;base64,YQ==" }] },
      { type: "function_call", call_id: "call-a" },
      { type: "function_call_output", output: "Sunny" }
    ],
    tools: [{ type: "function", name: "weather" }]
  });
  const result = completedAiResponse(
    {
      ...completed,
      output: [{ type: "function_call", call_id: "call-a", name: "weather", arguments: '{"city":"Dhaka"}' }]
    },
    "claude",
    "codex-test"
  );
  expect(result).toMatchObject({
    stop_reason: "tool_use",
    content: [{ type: "tool_use", input: { city: "Dhaka" } }],
    usage: { input_tokens: 8, cache_read_input_tokens: 3, output_tokens: 4 }
  });
  for (const protocol of ["chat", "claude"] as const) {
    const stream = new AiStream(protocol, "codex-test", true);
    let wire = "";
    for (const event of [
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", name: "weather", call_id: "call-a" }
      },
      { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"city":"Dhaka"}' },
      {
        type: "response.completed",
        response: {
          ...completed,
          output: [{ type: "function_call", call_id: "call-a", name: "weather", arguments: '{"city":"Dhaka"}' }]
        }
      }
    ])
      wire += stream.event(event);
    expect(wire).toContain("Dhaka");
    expect(wire).toContain(protocol === "chat" ? "tool_calls" : "tool_use");
  }
});

it("accepts Claude Code gateway controls and maps its effort setting", () => {
  const request = normalizeAiRequest({
    model: "codex-test",
    max_tokens: 32000,
    messages: [{ role: "user", content: [{ type: "text", text: "Reply exactly OK.", cache_control: { type: "ephemeral" } }] }],
    system: [{ type: "text", text: "System", cache_control: { type: "ephemeral" } }],
    thinking: { type: "adaptive", display: "omitted" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    output_config: { effort: "high" },
    metadata: { user_id: "fixture" },
    stream: true
  }, "claude");
  expect(request.body).toMatchObject({ model: "codex-test", max_output_tokens: 32000, reasoning: { effort: "high" }, stream: true });
  expect(request.body).not.toHaveProperty("context_management");
  expect(() => normalizeAiRequest({
    model: "codex-test",
    max_tokens: 100,
    system: [{ type: "image", source: { type: "url", url: "https://example.test/system.png" } }],
    messages: [{ role: "user", content: "Hello" }]
  }, "claude")).toThrow(/System content supports text blocks only/);
  expect(() => normalizeAiRequest({ model: "codex-test", max_tokens: 100, thinking: { type: "future-mode" }, messages: [{ role: "user", content: "Hello" }] }, "claude")).toThrow(/thinking.type/);
});

it("keeps Claude tool result images and ignores prior thinking blocks", () => {
  const request = normalizeAiRequest({
    model: "codex-test",
    max_tokens: 100,
    messages: [
      { role: "assistant", content: [{ type: "thinking", thinking: "prior plan", signature: "sig" }, { type: "tool_use", id: "call-1", name: "screenshot", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: "Screenshot" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } }] }] }
    ]
  }, "claude");
  expect(request.body.input).toMatchObject([
    { type: "function_call", call_id: "call-1" },
    { type: "function_call_output", output: "Screenshot" },
    { role: "user", content: [{ type: "input_text" }, { type: "input_image", image_url: "data:image/png;base64,YQ==" }] }
  ]);
  const failed = normalizeAiRequest({
    model: "codex-test",
    max_tokens: 100,
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", is_error: true, content: "boom" }] }]
  }, "claude");
  expect(failed.body.input).toMatchObject([{ type: "function_call_output", output: "[Tool error]\nboom" }]);
  expect(() => normalizeAiRequest({
    model: "codex-test",
    max_tokens: 100,
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", is_error: "yes", content: "boom" }] }]
  }, "claude")).toThrow(/tool_result.is_error/);
});

it("translates Responses reasoning deltas into Claude thinking blocks", () => {
  const stream = new AiStream("claude", "codex-test", false);
  const thinking = stream.event({ type: "response.reasoning_summary_text.delta", delta: "Plan" });
  const text = stream.event({ type: "response.output_text.delta", delta: "Answer" });
  const done = stream.event({ type: "response.completed", response: { ...completed, output: [{ type: "message", content: [{ type: "output_text", text: "Answer" }] }] } });
  expect(thinking).toContain('"type":"thinking"');
  expect(thinking).toContain('"type":"thinking_delta"');
  expect(text).toContain('"type":"content_block_stop"');
  expect(text).toContain('"type":"text_delta"');
  expect(done).toContain('"type":"message_stop"');
});
