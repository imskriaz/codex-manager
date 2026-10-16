import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDailyUsageBreakdown } from "../src/services/usage";

const tokens = { idToken: "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.", accessToken: "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0." };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("daily usage response validation", () => {
  it.each([{}, { errors: [] }, { daily_usage: [null] }, { daily_usage: [{ date: "2026-10-15" }] }])("does not treat malformed data as a successful empty history: %j", async payload => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload))));
    await expect(fetchDailyUsageBreakdown(tokens)).resolves.toBeUndefined();
  });
  it("accepts an explicitly empty history and preserves a zero-token day", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ daily_usage: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ daily_usage: [{ date: "2026-10-15", total_tokens: 0 }] })));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchDailyUsageBreakdown(tokens)).resolves.toEqual({ days: 30, points: [] });
    expect((await fetchDailyUsageBreakdown(tokens))?.points).toMatchObject([{ totalTokens: 0 }]);
  });
  it("forwards cancellation and keeps provider errors visible", async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchDailyUsageBreakdown(tokens, 30, controller.signal)).rejects.toThrow("503");
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("times out a provider whose response body stalls", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream())));
    const result = fetchDailyUsageBreakdown(tokens);
    const failed = expect(result).rejects.toThrow(/timed out after 15s/);
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
  });
});
