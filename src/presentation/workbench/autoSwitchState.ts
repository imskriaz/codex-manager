import * as vscode from "vscode";
import { CodexAutoSwitchReason } from "../../core/types";
import { waitWithin } from "../../utils/concurrency";
import { recordPersistentEvent } from "../../utils/persistentLog";
import { accountQuotaAvailability } from "../../utils/quotaWindows";
import type { CodexManagerAccountRecord } from "../../core/types";

type AutoSwitchRuntimeState = {
  lockedAccountId?: string;
  lockedUntil?: number;
  lastReason?: CodexAutoSwitchReason;
  pendingNotice?: {
    message: string;
    createdAt: number;
  };
  dashboardNotice?: {
    level: "info" | "warning" | "error";
    message: string;
    createdAt: number;
    accountId?: string;
    switchResult?: "switched" | "switched-and-reloaded";
  };
};

const GLOBAL_STATE_KEY = "codexManager.autoSwitchRuntimeState";
const DASHBOARD_NOTICE_TTL_MS = 2 * 60_000;

const state: AutoSwitchRuntimeState = {};
let extensionContext: vscode.ExtensionContext | undefined;
let lockUpdatePending = false;
let lockReleased = false;

export function initAutoSwitchRuntimeState(context: vscode.ExtensionContext): void {
  extensionContext = context;
  lockReleased = false;
  const saved = context.globalState.get<AutoSwitchRuntimeState>(GLOBAL_STATE_KEY);
  if (!saved) {
    pruneExpiredLock();
    return;
  }

  state.lockedAccountId = saved.lockedAccountId;
  state.lockedUntil = saved.lockedUntil;
  state.lastReason = saved.lastReason;
  state.pendingNotice = saved.pendingNotice;
  state.dashboardNotice = saved.dashboardNotice ??
    (saved.pendingNotice ? { level: "info", ...saved.pendingNotice } : undefined);
  pruneExpiredLock();
}

export function getAutoSwitchRuntimeSnapshot(): AutoSwitchRuntimeState {
  pruneExpiredLock();
  pruneExpiredDashboardNotice();
  return {
    lockedAccountId: state.lockedAccountId,
    lockedUntil: state.lockedUntil,
    lastReason: state.lastReason ? { ...state.lastReason, matchedRules: [...state.lastReason.matchedRules] } : undefined,
    dashboardNotice: state.dashboardNotice ? { ...state.dashboardNotice } : undefined
  };
}

export function setAutoSwitchLock(accountId: string | undefined, minutes: number): void {
  if (!accountId || !Number.isFinite(minutes) || minutes <= 0) {
    state.lockedAccountId = undefined;
    state.lockedUntil = undefined;
    persist(false);
    return;
  }

  state.lockedAccountId = accountId;
  state.lockedUntil = Date.now() + minutes * 60_000;
  persist(false);
}

export function clearAutoSwitchLock(accountId?: string): void {
  pruneExpiredLock();
  if (accountId && state.lockedAccountId && state.lockedAccountId !== accountId) {
    return;
  }
  state.lockedAccountId = undefined;
  state.lockedUntil = undefined;
  persist(false);
}

/** Explicit dashboard changes acknowledge persistence before reporting success. */
export async function updateAutoSwitchLock(accountId: string, minutes: number): Promise<void> {
  if (!accountId || !Number.isInteger(minutes) || minutes < 0 || minutes > 120) throw new Error("Choose an account and a whole lock duration from 0 to 120 minutes.");
  if (lockUpdatePending) throw new Error("The previous lock change is still saving. Retry after storage responds.");
  pruneExpiredLock();
  if (state.lockedAccountId && state.lockedAccountId !== accountId) throw new Error("Auto-switch is locked for another account. Unlock that account first.");
  const previous = { lockedAccountId: state.lockedAccountId, lockedUntil: state.lockedUntil };
  state.lockedAccountId = minutes ? accountId : undefined;
  state.lockedUntil = minutes ? Date.now() + minutes * 60_000 : undefined;
  const until = state.lockedUntil;
  const owner = state.lockedAccountId;
  const saved = { ...state };
  lockUpdatePending = true;
  const write = Promise.resolve().then(() => extensionContext?.globalState.update(GLOBAL_STATE_KEY, saved)).then(() => {
    if (!minutes && previous.lockedAccountId) lockReleased = true;
    recordPersistentEvent("info", "auto-switch-lock", "Lock change saved", { accountId, minutes });
  }).catch(error => {
    if (state.lockedUntil === until && state.lockedAccountId === owner) Object.assign(state, previous);
    throw error;
  }).finally(() => { lockUpdatePending = false; });
  try {
    await waitWithin(write, 5_000, "The lock change is still saving. Its outcome is unconfirmed; retry after storage responds.");
  } catch (error) {
    recordPersistentEvent("warning", "auto-switch-lock", "Lock change could not be confirmed", { accountId, minutes }, error);
    throw error;
  }
}

export async function lockAutoSwitchForManualSelection(account: CodexManagerAccountRecord): Promise<void> {
  const previous = getAutoSwitchRuntimeSnapshot().lockedAccountId;
  if (previous && previous !== account.id) await updateAutoSwitchLock(previous, 0);
  await updateAutoSwitchLock(account.id, accountQuotaAvailability(account) === 'available' ? 0 : 15);
}

export function consumeAutoSwitchLockRelease(): boolean {
  pruneExpiredLock();
  const released = lockReleased;
  lockReleased = false;
  return released;
}

export function isAutoSwitchLocked(accountId: string | undefined): boolean {
  pruneExpiredLock();
  return Boolean(accountId && state.lockedAccountId === accountId && state.lockedUntil && state.lockedUntil > Date.now());
}

export function recordAutoSwitchReason(reason: CodexAutoSwitchReason): void {
  state.lastReason = {
    ...reason,
    matchedRules: [...reason.matchedRules]
  };
  persist();
}

export function queueAutoSwitchNotice(message: string, accountId?: string): void {
  const notice = {
    message,
    createdAt: Date.now()
  };
  state.pendingNotice = notice;
  state.dashboardNotice = {
    level: "info",
    ...notice,
    accountId,
    switchResult: "switched-and-reloaded"
  };
  persist();
}

export function recordAutoSwitchDashboardNotice(
  message: string,
  level: "info" | "warning" | "error" = "info",
  options?: { accountId?: string; switchResult?: "switched" | "switched-and-reloaded" }
): void {
  state.dashboardNotice = {
    level,
    message,
    createdAt: Date.now(),
    ...options
  };
  persist();
}

export function consumeAutoSwitchNotice(): string | undefined {
  const message = state.pendingNotice?.message;
  if (!message) {
    return undefined;
  }
  state.pendingNotice = undefined;
  persist();
  return message;
}

function pruneExpiredLock(): void {
  refreshLock();
  if (!state.lockedUntil || state.lockedUntil > Date.now()) {
    return;
  }

  state.lockedAccountId = undefined;
  state.lockedUntil = undefined;
  lockReleased = true;
  persist(false);
}

function refreshLock(): void {
  if (!extensionContext || lockUpdatePending) return;
  const saved = extensionContext.globalState.get<AutoSwitchRuntimeState>(GLOBAL_STATE_KEY);
  if (state.lockedAccountId && !saved?.lockedAccountId) lockReleased = true;
  state.lockedAccountId = saved?.lockedAccountId;
  state.lockedUntil = saved?.lockedUntil;
}

function pruneExpiredDashboardNotice(): void {
  if (!state.dashboardNotice || Date.now() - state.dashboardNotice.createdAt <= DASHBOARD_NOTICE_TTL_MS) {
    return;
  }
  state.dashboardNotice = undefined;
  persist();
}

function persist(readLock = true): void {
  if (readLock) refreshLock();
  void Promise.resolve(extensionContext?.globalState.update(GLOBAL_STATE_KEY, {
    lockedAccountId: state.lockedAccountId,
    lockedUntil: state.lockedUntil,
    lastReason: state.lastReason,
    pendingNotice: state.pendingNotice,
    dashboardNotice: state.dashboardNotice
  })).catch(error => recordPersistentEvent("warning", "auto-switch-lock", "Runtime state could not be saved", undefined, error));
}
