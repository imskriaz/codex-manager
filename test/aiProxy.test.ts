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
const active = { id: "account-a", isActive: true, enabled: true, tokenRefreshEnabled: false };
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
          { slug: "hidden", visibility: "hide" },
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
  repo.getTokens.mockResolvedValue({ idToken: "", accessToken: "changed", accountId: "workspace-a" });
  await fetch(origin + "/v1/models", { headers: { Authorization: `Bearer ${key}` } });
  expect(upstream).toHaveBeenCalledTimes(2);
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

it("accepts the native backend event stream when it omits Content-Type", async () => {
  const source = generation();
  source.headers.delete("content-type");
  vi.mocked(upstream).mockResolvedValueOnce(source as never);
  const result = await post("/v1/chat/completions", chat());
  expect(result.status).toBe(200);
  expect(await result.text()).toContain("Hello 🌍");
});

it("uses the normal quota and switch rules before a bounded retry and defers host reload", async () => {
  vi.mocked(upstream)
    .mockResolvedValueOnce(new Response("", { status: 429 }) as never)
    .mockResolvedValueOnce(generation() as never);
  vi.mocked(maybeAutoSwitchForActiveQuota).mockImplementationOnce(async (_repo, view, options) => {
    expect(view.deferHostReload).toBe(true);
    expect(options?.canUseAccount?.("account-a")).toBe(true);
    return true;
  });
  expect((await post("/v1/chat/completions", chat())).status).toBe(200);
  expect(refreshSingleQuota).toHaveBeenCalledOnce();
  expect(maybeAutoSwitchForActiveQuota).toHaveBeenCalledOnce();
  expect(upstream).toHaveBeenCalledTimes(2);
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
          output: [{ type: "function_call", call_id: "call-a", name: "weather", arguments: "{}" }]
        }
      }
    ])
      wire += stream.event(event);
    expect(wire).toContain("Dhaka");
    expect(wire).toContain(protocol === "chat" ? "tool_calls" : "tool_use");
  }
});
