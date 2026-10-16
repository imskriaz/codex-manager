import * as fs from "fs/promises";
import * as path from "path";
import { cloneIndex, mergeAccountsIndexChanges } from "./accountsIndex";
import { saveAccountIndex } from "./sqliteAccounts";
import {
  backupCurrentIndex,
  countAvailableBackups,
  isFileNotFoundError,
  readIndexSnapshot,
  writeIndexAtomically
} from "./accountsPersistence";
import type { CodexManagerIndex } from "../core/types";
import { createError } from "../core/errors";
import type { AccountsRepositoryState } from "./accountsRepositoryState";
import { CrossWindowOperationBusyError, runCrossWindowExclusive } from "../utils/crossWindowOperations";
import { sqliteStoreForFile } from "./sqliteState";

const INDEX_PERSIST_OPERATION_KEY = "accounts:index-persist";

export function disposeWriteCoordinator(state: AccountsRepositoryState): void {
  state.disposed = true;
  if (state.saveDebounceTimer) {
    clearTimeout(state.saveDebounceTimer);
    state.saveDebounceTimer = null;
  }

  state.pendingSave = null;
  state.isDirty = false;
}
export function readPendingOrCachedIndex(
  state: AccountsRepositoryState,
  cacheTtlMs: number
): CodexManagerIndex | undefined {
  if (state.pendingSave) {
    return cloneIndex(state.pendingSave);
  }

  if (!state.cache) {
    return undefined;
  }

  const age = Date.now() - state.cache.timestamp;
  if (age >= cacheTtlMs) {
    return undefined;
  }

  return cloneIndex(state.cache.data);
}

export function markPendingSave(
  state: AccountsRepositoryState,
  index: CodexManagerIndex,
  debounceDelayMs: number,
  flush: () => void
): void {
  const snapshot = cloneIndex(index);
  state.cache = {
    data: snapshot,
    timestamp: Date.now()
  };
  state.isDirty = true;

  if (state.saveDebounceTimer) {
    clearTimeout(state.saveDebounceTimer);
  }

  state.pendingSave = snapshot;
  state.saveDebounceTimer = setTimeout(flush, debounceDelayMs);
}

export function markRecoveryPending(state: AccountsRepositoryState, index: CodexManagerIndex): void {
  if (state.saveDebounceTimer) {
    clearTimeout(state.saveDebounceTimer);
    state.saveDebounceTimer = null;
  }

  const snapshot = cloneIndex(index);
  state.cache = {
    data: snapshot,
    timestamp: Date.now()
  };
  state.pendingSave = snapshot;
  state.isDirty = true;
}

export async function flushPendingSave(
  state: AccountsRepositoryState,
  persistIndex: (index: CodexManagerIndex) => Promise<void>
): Promise<void> {
  state.saveDebounceTimer = null;
  if (!state.pendingSave) {
    return;
  }

  const persistTask = state.persistChain
    .catch(() => undefined)
    .then(async () => {
      const snapshot = state.pendingSave;
      if (!snapshot) return;
      await persistIndex(snapshot);
      if (state.pendingSave === snapshot) state.pendingSave = null;
      if (!state.pendingSave) state.isDirty = false;
    });
  state.persistChain = persistTask;

  try {
    await persistTask;
  } catch (error) {
    console.error("[codexManager] failed to persist accounts index:", error);
  }
}

export function assertWriteAllowed(state: AccountsRepositoryState): void {
  if (state.disposed) throw createError.storageWriteBlocked("Account repository is closed.");
  if (state.indexHealth.status === "corrupted_unrecoverable") {
    console.warn("[codexManager] blocked write because accounts index is corrupted");
    throw createError.storageWriteBlocked("Accounts index is corrupted. Restore accounts before writing again.");
  }
}

export async function persistIndexWithBackups(params: {
  state: AccountsRepositoryState;
  indexPath: string;
  index: CodexManagerIndex;
  tempSuffix: string;
  backupCount: number;
  activeCodexHomeKey?: string;
}): Promise<void> {
  try {
    await runCrossWindowExclusive(INDEX_PERSIST_OPERATION_KEY, "Account index save", async () => {
      assertWriteAllowed(params.state);
      await fs.mkdir(path.dirname(params.indexPath), { recursive: true });
      const sqlite = sqliteStoreForFile(params.indexPath);
      const current = await readIndexSnapshot(params.indexPath).catch((error: unknown) => {
        if (sqlite && !isFileNotFoundError(error)) throw error;
        return undefined;
      });
      assertWriteAllowed(params.state);
      const index = sqlite && current && params.state.persistedIndex
        ? mergeAccountsIndexChanges(params.state.persistedIndex, params.index, current, params.activeCodexHomeKey)
        : cloneIndex(params.index);
      if (params.activeCodexHomeKey) {
        if (current?.activeAccountIdsByCodexHome && !(sqlite && params.state.persistedIndex)) {
          const localAccountId = index.activeAccountIdsByCodexHome?.[params.activeCodexHomeKey];
          index.activeAccountStateVersion = 1;
          index.activeAccountIdsByCodexHome = { ...current.activeAccountIdsByCodexHome };
          if (localAccountId) {
            index.activeAccountIdsByCodexHome[params.activeCodexHomeKey] = localAccountId;
          } else {
            delete index.activeAccountIdsByCodexHome[params.activeCodexHomeKey];
          }
        }
      }
      if (sqlite) saveAccountIndex(sqlite, index, params.backupCount);
      else {
        await backupCurrentIndex(params.indexPath, params.backupCount);
        await writeIndexAtomically(params.indexPath, index, params.tempSuffix);
      }
      if (sqlite) {
        params.state.persistedIndex = cloneIndex(index);
        if (params.state.pendingSave && params.state.pendingSave !== params.index)
          params.state.pendingSave = mergeAccountsIndexChanges(params.index, params.state.pendingSave, index, params.activeCodexHomeKey);
        params.state.cache = { data: cloneIndex(params.state.pendingSave && params.state.pendingSave !== params.index ? params.state.pendingSave : index), timestamp: Date.now() };
      }
      const availableBackups = await countAvailableBackups(params.indexPath, params.backupCount);
      params.state.indexHealth =
        params.state.indexHealth.status === "corrupted_unrecoverable"
          ? { status: "healthy", availableBackups }
          : { ...params.state.indexHealth, availableBackups };
    }, { waitMs: 2_000 });
  } catch (cause) {
    // Preserve the process-safe busy signal so startup can defer its auth
    // reconciliation instead of presenting a normal overlapping write from
    // another VS Code window as a fatal storage failure.
    if (cause instanceof CrossWindowOperationBusyError) {
      throw cause;
    }
    throw createError.storageWriteFailed(params.indexPath, cause);
  }
}
