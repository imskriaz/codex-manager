import type { CodexManagerAccountRecord } from "../../core/types";
import type { AccountsRepository } from "../../storage";
import {
  compareCodexManagerAccountAutoQueueOrder,
  toAutoQueueOrderValue,
  getAccountAutoQueuePolicy
} from "./autoQueueOrder";
import { isAutoQueueCandidateEligible } from "../../domain/autoQueuePolicy";
import { getCodexHomeStateKey } from "../../codex";
import { runCrossWindowExclusive } from "../../utils/crossWindowOperations";

export type QueuedAccountActivationResult =
  | { status: "not-needed" }
  | { status: "activated"; account: CodexManagerAccountRecord }
  | { status: "failed"; message: string };

let activationInFlight: Promise<QueuedAccountActivationResult> | undefined;

/**
 * Restores a usable current account after an add/reauthorization flow when the
 * index has no active account. Only explicitly queued, enabled accounts qualify.
 */
export async function activateQueuedAccountIfCurrentMissing(
  repo: AccountsRepository,
  canUseAccount: (accountId: string) => boolean = () => true
): Promise<QueuedAccountActivationResult> {
  if (activationInFlight) {
    return activationInFlight;
  }

  const task = runCrossWindowExclusive(
    `automation:account-switch:${getCodexHomeStateKey()}`,
    "Queued account activation",
    () => activateQueuedAccount(repo, canUseAccount)
  );
  activationInFlight = task;
  try {
    return await task;
  } finally {
    if (activationInFlight === task) {
      activationInFlight = undefined;
    }
  }
}

async function activateQueuedAccount(
  repo: AccountsRepository,
  canUseAccount: (accountId: string) => boolean
): Promise<QueuedAccountActivationResult> {
  repo.invalidateCachedIndex?.();
  const accounts = await repo.listAccounts();
  if (accounts.some((account) => account.isActive)) {
    return { status: "not-needed" };
  }

  const policy = getAccountAutoQueuePolicy();
  const queuedAccounts = accounts
    .filter(
      (account) =>
        account.queuePriority === true &&
        canUseAccount(account.id) &&
        isAutoQueueCandidateEligible(toAutoQueueOrderValue(account), policy)
    )
    .sort((left, right) => compareCodexManagerAccountAutoQueueOrder(left, right, policy));
  if (queuedAccounts.length === 0) {
    return { status: "not-needed" };
  }

  let lastError: unknown;
  for (const account of queuedAccounts) {
    try {
      if (!(await repo.getTokens(account.id, { bypassCache: true }))) {
        lastError = new Error(`Stored credentials are missing for ${account.email}.`);
        continue;
      }
      const latestAccounts = await repo.listAccounts();
      if (latestAccounts.some((item) => item.isActive)) return { status: "not-needed" };
      const latest = latestAccounts.find((item) => item.id === account.id);
      if (
        !latest ||
        latest.queuePriority !== true ||
        !canUseAccount(latest.id) ||
        !isAutoQueueCandidateEligible(toAutoQueueOrderValue(latest), getAccountAutoQueuePolicy())
      )
        continue;
      const activated = await repo.switchAccount(account.id);
      await repo.flush?.();
      return { status: "activated", account: activated };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    status: "failed",
    message: lastError instanceof Error ? lastError.message : "No queued account could be activated."
  };
}
