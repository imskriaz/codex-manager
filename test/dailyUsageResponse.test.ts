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
  it("reads verified client token counts and rejects percentage or unsafe attribution", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ date: "2026-10-15", totals: { text_total_tokens: 1000 }, clients: [
      { client_id: "CODEX_IDE_VSCODE", text_total_tokens: 240 },
      { client_id: "CODEX_WORK_WEB", text_total_tokens: 760 }
    ] }] })));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchDailyUsageBreakdown(tokens)).resolves.toMatchObject({ points: [{ unit: "tokens", totalTokens: 1000, extensionTokens: 240, otherTokens: 760 }] });
    const request = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(request.pathname).toContain("/wham/analytics/daily-workspace-usage-counts");
    expect(request.searchParams.get("group_by")).toBe("day");
    expect(request.searchParams.get("workspace_user")).toBe("true");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ units: "percent", data: [{ date: "2026-10-15", total_tokens: 23 }] }))));
    await expect(fetchDailyUsageBreakdown(tokens)).resolves.toBeUndefined();
  });
  it("preserves the known total without inventing a VS Code share when clients are absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ date: "2026-10-15", totals: { text_total_tokens: 1000 } }] }))));
    await expect(fetchDailyUsageBreakdown(tokens)).resolves.toMatchObject({ points: [{ unit: "tokens", totalTokens: 1000, extensionTokens: undefined }] });
  });
  it.each([undefined, null])("keeps verified daily totals when a credit-only client omits tokens: %j", async missing => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ balance_unit: "credit", data: [
      { date: "2026-10-15", totals: { text_total_tokens: 1000 }, clients: [
        { client_id: "CODEX_IDE_VSCODE", text_total_tokens: 240 },
        { client_id: "CODEX_WORK_WEB", credits: 10, text_total_tokens: missing }
      ] },
      { date: "2026-10-16", totals: { text_total_tokens: 0 }, clients: [{ client_id: "CODEX_WORK_WEB", credits: 0 }] }
    ] }))));
    await expect(fetchDailyUsageBreakdown(tokens)).resolves.toMatchObject({ points: [
      { date: "2026-10-15", totalTokens: 1000, extensionTokens: undefined, otherTokens: undefined, surfaceValues: { vscode: 240 } },
      { date: "2026-10-16", totalTokens: 0, extensionTokens: undefined }
    ] });
  });
  it("keeps actionable HTTP failures without exposing the provider's response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"error":{"message":"private provider detail"}}', { status: 401 })));
    const error = await fetchDailyUsageBreakdown(tokens).catch(error => error as Error);
    expect(error).toHaveProperty('message', expect.stringContaining('Refresh the token or reauthorize'));
    expect(error).toHaveProperty('message', expect.not.stringContaining('private provider detail'));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('<html>proxy failure</html>')));
    await expect(fetchDailyUsageBreakdown(tokens)).rejects.toThrow('unreadable response');
  });
  it("accepts API date timestamps, keyed daily rows, and component token totals", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      daily_usage: {
        "2026-10-15": { totals: { uncached_text_input_tokens: 10, cached_text_input_tokens: 5, text_output_tokens: 2 } }
      }
    }))));
    await expect(fetchDailyUsageBreakdown(tokens)).resolves.toMatchObject({
      points: [{ date: "2026-10-15", totalTokens: 17 }]
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ date: "2026-10-15T00:00:00.000Z", total_tokens: 17 }]
    }))));
    await expect(fetchDailyUsageBreakdown(tokens)).resolves.toMatchObject({ points: [{ date: "2026-10-15", totalTokens: 17 }] });
  });
  it.each([{ clients: [] }, { clients: [{ client_id: "CODEX_IDE_VSCODE", text_total_tokens: 240 }] }])("does not invent attribution when the client list is incomplete: %j", async ({ clients }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ date: "2026-10-15", totals: { text_total_tokens: 1000 }, clients }] }))));
    await expect(fetchDailyUsageBreakdown(tokens)).resolves.toMatchObject({ points: [{ unit: "tokens", totalTokens: 1000, extensionTokens: undefined, otherTokens: undefined }] });
  });
  it.each([
    { totals: { text_total_tokens: 23.5 }, clients: [] },
    { totals: { text_total_tokens: 23 }, clients: [{ client_id: "CODEX_IDE_VSCODE", text_total_tokens: 24 }] },
    { totals: { text_total_tokens: 23 }, clients: [{ client_id: "CONSTRUCTOR", text_total_tokens: 1 }] },
    { totals: { text_total_tokens: 23 }, clients: [{ client_id: "CODEX_IDE_VSCODE", text_total_tokens: -1 }] }
  ])("rejects unsafe counts or invalid attribution: %j", async point => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ date: "2026-10-15", ...point }] }))));
    await expect(fetchDailyUsageBreakdown(tokens)).resolves.toBeUndefined();
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
