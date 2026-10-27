import { describe, expect, it, vi } from "vitest";
import { createAccountsRepositoryState } from "../src/storage/accountsRepositoryState";
import { assertWriteAllowed, markPendingSave, readPendingOrCachedIndex } from "../src/storage/accountsWriteCoordinator";
import { ErrorCode, StorageError } from "../src/core/errors";
import { parseSharedJsonInput, toImportActionPayload } from "../src/presentation/dashboard/actionUtils";
import {
  buildWorkbenchRefreshSignature,
  shouldRunAccountScheduler
} from "../src/presentation/workbench/refreshSignature";
import { buildDashboardStateSignature } from "../src/presentation/dashboard/signature";
import { createKeyedMutex, runWithConcurrencyLimit } from "../src/utils/concurrency";
import {
  normalizeAutoRefreshMinutes,
  normalizeCurrentAutoRefreshMinutes,
  normalizeUsageHistoryRetentionDays
} from "../src/infrastructure/config/extensionSettings";

describe("accountsWriteCoordinator helpers", () => {
  it("prefers pending saves over cache and schedules a flush", () => {
    vi.useFakeTimers();
    const state = createAccountsRepositoryState();
    const flush = vi.fn();

    markPendingSave(
      state,
      {
        currentAccountId: "a",
        accounts: [{ id: "a", email: "a@example.com", isActive: true, createdAt: 1, updatedAt: 1 }]
      },
      100,
      flush
    );

    expect(readPendingOrCachedIndex(state, 5000)?.currentAccountId).toBe("a");
    vi.advanceTimersByTime(100);
    expect(flush).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("blocks writes when the index is unrecoverable", () => {
    const state = createAccountsRepositoryState();
    state.indexHealth = {
      status: "corrupted_unrecoverable",
      availableBackups: 0
    };

    expect(() => assertWriteAllowed(state)).toThrowError(StorageError);
    expect(() => assertWriteAllowed(state)).toThrow(/Restore accounts before writing again/);
  });
});

describe("dashboard action utils", () => {
  it("parses shared json and formats import results", () => {
    expect(parseSharedJsonInput('[{"email":"dev@example.com"}]')).toEqual([{ email: "dev@example.com" }]);

    expect(
      toImportActionPayload({
        source: "backup",
        restoredCount: 2,
        restoredEmails: ["a@example.com", "b@example.com"]
      })
    ).toEqual({
      importedCount: 2,
      importedEmails: ["a@example.com", "b@example.com"],
      importResult: {
        total: 2,
        successCount: 2,
        overwriteCount: 0,
        failedCount: 0,
        importedEmails: ["a@example.com", "b@example.com"],
        failures: []
      }
    });
  });

  it("surfaces parser errors through the provided formatter", () => {
    expect(() => parseSharedJsonInput("", (message) => `invalid: ${message}`)).toThrow("invalid: Empty JSON input");
  });
});

describe("scheduler settings helpers", () => {
  it("normalizes auto refresh minutes to off or 5-60", () => {
    expect(normalizeAutoRefreshMinutes(-1)).toBe(0);
    expect(normalizeAutoRefreshMinutes(0)).toBe(0);
    expect(normalizeAutoRefreshMinutes(0.4)).toBe(5);
    expect(normalizeAutoRefreshMinutes(1.4)).toBe(5);
    expect(normalizeAutoRefreshMinutes(59.6)).toBe(60);
    expect(normalizeAutoRefreshMinutes(90)).toBe(60);
  });

  it("allows one-minute active-account polling for fresh quota state", () => {
    expect(normalizeCurrentAutoRefreshMinutes(0)).toBe(0);
    expect(normalizeCurrentAutoRefreshMinutes(1)).toBe(1);
    expect(normalizeCurrentAutoRefreshMinutes(4.4)).toBe(4);
    expect(normalizeCurrentAutoRefreshMinutes(12)).toBe(12);
    expect(normalizeCurrentAutoRefreshMinutes(90)).toBe(60);
  });

  it("normalizes quota history retention to the 30-day default or 1-90 days", () => {
    expect(normalizeUsageHistoryRetentionDays(-1)).toBe(30);
    expect(normalizeUsageHistoryRetentionDays(0)).toBe(30);
    expect(normalizeUsageHistoryRetentionDays(0.4)).toBe(1);
    expect(normalizeUsageHistoryRetentionDays(30)).toBe(30);
    expect(normalizeUsageHistoryRetentionDays(120)).toBe(90);
  });
});

describe("runWithConcurrencyLimit", () => {
  it.each([0, -1, 0.5, NaN, Infinity])("rejects an invalid concurrency limit: %s", async (limit) => {
    const worker = vi.fn();
    await expect(runWithConcurrencyLimit([1], limit, worker)).rejects.toThrow("positive integer");
    expect(worker).not.toHaveBeenCalled();
  });

  it("waits for active workers and stops taking new items after a failure", async () => {
    let finish!: () => void;
    const active = new Promise<void>((resolve) => { finish = resolve; });
    const started: number[] = [];
    const work = runWithConcurrencyLimit([1, 2, 3, 4], 2, async (value) => {
      started.push(value);
      if (value === 1) await active;
      else throw new Error("worker failed");
    });
    let settled = false;
    const checked = expect(work).rejects.toThrow("worker failed").finally(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await checked;
    expect(started).toEqual([1, 2]);
  });
  it("propagates unexpected worker failures", async () => {
    await expect(
      runWithConcurrencyLimit([1, 2, 3], 2, async (value) => {
        if (value === 2) {
          throw new Error("boom");
        }
      })
    ).rejects.toThrow("boom");
  });
});

describe("keyed mutex recovery", () => {
  it("serializes same-key tasks, permits unrelated work, and recovers from a rejection", async () => {
    const mutex = createKeyedMutex();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const first = mutex.runExclusive("a", async () => { order.push("first"); await blocked; throw new Error("failed"); });
    const checked = expect(first).rejects.toThrow("failed");
    const next = mutex.runExclusive("a", async () => { order.push("next"); return "done"; });
    await expect(mutex.runExclusive("b", async () => "independent")).resolves.toBe("independent");
    expect(order).toEqual(["first"]);
    release();
    await checked;
    await expect(next).resolves.toBe("done");
    await expect(mutex.runExclusive("a", async () => "recovered")).resolves.toBe("recovered");
    expect(order).toEqual(["first", "next"]);
  });
});

describe("workbench refresh signature helpers", () => {
  it("builds a stable signature from account and health state", () => {
    const signature = buildWorkbenchRefreshSignature({
      observedAuthIdentity: "acct-1",
      indexHealth: {
        status: "healthy",
        availableBackups: 1
      },
      accounts: [{ id: "a", email: "a@example.com", isActive: true, createdAt: 1, updatedAt: 2 }]
    });

    expect(signature).toContain("acct-1");
    expect(signature).toContain("a@example.com");
    expect(shouldRunAccountScheduler(0)).toBe(false);
    expect(shouldRunAccountScheduler(2)).toBe(true);
  });

  it("ignores legacy tag fields in refresh signatures", () => {
    const workbenchBase = buildWorkbenchRefreshSignature({
      observedAuthIdentity: "acct-1",
      indexHealth: {
        status: "healthy",
        availableBackups: 1
      },
      accounts: [{ id: "a", email: "a@example.com", tags: ["team"], isActive: true, createdAt: 1, updatedAt: 2 }]
    });
    const workbenchNext = buildWorkbenchRefreshSignature({
      observedAuthIdentity: "acct-1",
      indexHealth: {
        status: "healthy",
        availableBackups: 1
      },
      accounts: [{ id: "a", email: "a@example.com", tags: ["ops"], isActive: true, createdAt: 1, updatedAt: 2 }]
    });

    expect(workbenchBase).toBe(workbenchNext);

    const dashboardBase = buildDashboardStateSignature({
      lang: "en",
      panelTitle: "panel",
      brandSub: "brand",
      logoUri: "logo",
      settings: {
        dashboardTheme: "auto",
        codexAppRestartEnabled: false,
        codexAppRestartMode: "manual",
        autoRefreshMinutes: 0,
        autoRefreshCurrentMinutes: 0,
        autoSwitchEnabled: false,
        hourlyQuotaControlEnabled: false,
        autoSwitchReloadWindowEnabled: false,
        autoSwitchHourlyThreshold: 20,
        autoSwitchWeeklyThreshold: 20,
        autoSwitchLockMinutes: 0,
        codexAppPath: "",
        resolvedCodexAppPath: "",
        quotaWarningEnabled: false,
        quotaWarningThreshold: 20,
        quotaWarningWeeklyThreshold: 20,
        quotaGreenThreshold: 60,
        quotaYellowThreshold: 20,
        displayLanguage: "auto"
      },
      copy: {
        panelTitle: "panel",
        brandSub: "brand"
      } as never,
      tokenAutomation: {
        enabled: false
      },
      indexHealth: {
        status: "healthy",
        availableBackups: 1
      },
      accounts: [
        {
          id: "a",
          email: "a@example.com",
          displayName: "a@example.com",
          accountName: "Account",
          tags: ["team"],
          metrics: [],
          planTypeLabel: "Team",
          authProviderLabel: "google",
          isActive: true,
          isCurrentWindowAccount: false,
          showInStatusBar: false,
          canToggleStatusBar: true,
          statusToggleTitle: "toggle",
          healthKind: "healthy",
          healthLabel: "Healthy",
          dismissedHealth: false
        }
      ]
    });
    const dashboardNext = buildDashboardStateSignature({
      lang: "en",
      panelTitle: "panel",
      brandSub: "brand",
      logoUri: "logo",
      settings: {
        dashboardTheme: "auto",
        codexAppRestartEnabled: false,
        codexAppRestartMode: "manual",
        autoRefreshMinutes: 0,
        autoRefreshCurrentMinutes: 0,
        autoSwitchEnabled: false,
        hourlyQuotaControlEnabled: false,
        autoSwitchReloadWindowEnabled: false,
        autoSwitchHourlyThreshold: 20,
        autoSwitchWeeklyThreshold: 20,
        autoSwitchLockMinutes: 0,
        codexAppPath: "",
        resolvedCodexAppPath: "",
        quotaWarningEnabled: false,
        quotaWarningThreshold: 20,
        quotaWarningWeeklyThreshold: 20,
        quotaGreenThreshold: 60,
        quotaYellowThreshold: 20,
        displayLanguage: "auto"
      },
      copy: {
        panelTitle: "panel",
        brandSub: "brand"
      } as never,
      tokenAutomation: {
        enabled: false
      },
      indexHealth: {
        status: "healthy",
        availableBackups: 1
      },
      accounts: [
        {
          id: "a",
          email: "a@example.com",
          displayName: "a@example.com",
          accountName: "Account",
          tags: ["ops"],
          metrics: [],
          planTypeLabel: "Team",
          authProviderLabel: "google",
          isActive: true,
          isCurrentWindowAccount: false,
          showInStatusBar: false,
          canToggleStatusBar: true,
          statusToggleTitle: "toggle",
          healthKind: "healthy",
          healthLabel: "Healthy",
          dismissedHealth: false
        }
      ]
    });

    expect(dashboardBase).toBe(dashboardNext);
  });

  it("changes workbench signatures when token automation state changes", () => {
    const base = buildWorkbenchRefreshSignature({
      observedAuthIdentity: "acct-1",
      indexHealth: {
        status: "healthy",
        availableBackups: 1
      },
      accounts: [{ id: "a", email: "a@example.com", isActive: true, createdAt: 1, updatedAt: 2 }],
      tokenAutomation: {
        enabled: true,
        intervalMs: 300_000,
        skewSeconds: 600,
        lastSweepAt: 100,
        accounts: {
          a: {
            lastCheckAt: 100
          }
        }
      }
    });
    const next = buildWorkbenchRefreshSignature({
      observedAuthIdentity: "acct-1",
      indexHealth: {
        status: "healthy",
        availableBackups: 1
      },
      accounts: [{ id: "a", email: "a@example.com", isActive: true, createdAt: 1, updatedAt: 2 }],
      tokenAutomation: {
        enabled: true,
        intervalMs: 300_000,
        skewSeconds: 600,
        lastSweepAt: 200,
        accounts: {
          a: {
            lastCheckAt: 200,
            lastRefreshAt: 200
          }
        }
      }
    });

    expect(base).not.toBe(next);
  });
});
