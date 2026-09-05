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
});
