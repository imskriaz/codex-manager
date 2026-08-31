import type { CodexManagerIndex, CodexIndexHealthSummary } from "../core/types";

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export interface AccountsRepositoryState {
  cache: CacheEntry<CodexManagerIndex> | null;
  saveDebounceTimer: NodeJS.Timeout | null;
  pendingSave: CodexManagerIndex | null;
  persistChain: Promise<void>;
  isDirty: boolean;
  indexHealth: CodexIndexHealthSummary;
}

export function createAccountsRepositoryState(): AccountsRepositoryState {
  return {
    cache: null,
    saveDebounceTimer: null,
    pendingSave: null,
    persistChain: Promise.resolve(),
    isDirty: false,
    indexHealth: {
      status: "healthy",
      availableBackups: 0
    }
  };
}
