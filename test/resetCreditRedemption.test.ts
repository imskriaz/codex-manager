import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountsRepository } from "../src/storage";
import type { CodexManagerAccountRecord } from "../src/core/types";
import { APIError } from "../src/core/errors";
const { fetchCredits, consume } = vi.hoisted(() => ({ fetchCredits: vi.fn(), consume: vi.fn() }));
vi.mock("../src/services/quota", async () => ({
  ...(await vi.importActual<typeof import("../src/services/quota")>("../src/services/quota")),
  fetchResetCredits: fetchCredits,
  consumeResetCredit: consume
}));
import { redeemAccountResetCredit, verifyAccountResetCredit } from "../src/application/accounts/resetCreditRedemption";

let sequence = 0;
function fixture() {
  const account: CodexManagerAccountRecord = {
    id: `reset-redemption-${process.pid}-${++sequence}`,
    email: "test@example.com",
    isActive: true,
    createdAt: 1,
    updatedAt: 1,
    lastQuotaAt: Date.now() - 1000,
    quotaSummary: {
      hourlyPercentage: 0,
      hourlyWindowPresent: true,
      hourlyWindowMinutes: 300,
      weeklyPercentage: 0,
      weeklyWindowPresent: true,
      weeklyWindowMinutes: 10080,
      codeReviewPercentage: 0,
      resetCreditsAvailable: 1
    }
  };
  const repo = {
    getAccount: vi.fn(async () => account),
    getTokens: vi.fn(async () => ({ accessToken: "token", idToken: "id" })),
    updateResetCreditsSnapshot: vi.fn(async () => undefined),
    flush: vi.fn(async () => undefined),
    beginResetCreditAttempt: vi.fn(async (_id: string, requestId: string, availableBefore: number) => {
      account.resetCreditAttempt = { requestId, availableBefore, attemptedAt: Date.now() };
    }),
    completeResetCreditAttempt: vi.fn(async () => {
      account.resetCreditAttempt = undefined;
    }),
    excludeResetCredit: vi.fn(async () => undefined)
  };
  const refresh = async () => {
    account.lastQuotaAt = Date.now();
    account.quotaSummary!.hourlyPercentage = 100;
    account.quotaSummary!.weeklyPercentage = 100;
  };
  return { account, repo, refresh, repository: repo as unknown as AccountsRepository };
}

describe("durable shared reset redemption", () => {
  beforeEach(() => {
    fetchCredits.mockReset().mockResolvedValue({ availableCount: 1, credits: [{ id: "usable", status: "available" }] });
    consume.mockReset().mockResolvedValue(undefined);
  });

  it("persists a request fence before POST and acknowledges only fresh restored quota", async () => {
    const { account, repo, repository, refresh } = fixture();
    consume.mockImplementation(async (_token, _remote, requestId) => {
      expect(account.resetCreditAttempt?.requestId).toBe(requestId);
      expect(repo.beginResetCreditAttempt).toHaveBeenCalled();
    });
    await expect(redeemAccountResetCredit(repository, account.id, undefined, refresh)).resolves.toBe(true);
    expect(consume).toHaveBeenCalledWith("token", undefined, expect.stringMatching(/^cr-/));
    expect(repo.completeResetCreditAttempt).toHaveBeenCalledOnce();
  });

  it("does not consume when storage is full before the fence is durable", async () => {
    const { account, repo, repository } = fixture();
    repo.beginResetCreditAttempt.mockRejectedValueOnce(new Error("disk full"));
    await expect(redeemAccountResetCredit(repository, account.id)).rejects.toThrow("disk full");
    expect(consume).not.toHaveBeenCalled();
  });

  it("keeps uncertain network outcomes fenced across another invocation", async () => {
    const { account, repository } = fixture();
    consume.mockRejectedValueOnce(new Error("timeout"));
    await expect(redeemAccountResetCredit(repository, account.id)).rejects.toThrow("timeout");
    await expect(redeemAccountResetCredit(repository, account.id)).rejects.toThrow("unverified outcome");
    expect(consume).toHaveBeenCalledOnce();
  });

  it.each([408, 500, 503])("keeps HTTP %s uncertain until refresh", async (statusCode) => {
    const { account, repository } = fixture();
    consume.mockRejectedValueOnce(new APIError("uncertain", { statusCode }));
    await expect(redeemAccountResetCredit(repository, account.id)).rejects.toThrow("uncertain");
    expect(account.resetCreditAttempt).toBeDefined();
  });

  it("excludes the freshly verified rejected ID and clears a definitive rejection", async () => {
    const { account, repo, repository } = fixture();
    consume.mockRejectedValueOnce(
      new APIError("rate_limit_reset_ineligible", {
        statusCode: 403,
        context: { errorCode: "rate_limit_reset_ineligible" }
      })
    );
    await expect(redeemAccountResetCredit(repository, account.id)).rejects.toThrow("ineligible");
    expect(repo.excludeResetCredit).toHaveBeenCalledWith(account.id, "usable");
    expect(account.resetCreditAttempt).toBeUndefined();
  });

  it("rechecks settings and ownership after the durable write", async () => {
    const { account, repo, repository } = fixture();
    const validate = vi.fn(async () => !account.resetCreditAttempt);
    await expect(redeemAccountResetCredit(repository, account.id, validate)).resolves.toBe(false);
    expect(consume).not.toHaveBeenCalled();
    expect(repo.completeResetCreditAttempt).toHaveBeenCalledOnce();
  });

  it("rejects an empty usable snapshot despite an older positive count", async () => {
    const { account, repository } = fixture();
    fetchCredits.mockResolvedValueOnce({ availableCount: 0, credits: [] });
    await expect(redeemAccountResetCredit(repository, account.id)).rejects.toThrow("No usable reset");
    expect(consume).not.toHaveBeenCalled();
  });

  it("rechecks credit expiry after the durable fence write", async () => {
    const { account, repo, repository } = fixture();
    const snapshot = {
      availableCount: 1,
      credits: [{ id: "usable", status: "available" }],
      nextExpiresAt: Date.now() / 1000 + 60
    };
    fetchCredits.mockResolvedValueOnce(snapshot);
    repo.beginResetCreditAttempt.mockImplementationOnce(async () => {
      snapshot.nextExpiresAt = 1;
    });
    await expect(redeemAccountResetCredit(repository, account.id)).resolves.toBe(false);
    expect(consume).not.toHaveBeenCalled();
    expect(repo.completeResetCreditAttempt).toHaveBeenCalledOnce();
  });

  it("keeps the fence when POST succeeds but refresh fails or quota remains exhausted", async () => {
    const { account, repository } = fixture();
    await expect(redeemAccountResetCredit(repository, account.id, undefined, async () => {})).rejects.toThrow(
      "could not be verified"
    );
    expect(account.resetCreditAttempt).toBeDefined();
    await expect(redeemAccountResetCredit(repository, account.id)).rejects.toThrow("unverified outcome");
    expect(consume).toHaveBeenCalledOnce();
  });

  it("does not acknowledge pre-request or future quota timestamps", async () => {
    const { account, repository, refresh } = fixture();
    await redeemAccountResetCredit(repository, account.id);
    await refresh();
    account.lastQuotaAt = account.resetCreditAttempt!.attemptedAt - 1;
    await expect(verifyAccountResetCredit(repository, account.id)).rejects.toThrow("could not be verified");
    account.lastQuotaAt = Date.now() + 60000;
    await expect(verifyAccountResetCredit(repository, account.id)).rejects.toThrow("could not be verified");
  });

  it("does not verify an in-flight quota request that preceded POST completion", async () => {
    const { account, repository, refresh } = fixture();
    await expect(
      redeemAccountResetCredit(repository, account.id, undefined, async () => {
        await refresh();
        return { requestStartedAt: 1, quota: account.quotaSummary };
      })
    ).rejects.toThrow("before reset submission completed");
    expect(account.resetCreditAttempt).toBeDefined();
  });
});
