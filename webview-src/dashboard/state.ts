import type { DashboardActionName, DashboardSettings, DashboardState } from "../../src/domain/dashboard/types";

export type PendingActionRequest = {
  requestId: string;
  action: DashboardActionName;
  accountId?: string;
  requestedAt: number;
  timeoutMs?: number;
};

export type AppState = {
  snapshot?: DashboardState;
  settingsOpen: boolean;
  privacyMode: boolean;
  lastEnabledAutoRefreshMinutes: number;
  lastEnabledAutoRefreshCurrentMinutes: number;
  now: number;
  selectedAccountIds: string[];
  pendingActions: PendingActionRequest[];
};

export type AppAction =
  | { type: "snapshot"; snapshot: DashboardState }
  | { type: 'account-tags'; updates: import('../../src/domain/accountTags').AccountTagUpdate[]; deviceId?: string }
  | { type: "open-settings" }
  | { type: "close-settings" }
  | { type: "toggle-privacy" }
  | { type: "settings-patch"; patch: Partial<DashboardSettings> }
  | { type: "tick"; now: number }
  | { type: "toggle-select"; accountId: string }
  | { type: "request-action"; request: PendingActionRequest }
  | { type: "resolve-action"; requestId: string };

export function createInitialState(): AppState {
  return {
    settingsOpen: false,
    privacyMode: false,
    lastEnabledAutoRefreshMinutes: 15,
    lastEnabledAutoRefreshCurrentMinutes: 1,
    now: Date.now(),
    selectedAccountIds: [],
    pendingActions: []
  };
}

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "snapshot": {
      const nextAccountIds = new Set(action.snapshot.accounts.map((account) => account.id));
      const selectedAccountIds = state.selectedAccountIds.filter((accountId) => nextAccountIds.has(accountId));
      const retainTags = (incoming: DashboardState['accounts'], previous: DashboardState['accounts'] = []) => {
        const saved = new Map(previous.map(account => [account.id, account]));
        return incoming.map(account => {
          const prior = saved.get(account.id);
          return prior?.tags !== undefined && (prior.updatedAt ?? 0) > (account.updatedAt ?? 0) ? { ...account, tags: prior.tags, updatedAt: prior.updatedAt } : account;
        });
      };

      return {
        ...state,
        snapshot: { ...action.snapshot, accounts: retainTags(action.snapshot.accounts, state.snapshot?.accounts),
          peerAccounts: action.snapshot.peerAccounts ? Object.fromEntries(Object.entries(action.snapshot.peerAccounts).map(([id, accounts]) => [id, retainTags(accounts, state.snapshot?.peerAccounts?.[id])])) : action.snapshot.peerAccounts },
        now: Date.now(),
        privacyMode: action.snapshot.settings.privacyMode === true,
        selectedAccountIds,
        lastEnabledAutoRefreshMinutes:
          action.snapshot.settings.autoRefreshMinutes > 0
            ? Math.max(5, action.snapshot.settings.autoRefreshMinutes)
            : state.lastEnabledAutoRefreshMinutes,
        lastEnabledAutoRefreshCurrentMinutes:
          action.snapshot.settings.autoRefreshCurrentMinutes > 0
            ? action.snapshot.settings.autoRefreshCurrentMinutes
            : state.lastEnabledAutoRefreshCurrentMinutes
      };
    }
    case "toggle-select":
      return {
        ...state,
        selectedAccountIds: state.selectedAccountIds.includes(action.accountId)
          ? state.selectedAccountIds.filter((accountId) => accountId !== action.accountId)
          : [...state.selectedAccountIds, action.accountId]
      };
    case "open-settings":
      return {
        ...state,
        settingsOpen: true
      };
    case "close-settings":
      return {
        ...state,
        settingsOpen: false
      };
    case "toggle-privacy":
      return {
        ...state,
        privacyMode: !state.privacyMode
      };
    case "settings-patch":
      if (!state.snapshot) {
        return state;
      }

      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          settings: {
            ...state.snapshot.settings,
            ...action.patch
          }
        },
        lastEnabledAutoRefreshMinutes:
          typeof action.patch.autoRefreshMinutes === "number" && action.patch.autoRefreshMinutes > 0
            ? Math.max(5, action.patch.autoRefreshMinutes)
            : state.lastEnabledAutoRefreshMinutes,
        lastEnabledAutoRefreshCurrentMinutes:
          typeof action.patch.autoRefreshCurrentMinutes === "number" && action.patch.autoRefreshCurrentMinutes > 0
            ? action.patch.autoRefreshCurrentMinutes
            : state.lastEnabledAutoRefreshCurrentMinutes
      };
    case 'account-tags': {
      if (!state.snapshot) return state;
      const updates = new Map(action.updates.map(update => [update.accountId, update]));
      const patch = (accounts: DashboardState['accounts']) => accounts.map(account => {
        const update = updates.get(account.id);
        return update && (account.updatedAt ?? 0) <= update.updatedAt ? { ...account, tags: [...update.tags], updatedAt: update.updatedAt, ...(update.enabled !== undefined ? { enabled: update.enabled } : {}) } : account;
      });
      return { ...state, snapshot: action.deviceId ? { ...state.snapshot, peerAccounts: { ...state.snapshot.peerAccounts, [action.deviceId]: patch(state.snapshot.peerAccounts?.[action.deviceId] ?? []) } } : { ...state.snapshot, accounts: patch(state.snapshot.accounts) } };
    }
    case "tick":
      return {
        ...state,
        now: action.now
      };
    case "request-action":
      if (state.pendingActions.some((request) => request.requestId === action.request.requestId)) {
        return state;
      }

      return {
        ...state,
        pendingActions: [...state.pendingActions, action.request]
      };
    case "resolve-action":
      return {
        ...state,
        pendingActions: state.pendingActions.filter((request) => request.requestId !== action.requestId)
      };
    default:
      return state;
  }
}
