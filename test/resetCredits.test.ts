import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeResetCredit, fetchResetCredits, isResetCreditIneligibleError } from "../src/services/quota";
import { APIError } from "../src/core/errors";
import { normalizeQuotaSummary, normalizeUsableResetCount } from "../src/utils/quotaWindows";

async function fetchSnapshot(payload: unknown, excludedIds: string[] = []) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })));
  return fetchResetCredits("token", "account", excludedIds);
}

describe("fetchResetCredits", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("prefers explicit next_expires_at from the reset credits payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              available_count: 1,
              next_expires_at: 1_800_000_123,
              credits: []
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json"
              }
            }
          )
      )
    );

    const snapshot = await fetchResetCredits("token", "acct-1");

    expect(snapshot.availableCount).toBe(1);
    expect(snapshot.nextExpiresAt).toBe(1_800_000_123);
  });

  it("reads nested data.reset_credits_next_expires_at when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                available_count: 1,
                reset_credits_next_expires_at: "1800000456"
              }
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json"
              }
            }
          )
      )
    );

    const snapshot = await fetchResetCredits("token", "acct-2");

    expect(snapshot.availableCount).toBe(1);
    expect(snapshot.nextExpiresAt).toBe(1_800_000_456);
  });

  it("derives next expiry from ISO expires_at values in available credits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              credits: [
                {
                  id: "RateLimitResetCredit_1",
                  status: "available",
                  expires_at: "2026-07-26T23:49:56.470185Z"
                }
              ],
              available_count: 1
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json"
              }
            }
          )
      )
    );

    const snapshot = await fetchResetCredits("token", "acct-3");

    expect(snapshot.availableCount).toBe(1);
    expect(snapshot.credits[0]?.expires_at).toBe(1_785_109_796);
    expect(snapshot.nextExpiresAt).toBe(1_785_109_796);
  });

  it("filters only locally excluded credit IDs and preserves newer credits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              available_count: 2,
              credits: [
                { id: "bad-credit", status: "available", expires_at: 1_900_000_000 },
                { id: "new-credit", status: "available", expires_at: 1_900_000_100 }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      )
    );

    const snapshot = await fetchResetCredits("token", "acct-4", ["bad-credit"]);

    expect(snapshot.availableCount).toBe(1);
    expect(snapshot.credits.map((credit) => credit.id)).toEqual(["new-credit"]);
  });

  it("recognizes the ineligible reset response", () => {
    const error = new APIError('Consume reset credit returned 403: {"detail":{"code":"rate_limit_reset_ineligible"}}', {
      statusCode: 403,
      context: { errorCode: "rate_limit_reset_ineligible" }
    });
    expect(isResetCreditIneligibleError(error)).toBe(true);
    expect(isResetCreditIneligibleError(new Error("403 rate_limit_reset_ineligible"))).toBe(false);
  });

  it("uses expiry of the remaining usable credit after removing the provider-rejected credit", async () => {
    const snapshot = await fetchSnapshot({
      available_count: 2,
      next_expires_at: 1_900_000_000,
      credits: [
        { id: "rejected", status: "available", expires_at: 1_900_000_000 },
        { id: "good", status: "available", expires_at: 1_900_000_100 }
      ]
    }, [" rejected "]);
    expect(snapshot.availableCount).toBe(1);
    expect(snapshot.nextExpiresAt).toBe(1_900_000_100);
  });

  it("deduplicates credit IDs, floors counts and normalizes millisecond expiry", async () => {
    const snapshot = await fetchSnapshot({
      available_count: "2.9",
      credits: [
        { id: "same", expires_at: 1_900_000_100_000 },
        { id: " same ", expires_at: 1_900_000_000_000 }
      ]
    });
    expect(snapshot.availableCount).toBe(1);
    expect(snapshot.credits).toHaveLength(1);
    expect(snapshot.nextExpiresAt).toBe(1_900_000_000);
  });

  it("excludes expired, unknown and redeemed records from usable reserves", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
    const snapshot = await fetchSnapshot({ credits: [
      { id: "expired", status: "available", expires_at: "2026-07-01T00:00:00Z" },
      { id: "unknown", status: "pending", expires_at: 1_900_000_000 },
      { id: "consumed", redeemed_at: "2026-06-30T00:00:00Z" },
      { id: "good", status: "unused", expires_at: 1_900_000_100 }
    ] });
    expect(snapshot.availableCount).toBe(1);
    expect(snapshot.nextExpiresAt).toBe(1_900_000_100);
    expect(snapshot.credits[0]?.id).toBe("good");
    expect(snapshot.credits.find((credit) => credit.id === "good")?.status).toBe("available");
  });

  it("corrects an aggregate that still counts a listed expired credit", async () => {
    const snapshot = await fetchSnapshot({ available_count: 2, credits: [
      { id: "expired", status: "available", expires_at: 1 },
      { id: "good", status: "available", expires_at: 1_900_000_100 }
    ] });
    expect(snapshot.availableCount).toBe(1);
    expect(snapshot.nextExpiresAt).toBe(1_900_000_100);
  });

  it("requires reconciliation when an aggregate-only earliest expiry has elapsed", async () => {
    expect((await fetchSnapshot({ available_count: 2, next_expires_at: 1 })).availableCount).toBe(0);
    expect((await fetchSnapshot({ available_count: 1, credits: [{}] })).availableCount).toBe(0);
  });

  it("preserves explicit aggregate reserves when a list is partial and there are no rejection fences", async () => {
    const snapshot = await fetchSnapshot({ available_count: 4, credits: [
      { id: "good", expires_at: 1_900_000_000 }
    ] });
    expect(snapshot.availableCount).toBe(4);
  });

  it("does not revive rejected reserves from an aggregate-only or incomplete response", async () => {
    expect((await fetchSnapshot({ available_count: 4 }, ["rejected"])).availableCount).toBe(0);
    const partial = await fetchSnapshot({ available_count: 4, credits: [
      { id: "good", expires_at: 1_900_000_000 }
    ] }, ["rejected"]);
    expect(partial.availableCount).toBe(1);
  });

  it("honors zero aggregate even when the list or explicit expiry is stale", async () => {
    const snapshot = await fetchSnapshot({ available_count: 0, next_expires_at: 1_900_000_000,
      credits: [{ id: "stale", expires_at: 1_900_000_000 }] });
    expect(snapshot.availableCount).toBe(0);
    expect(snapshot.nextExpiresAt).toBeUndefined();
  });

  it("treats contradictory duplicate status as unavailable", async () => {
    const snapshot = await fetchSnapshot({ available_count: 1, credits: [
      { id: "same", status: "available" },
      { id: "same", status: "consumed" }
    ] });
    expect(snapshot.availableCount).toBe(0);
    const reversed = await fetchSnapshot({ available_count: 1, credits: [
      { id: "same", status: "consumed" },
      { id: "same", status: "available" }
    ] });
    expect(reversed.availableCount).toBe(0);
  });

  it("uses a durable redemption ID supplied by the operation owner", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await consumeResetCredit("token", "account", "cr-durable-id");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ redeem_request_id: "cr-durable-id" });
  });

  it("normalizes stored usable count without subtracting known exclusions twice", () => {
    const normalized = normalizeQuotaSummary({
      hourlyPercentage: 80, hourlyWindowPresent: true, weeklyPercentage: 80, weeklyWindowPresent: true,
      resetCreditsAvailable: 1.9, resetCreditsAvailableIds: [" good ", "good", "bad"],
      resetCreditsExcludedIds: [" bad "], resetCreditsNextExpiresAt: 1_900_000_000_000
    });
    expect(normalized).toMatchObject({ resetCreditsAvailable: 1,
      resetCreditsAvailableIds: ["good"], resetCreditsNextExpiresAt: 1_900_000_000 });
    expect([NaN, Infinity, -1, undefined].map(normalizeUsableResetCount)).toEqual([0, 0, 0, 0]);
  });
});
