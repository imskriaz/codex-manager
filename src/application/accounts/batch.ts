import type { AccountsRepository } from "../../storage";
import type { CodexManagerAccountRecord } from "../../core/types";
import type { DashboardBatchResult } from "../../domain/dashboard/types";
import { runWithConcurrencyLimit } from "../../utils/concurrency";
import { runWithBulkProviderRequests } from "../../utils/network";

/** Every entry point uses the same pacing, deduplication and per-account outcomes. */
export async function runAccountBatch(
  repo: AccountsRepository,
  accountIds: readonly string[],
  worker: (accountId: string) => Promise<void>,
  options: {
    kind: DashboardBatchResult["kind"];
    background?: boolean;
    onStart?: (accountId: string, started: number, total: number) => void;
    onComplete?: () => void;
  }
): Promise<DashboardBatchResult> {
  const ids = [...new Set(accountIds)];
  const accounts = new Map<string, CodexManagerAccountRecord>();
  const result: DashboardBatchResult = { kind: options.kind, successCount: 0, failedCount: 0, failures: [] };
  let started = 0;
  await runWithBulkProviderRequests(() =>
    runWithConcurrencyLimit(
      ids,
      options.background ? 1 : 2,
      async (id) => {
        try {
          const account = await repo.getAccount(id);
          if (!account) throw new Error("That account no longer exists. Refresh the account list.");
          accounts.set(id, account);
          options.onStart?.(id, ++started, ids.length);
          await worker(id);
          result.successCount++;
        } catch (error) {
          result.failedCount++;
          result.failures.push({
            accountId: id,
            email: accounts.get(id)?.email,
            message: error instanceof Error ? error.message : String(error)
          });
        } finally {
          try {
            options.onComplete?.();
          } catch (error) {
            console.warn("[codexManager] batch completion notification failed", error);
          }
        }
      },
      { delayMs: 300 }
    )
  );
  return result;
}
