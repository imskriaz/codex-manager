import * as vscode from "vscode";
import { needsTokenRefresh, refreshTokens } from "../../auth/oauth";
import {
  getCodexManagerConfiguration,
  getAutoRefreshCurrentMinutes,
  getAutoRefreshMinutes,
  isAutoSwitchRefreshAllBeforeSwitchEnabled
} from "../../infrastructure/config/extensionSettings";
import {
  maybeAutoSwitchForActiveQuota,
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
  let allInFlight = false;
  let currentInFlight = false;
  let currentScheduleVersion = 0;
  let disposed = false;
  const handledQuotaResets = new Set<string>();

  let quotaResetInFlight = false;
  let quotaResetScheduleVersion = 0;
  let quotaResetReadRetryAt = 0;
  const quotaResetRetries = new Map<string, { attempts: number; retryAt: number }>();

  const quotaResetTimes = (account: Awaited<ReturnType<AccountsRepository["listAccounts"]>>[number]): number[] =>
    [account.quotaSummary?.hourlyResetTime, account.quotaSummary?.weeklyResetTime]
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
      .map((value) => value * 1_000);

  const canScheduleQuotaReset = (account: Awaited<ReturnType<AccountsRepository["listAccounts"]>>[number]): boolean =>
    (account.enabled !== false || account.isActive) &&
    (getAutoRefreshMinutes() > 0 || (account.isActive && getAutoRefreshCurrentMinutes() > 0));

  const scheduleNextQuotaReset = async (): Promise<void> => {
    if (disposed || quotaResetInFlight) return;
    if (quotaResetTimer) clearTimeout(quotaResetTimer);
    quotaResetTimer = undefined;
    const scheduleVersion = currentScheduleVersion;
    const resetScheduleVersion = ++quotaResetScheduleVersion;
    const accounts = await params.repo.listAccounts();
    if (disposed || scheduleVersion !== currentScheduleVersion || resetScheduleVersion !== quotaResetScheduleVersion)
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
        if (handledQuotaResets.has(key)) return [];
        const retry = quotaResetRetries.get(key);
        // After six failures, normal configured maintenance owns recovery.
        if (retry && retry.attempts >= 6) return [];
        return [Math.max(resetAt + 1_000, retry?.retryAt ?? now, quotaResetReadRetryAt)];
      })
    );
    if (!nextAttempts.length) return;
    quotaResetTimer = setTimeout(
      runDueQuotaResetRefreshes,
      Math.min(2_147_000_000, Math.max(0, Math.min(...nextAttempts) - now))
    );
    quotaResetTimer.unref?.();
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
          return at <= now && !handledQuotaResets.has(key) && (!retry || (retry.attempts < 6 && retry.retryAt <= now));
        });
        if (!due.length) continue;
        let refreshed = false;
        try {
          if (params.canRefreshAccount?.(account.id) ?? true) {
            await runCrossWindowExclusive(
              `background:quota-reset-refresh:${account.id}`,
              "Quota reset refresh",
              async () => {
                if (
                  disposed ||
                  scheduleVersion !== currentScheduleVersion ||
                  !canScheduleQuotaReset(account) ||
                  !(params.canRefreshAccount?.(account.id) ?? true)
                )
                  return;
                refreshed = await refreshSingleQuotaSafely(params.repo, { refresh: params.onRefresh }, account.id, {
                  forceRefresh: true,
                  allowTokenRefresh: true,
                  skipDisabled: !account.isActive,
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
        for (const at of due) {
          const key = `${account.id}:${at}`;
          if (refreshed) {
            handledQuotaResets.add(key);
            quotaResetRetries.delete(key);
          } else {
            const attempts = (quotaResetRetries.get(key)?.attempts ?? 0) + 1;
            quotaResetRetries.set(key, {
              attempts,
              retryAt: Date.now() + Math.min(300_000, 60_000 * 2 ** (attempts - 1))
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

  const configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration("codexManager.autoRefreshMinutes") ||
      event.affectsConfiguration("codexManager.autoRefreshCurrentMinutes") ||
      event.affectsConfiguration("codexManager.autoSwitchRefreshAllBeforeSwitchEnabled") ||
      event.affectsConfiguration("codexManager.autoSwitchEnabled") ||
      event.affectsConfiguration("codexManager.quotaWarningEnabled") ||
      event.affectsConfiguration("codexManager.autoSwitchHourlyThreshold") ||
      event.affectsConfiguration("codexManager.autoSwitchWeeklyThreshold")
    ) {
      applySchedule();
    }
  });

  params.context.subscriptions.push(configDisposable);
  return {
    dispose(): void {
      disposed = true;
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
    let checked = 0;
    let refreshedCount = 0;
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
              checked += 1;
              if (!tokens?.accessToken || !needsTokenRefresh(tokens, params.skewSeconds)) {
                clearTokenAutomationError(account.id);
                return;
              }

              if (!tokens.refreshToken) {
                throw new Error("Token expired and no refresh token is available");
              }

              const refreshed = await refreshTokens(tokens.refreshToken, tokens.idToken);
              // A provider may rotate the refresh token. Once requested, save
              // the response even if automation is disabled while it is in flight.
              await params.repo.updateTokens(account.id, {
                ...refreshed,
                accountId: refreshed.accountId ?? latestAccount.accountId ?? tokens.accountId
              });
              if (!disposed && version === scheduleVersion) markTokenAutomationRefreshSuccess(account.id);
              refreshedCount += 1;
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
      console.info(
        `[codexManager] background token refresh sweep: checked=${checked}, refreshed=${refreshedCount}` +
          (lastFailureMessage ? `, lastError=${lastFailureMessage}` : ""),
        { checked, refreshed: refreshedCount }
      );
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

  const configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
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
