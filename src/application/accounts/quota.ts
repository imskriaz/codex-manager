import * as vscode from "vscode";
import { createError } from "../../core";
import { CodexManagerAccountRecord, CodexTokens } from "../../core/types";
import {
  getCodexManagerConfiguration,
  getAutoRefreshMinutes,
  getQuotaWarningThresholds,
  isBackgroundTokenRefreshEnabled,
  normalizeAutoSwitchThreshold,
  normalizeAutoResetWeeklyThreshold
} from "../../infrastructure/config/extensionSettings";
import {
  QuotaRefreshResult,
  refreshQuota,
  fetchResetCredits,
  consumeResetCredit
} from "../../services";
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
import { isEncryptedSyncRegistryOverrideEnabled } from "../../services/encryptedSync";
import { getCommandCopy, getLanguage, getQuotaWarningCopy, resolveLongQuotaLabel } from "../../utils";
import { getQuotaIssueKind } from "../../utils/quotaIssue";
import { recordDashboardActionPrompt, shouldSuppressDashboardNotifications } from "../../utils/notificationPolicy";
import { getDashboardCopy } from "../dashboard/copy";
import {
  compareCodexManagerAccountAutoQueueOrder,
  hasCodexManagerAccountAutoQueueCapability,
  hasComparableHourlyWindow,
  hasComparableWeeklyWindow
} from "./autoQueueOrder";
import {
  autoReloadWindowForAccount,
  handleCodexAppRestartPreference,
  promptWindowReloadForAccount,
  reloadWindowNow
} from "./switchEffects";

const AUTO_SWITCH_ENABLED = "autoSwitchEnabled";
const HOURLY_QUOTA_CONTROL_ENABLED = "hourlyQuotaControlEnabled";
const AUTO_SWITCH_RELOAD_WINDOW_ENABLED = "autoSwitchReloadWindowEnabled";
const AUTO_SWITCH_HOURLY_THRESHOLD = "autoSwitchHourlyThreshold";
const AUTO_SWITCH_WEEKLY_THRESHOLD = "autoSwitchWeeklyThreshold";
const AUTO_RESET_ENABLED = "autoResetEnabled";
const AUTO_RESET_WEEKLY_THRESHOLD = "autoResetWeeklyThreshold";
const QUOTA_WARNING_ENABLED = "quotaWarningEnabled";
const MAX_WARNINGS_PER_CYCLE = 3;
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
    const task = runAndFlush(repo, () => refreshSingleQuotaInternal(repo, view, accountId, options)).finally(() => {
      if (silentQuotaRefreshes.get(accountId) === task) silentQuotaRefreshes.delete(accountId);
    });
    silentQuotaRefreshes.set(accountId, task);
    return task;
  }
  return runAndFlush(repo, () => refreshSingleQuotaInternal(repo, view, accountId, options));
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

  const allowTokenRefresh =
    (options.allowTokenRefresh ?? isBackgroundTokenRefreshEnabled()) && account.tokenRefreshEnabled === true;
  let result = await refreshQuota(account, tokens, forceRefresh, {
    allowTokenRefresh
  });
  let effectiveTokens = tokens;
  if (!allowTokenRefresh && account.isActive && getQuotaIssueKind(result.error) === "auth") {
    const retry = await retryQuotaFromTrackedAuthFile(repo, accountId, account, tokens, result);
    result = retry.result;
    effectiveTokens = retry.tokens;
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
  if (!result.error && updatedAccount.quotaSummary) {
    const credTokens = result.updatedTokens ?? effectiveTokens;
    const credAccountId = updatedAccount.accountId ?? account.accountId ?? undefined;
    await syncResetCreditsSnapshot(repo, view, accountId, updatedAccount, credTokens.accessToken, credAccountId);
  }
  if (!result.error) {
    clearTokenAutomationError(accountId);
  }
  if (shouldRefreshView) {
    view.refresh();
  }
  if (warnQuota && account.isActive) {
    await refreshAllBeforeWarningIfNeeded(repo, view, updatedAccount, announce);
    await maybeAutoSwitchForActiveQuota(repo, view);
  }
  if (warnQuota) {
    // Keep the warning check independent from auto-switch. If auto-switch
    // succeeds the new active account normally has enough quota, while a
    // locked/failed/disabled switch still surfaces the warning choices.
    await maybeWarnForAccount(repo, accountId);
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
    allowTokenRefresh: isBackgroundTokenRefreshEnabled() && account.tokenRefreshEnabled === true
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
): Promise<void> {
  try {
    const snapshot = await fetchResetCredits(accessToken, remoteAccountId);
    if (updatedAccount.quotaSummary) {
      updatedAccount.quotaSummary.resetCreditsAvailable = snapshot.availableCount;
      updatedAccount.quotaSummary.resetCreditsNextExpiresAt = snapshot.nextExpiresAt;
    }
    await repo
      .updateResetCreditsSnapshot(accountId, snapshot.availableCount, snapshot.nextExpiresAt)
      .catch(() => undefined);
    view?.refresh();
  } catch {
    return;
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
  } = {}
): Promise<boolean> {
  try {
    const result = await refreshSingleQuota(repo, view, accountId, {
      announce: false,
      allowTokenRefresh: options.allowTokenRefresh,
      skipDisabled: options.skipDisabled ?? true,
      forceRefresh: options.forceRefresh ?? false,
      refreshView: false,
      warnQuota: false
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
  options: { ignoreEnabled?: boolean; userInitiated?: boolean } = {}
): Promise<boolean> {
  if (autoSwitchInFlight) {
    return autoSwitchInFlight;
  }

  // Rescue override is a local, passphrase-gated escape hatch for the shared
  // enablement registry. While it is active, automatic switching must be
  // allowed to consider accounts claimed by another PC as well.
  const effectiveOptions = {
    ...options,
    ignoreEnabled: options.ignoreEnabled === true || isEncryptedSyncRegistryOverrideEnabled()
  };
  const task = evaluateAutoSwitchForActiveQuota(repo, view, effectiveOptions);
  autoSwitchInFlight = task;
  try {
    return await task;
  } catch (error) {
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
  options: { ignoreEnabled?: boolean; userInitiated?: boolean }
): Promise<boolean> {
  const config = getCodexManagerConfiguration();
  if (!options.ignoreEnabled && !config.get<boolean>(AUTO_SWITCH_ENABLED, false)) {
    lastBlockedAutoSwitchKey = undefined;
    return false;
  }

  const hourlyThreshold = normalizeAutoSwitchThreshold(config.get<number>(AUTO_SWITCH_HOURLY_THRESHOLD, 20));
  const weeklyThreshold = normalizeAutoSwitchThreshold(config.get<number>(AUTO_SWITCH_WEEKLY_THRESHOLD, 20));
  const hourlyQuotaControlEnabled = config.get<boolean>(HOURLY_QUOTA_CONTROL_ENABLED, true);
  const accounts = (await repo.listAccounts()).map(applyCoordinatedQuotaSnapshot);
  const active = accounts.find((account) => account.isActive);
  if (
    !active?.quotaSummary ||
    active.quotaError ||
    (!options.ignoreEnabled && active.enabled === false) ||
    !hasCurrentSessionQuotaSnapshot(active)
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
        (options.ignoreEnabled || account.enabled !== false) &&
        !!account.quotaSummary &&
        !account.quotaError &&
        hasCurrentSessionQuotaSnapshot(account) &&
        hasCodexManagerAccountAutoQueueCapability(account, {
          hourlyEnabled: hourlyQuotaControlEnabled,
          hourlyThreshold,
          weeklyThreshold
        }) &&
        (!activeHourlyTriggered ||
          (hasComparableHourlyWindow(account) && account.quotaSummary.hourlyPercentage > hourlyThreshold)) &&
        (!activeWeeklyTriggered ||
          (hasComparableWeeklyWindow(account) && account.quotaSummary.weeklyPercentage > weeklyThreshold))
    )
    .sort(compareAutoSwitchCandidate);

  const next = candidates[0];
  if (!next) {
    if (config.get<boolean>(AUTO_RESET_ENABLED, false)) {
      const resetThreshold = normalizeAutoResetWeeklyThreshold(
        config.get<number>(AUTO_RESET_WEEKLY_THRESHOLD, 1)
      );
      if (
        (active.quotaSummary?.resetCreditsAvailable ?? 0) > 0 &&
        hasComparableWeeklyWindow(active) &&
        active.quotaSummary.weeklyPercentage <= resetThreshold
      ) {
        try {
          const resetResult = await executeActiveResetPlan(repo, view, active, hourlyThreshold, weeklyThreshold, resetThreshold);
          if (!resetResult && options.userInitiated) {
            void vscode.window.showWarningMessage("Auto Select cancelled — account state changed. Refresh and try again.");
          }
          return resetResult;
        } catch (error) {
          const fallback = findResetFailureFallback(
            accounts,
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
            weeklyThreshold
          );
          if (!fallbackResult && options.userInitiated) {
            void vscode.window.showWarningMessage("Auto Select cancelled — account state changed. Refresh and try again.");
          }
          return fallbackResult;
        }
      }
      const resetCandidate = accounts
        .filter(
          (account) =>
            !account.isActive &&
            (options.ignoreEnabled || account.enabled !== false) &&
            !account.quotaError &&
            hasCurrentSessionQuotaSnapshot(account) &&
            (account.quotaSummary?.resetCreditsAvailable ?? 0) > 0 &&
            hasComparableWeeklyWindow(account) && account.quotaSummary!.weeklyPercentage <= resetThreshold
        )
        .sort(compareAutoSwitchCandidate)[0];
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
            resetThreshold
          );
          if (!resetResult && options.userInitiated) {
            void vscode.window.showWarningMessage("Auto Select cancelled — account state changed. Refresh and try again.");
          }
          return resetResult;
        } catch (error) {
          const fallback = findResetFailureFallback(
            accounts,
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
            weeklyThreshold
          );
          if (!fallbackResult && options.userInitiated) {
            void vscode.window.showWarningMessage("Auto Select cancelled — account state changed. Refresh and try again.");
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
      `candidates:${accounts.length - 1}`
    ].join("|");
    if (options.userInitiated || blockedKey !== lastBlockedAutoSwitchKey) {
      lastBlockedAutoSwitchKey = blockedKey;
      const message = "No account to switch — no capable account has enough quota remaining.";
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
  if (
    !latestActive ||
    latestActive.id !== active.id ||
    !latestNext ||
    latestNext.isActive ||
    (!options.ignoreEnabled && latestNext.enabled === false) ||
    latestNext.quotaError ||
    !latestNext.quotaSummary
  ) {
    if (options.userInitiated) {
      void vscode.window.showWarningMessage("Auto Select cancelled — account state changed. Refresh and try again.");
    }
    return false;
  }
  await repo.switchAccount(next.id);
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
    toAccountId: next.id,
    toEmail: next.email,
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
  view.markObservedAuthIdentity?.(next.id);
  view.refresh();

  const switchMessage = buildAutoSwitchSuccessMessage(next);

  if (!needsWindowReloadForAccount(next.id)) {
    recordAutoSwitchDashboardNotice(switchMessage, "info", {
      accountId: next.id,
      switchResult: "switched"
    });
    void vscode.window.showInformationMessage(switchMessage);
    return true;
  }

  if (config.get<boolean>(AUTO_SWITCH_RELOAD_WINDOW_ENABLED, false)) {
    await handleCodexAppRestartPreference({ allowManualPrompt: false });
    queueAutoSwitchNotice(buildAutoSwitchSuccessMessage(next, true), next.id);
    try {
      const reloaded = await autoReloadWindowForAccount(next.id);
      if (!reloaded) {
        consumeAutoSwitchNotice();
        const skippedMessage = `Switched to ${next.email}; reload not needed.`;
        recordAutoSwitchDashboardNotice(skippedMessage, "warning", { accountId: next.id });
        void vscode.window.showWarningMessage(skippedMessage);
      }
    } catch (error) {
      consumeAutoSwitchNotice();
      throw error;
    }
    return true;
  }

  await promptWindowReloadForAccount(next, {
    message: `${switchMessage} Reload VS Code?`
  });
  return true;
}

async function refreshAllBeforeWarningIfNeeded(
  repo: AccountsRepository,
  view: RefreshView,
  account: CodexManagerAccountRecord,
  bypassGap: boolean
): Promise<void> {
  if (!account.isActive || !account.quotaSummary || account.enabled === false) {
    return;
  }
  const config = getCodexManagerConfiguration();
  if (!config.get<boolean>(QUOTA_WARNING_ENABLED, false)) {
    return;
  }
  const warningThresholds = getQuotaWarningThresholds(config);
  const hourlyEnabled = config.get<boolean>(HOURLY_QUOTA_CONTROL_ENABLED, false);
  const warningThresholdReached =
    (hourlyEnabled &&
      hasComparableHourlyWindow(account) &&
      account.quotaSummary.hourlyPercentage <= warningThresholds.hourly) ||
    (hasComparableWeeklyWindow(account) && account.quotaSummary.weeklyPercentage <= warningThresholds.weekly);
  if (warningThresholdReached) {
    await refreshAllBeforeAutoSwitchIfDue(repo, view, config, bypassGap);
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
  bypassGap = false
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
      (account) => account.enabled !== false && !account.isActive
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
        allowTokenRefresh: isBackgroundTokenRefreshEnabled(),
        forceRefresh: true,
        announceFailure: false,
        skipDisabled: true
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
  resetThreshold: number
): Promise<boolean> {
  if (!(await isExpectedActiveAccount(repo, active.id))) {
    return false;
  }
  const tokens = await repo.getTokens(active.id, { bypassCache: true });
  if (!tokens?.accessToken) {
    throw new Error(`No access token available for reset-plan account ${active.email}`);
  }
  await consumeResetCredit(tokens.accessToken, active.accountId ?? undefined);
  const refreshed = await refreshSingleQuota(repo, view, active.id, {
    announce: false,
    warnQuota: false,
    forceRefresh: true,
    refreshView: false
  });
  if (refreshed.error || refreshed.skipped) {
    throw new Error(refreshed.error?.message ?? `Quota reset did not refresh ${active.email}`);
  }
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
  await handleCodexAppRestartPreference({ allowManualPrompt: false });
  await reloadWindowNow();
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
  resetThreshold: number
): Promise<boolean> {
  if (!(await isExpectedActiveAccount(repo, active.id))) {
    return false;
  }
  const tokens = await repo.getTokens(next.id, { bypassCache: true });
  if (!tokens?.accessToken) {
    throw new Error(`No access token available for reset-plan account ${next.email}`);
  }
  await consumeResetCredit(tokens.accessToken, next.accountId ?? undefined);
  const refreshed = await refreshSingleQuota(repo, view, next.id, {
    announce: false,
    warnQuota: false,
    forceRefresh: true,
    refreshView: false
  });
  if (refreshed.error || refreshed.skipped) {
    throw new Error(refreshed.error?.message ?? `Quota reset did not refresh ${next.email}`);
  }
  if (!(await isExpectedActiveAccount(repo, active.id))) {
    return false;
  }
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
        hasCurrentSessionQuotaSnapshot(account) &&
        hasCodexManagerAccountAutoQueueCapability(account, {
          hourlyEnabled,
          hourlyThreshold,
          weeklyThreshold
        })
    )
    .sort(compareAutoSwitchCandidate)[0];
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
  weeklyThreshold: number
): Promise<boolean> {
  if (!(await isExpectedActiveAccount(repo, active.id))) {
    return false;
  }
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

export async function maybeWarnForAccount(repo: AccountsRepository, accountId: string): Promise<void> {
  const config = getCodexManagerConfiguration();
  if (!config.get<boolean>(QUOTA_WARNING_ENABLED, false)) {
    quotaWarningCounts.clear();
    return;
  }

  const warningThresholds = getQuotaWarningThresholds(config);
  const hourlyQuotaControlEnabled = config.get<boolean>(HOURLY_QUOTA_CONTROL_ENABLED, true);
  let account = applyOptionalCoordinatedQuotaSnapshot(await repo.getAccount(accountId));
  if (!account) {
    clearQuotaWarningCountsForAccount(accountId);
    return;
  }
  if (
    !account?.isActive ||
    !account.quotaSummary ||
    account.enabled === false ||
    !hasCurrentSessionQuotaSnapshot(account)
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
      account.enabled === false ||
      !account.isActive ||
      !hasCurrentSessionQuotaSnapshot(account)
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
    account.enabled === false ||
    !hasCurrentSessionQuotaSnapshot(account)
  ) {
    clearQuotaWarningCountsForAccount(accountId);
    return;
  }
  if (!hourlyQuotaControlEnabled) {
    clearQuotaWarningCountsForDimension("hourly");
  }

  const checks: Array<{
    dimension: "hourly" | "weekly";
    label: string;
    value: number;
    threshold: number;
  }> = [];
  const weeklyLabel = hasComparableWeeklyWindow(account)
    ? resolveLongQuotaLabel(
        account.planType,
        account.quotaSummary.weeklyWindowMinutes,
        getLanguage(),
        copy.weeklyLabel
      )
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
    const switchTarget = selectQuotaWarningSwitchTarget(accounts, account, check.dimension, check.threshold);
    const switchAccount = switchTarget
      ? copy.switchAccount(formatAccountToastLabel(switchTarget))
      : undefined;
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
    void vscode.window
      .showWarningMessage(
        warningMessage,
        ...actions
      )
      .then((selection) => {
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

function hasCurrentSessionQuotaSnapshot(account: CodexManagerAccountRecord): boolean {
  return (
    typeof account.sessionStartedAt !== "number" ||
    (typeof account.lastQuotaAt === "number" && account.lastQuotaAt >= account.sessionStartedAt)
  );
}

function applyOptionalCoordinatedQuotaSnapshot(
  account: CodexManagerAccountRecord | undefined
): CodexManagerAccountRecord | undefined {
  return account ? applyCoordinatedQuotaSnapshot(account) : undefined;
}

function applyCoordinatedQuotaSnapshot(account: CodexManagerAccountRecord): CodexManagerAccountRecord {
  const snapshot = getCoordinatedQuotaSnapshot(account);
  if (!snapshot || !account.quotaSummary) return account;
  return {
    ...account,
    lastQuotaAt: snapshot.checkedAt,
    quotaSummary: {
      ...account.quotaSummary,
      hourlyPercentage: snapshot.hourlyPercentage ?? account.quotaSummary.hourlyPercentage,
      hourlyResetTime: snapshot.hourlyResetTime ?? account.quotaSummary.hourlyResetTime,
      weeklyPercentage: snapshot.weeklyPercentage ?? account.quotaSummary.weeklyPercentage,
      weeklyResetTime: snapshot.weeklyResetTime ?? account.quotaSummary.weeklyResetTime,
      resetCreditsAvailable: snapshot.resetCreditsAvailable ?? account.quotaSummary.resetCreditsAvailable
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
      if (!hasCurrentSessionQuotaSnapshot(candidate)) return false;
      if (dimension === "hourly") {
        return hasComparableHourlyWindow(candidate) && candidate.quotaSummary.hourlyPercentage > threshold;
      }
      return hasComparableWeeklyWindow(candidate) && candidate.quotaSummary.weeklyPercentage > threshold;
    })
    .sort(compareAutoSwitchCandidate)[0];
}

function clearQuotaWarningCountsForDimension(dimension: "hourly" | "weekly"): void {
  for (const key of quotaWarningCounts.keys()) {
    if (key.includes(`:${dimension}:`)) {
      quotaWarningCounts.delete(key);
    }
  }
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

function compareAutoSwitchCandidate(left: CodexManagerAccountRecord, right: CodexManagerAccountRecord): number {
  return compareCodexManagerAccountAutoQueueOrder(left, right);
}

function buildMatchedRules(): string[] {
  return ["quota"];
}

function buildAutoSwitchSuccessMessage(account: CodexManagerAccountRecord, reloaded = false): string {
  const copy = getDashboardCopy(getLanguage());
  const template = reloaded ? copy.autoSwitchToastSwitchedAndReloaded : copy.autoSwitchToastSwitched;
  return template.replace("{account}", account.email);
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
