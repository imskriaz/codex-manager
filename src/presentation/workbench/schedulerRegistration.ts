import { onDidChangeConfiguration } from "../../storage/configurationEvents";
import * as vscode from "vscode";
import { needsTokenRefresh } from "../../auth/oauth";
import { runWithBulkProviderRequests } from "../../utils/network";
import {
  getCodexManagerConfiguration,
  getAutoRefreshCurrentMinutes,
  getAutoRefreshMinutes,
  isAutoSwitchRefreshAllBeforeSwitchEnabled
} from "../../infrastructure/config/extensionSettings";
import {
  maybeAutoSwitchForActiveQuota,
  isAutoSwitchWaitingForSessions,
  maybeWarnForActiveQuota,
  refreshSingleQuotaSafely
} from "../../application/accounts/quota";
import type { AccountsRepository } from "../../storage";
import { shouldRunAccountScheduler } from "./refreshSignature";
import {
  clearTokenAutomationError,
  configureTokenAutomation,
  markTokenAutomationCheck,
  markTokenAutomationRefreshFailure,
  markTokenAutomationRefreshSuccess,
  markTokenAutomationSweepFinished,
  markTokenAutomationSweepStarted
} from "./tokenAutomationState";
import {
  CrossWindowOperationBusyError,
  runCrossWindowExclusive,
  runSharedMaintenance
} from "../../utils/crossWindowOperations";
import { toAutoQueueOrderValue } from "../../application/accounts/autoQueueOrder";
import { createAutoQueuePolicy, isAutoQueueCandidateEligible } from "../../domain/autoQueuePolicy";
import { isUserFacingAdditionalQuotaLimit } from "../../utils/quotaLabels";

const CURRENT_REFRESH_FAILURE_BACKOFF_MULTIPLIER = 5;

/**
 * Safety mode normally refreshes non-current accounts only when a warning is
 * reached. If every enabled account is below an automatic-switch threshold,
 * that leaves the active account and candidate set dependent on stale data.
 * Resume the configured all-account cadence until at least one account is
 * above the relevant automatic-switch limits.
 */
async function allAccountsNeedCapabilityRefresh(
  repo: AccountsRepository,
  canUseAccount?: (id: string) => boolean
): Promise<boolean> {
  const accounts = (await repo.listAccounts()).filter(
    (account) => (account.enabled !== false || account.isActive) && (canUseAccount?.(account.id) ?? true)
  );
  if (!accounts.length) return false;
  const config = getCodexManagerConfiguration();
  const policy = createAutoQueuePolicy({
    autoSwitchHourlyThreshold: config.get<number>("autoSwitchHourlyThreshold", 5),
    autoSwitchWeeklyThreshold: config.get<number>("autoSwitchWeeklyThreshold", 0),
    autoRefreshMinutes: getAutoRefreshMinutes()
  });
  return accounts.every(
    (account) =>
      !isAutoQueueCandidateEligible(
        {
          ...toAutoQueueOrderValue(account),
          disabled: account.isActive ? false : account.enabled === false
        },
        policy
      )
  );
}

export function registerAutoRefreshScheduler(params: {
  context: vscode.ExtensionContext;
  repo: AccountsRepository;
  onRefresh: () => void;
  canRefreshAccount?: (accountId: string) => boolean;
}): vscode.Disposable {
  let allTimer: NodeJS.Timeout | undefined;
  let currentTimer: NodeJS.Timeout | undefined;
  let quotaResetTimer: NodeJS.Timeout | undefined;
  let quotaResetTimerAt = 0;
  let allInFlight = false;
  let currentInFlight = false;
  let currentScheduleVersion = 0;
  let disposed = false;
  const handledQuotaResets = new Set<string>();

  let quotaResetInFlight = false;
  let quotaResetScheduling = false;
  let quotaResetReadRetryAt = 0;
  const quotaResetRetries = new Map<string, { attempts: number; retryAt: number; unconfirmed?: boolean }>();

  const quotaResetTimes = (account: Awaited<ReturnType<AccountsRepository["listAccounts"]>>[number]): number[] =>
    [
      account.quotaSummary?.hourlyWindowPresent === false ? undefined : account.quotaSummary?.hourlyResetTime,
      account.quotaSummary?.weeklyWindowPresent === false ? undefined : account.quotaSummary?.weeklyResetTime,
      account.quotaSummary?.codeReviewWindowPresent ? account.quotaSummary.codeReviewResetTime : undefined,
      ...(account.quotaSummary?.additionalRateLimits ?? []).filter(isUserFacingAdditionalQuotaLimit).flatMap((limit) => [
        limit.hourlyWindowPresent ? limit.hourlyResetTime : undefined,
        limit.weeklyWindowPresent ? limit.weeklyResetTime : undefined
      ])
    ]
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
      .map((value) => value * 1_000);

  const canScheduleQuotaReset = (account: Awaited<ReturnType<AccountsRepository["listAccounts"]>>[number]): boolean =>
    account.enabled !== false || account.isActive;

  const hasPeriodicQuotaFallback = (account: Awaited<ReturnType<AccountsRepository["listAccounts"]>>[number]): boolean =>
    getAutoRefreshMinutes() > 0 || (account.isActive && getAutoRefreshCurrentMinutes() > 0);

  const resetStillExhausted = (account: Awaited<ReturnType<AccountsRepository["listAccounts"]>>[number], at: number): boolean => {
    const quota = account.quotaSummary;
    return [
      [quota?.hourlyResetTime, quota?.weeklyWindowPresent && quota.weeklyPercentage === 0 && (quota.weeklyResetTime ?? 0) * 1000 > at ? undefined : quota?.hourlyPercentage],
      [quota?.weeklyResetTime, quota?.weeklyPercentage],
      [quota?.codeReviewWindowPresent ? quota.codeReviewResetTime : undefined, quota?.codeReviewPercentage],
      ...(quota?.additionalRateLimits ?? []).filter(isUserFacingAdditionalQuotaLimit).flatMap(limit => [
        [limit.hourlyWindowPresent ? limit.hourlyResetTime : undefined, limit.hourlyPercentage],
        [limit.weeklyWindowPresent ? limit.weeklyResetTime : undefined, limit.weeklyPercentage]
      ])
    ].some(([resetAt, percentage]) => typeof resetAt === "number" && resetAt * 1000 === at && percentage === 0);
  };

  const scheduleNextQuotaReset = async (): Promise<void> => {
    if (disposed || quotaResetInFlight || quotaResetScheduling) return;
    if (Date.now() < quotaResetReadRetryAt) {
      if (!quotaResetTimer) {
        quotaResetTimerAt = quotaResetReadRetryAt;
        quotaResetTimer = setTimeout(runDueQuotaResetRefreshes, quotaResetReadRetryAt - Date.now());
        quotaResetTimer.unref?.();
      }
      return;
    }
    quotaResetScheduling = true;
    try {
      const scheduleVersion = currentScheduleVersion;
      const accounts = await params.repo.listAccounts();
      if (disposed || quotaResetInFlight || scheduleVersion !== currentScheduleVersion)
        return;
      const currentKeys = new Set(
        accounts.flatMap((account) => quotaResetTimes(account).map((at) => `${account.id}:${at}`))
      );
      for (const key of handledQuotaResets) if (!currentKeys.has(key)) handledQuotaResets.delete(key);
      for (const key of quotaResetRetries.keys()) if (!currentKeys.has(key)) quotaResetRetries.delete(key);
      const now = Date.now();
      const nextAttempts = accounts.filter(canScheduleQuotaReset).flatMap((account) =>
        quotaResetTimes(account).flatMap((resetAt) => {
          const key = `${account.id}:${resetAt}`;
          if (handledQuotaResets.has(key) || (!account.quotaError && (account.lastQuotaAt ?? 0) >= resetAt && !resetStillExhausted(account, resetAt))) return [];
          const retry = quotaResetRetries.get(key);
          // Leave repeated failures to periodic polling only when it covers this account.
          if (retry && retry.attempts >= 6 && !retry.unconfirmed && hasPeriodicQuotaFallback(account)) return [];
          return [Math.max(resetAt, retry?.retryAt ?? now, quotaResetReadRetryAt)];
        })
      );
      const nextAttemptAt = Math.min(...nextAttempts);
      if (quotaResetTimer && quotaResetTimerAt === nextAttemptAt) return;
      if (quotaResetTimer) clearTimeout(quotaResetTimer);
      quotaResetTimer = undefined;
      if (!nextAttempts.length) return;
      quotaResetTimerAt = nextAttemptAt;
      quotaResetTimer = setTimeout(
        runDueQuotaResetRefreshes,
        Math.min(2_147_000_000, Math.max(0, nextAttemptAt - now))
      );
      quotaResetTimer.unref?.();
    } catch (error) {
      if (quotaResetTimer) clearTimeout(quotaResetTimer);
      quotaResetTimer = undefined;
      quotaResetReadRetryAt = Date.now() + 60_000;
      console.warn("[codexManager] unable to schedule quota reset refresh:", error);
    } finally {
      quotaResetScheduling = false;
      if (quotaResetReadRetryAt > Date.now()) void scheduleNextQuotaReset();
    }
  };

  const runDueQuotaResetRefreshes = (): void => {
    if (disposed || quotaResetInFlight) return;
    quotaResetTimer = undefined;
    quotaResetInFlight = true;
    const scheduleVersion = currentScheduleVersion;
    void (async () => {
      const accounts = await params.repo.listAccounts();
      quotaResetReadRetryAt = 0;
      let refreshedAny = false;
      for (const account of accounts) {
        if (disposed || scheduleVersion !== currentScheduleVersion) break;
        if (!canScheduleQuotaReset(account)) continue;
        const now = Date.now();
        const due = quotaResetTimes(account).filter((at) => {
          const key = `${account.id}:${at}`;
          const retry = quotaResetRetries.get(key);
          return at <= now && !handledQuotaResets.has(key) &&
            (account.quotaError || (account.lastQuotaAt ?? 0) < at || resetStillExhausted(account, at)) &&
            (!retry || ((retry.attempts < 6 || retry.unconfirmed || !hasPeriodicQuotaFallback(account)) && retry.retryAt <= now));
        });
        if (!due.length) continue;
        let refreshed = false;
        let attempted = false;
        try {
          if (params.canRefreshAccount?.(account.id) ?? true) {
            await runCrossWindowExclusive(
              `background:quota-reset-refresh:${account.id}`,
              "Quota reset refresh",
              async () => {
                params.repo.invalidateCachedIndex?.();
                const latest = (await params.repo.listAccounts()).find(candidate => candidate.id === account.id);
                if (
                  disposed ||
                  scheduleVersion !== currentScheduleVersion ||
                  !latest || !canScheduleQuotaReset(latest) ||
                  !(params.canRefreshAccount?.(account.id) ?? true)
                )
                  return;
                if (!latest.quotaError && due.every(at => (latest.lastQuotaAt ?? 0) >= at && !resetStillExhausted(latest, at))) {
                  refreshed = true;
                  return;
                }
                attempted = true;
                refreshed = await refreshSingleQuotaSafely(params.repo, { refresh: params.onRefresh }, account.id, {
                  forceRefresh: true,
                  allowTokenRefresh: true,
                  skipDisabled: !latest.isActive,
                  announceFailure: false,
                  canUseAccount: params.canRefreshAccount
                });
              }
            );
          }
        } catch (error) {
          if (!(error instanceof CrossWindowOperationBusyError)) {
            console.warn(`[codexManager] quota reset refresh failed for ${account.email}:`, error);
          }
        }
        refreshedAny ||= refreshed;
        const latest = refreshed ? (await params.repo.listAccounts()).find(candidate => candidate.id === account.id) : undefined;
        for (const at of due) {
          const key = `${account.id}:${at}`;
          const unconfirmed = refreshed && latest !== undefined && quotaResetTimes(latest).includes(at) && resetStillExhausted(latest, at);
          if (refreshed && !unconfirmed) {
            handledQuotaResets.add(key);
            quotaResetRetries.delete(key);
          } else {
            const attempts = (quotaResetRetries.get(key)?.attempts ?? 0) + (attempted ? 1 : 0);
            quotaResetRetries.set(key, {
              attempts,
              unconfirmed,
              retryAt: Date.now() + Math.min(300_000, 60_000 * 2 ** Math.max(0, attempts - 1))
            });
          }
        }
      }
      if (refreshedAny && !disposed && scheduleVersion === currentScheduleVersion) {
        const switched = await maybeAutoSwitchForActiveQuota(
          params.repo,
          { refresh: params.onRefresh },
          {
            canUseAccount: params.canRefreshAccount
          }
        );
        if (!switched) await maybeWarnForActiveQuota(params.repo);
        params.onRefresh();
      }
    })()
      .catch((error) => {
        quotaResetReadRetryAt = Date.now() + 60_000;
        console.warn("[codexManager] quota reset maintenance failed:", error);
      })
      .finally(() => {
        quotaResetInFlight = false;
        void scheduleNextQuotaReset().catch((error) => {
          console.warn("[codexManager] unable to schedule quota reset refresh:", error);
        });
      });
  };

  const applySchedule = (): void => {
    const scheduleVersion = ++currentScheduleVersion;
    if (allTimer) {
      clearInterval(allTimer);
      allTimer = undefined;
    }
    if (currentTimer) {
      clearTimeout(currentTimer);
      currentTimer = undefined;
    }

    const runAllRefresh = (): void => {
      if (disposed || scheduleVersion !== currentScheduleVersion || allInFlight) return;
      allInFlight = true;
      const excludeCurrent = getAutoRefreshCurrentMinutes() > 0;
      const safetyRefresh = isAutoSwitchRefreshAllBeforeSwitchEnabled();
      const shouldRefresh = safetyRefresh
        ? allAccountsNeedCapabilityRefresh(params.repo, params.canRefreshAccount)
        : Promise.resolve(true);
      void shouldRefresh
        .then((needed) => {
          if (!needed || disposed || scheduleVersion !== currentScheduleVersion || getAutoRefreshMinutes() <= 0) return;
          const refreshOptions = {
            silent: true,
            forceRefresh: true,
            // Once every account is below an automatic-switch limit, refresh the
            // active account too; otherwise safety mode can leave the whole set
            // stale while the normal all-account sweep is suppressed.
            excludeCurrent: safetyRefresh ? false : excludeCurrent
          } as { silent: true; forceRefresh: true; excludeCurrent: boolean; respectQuotaCheckGap?: boolean };
          if (safetyRefresh) {
            refreshOptions.respectQuotaCheckGap = false;
          }
          return vscode.commands.executeCommand("codexManager.refreshAllQuotas", refreshOptions);
        })
        .catch(() => undefined)
        .finally(() => {
          allInFlight = false;
          void scheduleNextQuotaReset().catch((error) => {
            console.warn("[codexManager] unable to schedule quota reset refresh:", error);
          });
        });
    };

    const scheduleCurrentRefresh = (delayMs: number): void => {
      if (disposed || scheduleVersion !== currentScheduleVersion || getAutoRefreshCurrentMinutes() <= 0 || delayMs <= 0)
        return;
      currentTimer = setTimeout(() => {
        currentTimer = undefined;
        runCurrentRefresh();
      }, delayMs);
      currentTimer.unref?.();
    };

    const runCurrentRefresh = (knownCurrent?: { id: string }): void => {
      if (disposed || scheduleVersion !== currentScheduleVersion || getAutoRefreshCurrentMinutes() <= 0) return;
      if (currentInFlight) {
        scheduleCurrentRefresh(getAutoRefreshCurrentMinutes() * 60 * 1000);
        return;
      }
      currentInFlight = true;
      const refreshCurrent = async (current: { id: string }): Promise<void> => {
        let failed = false;
        try {
          await runCrossWindowExclusive(`background:quota-refresh:${current.id}`, "Quota refresh", async () => {
            if (
              disposed ||
              scheduleVersion !== currentScheduleVersion ||
              getAutoRefreshCurrentMinutes() <= 0 ||
              (params.canRefreshAccount && !params.canRefreshAccount(current.id))
            ) {
              return;
            }
            const refreshed = await refreshSingleQuotaSafely(params.repo, { refresh: params.onRefresh }, current.id, {
              forceRefresh: true,
              allowTokenRefresh: true,
              // The active account is the account currently used by Codex. Its
              // local enablement flag is an auto-switch/sync ownership setting,
              // not permission to stop observing the account in use.
              skipDisabled: false,
              // Timed refreshes are background maintenance. Keep failures in the
              // automation state/logs without interrupting the user's workspace
              // with a notification toast. Manual refreshes still announce errors.
              announceFailure: false,
              canUseAccount: params.canRefreshAccount
            });
            if (!refreshed) {
              failed = true;
              return;
            }
            if (disposed || scheduleVersion !== currentScheduleVersion || getAutoRefreshCurrentMinutes() <= 0) return;
            const switched = await maybeAutoSwitchForActiveQuota(
              params.repo,
              { refresh: params.onRefresh },
              {
                canUseAccount: params.canRefreshAccount
              }
            );
            if (!switched) {
              await maybeWarnForActiveQuota(params.repo);
            }
            params.onRefresh();
          });
        } catch (error) {
          if (error instanceof CrossWindowOperationBusyError) {
            return;
          }
          failed = true;
          console.warn("[codexManager] current-account auto refresh or auto switch failed:", error);
        } finally {
          currentInFlight = false;
          void scheduleNextQuotaReset().catch((error) => {
            console.warn("[codexManager] unable to schedule quota reset refresh:", error);
          });
          if (scheduleVersion === currentScheduleVersion) {
            const baseDelayMs = getAutoRefreshCurrentMinutes() * 60 * 1000;
            const delayMs = failed ? baseDelayMs * CURRENT_REFRESH_FAILURE_BACKOFF_MULTIPLIER : baseDelayMs;
            scheduleCurrentRefresh(delayMs);
          }
        }
      };
      if (knownCurrent) {
        void refreshCurrent(knownCurrent);
        return;
      }
      void params.repo
        .listAccounts()
        .then((accounts) => {
          const current = accounts.find((account) => account.isActive);
          if (current) void refreshCurrent(current);
          else {
            currentInFlight = false;
            scheduleCurrentRefresh(getAutoRefreshCurrentMinutes() * 60 * 1000);
          }
        })
        .catch(() => {
          currentInFlight = false;
          scheduleCurrentRefresh(getAutoRefreshCurrentMinutes() * 60 * 1000);
        });
    };

    const allMinutes = getAutoRefreshMinutes();
    if (allMinutes > 0) {
      allTimer = setInterval(runAllRefresh, allMinutes * 60 * 1000);
      allTimer.unref?.();
    }
    if (quotaResetTimer) {
      clearTimeout(quotaResetTimer);
      quotaResetTimer = undefined;
    }

    const currentMinutes = getAutoRefreshCurrentMinutes();
    if (currentMinutes > 0) {
      // Cached quota data is rendered during activation. Wait for the user's
      // configured cadence before starting network maintenance so extension
      // startup cannot trigger current-account and all-account bursts together.
      scheduleCurrentRefresh(currentMinutes * 60 * 1000);
    }
    void scheduleNextQuotaReset().catch((error) => {
      console.warn("[codexManager] unable to schedule quota reset refresh:", error);
    });
  };

  applySchedule();

  let sessionWaitInFlight = false;
  const sessionWaitTimer = setInterval(() => {
    if (!disposed) {
      // Manual refreshes and newly imported accounts can introduce earlier reset deadlines.
      void scheduleNextQuotaReset();
    }
    if (disposed || sessionWaitInFlight || !isAutoSwitchWaitingForSessions()) return;
    sessionWaitInFlight = true;
    void maybeAutoSwitchForActiveQuota(params.repo, { refresh: params.onRefresh }, { canUseAccount: params.canRefreshAccount })
      .catch((error) => { console.warn("[codexManager] deferred auto switch failed", error); })
      .finally(() => {
        sessionWaitInFlight = false;
        if (!disposed) {
          try { params.onRefresh(); }
          catch (error) { console.warn("[codexManager] deferred switch view refresh failed", error); }
        }
      });
  }, 5_000);
  sessionWaitTimer.unref?.();

  const configDisposable = onDidChangeConfiguration((event) => {
    const refreshScheduleChanged =
      event.affectsConfiguration("codexManager.autoRefreshMinutes") ||
      event.affectsConfiguration("codexManager.autoRefreshCurrentMinutes") ||
      event.affectsConfiguration("codexManager.autoSwitchRefreshAllBeforeSwitchEnabled");
    const autoSwitchChanged =
      event.affectsConfiguration("codexManager.autoSwitchEnabled") ||
      event.affectsConfiguration("codexManager.autoSwitchWaitForSessionsEnabled") ||
      event.affectsConfiguration("codexManager.autoSwitchHourlyThreshold") ||
      event.affectsConfiguration("codexManager.autoSwitchWeeklyThreshold");
    if (
      refreshScheduleChanged ||
      autoSwitchChanged ||
      event.affectsConfiguration("codexManager.quotaWarningEnabled")
    ) {
      applySchedule();
    }
    // A settings change can make an already-cached active quota eligible (or
    // ineligible) without waiting for the next refresh interval. Re-evaluate
    // immediately so enabling Auto Switch and changing its thresholds have a
    // deterministic effect.
    if (autoSwitchChanged && getCodexManagerConfiguration().get<boolean>("autoSwitchEnabled", false)) {
      void maybeAutoSwitchForActiveQuota(
        params.repo,
        { refresh: params.onRefresh },
        { canUseAccount: params.canRefreshAccount }
      ).catch((error) => {
        console.warn("[codexManager] settings-triggered auto switch failed:", error);
      });
    }
  });

  params.context.subscriptions.push(configDisposable);
  return {
    dispose(): void {
      disposed = true;
      clearInterval(sessionWaitTimer);
      configDisposable.dispose();
      if (allTimer) clearInterval(allTimer);
      currentScheduleVersion += 1;
      if (currentTimer) clearTimeout(currentTimer);
      if (quotaResetTimer) clearTimeout(quotaResetTimer);
    }
  };
}

export function registerTokenRefreshScheduler(params: {
  context: vscode.ExtensionContext;
  repo: AccountsRepository;
  view: { refresh(): void };
  checkIntervalMs: number;
  skewSeconds: number;
  canRefreshAccount?: (accountId: string) => boolean;
}): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;
  let disposed = false;
  let scheduleVersion = 0;
  const intervalMs =
    Number.isFinite(params.checkIntervalMs) && params.checkIntervalMs > 0
      ? Math.max(1_000, Math.min(2_147_000_000, params.checkIntervalMs))
      : 0;

  const readEligibleAccount = async (accountId: string, version: number) => {
    if (disposed || version !== scheduleVersion || !(params.canRefreshAccount?.(accountId) ?? true)) return undefined;
    params.repo.invalidateCachedIndex?.();
    const account = await params.repo.getAccount(accountId);
    return !disposed &&
      version === scheduleVersion &&
      account?.enabled !== false &&
      account?.tokenRefreshEnabled === true &&
      (params.canRefreshAccount?.(accountId) ?? true)
      ? account
      : undefined;
  };

  const runTokenRefreshSweep = async (): Promise<void> => {
    if (disposed || !intervalMs || inFlight) {
      return;
    }

    inFlight = true;
    const version = scheduleVersion;
    let lastFailureMessage: string | undefined;
    try {
      await runSharedMaintenance("background:token-refresh-sweep", "Background token refresh", intervalMs, async () => {
        if (disposed || version !== scheduleVersion) return;
        markTokenAutomationSweepStarted();
        const accounts = (await params.repo.listAccounts()).filter(
          (account) =>
            account.enabled !== false &&
            account.tokenRefreshEnabled === true &&
            (params.canRefreshAccount?.(account.id) ?? true)
        );
        if (disposed || version !== scheduleVersion || !shouldRunAccountScheduler(accounts.length)) {
          return;
        }

        for (const account of accounts) {
          if (disposed || version !== scheduleVersion) break;
          try {
            await runCrossWindowExclusive(`background:token-refresh:${account.id}`, "Token refresh", async () => {
              if (!(await readEligibleAccount(account.id, version))) return;
              const tokens = await params.repo.getTokens(account.id, { bypassCache: true });
              const latestAccount = await readEligibleAccount(account.id, version);
              if (!latestAccount) return;
              markTokenAutomationCheck(account.id);
              if (!tokens?.accessToken || !needsTokenRefresh(tokens, params.skewSeconds)) {
                clearTokenAutomationError(account.id);
                return;
              }

              if (!tokens.refreshToken) {
                throw new Error("Token expired and no refresh token is available");
              }

              await runWithBulkProviderRequests(() => params.repo.refreshAccountTokens(account.id, { skewSeconds: params.skewSeconds }));
              if (!disposed && version === scheduleVersion) markTokenAutomationRefreshSuccess(account.id);
            });
          } catch (error) {
            if (error instanceof CrossWindowOperationBusyError) {
              continue;
            }
            lastFailureMessage = error instanceof Error ? error.message : String(error);
            if (!disposed && version === scheduleVersion)
              markTokenAutomationRefreshFailure(account.id, lastFailureMessage);
            console.warn(`[codexManager] background token refresh failed for ${account.email}:`, error);
          }
        }
      });
    } catch (error) {
      if (!(error instanceof CrossWindowOperationBusyError)) {
        lastFailureMessage = error instanceof Error ? error.message : String(error);
        console.warn("[codexManager] background token refresh sweep failed:", error);
      }
    } finally {
      inFlight = false;
      if (!disposed && version === scheduleVersion) markTokenAutomationSweepFinished(lastFailureMessage);
      if (!disposed && version === scheduleVersion) params.view.refresh();
    }
  };

  const applySchedule = (): void => {
    if (disposed) return;
    scheduleVersion += 1;
    const enabled = intervalMs > 0;
    configureTokenAutomation(enabled, intervalMs, params.skewSeconds);

    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }

    if (!enabled) {
      params.view.refresh();
      return;
    }

    timer = setInterval(() => {
      void runTokenRefreshSweep();
    }, intervalMs);
    timer.unref?.();
  };

  applySchedule();

  const configDisposable = onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("codexManager.crossWindowAccountModeEnabled")) {
      applySchedule();
    }
  });

  params.context.subscriptions.push(configDisposable);
  return {
    dispose(): void {
      disposed = true;
      scheduleVersion += 1;
      configureTokenAutomation(false, intervalMs, params.skewSeconds);
      configDisposable.dispose();
      if (timer) {
        clearInterval(timer);
      }
    }
  };
}
