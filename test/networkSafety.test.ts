import { afterEach, describe, expect, it, vi } from "vitest";
import { isRetriableHttpStatus, summarizeNetworkBody } from "../src/utils/network";

describe("provider network safety", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retries rate limits and transient server failures only", () => {
    expect(isRetriableHttpStatus(429)).toBe(true);
    expect(isRetriableHttpStatus(503)).toBe(true);
    expect(isRetriableHttpStatus(401)).toBe(false);
    expect(isRetriableHttpStatus(403)).toBe(false);
  });

  it("bounds provider diagnostics and redacts credential-shaped fields", () => {
    const summary = summarizeNetworkBody(
      `{"refresh_token":"json-secret"} access_token=secret-value authorization: bearer-value ${"x".repeat(300)}`
    );

    expect(summary).toContain('"refresh_token":"[redacted]"');
    expect(summary).toContain("access_token=[redacted]");
    expect(summary).toContain("authorization=[redacted]");
    expect(summary).not.toContain("secret-value");
    expect(summary).not.toContain("bearer-value");
    expect(summary).not.toContain("json-secret");
    expect(summary.length).toBeLessThanOrEqual(241);
  });

  it("holds later requests until a provider Retry-After cooldown expires", async () => {
    vi.resetModules();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("limited", { status: 429, headers: { "Retry-After": "0.4" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchWithTimeout } = await import("../src/utils/network");

    await fetchWithTimeout("https://example.test/first");
    const startedAt = Date.now();
    await fetchWithTimeout("https://example.test/second");

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never starts more than two provider requests concurrently", async () => {
    vi.resetModules();
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchWithTimeout } = await import("../src/utils/network");

    const requests = [
      fetchWithTimeout("https://example.test/one"),
      fetchWithTimeout("https://example.test/two"),
      fetchWithTimeout("https://example.test/three")
    ];
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 1_000 });
    pending[0]!(new Response("ok", { status: 200 }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3), { timeout: 1_000 });
    pending[1]!(new Response("ok", { status: 200 }));
    pending[2]!(new Response("ok", { status: 200 }));

    await expect(Promise.all(requests)).resolves.toHaveLength(3);
  });

  it("times out while queued and never starts an expired request", async () => {
    vi.resetModules();
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchWithTimeout } = await import("../src/utils/network");

    const first = fetchWithTimeout("https://example.test/one", {}, 2_000);
    const second = fetchWithTimeout("https://example.test/two", {}, 2_000);
    const expired = fetchWithTimeout("https://example.test/expired", {}, 30, "Queued request");
    await expect(expired).rejects.toThrow("Queued request timed out");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 1_000 });
    pending[0]!(new Response("ok"));
    pending[1]!(new Response("ok"));
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors caller cancellation while waiting for a provider slot", async () => {
    vi.resetModules();
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchWithTimeout } = await import("../src/utils/network");

    const first = fetchWithTimeout("https://example.test/one", {}, 2_000);
    const second = fetchWithTimeout("https://example.test/two", {}, 2_000);
    const controller = new AbortController();
    const cancelled = fetchWithTimeout("https://example.test/cancelled", { signal: controller.signal }, 2_000);
    controller.abort(new DOMException("Cancelled by caller", "AbortError"));
    await expect(cancelled).rejects.toThrow("Cancelled by caller");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 1_000 });
    pending[0]!(new Response("ok"));
    pending[1]!(new Response("ok"));
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("times out a response that sends headers but never finishes its body", async () => {
    vi.resetModules();
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 200 })));
    const { fetchWithTimeout } = await import("../src/utils/network");
    await expect(fetchWithTimeout("https://example.test/stalled", {}, 30, "Body read"))
      .rejects.toThrow("Body read timed out");
    expect(cancel).toHaveBeenCalledOnce();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("recovered")));
    await expect((await fetchWithTimeout("https://example.test/retry")).text()).resolves.toBe("recovered");
  });

  it("rejects an oversized body and releases its stream", async () => {
    vi.resetModules();
    const cancel = vi.fn();
    const body = new ReadableStream({ start: (controller) => controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)), cancel });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    const { fetchWithTimeout } = await import("../src/utils/network");
    await expect(fetchWithTimeout("https://example.test/oversized")).rejects.toThrow("safe 8 MB limit");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves response metadata and JSON after buffering and accepts empty responses", async () => {
    vi.resetModules();
    const original = new Response('{"ok":true}', { status: 201, statusText: "Created", headers: { "x-test": "value" } });
    Object.defineProperty(original, "url", { value: "https://example.test/response" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(new Response(null, { status: 204 })));
    const { fetchWithTimeout } = await import("../src/utils/network");
    const response = await fetchWithTimeout("https://example.test/request");
    expect(response.status).toBe(201);
    expect(response.url).toBe(original.url);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("x-test")).toBe("value");
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect((await fetchWithTimeout("https://example.test/empty")).status).toBe(204);
  });

  it("honors caller cancellation after headers arrive", async () => {
    vi.resetModules();
    const cancel = vi.fn();
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({ cancel })));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchWithTimeout } = await import("../src/utils/network");
    const controller = new AbortController();
    const request = fetchWithTimeout("https://example.test/body", { signal: controller.signal });
    const result = expect(request).rejects.toThrow("Cancelled by caller");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(new Error("Cancelled by caller"));
    await result;
    expect(cancel).toHaveBeenCalledOnce();
  });
});
