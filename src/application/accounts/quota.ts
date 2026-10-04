import * as vscode from "vscode";
import {
  CrossWindowOperationBusyError,
  runCrossWindowExclusive,
  runSharedMaintenance
} from "../../utils/crossWindowOperations";
import { getCodexHomeStateKey } from "../../codex";
import { createError } from "../../core";
import { CodexManagerAccountRecord, CodexTokens } from "../../core/types";
import {
  getCodexManagerConfiguration,
  getAutoRefreshMinutes,
  getQuotaWarningThresholds
} from "../../infrastructure/config/extensionSettings";
import { QuotaRefreshResult, refreshQuota, fetchResetCredits } from "../../services";
import {
  recordAccountQuotaCheck,
  getCoordinatedQuotaSnapshot,
  wasAccountQuotaCheckedWithin,
  wasQuotaCheckedWithin
} from "../../services/quotaCheckCoordination";
import { AccountsRepository } from "../../storage";
import { needsWindowReloadForAccount } from "../../presentation/workbench/windowRuntimeAccount";
import {
  clearAutoSwitchLock,
  consumeAutoSwitchNotice,
  isAutoSwitchLocked,
  queueAutoSwitchNotice,
  recordAutoSwitchDashboardNotice,
  recordAutoSwitchReason
} from "../../presentation/workbench/autoSwitchState";
import { clearTokenAutomationError } from "../../presentation/workbench/tokenAutomationState";
import { getCommandCopy, getLanguage, getQuotaWarningCopy, resolveLongQuotaLabel } from "../../utils";
import { getQuotaIssueKind } from "../../utils/quotaIssue";
import { recordDashboardActionPrompt, shouldSuppressDashboardNotifications } from "../../utils/notificationPolicy";
import { getDashboardCopy } from "../dashboard/copy";
import { redeemAccountResetCredit, verifyAccountResetCredit } from "./resetCreditRedemption";
import {
  isAutoQueueCandidateEligible,
  isAutoQueueSnapshotFresh,
  usableAutoQueueResetCount
} from "../../domain/autoQueuePolicy";
import {
  compareCodexManagerAccountAutoQueueOrder,
  getCodexManagerAccountAutoQueueEfficiency,
  hasComparableHourlyWindow,
  hasComparableWeeklyWindow,
  toAutoQueueOrderValue,
  getAccountAutoQueuePolicy
} from "./autoQueueOrder";
import {
  autoReloadWindowForAccount,
  handleCodexAppRestartPreference,
  promptWindowReloadForAccount,
  reloadWindowNow
} from "./switchEffects";

const AUTO_SWITCH_ENABLED = "autoSwitchEnabled";
const AUTO_SWITCH_RELOAD_WINDOW_ENABLED = "autoSwitchReloadWindowEnabled";
const QUOTA_WARNING_ENABLED = "quotaWarningEnabled";
// One native warning is enough while the same account/dimension remains below
// the same threshold. The count resets after recovery or a threshold change.
const MAX_WARNINGS_PER_CYCLE = 1;
const quotaWarningCounts = new Map<string, number>();
let autoSwitchInFlight: Promise<boolean> | undefined;
let lastBlockedAutoSwitchKey: string | undefined;
let lastAutoSwitchFailure: { key: string; shownAt: number } | undefined;
let lastAutoSwitchSafetyRefreshAt = 0;
let autoSwitchSafetyRefreshInFlight: Promise<boolean> | undefined;
const silentQuotaRefreshes = new Map<string, Promise<QuotaRefreshResult>>();
const AUTO_SWITCH_FAILURE_NOTICE_COOLDOWN_MS = 15 * 60 * 1000;

export type RefreshView = {
  refresh(): void;
  markObservedAuthIdentity?: (accountId?: string) => void;
};

type RefreshSingleQuotaOptions = {
  announce?: boolean;
  allowTokenRefresh?: boolean;
  skipDisabled?: boolean;
  awaitSubscriptionRefresh?: boolean;
  forceRefresh?: boolean;
  refreshView?: boolean;
  warnQuota?: boolean;
  reconcileResetAttempt?: boolean;
  canUseAccount?: (accountId: string) => boolean;
};

export async function refreshSingleQuota(
  repo: AccountsRepository,
  view: RefreshView,
  accountId: string,
  options: RefreshSingleQuotaOptions = {}
): Promise<QuotaRefreshResult> {
  // Background/manual batch refreshes frequently converge on the same account
  // (scheduler, safety sweep, and a dashboard click). Share one request for
  // silent callers so token reads, network fetches, and index writes are not
  // duplicated. User-facing calls keep their own notification semantics.
  if (options.announce === false) {
    const existing = silentQuotaRefreshes.get(accountId);
    if (existing) return existing;
    const task = coordinatedQuotaRefresh(repo, view, accountId, options).finally(() => {
      if (silentQuotaRefreshes.get(accountId) === task) silentQuotaRefreshes.delete(accountId);
    });
    silentQuotaRefreshes.set(accountId, task);
    return task;
  }
  return coordinatedQuotaRefresh(repo, view, accountId, options);
}

async function coordinatedQuotaRefresh(
  repo: AccountsRepository,
  view: RefreshView,
  accountId: string,
  options: RefreshSingleQuotaOptions
): Promise<QuotaRefreshResult> {
  const run = (): Promise<QuotaRefreshResult> =>
    runAndFlush(repo, () => refreshSingleQuotaInternal(repo, view, accountId, options));
  const key = `network:account-quota:${accountId}`;
  if (options.announce !== false) return runCrossWindowExclusive(key, "Quota refresh", run);
  const result = await runSharedMaintenance(key, "Quota refresh", 15_000, run);
  if (result.ran) return result.value!;
  // Another window completed the maintenance request. Re-read its durable
  // result instead of rotating OAuth tokens and querying quota again.
  repo.invalidateCachedIndex?.();
  const account = await repo.getAccount(accountId);
  view.refresh();
  if (!account) throw createError.accountNotFound(accountId);
  if (account.resetCreditAttempt) {
    throw new Error(
      "Another window owns the quota refresh. Retry refresh to verify the pending reset after it completes."
    );
  }
  return { quota: account.quotaSummary, error: account.quotaError };
}

async function refreshSingleQuotaInternal(
  repo: AccountsRepository,
  view: RefreshView,
  accountId: string,
  options: RefreshSingleQuotaOptions = {}
): Promise<QuotaRefreshResult> {
  const announce = options.announce ?? true;
  const forceRefresh = options.forceRefresh ?? announce;
  const awaitSubscriptionRefresh = options.awaitSubscriptionRefresh ?? false;
  const shouldRefreshView = options.refreshView ?? true;
  const warnQuota = options.warnQuota ?? true;
  const account = await repo.getAccount(accountId);
  if (!account) {
    throw createError.accountNotFound(accountId);
  }
  if (account.enabled === false && options.skipDisabled) {
    if (announce) {
      void vscode.window.showWarningMessage(formatDisabledQuotaSkip(formatAccountToastLabel(account)));
    }
    return { skipped: "disabled" };
  }

  // Quota refresh can rotate OAuth tokens. Read through to SecretStorage so a
  // concurrent background refresh (or another Codex process) cannot leave this
  // request using a stale cached refresh token.
  const tokens = await repo.getTokens(accountId, { bypassCache: true });
  if (!tokens) {
    throw createError.accountNotFound(account.email);
  }

  const allowTokenRefresh = (options.allowTokenRefresh ?? true) && account.tokenRefreshEnabled === true;
  const refreshStartedAt = Date.now();
  let result = await refreshQuota(account, tokens, forceRefresh, {
    allowTokenRefresh
  });
  let effectiveTokens = tokens;
  if (!allowTokenRefresh && account.isActive && getQuotaIssueKind(result.error) === "auth") {
    const retry = await retryQuotaFromTrackedAuthFile(repo, accountId, account, tokens, result);
    result = retry.result;
    effectiveTokens = retry.tokens;
  }
  if (
    account.resetCreditAttempt &&
    result.requestStartedAt !== undefined &&
    result.requestStartedAt < account.resetCreditAttempt.attemptedAt
  ) {
    // Joining an older in-flight request cannot establish post-reset quota.
    throw new Error("Quota refresh began before the reset. Refresh quota again to verify its outcome.");
  }
  const updatedAccount = await repo.updateQuota(
    accountId,
    result.quota,
    result.error,
    result.updatedTokens,
    result.updatedPlanType,
    result.updatedSubscriptionActiveUntil
  );
  recordAccountQuotaCheck(updatedAccount, updatedAccount.lastQuotaAt ?? Date.now());
  const subscriptionRefresh = repo.refreshSubscriptionState(accountId, forceRefresh).catch(() => undefined);
  if (awaitSubscriptionRefresh) {
    // 账号信息同步需要等订阅写入完成后再发布页面状态，避免继续展示旧套餐和旧到期时间。
    await subscriptionRefresh;
  } else {
    // Finish the account-level state write before this action reports success.
    await subscriptionRefresh;
  }
  // 后台异步拉取重置次数明细（含最新可用次数与最近到期时间），不阻塞配额刷新
  let resetSnapshotVerified = false;
  if (!result.error && updatedAccount.quotaSummary) {
    const credTokens = result.updatedTokens ?? effectiveTokens;
    const credAccountId = updatedAccount.accountId ?? account.accountId ?? undefined;
    resetSnapshotVerified = await syncResetCreditsSnapshot(
      repo,
      view,
      accountId,
      updatedAccount,
      credTokens.accessToken,
      credAccountId
    );
  }
  if (!result.error) {
    clearTokenAutomationError(accountId);
    // A fresh successful refresh can reconcile a reset interrupted by a reboot
    // or uncertain response. Failed refreshes leave the durable fence intact.
    const reconciled = await repo.getAccount(accountId);
    if (
      options.reconcileResetAttempt !== false &&
      resetSnapshotVerified &&
      reconciled?.resetCreditAttempt &&
      forceRefresh &&
      (result.requestStartedAt ?? refreshStartedAt) >= reconciled.resetCreditAttempt.attemptedAt &&
      (reconciled.quotaSummary?.resetCreditsAvailable ?? Number.POSITIVE_INFINITY) <
        reconciled.resetCreditAttempt.availableBefore
    ) {
      await verifyAccountResetCredit(repo, accountId).catch(() => undefined);
    }
  }
  if (shouldRefreshView) {
    view.refresh();
  }
  if (warnQuota && account.isActive) {
    await refreshAllBeforeWarningIfNeeded(repo, view, updatedAccount, announce, options.canUseAccount);
    await maybeAutoSwitchForActiveQuota(repo, view, { canUseAccount: options.canUseAccount });
  }
  if (warnQuota) {
    // Keep the warning check independent from auto-switch. If auto-switch
    // succeeds the new active account normally has enough quota, while a
    // locked/failed/disabled switch still surfaces the warning choices.
    await maybeWarnForAccount(repo, accountId, options.canUseAccount);
  }

  if (announce) {
    const copy = getCommandCopy();
    const label = formatAccountToastLabel(account);
    if (result.error) {
      void vscode.window.showWarningMessage(copy.failedToRefresh(label, result.error.message));
    } else {
      void vscode.window.showInformationMessage(copy.quotaRefreshed(label));
    }
  }
  return result;
}

export async function refreshImportedAccountQuota(
  repo: AccountsRepository,
  accountId: string
): Promise<QuotaRefreshResult> {
  return runAndFlush(repo, () => refreshImportedAccountQuotaInternal(repo, accountId));
}

async function runAndFlush<T>(repo: AccountsRepository, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } finally {
    await repo.flush?.();
  }
}

async function refreshImportedAccountQuotaInternal(
  repo: AccountsRepository,
  accountId: string
): Promise<QuotaRefreshResult> {
  const account = await repo.getAccount(accountId);
  if (!account) {
    throw createError.accountNotFound(accountId);
  }
  const tokens = await repo.getTokens(accountId);
  if (!tokens) {
    throw createError.accountNotFound(account.email);
  }

  const result = await refreshQuota(account, tokens, true, {
    allowTokenRefresh: account.tokenRefreshEnabled === true
  });
  const updatedAccount = await repo.updateQuota(
    accountId,
    result.quota,
    result.error,
    result.updatedTokens,
    result.updatedPlanType,
    result.updatedSubscriptionActiveUntil
  );
  await repo.refreshSubscriptionState(accountId, true).catch(() => undefined);
  if (!result.error && updatedAccount.quotaSummary) {
    const credTokens = result.updatedTokens ?? tokens;
    const credAccountId = updatedAccount.accountId ?? account.accountId ?? undefined;
    await syncResetCreditsSnapshot(repo, undefined, accountId, updatedAccount, credTokens.accessToken, credAccountId);
  }
  if (!result.error) {
    clearTokenAutomationError(accountId);
  }
  await maybeWarnForAccount(repo, accountId);
  return result;
}

async function retryQuotaFromTrackedAuthFile(
  repo: AccountsRepository,
  accountId: string,
  account: CodexManagerAccountRecord,
  tokens: CodexTokens,
  originalResult: QuotaRefreshResult
): Promise<{ result: QuotaRefreshResult; tokens: CodexTokens }> {
  if (typeof repo.syncActiveAccountFromAuthFile !== "function") {
    return { result: originalResult, tokens };
  }
  try {
    await repo.syncActiveAccountFromAuthFile();
    const [latestAccount, latestTokens] = await Promise.all([
      repo.getAccount(accountId),
      repo.getTokens(accountId, { bypassCache: true })
    ]);
    if (!latestAccount || !latestTokens || tokenSnapshot(latestTokens) === tokenSnapshot(tokens)) {
      return { result: originalResult, tokens };
    }

    return {
      result: await refreshQuota(latestAccount, latestTokens, true, { allowTokenRefresh: false }),
      tokens: latestTokens
    };
  } catch (error) {
    console.warn(`[codexManager] unable to retry quota from tracked auth.json for ${account.email}:`, error);
    return { result: originalResult, tokens };
  }
}

function tokenSnapshot(tokens: CodexTokens): string {
  return [tokens.idToken, tokens.accessToken, tokens.refreshToken ?? "", tokens.accountId ?? ""].join("\u0000");
}

async function syncResetCreditsSnapshot(
  repo: AccountsRepository,
  view: RefreshView | undefined,
  accountId: string,
  updatedAccount: CodexManagerAccountRecord,
  accessToken: string,
  remoteAccountId?: string
): Promise<boolean> {
  try {
    const excludedIds = updatedAccount.quotaSummary?.resetCreditsExcludedIds ?? [];
    const snapshot = excludedIds.length
      ? await fetchResetCredits(accessToken, remoteAccountId, excludedIds)
      : await fetchResetCredits(accessToken, remoteAccountId);
    if (updatedAccount.quotaSummary) {
      updatedAccount.quotaSummary.resetCreditsAvailable = snapshot.availableCount;
      updatedAccount.quotaSummary.resetCreditsNextExpiresAt = snapshot.nextExpiresAt;
      updatedAccount.quotaSummary.resetCreditsAvailableIds = snapshot.credits
        .filter((credit) => credit.status === undefined || credit.status === "available")
        .map((credit) => credit.id)
        .filter((id): id is string => Boolean(id));
    }
    const availableIds = updatedAccount.quotaSummary?.resetCreditsAvailableIds ?? [];
    // Always replace the persisted ID list, including with an empty list, so
    // credits fenced by the provider cannot leave a stale reset action behind.
    const update = repo.updateResetCreditsSnapshot(
      accountId,
      snapshot.availableCount,
      snapshot.nextExpiresAt,
      availableIds
    );
    await update;
    view?.refresh();
    return true;
  } catch (error) {
    // A fresh quota response must not renew the age of a reset snapshot that
    // could not be reconciled. Retain rejection IDs, invalidate usable reserves.
    console.warn("[codexManager] reset reserves could not be verified", error);
    if (updatedAccount.quotaSummary) {
      updatedAccount.quotaSummary.resetCreditsAvailable = 0;
      updatedAccount.quotaSummary.resetCreditsNextExpiresAt = undefined;
      updatedAccount.quotaSummary.resetCreditsAvailableIds = [];
    }
    await repo.updateResetCreditsSnapshot(accountId, 0, undefined, []);
    await repo.flush?.();
    return false;
  }
}

export async function refreshSingleQuotaSafely(
  repo: AccountsRepository,
  view: RefreshView,
  accountId: string,
  options: {
    allowTokenRefresh?: boolean;
    forceRefresh?: boolean;
    announceFailure?: boolean;
    skipDisabled?: boolean;
    canUseAccount?: (accountId: string) => boolean;
  } = {}
): Promise<boolean> {
  try {
    if (options.canUseAccount && !options.canUseAccount(accountId)) {
      return false;
    }
    const result = await refreshSingleQuota(repo, view, accountId, {
      announce: false,
      allowTokenRefresh: options.allowTokenRefresh,
      skipDisabled: options.skipDisabled ?? true,
      forceRefresh: options.forceRefresh ?? false,
      refreshView: false,
      warnQuota: false,
      canUseAccount: options.canUseAccount
    });
    return !result.error && !result.skipped;
  } catch (error) {
    const account = await repo.getAccount(accountId);
    const label = account ? formatAccountToastLabel(account) : accountId;
    console.warn(`[codexManager] auto refresh failed for ${label}:`, error);
    if (options.announceFailure) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(getCommandCopy().failedToRefresh(label, message));
    }
    return false;
  }
}

function formatDisabledQuotaSkip(label: string): string {
  const lang = getLanguage();
  if (lang === "zh") {
    return `已跳过 ${label} 的配额刷新，因为该账号已禁用。`;
  }
  if (lang === "zh-hant") {
    return `已略過 ${label} 的配額重新整理，因為該帳號已停用。`;
  }
  return `Skipped quota refresh for ${label} because the account is disabled.`;
}

export async function maybeWarnForActiveQuota(repo: AccountsRepository): Promise<void> {
  const accounts = (await repo.listAccounts()).map(applyCoordinatedQuotaSnapshot);
  const active = accounts.find((account) => account.isActive);
  if (!active) {
    return;
  }
  await maybeWarnForAccount(repo, active.id);
}

export async function maybeAutoSwitchForActiveQuota(
  repo: AccountsRepository,
  view: RefreshView,
  options: {
    ignoreEnabled?: boolean;
    userInitiated?: boolean;
    canUseAccount?: (accountId: string) => boolean;
  } = {}
): Promise<boolean> {
  if (autoSwitchInFlight) {
    return autoSwitchInFlight;
  }

  // Rescue override is a local, passphrase-gated escape hatch for the shared
  // enablement registry. While it is active, automatic switching must be
  // allowed to consider accounts claimed by another PC as well.
  const task = runCrossWindowExclusive(
    `automation:account-switch:${getCodexHomeStateKey()}`,
    "Automatic account selection",
    async () => {
      repo.invalidateCachedIndex?.();
      return evaluateAutoSwitchForActiveQuota(repo, view, options);
    }
  );
  autoSwitchInFlight = task;
  try {
    return await task;
  } catch (error) {
    if (error instanceof CrossWindowOperationBusyError && !options.userInitiated) return false;
    showAutoSwitchFailure(error);
    return false;
  } finally {
    if (autoSwitchInFlight === task) {
      autoSwitchInFlight = undefined;
    }
  }
}

async function evaluateAutoSwitchForActiveQuota(
  repo: AccountsRepository,
  view: RefreshView,
  options: {
    ignoreEnabled?: boolean;
    userInitiated?: boolean;
    canUseAccount?: (accountId: string) => boolean;
  },
  refreshedStaleCandidates = false,
  failedCandidateVerification = false,
  refreshedActive = false
): Promise<boolean> {
  const config = getCodexManagerConfiguration();
  if (!options.ignoreEnabled && !config.get<boolean>(AUTO_SWITCH_ENABLED, false)) {
    lastBlockedAutoSwitchKey = undefined;
    return false;
  }

  // Keep the runtime fallback aligned with the manifest and settings store.
  // Missing configuration must not silently use the old 20% emergency value,
  // otherwise auto-switch can fire well before the configured 5% default.
  const policy = getAccountAutoQueuePolicy();
  const hourlyThreshold = policy.hourlyThreshold;
  const weeklyThreshold = policy.weeklyThreshold;
  const hourlyQuotaControlEnabled = true;
  const accounts = (await repo.listAccounts()).map(applyCoordinatedQuotaSnapshot);
  const active = accounts.find((account) => account.isActive);
  if (
    active &&
    !refreshedActive &&
    (options.ignoreEnabled || active.enabled !== false) &&
    (!hasFreshQuotaSnapshot(active) || active.quotaError || !active.quotaSummary)
  ) {
    const verified = await refreshSingleQuotaSafely(repo, view, active.id, {
      forceRefresh: true,
      skipDisabled: !options.ignoreEnabled,
      canUseAccount: options.canUseAccount
    });
    if (verified)
      return evaluateAutoSwitchForActiveQuota(
        repo,
        view,
        options,
        refreshedStaleCandidates,
        failedCandidateVerification,
        true
      );
  }
  if (
    !active?.quotaSummary ||
    active.quotaError ||
    (!options.ignoreEnabled && active.enabled === false) ||
    !hasFreshQuotaSnapshot(active)
  ) {
    if (options.userInitiated) {
      void vscode.window.showWarningMessage("Auto Select unavailable — refresh the active account and retry.");
    }
    return false;
  }
  if (isAutoSwitchLocked(active.id)) {
    if (options.userInitiated) {
      void vscode.window.showInformationMessage("Auto Select skipped — active account is locked.");
    }
    return false;
  }

  const activeHourlyTriggered =
    hourlyQuotaControlEnabled &&
    hasComparableHourlyWindow(active) &&
    active.quotaSummary.hourlyPercentage <= hourlyThreshold;
  const activeWeeklyTriggered =
    hasComparableWeeklyWindow(active) && active.quotaSummary.weeklyPercentage <= weeklyThreshold;
  const shouldSwitch = activeHourlyTriggered || activeWeeklyTriggered;
  if (!shouldSwitch) {
    lastBlockedAutoSwitchKey = undefined;
    if (options.userInitiated) {
      void vscode.window.showInformationMessage("No switch needed — active account has enough quota.");
    }
    return false;
  }

  const candidates = accounts
    .filter(
      (account) =>
        !account.isActive &&
        (options.canUseAccount?.(account.id) ?? true) &&
        (options.ignoreEnabled || account.enabled !== false) &&
        !!account.quotaSummary &&
        !account.quotaError &&
        isAutoQueueCandidateEligible(
          { ...toAutoQueueOrderValue(account), disabled: options.ignoreEnabled ? false : account.enabled === false },
          getAccountAutoQueuePolicy()
        )
    )
    .sort(createAutoSwitchComparator());

  const next = candidates[0];
  if (!next) {
    // The dashboard can show usable quota from the last snapshot while Auto
    // Select correctly refuses to switch on a stale or pre-session snapshot.
    // Refresh those otherwise eligible accounts once before reporting that no
    // capable account exists. A failed refresh remains inconclusive.
    const unverifiedCandidates = accounts.filter(
      (account) =>
        !account.isActive &&
        (options.canUseAccount?.(account.id) ?? true) &&
        (options.ignoreEnabled || account.enabled !== false) &&
        (!account.quotaSummary || account.quotaError || !hasFreshQuotaSnapshot(account))
    );
    if (unverifiedCandidates.length && !refreshedStaleCandidates) {
      let verificationFailed = false;
      for (const candidate of unverifiedCandidates) {
        const refreshed = await refreshSingleQuotaSafely(repo, view, candidate.id, {
          forceRefresh: true,
          skipDisabled: !options.ignoreEnabled,
          canUseAccount: options.canUseAccount
        });
        if (!refreshed) verificationFailed = true;
      }
      view.refresh();
      return evaluateAutoSwitchForActiveQuota(repo, view, options, true, verificationFailed, true);
    }

    if (getAccountAutoQueuePolicy().autoResetEnabled) {
      const resetThreshold = getAccountAutoQueuePolicy().resetWeeklyThreshold;
      if (
        usableAutoQueueResetCount(toAutoQueueOrderValue(active), getAccountAutoQueuePolicy()) > 0 &&
        hasComparableWeeklyWindow(active) &&
        active.quotaSummary.weeklyPercentage <= resetThreshold
      ) {
        try {
          const resetResult = await executeActiveResetPlan(
            repo,
            view,
            active,
            hourlyThreshold,
            weeklyThreshold,
            resetThreshold,
            options.canUseAccount
          );
          if (!resetResult && options.userInitiated) {
            void vscode.window.showWarningMessage(
              "Auto Select cancelled — account state changed. Refresh and try again."
            );
          }
          return resetResult;
        } catch (error) {
          const fallback = findResetFailureFallback(
            (await repo.listAccounts()).filter((account) => options.canUseAccount?.(account.id) ?? true),
            active.id,
            options.ignoreEnabled === true,
            hourlyQuotaControlEnabled,
            hourlyThreshold,
            weeklyThreshold
          );
          if (!fallback) {
            throw error;
          }
          const fallbackResult = await executeResetFailureFallbackSwitch(
            repo,
            view,
            config,
            active,
            fallback,
            active,
            error,
            hourlyThreshold,
            weeklyThreshold,
            options.canUseAccount
          );
          if (!fallbackResult && options.userInitiated) {
            void vscode.window.showWarningMessage(
              "Auto Select cancelled — account state changed. Refresh and try again."
            );
          }
          return fallbackResult;
        }
      }
      const resetCandidate = accounts
        .filter(
          (account) =>
            !account.isActive &&
            (options.canUseAccount?.(account.id) ?? true) &&
            (options.ignoreEnabled || account.enabled !== false) &&
            !account.quotaError &&
            hasFreshQuotaSnapshot(account) &&
            usableAutoQueueResetCount(toAutoQueueOrderValue(account), getAccountAutoQueuePolicy()) > 0 &&
            hasComparableWeeklyWindow(account) &&
            account.quotaSummary!.weeklyPercentage <= resetThreshold
        )
        .sort(createAutoSwitchComparator())[0];
      if (resetCandidate) {
        try {
          const resetResult = await executeResetPlan(
            repo,
            view,
            config,
            active,
            resetCandidate,
            hourlyThreshold,
            weeklyThreshold,
            resetThreshold,
            options.canUseAccount
          );
          if (!resetResult && options.userInitiated) {
            void vscode.window.showWarningMessage(
              "Auto Select cancelled — account state changed. Refresh and try again."
            );
          }
          return resetResult;
        } catch (error) {
          const fallback = findResetFailureFallback(
            (await repo.listAccounts()).filter((account) => options.canUseAccount?.(account.id) ?? true),
            active.id,
            options.ignoreEnabled === true,
            hourlyQuotaControlEnabled,
            hourlyThreshold,
            weeklyThreshold
          );
          if (!fallback) {
            throw error;
          }
          const fallbackResult = await executeResetFailureFallbackSwitch(
            repo,
            view,
            config,
            active,
            fallback,
            resetCandidate,
            error,
            hourlyThreshold,
            weeklyThreshold,
            options.canUseAccount
          );
          if (!fallbackResult && options.userInitiated) {
            void vscode.window.showWarningMessage(
              "Auto Select cancelled — account state changed. Refresh and try again."
            );
          }
          return fallbackResult;
        }
      }
    }
    console.info("[codexManager] auto switch threshold reached, but no safe candidate is available", {
      activeHourlyTriggered,
      activeWeeklyTriggered,
      hourlyRemaining: active.quotaSummary.hourlyPercentage,
      weeklyRemaining: active.quotaSummary.weeklyPercentage,
      candidateCount: accounts.length - 1
    });
    const blockedKey = [
      active.id,
      activeHourlyTriggered ? `hourly:${active.quotaSummary.hourlyPercentage}` : "",
      activeWeeklyTriggered ? `weekly:${active.quotaSummary.weeklyPercentage}` : "",
      `candidates:${accounts.length - 1}`,
      unverifiedCandidates.length || failedCandidateVerification ? "unverified" : "unavailable"
    ].join("|");
    if (options.userInitiated || blockedKey !== lastBlockedAutoSwitchKey) {
      lastBlockedAutoSwitchKey = blockedKey;
      const message =
        unverifiedCandidates.length || failedCandidateVerification
          ? "Auto Select could not verify quota for an available account. Refresh its quota and retry."
          : "No account to switch — no capable account has enough quota remaining.";
      // Persist the terminal outcome so a browser dashboard that reconnects
      // after the native toast still receives the same warning (and can emit
      // its OS push notification).
      recordAutoSwitchDashboardNotice(message, "warning");
      void vscode.window.showWarningMessage(message);
    }
    return false;
  }

  lastBlockedAutoSwitchKey = undefined;
  const matchedRules = buildMatchedRules();
  // Revalidate the active identity immediately before mutating auth state. A
  // manual/dashboard switch may have won a race while candidate selection was
  // running; never switch based on that stale list snapshot.
  const latestAccounts = (await repo.listAccounts()).map(applyCoordinatedQuotaSnapshot);
  const latestActive = latestAccounts.find((account) => account.isActive);
  const latestNext = latestAccounts.find((account) => account.id === next.id);
  const latestPolicy = getAccountAutoQueuePolicy();
  if (
    !latestActive ||
    latestActive.id !== active.id ||
    !isAutoSelectionStillNeeded(latestActive, options.ignoreEnabled === true) ||
    !latestNext ||
    latestNext.isActive ||
    !(options.canUseAccount?.(latestNext.id) ?? true) ||
    (!options.ignoreEnabled && latestNext.enabled === false) ||
    latestNext.quotaError ||
    latestNext.resetCreditAttempt ||
    !latestNext.quotaSummary ||
    !hasFreshQuotaSnapshot(latestNext) ||
    !isAutoQueueCandidateEligible(
      { ...toAutoQueueOrderValue(latestNext), disabled: options.ignoreEnabled ? false : latestNext.enabled === false },
      latestPolicy
    )
  ) {
    if (options.userInitiated) {
      void vscode.window.showWarningMessage("Auto Select cancelled — account state changed. Refresh and try again.");
    }
    return false;
  }
  await repo.switchAccount(latestNext.id);
  console.info("[codexManager] auto switch completed", {
    trigger:
      activeHourlyTriggered && activeWeeklyTriggered
        ? "hourly_and_weekly"
        : activeHourlyTriggered
          ? "hourly"
          : "weekly",
    reloadEnabled: config.get<boolean>(AUTO_SWITCH_RELOAD_WINDOW_ENABLED, false)
  });
  clearAutoSwitchLock(active.id);
  recordAutoSwitchReason({
    fromAccountId: active.id,
    fromEmail: active.email,
    toAccountId: latestNext.id,
    toEmail: latestNext.email,
    trigger:
      activeHourlyTriggered && activeWeeklyTriggered
        ? "hourly_and_weekly"
        : activeHourlyTriggered
          ? "hourly"
          : "weekly",
    matchedRules,
    hourlyThreshold,
    weeklyThreshold,
    createdAt: Date.now()
  });
  view.markObservedAuthIdentity?.(latestNext.id);
  view.refresh();

  const decisionReason = getCodexManagerAccountAutoQueueEfficiency(latestNext, autoQueueScoringOptions()).reason;
  const switchMessage = buildAutoSwitchSuccessMessage(latestNext, false, decisionReason);

  if (!needsWindowReloadForAccount(latestNext.id)) {
    recordAutoSwitchDashboardNotice(switchMessage, "info", {
      accountId: latestNext.id,
      switchResult: "switched"
    });
    void vscode.window.showInformationMessage(switchMessage);
    return true;
  }

  if (config.get<boolean>(AUTO_SWITCH_RELOAD_WINDOW_ENABLED, false)) {
    await handleCodexAppRestartPreference({ allowManualPrompt: false });
    queueAutoSwitchNotice(buildAutoSwitchSuccessMessage(latestNext, true), latestNext.id);
    try {
      const reloaded = await autoReloadWindowForAccount(latestNext.id);
      if (!reloaded) {
        consumeAutoSwitchNotice();
        const skippedMessage = `Switched to ${latestNext.email}; reload not needed.`;
        recordAutoSwitchDashboardNotice(skippedMessage, "warning", { accountId: latestNext.id });
        void vscode.window.showWarningMessage(skippedMessage);
      }
    } catch (error) {
      consumeAutoSwitchNotice();
      throw error;
    }
    return true;
  }

  await promptWindowReloadForAccount(latestNext, {
    message: `${switchMessage} Reload VS Code?`
  });
  return true;
}

async function refreshAllBeforeWarningIfNeeded(
  repo: AccountsRepository,
  view: RefreshView,
  account: CodexManagerAccountRecord,
  bypassGap: boolean,
  canUseAccount?: (accountId: string) => boolean
): Promise<void> {
  if (!account.isActive || !account.quotaSummary || account.enabled === false) {
    return;
  }
  const config = getCodexManagerConfiguration();
  if (!config.get<boolean>(QUOTA_WARNING_ENABLED, false)) {
    return;
  }
  const warningThresholds = getQuotaWarningThresholds(config);
  const hourlyEnabled = true;
  const warningThresholdReached =
    (hourlyEnabled &&
      hasComparableHourlyWindow(account) &&
      account.quotaSummary.hourlyPercentage <= warningThresholds.hourly) ||
    (hasComparableWeeklyWindow(account) && account.quotaSummary.weeklyPercentage <= warningThresholds.weekly);
  if (warningThresholdReached) {
    await refreshAllBeforeAutoSwitchIfDue(repo, view, config, bypassGap, canUseAccount);
  }
}

/**
 * Refresh all enabled non-current accounts before a warning notification when
 * the safety toggle is enabled. The regular all-account refresh interval is
 * also the minimum gap between these safety sweeps; the current-account
 * scheduler remains independent.
 */
async function refreshAllBeforeAutoSwitchIfDue(
  repo: AccountsRepository,
  view: RefreshView,
  config: vscode.WorkspaceConfiguration,
  bypassGap = false,
  canUseAccount?: (accountId: string) => boolean
): Promise<boolean> {
  if (!config.get<boolean>("autoSwitchRefreshAllBeforeSwitchEnabled", false)) {
    return true;
  }
  const intervalMinutes = getAutoRefreshMinutes();
  const now = Date.now();
  const minGapMs = intervalMinutes * 60_000;
  if (!bypassGap && intervalMinutes > 0 && now - lastAutoSwitchSafetyRefreshAt < minGapMs) {
    return true;
  }
  if (autoSwitchSafetyRefreshInFlight) {
    return autoSwitchSafetyRefreshInFlight;
  }

  lastAutoSwitchSafetyRefreshAt = now;
  let allRefreshed = true;
  const task = (async (): Promise<boolean> => {
    const accounts = (await repo.listAccounts()).filter(
      (account) => account.enabled !== false && !account.isActive && (canUseAccount?.(account.id) ?? true)
    );
    for (const account of accounts) {
      if (
        !bypassGap &&
        (wasAccountQuotaCheckedWithin(account, minGapMs) ||
          wasQuotaCheckedWithin(account.id, minGapMs) ||
          (typeof account.lastQuotaAt === "number" && Date.now() - account.lastQuotaAt < minGapMs))
      ) {
        continue;
      }
      const refreshed = await refreshSingleQuotaSafely(repo, view, account.id, {
        allowTokenRefresh: true,
        forceRefresh: true,
        announceFailure: false,
        skipDisabled: true,
        canUseAccount
      });
      if (!refreshed) allRefreshed = false;
    }
    return allRefreshed;
  })();
  autoSwitchSafetyRefreshInFlight = task;
  try {
    return await task;
  } finally {
    if (autoSwitchSafetyRefreshInFlight === task) {
      autoSwitchSafetyRefreshInFlight = undefined;
    }
  }
}

async function executeActiveResetPlan(
  repo: AccountsRepository,
  view: RefreshView,
  active: CodexManagerAccountRecord,
  hourlyThreshold: number,
  weeklyThreshold: number,
  resetThreshold: number,
  canUseAccount?: (accountId: string) => boolean
): Promise<boolean> {
  if (!(await isExpectedActiveAccount(repo, active.id))) {
    return false;
  }
  const redeemed = await redeemAccountResetCredit(
    repo,
    active.id,
    (account) => account.isActive && (canUseAccount?.(account.id) ?? true) && isAutomaticResetAllowed(account),
    () => refreshResetQuota(repo, view, active.id)
  );
  if (!redeemed) return false;
  if (!(await isExpectedActiveAccount(repo, active.id))) {
    return false;
  }
  clearAutoSwitchLock(active.id);
  recordAutoSwitchReason({
    fromAccountId: active.id,
    fromEmail: active.email,
    toAccountId: active.id,
    toEmail: active.email,
    trigger: "reset",
    matchedRules: ["quota", "reset_plan", "active_account"],
    hourlyThreshold,
    weeklyThreshold,
    createdAt: Date.now()
  });
  view.refresh();
  const message = `Reset quota for ${active.email}; staying on the current account (weekly threshold ${resetThreshold}%).`;
  recordAutoSwitchDashboardNotice(message, "info", { accountId: active.id });
  // Resetting the current account changes the quota consumed by the running
  // Codex session even though credentials did not change; reload to ensure the
  // host observes the new quota immediately.
  void vscode.window.showInformationMessage(message);
  if (getCodexManagerConfiguration().get<boolean>(AUTO_SWITCH_RELOAD_WINDOW_ENABLED, false)) {
    await handleCodexAppRestartPreference({ allowManualPrompt: false });
    await reloadWindowNow();
  }
  return true;
}

async function executeResetPlan(
  repo: AccountsRepository,
  view: RefreshView,
  config: vscode.WorkspaceConfiguration,
  active: CodexManagerAccountRecord,
  next: CodexManagerAccountRecord,
  hourlyThreshold: number,
  weeklyThreshold: number,
  resetThreshold: number,
  canUseAccount?: (accountId: string) => boolean
): Promise<boolean> {
  if (!(await isExpectedActiveAccount(repo, active.id))) {
    return false;
  }
  const redeemed = await redeemAccountResetCredit(
    repo,
    next.id,
    async (account) =>
      !account.isActive &&
      (canUseAccount?.(account.id) ?? true) &&
      isAutomaticResetAllowed(account) &&
      isAutoSelectionStillNeeded((await repo.getAccount(active.id)) ?? active),
    () => refreshResetQuota(repo, view, next.id)
  );
  if (!redeemed) return false;
  if (!(await isExpectedActiveAccount(repo, active.id))) {
    return false;
  }
  const latestActive = await repo.getAccount(active.id);
  const latestNext = await repo.getAccount(next.id);
  if (
    !latestActive ||
    !isAutoSelectionStillNeeded(latestActive) ||
    !latestNext ||
    !(canUseAccount?.(next.id) ?? true) ||
    !isAutoQueueCandidateEligible(toAutoQueueOrderValue(latestNext), getAccountAutoQueuePolicy())
  )
    return false;
  await repo.switchAccount(next.id);
  clearAutoSwitchLock(active.id);
  recordAutoSwitchReason({
    fromAccountId: active.id,
    fromEmail: active.email,
    toAccountId: next.id,
    toEmail: next.email,
    trigger: "reset",
    matchedRules: ["quota", "reset_plan"],
    hourlyThreshold,
    weeklyThreshold,
    createdAt: Date.now()
  });
  view.markObservedAuthIdentity?.(next.id);
  view.refresh();
  const switchMessage = `Reset quota for ${next.email} and switched to it (weekly threshold ${resetThreshold}%).`;
  if (!needsWindowReloadForAccount(next.id)) {
    recordAutoSwitchDashboardNotice(switchMessage, "info", { accountId: next.id, switchResult: "switched" });
    void vscode.window.showInformationMessage(switchMessage);
    return true;
  }
  if (config.get<boolean>(AUTO_SWITCH_RELOAD_WINDOW_ENABLED, false)) {
    await handleCodexAppRestartPreference({ allowManualPrompt: false });
    queueAutoSwitchNotice(switchMessage, next.id);
    try {
      const reloaded = await autoReloadWindowForAccount(next.id);
      if (!reloaded) {
        consumeAutoSwitchNotice();
        const skippedMessage = `Reset quota and switched to ${next.email}; reload not needed.`;
        recordAutoSwitchDashboardNotice(skippedMessage, "warning", { accountId: next.id });
        void vscode.window.showWarningMessage(skippedMessage);
      }
    } catch (error) {
      consumeAutoSwitchNotice();
      throw error;
    }
    return true;
  }
  await promptWindowReloadForAccount(next, { message: `${switchMessage} Reload VS Code?` });
  return true;
}

function findResetFailureFallback(
  accounts: CodexManagerAccountRecord[],
  activeAccountId: string,
  ignoreEnabled: boolean,
  hourlyEnabled: boolean,
  hourlyThreshold: number,
  weeklyThreshold: number
): CodexManagerAccountRecord | undefined {
  return accounts
    .filter(
      (account) =>
        !account.isActive &&
        account.id !== activeAccountId &&
        (ignoreEnabled || account.enabled !== false) &&
        !!account.quotaSummary &&
        !account.quotaError &&
        isAutoQueueCandidateEligible(
          { ...toAutoQueueOrderValue(account), disabled: ignoreEnabled ? false : account.enabled === false },
          {
            ...getAccountAutoQueuePolicy(),
            hourlyEnabled,
            hourlyThreshold,
            weeklyThreshold
          }
        )
    )
    .sort(createAutoSwitchComparator())[0];
}

async function executeResetFailureFallbackSwitch(
  repo: AccountsRepository,
  view: RefreshView,
  config: vscode.WorkspaceConfiguration,
  active: CodexManagerAccountRecord,
  next: CodexManagerAccountRecord,
  resetAccount: CodexManagerAccountRecord,
  resetError: unknown,
  hourlyThreshold: number,
  weeklyThreshold: number,
  canUseAccount?: (accountId: string) => boolean
): Promise<boolean> {
  if (!(await isExpectedActiveAccount(repo, active.id))) {
    return false;
  }
  const latestActive = await repo.getAccount(active.id);
  const latestNext = await repo.getAccount(next.id);
  if (
    !latestActive ||
    !isAutoSelectionStillNeeded(latestActive) ||
    !latestNext ||
    !(canUseAccount?.(next.id) ?? true) ||
    !isAutoQueueCandidateEligible(toAutoQueueOrderValue(latestNext), getAccountAutoQueuePolicy())
  )
    return false;
  const detail = resetError instanceof Error ? resetError.message : String(resetError);
  await repo.switchAccount(next.id);
  lastBlockedAutoSwitchKey = undefined;
  clearAutoSwitchLock(active.id);
  recordAutoSwitchReason({
    fromAccountId: active.id,
    fromEmail: active.email,
    toAccountId: next.id,
    toEmail: next.email,
    trigger: "reset",
    matchedRules: ["quota", "reset_plan", "reset_failed_fallback"],
    hourlyThreshold,
    weeklyThreshold,
    createdAt: Date.now()
  });
  view.markObservedAuthIdentity?.(next.id);
  view.refresh();

  const switchMessage = `Automatic reset failed for ${resetAccount.email} (${detail}); switched to ${next.email}.`;
  // The reset failure is actionable context and must remain visible even when
  // the account switch also requires a window reload or prompt.
  recordAutoSwitchDashboardNotice(switchMessage, "warning", { accountId: next.id, switchResult: "switched" });
  void vscode.window.showWarningMessage(switchMessage);
  if (!needsWindowReloadForAccount(next.id)) {
    return true;
  }

  if (config.get<boolean>(AUTO_SWITCH_RELOAD_WINDOW_ENABLED, false)) {
    await handleCodexAppRestartPreference({ allowManualPrompt: false });
    try {
      const reloaded = await autoReloadWindowForAccount(next.id);
      if (!reloaded) {
        consumeAutoSwitchNotice();
        const skippedMessage = `${switchMessage} Reload not needed.`;
        recordAutoSwitchDashboardNotice(skippedMessage, "warning", { accountId: next.id });
        void vscode.window.showWarningMessage(skippedMessage);
      }
    } catch (error) {
      consumeAutoSwitchNotice();
      throw error;
    }
    return true;
  }

  await promptWindowReloadForAccount(next, { message: `${switchMessage} Reload VS Code?` });
  return true;
}

async function isExpectedActiveAccount(repo: AccountsRepository, accountId: string): Promise<boolean> {
  const account = await repo.getAccount(accountId);
  return account?.isActive === true;
}

export async function maybeWarnForAccount(
  repo: AccountsRepository,
  accountId: string,
  canUseAccount?: (accountId: string) => boolean
): Promise<void> {
  const config = getCodexManagerConfiguration();
  if (!config.get<boolean>(QUOTA_WARNING_ENABLED, false)) {
    quotaWarningCounts.clear();
    return;
  }

  const warningThresholds = getQuotaWarningThresholds(config);
  const hourlyQuotaControlEnabled = true;
  let account = applyOptionalCoordinatedQuotaSnapshot(await repo.getAccount(accountId));
  if (!account) {
    clearQuotaWarningCountsForAccount(accountId);
    return;
  }
  if (
    !account?.isActive ||
    !account.quotaSummary ||
    account.quotaError ||
    account.enabled === false ||
    !hasFreshQuotaSnapshot(account)
  ) {
    clearQuotaWarningCountsForAccount(accountId);
    return;
  }

  const copy = getQuotaWarningCopy();
  const warningThresholdReached =
    (hourlyQuotaControlEnabled &&
      hasComparableHourlyWindow(account) &&
      account.quotaSummary.hourlyPercentage <= warningThresholds.hourly) ||
    (hasComparableWeeklyWindow(account) && account.quotaSummary.weeklyPercentage <= warningThresholds.weekly);
  if (warningThresholdReached) {
    // Refresh non-current accounts only after the warning limit is reached, so
    // the notification's recommended switch target is based on fresh data.
    // The helper is throttled by autoRefreshMinutes to prevent refresh storms.
    const safetyReady = await refreshAllBeforeAutoSwitchIfDue(repo, { refresh: () => undefined }, config);
    if (!safetyReady) {
      return;
    }
    account = applyOptionalCoordinatedQuotaSnapshot(await repo.getAccount(accountId));
    if (
      !account?.quotaSummary ||
      account.quotaError ||
      account.enabled === false ||
      !account.isActive ||
      !hasFreshQuotaSnapshot(account)
    ) {
      clearQuotaWarningCountsForAccount(accountId);
      return;
    }
  }

  const accounts = (await repo.listAccounts()).map(applyCoordinatedQuotaSnapshot);
  // A switch can complete while the safety refresh/list operation is in flight.
  // Re-read the target before constructing the warning to avoid using stale
  // state from the previous active session.
  account = applyOptionalCoordinatedQuotaSnapshot(await repo.getAccount(accountId));
  if (
    !account?.isActive ||
    !account.quotaSummary ||
    account.quotaError ||
    account.enabled === false ||
    !hasFreshQuotaSnapshot(account)
  ) {
    clearQuotaWarningCountsForAccount(accountId);
    return;
  }

  const checks: Array<{
    dimension: "hourly" | "weekly";
    label: string;
    value: number;
    threshold: number;
  }> = [];
  const weeklyLabel = hasComparableWeeklyWindow(account)
    ? resolveLongQuotaLabel(account.planType, account.quotaSummary.weeklyWindowMinutes, getLanguage(), copy.weeklyLabel)
    : undefined;
  if (hourlyQuotaControlEnabled && hasComparableHourlyWindow(account)) {
    checks.push({
      dimension: "hourly",
      label: copy.hourlyLabel,
      value: account.quotaSummary.hourlyPercentage,
      threshold: warningThresholds.hourly
    });
  } else {
    clearQuotaWarningCount(account.id, "hourly");
  }
  if (weeklyLabel) {
    checks.push({
      dimension: "weekly",
      label: weeklyLabel,
      value: account.quotaSummary.weeklyPercentage,
      threshold: warningThresholds.weekly
    });
  } else {
    clearQuotaWarningCount(account.id, "weekly");
  }

  for (const check of checks) {
    const warnKey = `${account.id}:${check.dimension}:${check.threshold}`;
    if (typeof check.value !== "number" || check.value > check.threshold) {
      quotaWarningCounts.delete(warnKey);
      continue;
    }

    const warningCount = quotaWarningCounts.get(warnKey) ?? 0;
    if (warningCount >= MAX_WARNINGS_PER_CYCLE) {
      continue;
    }

    quotaWarningCounts.set(warnKey, warningCount + 1);
    const accountLabel = account.email;
    const switchTarget = selectQuotaWarningSwitchTarget(
      accounts.filter((candidate) => canUseAccount?.(candidate.id) ?? true),
      account,
      check.dimension,
      check.threshold
    );
    // Native notification actions have very limited horizontal space. The
    // destination email is unambiguous here; omit workspace/plan prefixes.
    const switchAccount = switchTarget ? copy.switchAccount(switchTarget.email) : undefined;
    const resetAccount = copy.resetAccount(accountLabel);
    const resetAvailable = (account.quotaSummary.resetCreditsAvailable ?? 0) > 0;
    const actions = [
      ...(switchAccount ? [switchAccount] : []),
      ...(resetAvailable ? [resetAccount] : []),
      copy.selectAccount,
      copy.later
    ];
    const warningMessage =
      copy.message(accountLabel, check.label, check.value, check.threshold) +
      (check.dimension !== "weekly" && weeklyLabel
        ? ` ${copy.balanceSummary(weeklyLabel, account.quotaSummary.weeklyPercentage)}`
        : "");
    if (
      shouldSuppressDashboardNotifications() &&
      recordDashboardActionPrompt({
        kind: "quotaWarning",
        accountId: account.id,
        message: warningMessage,
        switchAccountId: switchTarget?.id,
        switchLabel: switchAccount,
        resetLabel: resetAvailable ? resetAccount : undefined,
        selectLabel: copy.selectAccount,
        laterLabel: copy.later
      })
    ) {
      continue;
    }
    void vscode.window.showWarningMessage(warningMessage, ...actions).then((selection) => {
      if (switchAccount && switchTarget && selection === switchAccount) {
        void vscode.commands.executeCommand("codexManager.switchAccount", switchTarget);
      } else if (selection === resetAccount) {
        void vscode.commands.executeCommand("codexManager.consumeResetCredit", account);
      } else if (selection === copy.selectAccount) {
        void vscode.commands.executeCommand("codexManager.switchAccount");
      }
    });
  }
}

function hasFreshQuotaSnapshot(account: CodexManagerAccountRecord, now = Date.now()): boolean {
  return isAutoQueueSnapshotFresh(toAutoQueueOrderValue(account), getAccountAutoQueuePolicy(now));
}

function applyOptionalCoordinatedQuotaSnapshot(
  account: CodexManagerAccountRecord | undefined
): CodexManagerAccountRecord | undefined {
  return account ? applyCoordinatedQuotaSnapshot(account) : undefined;
}

function applyCoordinatedQuotaSnapshot(account: CodexManagerAccountRecord): CodexManagerAccountRecord {
  const snapshot = getCoordinatedQuotaSnapshot(account);
  if (!snapshot || !account.quotaSummary) return account;
  // Timestamp-only or partial peer messages may suppress duplicate fetches,
  // but cannot refresh the age of a missing local quota dimension.
  if (
    account.quotaError ||
    (hasComparableHourlyWindow(account) && snapshot.hourlyPercentage === undefined) ||
    (hasComparableWeeklyWindow(account) && snapshot.weeklyPercentage === undefined)
  )
    return account;
  return {
    ...account,
    lastQuotaAt: snapshot.checkedAt,
    quotaSummary: {
      ...account.quotaSummary,
      hourlyPercentage: snapshot.hourlyPercentage ?? account.quotaSummary.hourlyPercentage,
      hourlyResetTime: snapshot.hourlyResetTime ?? account.quotaSummary.hourlyResetTime,
      weeklyPercentage: snapshot.weeklyPercentage ?? account.quotaSummary.weeklyPercentage,
      weeklyResetTime: snapshot.weeklyResetTime ?? account.quotaSummary.weeklyResetTime,
      // Reset IDs/exclusions are local verified metadata. A peer count alone
      // must not resurrect a rejected credit or carry another count's expiry.
      resetCreditsAvailable: hasFreshQuotaSnapshot(account) ? account.quotaSummary.resetCreditsAvailable : undefined,
      resetCreditsNextExpiresAt: hasFreshQuotaSnapshot(account)
        ? account.quotaSummary.resetCreditsNextExpiresAt
        : undefined
    }
  };
}

export function selectQuotaWarningSwitchTarget(
  accounts: CodexManagerAccountRecord[],
  active: CodexManagerAccountRecord,
  dimension: "hourly" | "weekly",
  threshold: number
): CodexManagerAccountRecord | undefined {
  return accounts
    .filter((candidate) => {
      if (candidate.id === active.id || candidate.isActive || candidate.enabled === false) return false;
      if (!candidate.quotaSummary || candidate.quotaError) return false;
      if (!isAutoQueueCandidateEligible(toAutoQueueOrderValue(candidate), getAccountAutoQueuePolicy())) return false;
      if (dimension === "hourly") {
        return !hasComparableHourlyWindow(candidate) || candidate.quotaSummary.hourlyPercentage > threshold;
      }
      return !hasComparableWeeklyWindow(candidate) || candidate.quotaSummary.weeklyPercentage > threshold;
    })
    .sort(createAutoSwitchComparator())[0];
}

function clearQuotaWarningCount(accountId: string, dimension: "hourly" | "weekly"): void {
  const prefix = `${accountId}:${dimension}:`;
  for (const key of quotaWarningCounts.keys()) {
    if (key.startsWith(prefix)) {
      quotaWarningCounts.delete(key);
    }
  }
}

function clearQuotaWarningCountsForAccount(accountId: string): void {
  const prefix = `${accountId}:`;
  for (const key of quotaWarningCounts.keys()) {
    if (key.startsWith(prefix)) {
      quotaWarningCounts.delete(key);
    }
  }
}

export function formatAccountToastLabel(account: CodexManagerAccountRecord): string {
  const team = account.accountName?.trim();
  if (team) {
    return `${team} · ${account.email}`;
  }
  return account.email;
}

function createAutoSwitchComparator() {
  const policy = getAccountAutoQueuePolicy();
  return (left: CodexManagerAccountRecord, right: CodexManagerAccountRecord) =>
    compareCodexManagerAccountAutoQueueOrder(left, right, policy);
}

function autoQueueScoringOptions() {
  return getAccountAutoQueuePolicy();
}

function isAutomaticResetAllowed(account: CodexManagerAccountRecord): boolean {
  const policy = getAccountAutoQueuePolicy();
  return (
    policy.autoResetEnabled &&
    account.enabled !== false &&
    !account.quotaError &&
    hasFreshQuotaSnapshot(account) &&
    hasComparableWeeklyWindow(account) &&
    account.quotaSummary!.weeklyPercentage <= policy.resetWeeklyThreshold
  );
}

async function refreshResetQuota(
  repo: AccountsRepository,
  view: RefreshView,
  accountId: string
): Promise<QuotaRefreshResult> {
  const result = await refreshSingleQuota(repo, view, accountId, {
    announce: false,
    warnQuota: false,
    forceRefresh: true,
    refreshView: false,
    reconcileResetAttempt: false
  });
  if (result.error || result.skipped)
    throw new Error(result.error?.message ?? "Reset quota could not be verified. Refresh before retrying.");
  const account = await repo.getAccount(accountId);
  if (
    account?.resetCreditAttempt &&
    result.requestStartedAt !== undefined &&
    result.requestStartedAt < account.resetCreditAttempt.attemptedAt
  ) {
    throw new Error("Quota refresh began before the reset. Refresh quota again to verify its outcome.");
  }
  if (
    !account ||
    !isAutoQueueCandidateEligible(
      { ...toAutoQueueOrderValue(account), resetCreditAttempt: false },
      getAccountAutoQueuePolicy()
    )
  ) {
    throw new Error("Reset did not restore enough usable quota. The account was not selected.");
  }
  return result;
}

export { getAccountAutoQueuePolicy } from "./autoQueueOrder";

function isAutoSelectionStillNeeded(active: CodexManagerAccountRecord, ignoreEnabled = false): boolean {
  const policy = getAccountAutoQueuePolicy();
  if (
    !ignoreEnabled &&
    (!getCodexManagerConfiguration().get<boolean>(AUTO_SWITCH_ENABLED, false) || active.enabled === false)
  )
    return false;
  if (!active.quotaSummary || active.quotaError || !hasFreshQuotaSnapshot(active)) return false;
  return (
    (hasComparableHourlyWindow(active) && active.quotaSummary.hourlyPercentage <= policy.hourlyThreshold) ||
    (hasComparableWeeklyWindow(active) && active.quotaSummary.weeklyPercentage <= policy.weeklyThreshold)
  );
}

function buildMatchedRules(): string[] {
  return ["quota"];
}

function buildAutoSwitchSuccessMessage(
  account: CodexManagerAccountRecord,
  reloaded = false,
  reason?: ReturnType<typeof getCodexManagerAccountAutoQueueEfficiency>["reason"]
): string {
  const copy = getDashboardCopy(getLanguage());
  const template = reloaded ? copy.autoSwitchToastSwitchedAndReloaded : copy.autoSwitchToastSwitched;
  const message = template.replace("{account}", account.email);
  if (reloaded || !reason) return message;
  if (reason === "quota-expiring") return `${message} Selected to use quota before its next reset.`;
  if (reason === "long-window-protected") return `${message} Selected while protecting scarce long-window quota.`;
  if (reason === "starred-priority") return `${message} Selected by queue priority.`;
  return `${message} Selected for the best usable quota balance.`;
}

function showAutoSwitchFailure(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  const key = detail.trim().toLowerCase();
  const now = Date.now();
  if (
    lastAutoSwitchFailure?.key === key &&
    now - lastAutoSwitchFailure.shownAt < AUTO_SWITCH_FAILURE_NOTICE_COOLDOWN_MS
  ) {
    return;
  }
  lastAutoSwitchFailure = { key, shownAt: now };
  const message = `Auto switch failed: ${detail}. Check the account and retry.`;
  recordAutoSwitchDashboardNotice(message, "error");
  void vscode.window.showErrorMessage(message);
}
