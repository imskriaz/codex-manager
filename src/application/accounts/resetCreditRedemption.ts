import { randomUUID } from "node:crypto";
import type { AccountsRepository } from "../../storage";
import type { CodexManagerAccountRecord } from "../../core/types";
import { APIError } from "../../core/errors";
import { consumeResetCredit, fetchResetCredits, isResetCreditIneligibleError } from "../../services/quota";
import { runCrossWindowExclusive } from "../../utils/crossWindowOperations";
import { hasCodexManagerAccountAutoQueueCapability } from "./autoQueueOrder";
import type { QuotaRefreshResult } from "../../services/quota";

/** All manual and automatic redemption routes share this account-scoped fence. */
export async function redeemAccountResetCredit(
  repo: AccountsRepository,
  accountId: string,
  validate?: (account: CodexManagerAccountRecord) => Promise<boolean> | boolean,
  refreshAndVerify?: () => Promise<QuotaRefreshResult | void>
): Promise<boolean> {
  return runCrossWindowExclusive(`account:reset-credit:${accountId}`, "Quota reset", async () => {
    repo.invalidateCachedIndex?.();
    let account = await repo.getAccount(accountId);
    if (!account) throw new Error("That account no longer exists. Refresh the account list.");
    if (account.resetCreditAttempt)
      throw new Error("A previous reset has an unverified outcome. Refresh quota before attempting another reset.");
    if (validate && !(await validate(account))) return false;
    const tokens = await repo.getTokens(accountId, { bypassCache: true });
    if (!tokens?.accessToken) throw new Error("No access token available for quota reset.");
    const snapshot = await fetchResetCredits(
      tokens.accessToken,
      account.accountId ?? undefined,
      account.quotaSummary?.resetCreditsExcludedIds ?? []
    );
    const ids = snapshot.credits
      .filter((credit) => credit.status === undefined || credit.status === "available")
      .map((credit) => credit.id)
      .filter((id): id is string => Boolean(id));
    await repo.updateResetCreditsSnapshot(accountId, snapshot.availableCount, snapshot.nextExpiresAt, ids);
    await repo.flush?.();
    account = await repo.getAccount(accountId);
    if (!account || snapshot.availableCount <= 0)
      throw new Error("No usable reset credits available. Refresh quota and try another account.");
    if (validate && !(await validate(account))) return false;
    const requestId = `cr-${randomUUID()}`;
    await repo.beginResetCreditAttempt(accountId, requestId, snapshot.availableCount);
    // Settings/ownership may change while the durable fence is being written.
    account = await repo.getAccount(accountId);
    if (
      !account ||
      (snapshot.nextExpiresAt !== undefined && snapshot.nextExpiresAt <= Date.now() / 1000) ||
      (validate && !(await validate(account)))
    ) {
      await repo.completeResetCreditAttempt(accountId, requestId);
      return false;
    }
    try {
      await consumeResetCredit(tokens.accessToken, account.accountId ?? undefined, requestId);
    } catch (error) {
      if (isResetCreditIneligibleError(error) && ids[0]) await repo.excludeResetCredit(accountId, ids[0]);
      // A definitive rejection did not redeem anything; network/timeouts remain fenced.
      if (
        error instanceof APIError &&
        error.statusCode &&
        error.statusCode >= 400 &&
        error.statusCode < 500 &&
        error.statusCode !== 408
      ) {
        await repo.completeResetCreditAttempt(accountId, requestId);
      }
      await repo.flush?.();
      throw error;
    }
    // Keep the account lock through refresh and verification so a concurrent
    // manual click cannot consume a second credit while the result is pending.
    const submittedAt = Date.now();
    if (refreshAndVerify) {
      const result = await refreshAndVerify();
      if (result?.requestStartedAt !== undefined && result.requestStartedAt < submittedAt) {
        throw new Error(
          "Quota refresh began before reset submission completed. Refresh quota again to verify its outcome."
        );
      }
      await verifyAccountResetCredit(repo, accountId);
    }
    return true;
  });
}

export async function verifyAccountResetCredit(repo: AccountsRepository, accountId: string): Promise<void> {
  const account = await repo.getAccount(accountId);
  if (
    !account?.quotaSummary ||
    account.quotaError ||
    !hasCodexManagerAccountAutoQueueCapability(account) ||
    (account.resetCreditAttempt &&
      (!account.lastQuotaAt ||
        account.lastQuotaAt < account.resetCreditAttempt.attemptedAt ||
        account.lastQuotaAt > Date.now()))
  ) {
    throw new Error(
      "Reset was submitted, but usable quota could not be verified. Refresh quota before retrying; another credit was not consumed."
    );
  }
  if (account.resetCreditAttempt)
    await repo.completeResetCreditAttempt(accountId, account.resetCreditAttempt.requestId);
}
