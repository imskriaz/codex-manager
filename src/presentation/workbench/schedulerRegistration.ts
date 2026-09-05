import * as vscode from "vscode";
import { needsTokenRefresh, refreshTokens } from "../../auth/oauth";
import {
  getCodexManagerConfiguration,
  getAutoRefreshCurrentMinutes,
  getAutoRefreshMinutes,
  normalizeAutoSwitchThreshold,
  isAutoSwitchRefreshAllBeforeSwitchEnabled,
  isBackgroundTokenRefreshEnabled
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
import { CrossWindowOperationBusyError, runCrossWindowExclusive } from "../../utils/crossWindowOperations";
import { hasCodexManagerAccountAutoQueueCapability } from "../../application/accounts/autoQueueOrder";

const CURRENT_REFRESH_FAILURE_BACKOFF_MULTIPLIER = 5;

/**
 * Safety mode normally refreshes non-current accounts only when a warning is
 * reached. If every enabled account is below an automatic-switch threshold,
 * that leaves the active account and candidate set dependent on stale data.
 * Resume the configured all-account cadence until at least one account is
 * above the relevant automatic-switch limits.
 */
async function allAccountsNeedCapabilityRefresh(repo: AccountsRepository): Promise<boolean> {
  const accounts = (await repo.listAccounts()).filter((account) => account.enabled !== false);
  if (accounts.length === 0) {
    return false;
  }

  const config = getCodexManagerConfiguration();
  const switchThresholds = {
    hourly: normalizeAutoSwitchThreshold(config.get<number>("autoSwitchHourlyThreshold", 5)),
    weekly: normalizeAutoSwitchThreshold(config.get<number>("autoSwitchWeeklyThreshold", 0))
  };
  const hourlyEnabled = config.get<boolean>("hourlyQuotaControlEnabled", true);

  return accounts.every((account) => {
    if (
      !account.quotaSummary ||
      account.quotaError ||
      !hasCodexManagerAccountAutoQueueCapability(account, {
        hourlyEnabled,
        hourlyThreshold: switchThresholds.hourly,
        weeklyThreshold: switchThresholds.weekly
      })
    ) {
      return true;
    }
    return false;
  });
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

  const quotaResetTimes = (account: Awaited<ReturnType<AccountsRepository["listAccounts"]>>[number]): number[] => {
    const quota = account.quotaSummary;
    return [quota?.hourlyResetTime, quota?.weeklyResetTime]
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      .map((value) => value * 1_000);
  };

  const scheduleNextQuotaReset = async (): Promise<void> => {
    if (disposed) return;
    if (quotaResetTimer) {
      clearTimeout(quotaResetTimer);
      quotaResetTimer = undefined;
    }
    const accounts = (await params.repo.listAccounts()).filter((account) => account.enabled !== false);
    const now = Date.now();
    const futureResets = accounts.flatMap(quotaResetTimes).filter((resetAt) => resetAt > now);
    if (!futureResets.length) {
      return;
    }
    const nextResetAt = Math.min(...futureResets);
    quotaResetTimer = setTimeout(
      runDueQuotaResetRefreshes,
      Math.min(2_147_000_000, Math.max(0, nextResetAt - now + 1_000))
    );
    quotaResetTimer.unref?.();
  };

  const runDueQuotaResetRefreshes = (): void => {
    if (disposed) return;
    quotaResetTimer = undefined;
    void (async () => {
      const now = Date.now();
      const accounts = (await params.repo.listAccounts()).filter((account) => account.enabled !== false);
      let refreshedAny = false;
      for (const account of accounts) {
        const dueResets = quotaResetTimes(account).filter((resetAt) => resetAt <= now);
        const unhandled = dueResets.filter((resetAt) => !handledQuotaResets.has(`${account.id}:${resetAt}`));
        if (!unhandled.length || (params.canRefreshAccount && !params.canRefreshAccount(account.id))) {
          continue;
        }
        for (const resetAt of unhandled) {
          handledQuotaResets.add(`${account.id}:${resetAt}`);
        }
        try {
          await runCrossWindowExclusive(
            `background:quota-reset-refresh:${account.id}`,
            "Quota reset refresh",
            async () => {
              refreshedAny =
                (await refreshSingleQuotaSafely(params.repo, { refresh: params.onRefresh }, account.id, {
                  forceRefresh: true,
                  allowTokenRefresh: isBackgroundTokenRefreshEnabled(),
                  skipDisabled: true,
                  announceFailure: false,
                  canUseAccount: params.canRefreshAccount
                })) || refreshedAny;
            }
          );
        } catch (error) {
          if (!(error instanceof CrossWindowOperationBusyError)) {
            console.warn(`[codexManager] quota reset refresh failed for ${account.email}:`, error);
          }
        }
      }
      if (refreshedAny) {
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
      }
      // Retain only keys still represented by the current snapshots.
      const currentKeys = new Set(
        accounts.flatMap((account) => quotaResetTimes(account).map((at) => `${account.id}:${at}`))
      );
      for (const key of handledQuotaResets) {
        if (!currentKeys.has(key)) handledQuotaResets.delete(key);
      }
      await scheduleNextQuotaReset();
    })().catch((error) => {
      console.warn("[codexManager] unable to schedule quota reset refresh:", error);
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
      if (allInFlight) return;
      allInFlight = true;
      const excludeCurrent = getAutoRefreshCurrentMinutes() > 0;
      const safetyRefresh = isAutoSwitchRefreshAllBeforeSwitchEnabled();
      const shouldRefresh = safetyRefresh ? allAccountsNeedCapabilityRefresh(params.repo) : Promise.resolve(true);
      void shouldRefresh
        .then((needed) => {
          if (!needed) return;
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
        });
    };

    const scheduleCurrentRefresh = (delayMs: number): void => {
      if (scheduleVersion !== currentScheduleVersion) return;
      currentTimer = setTimeout(() => {
        currentTimer = undefined;
        runCurrentRefresh();
      }, delayMs);
    };

    const runCurrentRefresh = (knownCurrent?: { id: string }): void => {
      if (currentInFlight) {
        scheduleCurrentRefresh(getAutoRefreshCurrentMinutes() * 60 * 1000);
        return;
      }
      currentInFlight = true;
      const refreshCurrent = async (current: { id: string }): Promise<void> => {
        let failed = false;
        try {
          await runCrossWindowExclusive(`background:quota-refresh:${current.id}`, "Quota refresh", async () => {
            if (params.canRefreshAccount && !params.canRefreshAccount(current.id)) {
              return;
            }
            const refreshed = await refreshSingleQuotaSafely(params.repo, { refresh: params.onRefresh }, current.id, {
              forceRefresh: true,
              allowTokenRefresh: isBackgroundTokenRefreshEnabled(),
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
      event.affectsConfiguration("codexManager.autoSwitchRefreshAllBeforeSwitchEnabled")
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

  const runTokenRefreshSweep = async (): Promise<void> => {
    if (inFlight) {
      return;
    }

    inFlight = true;
    let lastFailureMessage: string | undefined;
    let checked = 0;
    let refreshedCount = 0;
    try {
      await runCrossWindowExclusive("background:token-refresh-sweep", "Background token refresh", async () => {
        markTokenAutomationSweepStarted();
        const accounts = (await params.repo.listAccounts()).filter(
          (account) =>
            account.enabled !== false &&
            account.tokenRefreshEnabled === true &&
            (params.canRefreshAccount?.(account.id) ?? true)
        );
        if (!shouldRunAccountScheduler(accounts.length)) {
          return;
        }

        for (const account of accounts) {
          try {
            await runCrossWindowExclusive(`background:token-refresh:${account.id}`, "Token refresh", async () => {
              const tokens = await params.repo.getTokens(account.id, { bypassCache: true });
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
              await params.repo.updateTokens(account.id, {
                ...refreshed,
                accountId: refreshed.accountId ?? account.accountId ?? tokens.accountId
              });
              markTokenAutomationRefreshSuccess(account.id);
              refreshedCount += 1;
            });
          } catch (error) {
            if (error instanceof CrossWindowOperationBusyError) {
              continue;
            }
            lastFailureMessage = error instanceof Error ? error.message : String(error);
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
      markTokenAutomationSweepFinished(lastFailureMessage);
      console.info(
        `[codexManager] background token refresh sweep: checked=${checked}, refreshed=${refreshedCount}` +
          (lastFailureMessage ? `, lastError=${lastFailureMessage}` : ""),
        { checked, refreshed: refreshedCount }
      );
      params.view.refresh();
    }
  };

  const applySchedule = (): void => {
    const enabled = isBackgroundTokenRefreshEnabled();
    configureTokenAutomation(enabled, params.checkIntervalMs, params.skewSeconds);

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
    }, params.checkIntervalMs);
    timer.unref?.();
  };

  applySchedule();

  const configDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("codexManager.backgroundTokenRefreshEnabled")) {
      applySchedule();
    }
  });

  params.context.subscriptions.push(configDisposable);
  return {
    dispose(): void {
      configDisposable.dispose();
      if (timer) {
        clearInterval(timer);
      }
    }
  };
}
