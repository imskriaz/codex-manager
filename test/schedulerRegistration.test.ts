import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

const {
  refreshSingleQuotaSafelyMock,
  maybeAutoSwitchForActiveQuotaMock,
  maybeWarnForActiveQuotaMock,
  refreshTokensMock,
  needsTokenRefreshMock
} = vi.hoisted(() => ({
  refreshSingleQuotaSafelyMock: vi.fn(),
  maybeAutoSwitchForActiveQuotaMock: vi.fn(),
  maybeWarnForActiveQuotaMock: vi.fn(),
  refreshTokensMock: vi.fn(),
  needsTokenRefreshMock: vi.fn()
}));

vi.mock("../src/application/accounts/quota", () => ({
  refreshSingleQuotaSafely: refreshSingleQuotaSafelyMock,
  maybeAutoSwitchForActiveQuota: maybeAutoSwitchForActiveQuotaMock,
  maybeWarnForActiveQuota: maybeWarnForActiveQuotaMock
}));

vi.mock("../src/auth/oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth/oauth")>()),
  refreshTokens: refreshTokensMock,
  needsTokenRefresh: needsTokenRefreshMock
}));

import {
  registerAutoRefreshScheduler,
  registerTokenRefreshScheduler
} from "../src/presentation/workbench/schedulerRegistration";
import type { AccountsRepository } from "../src/storage";

describe("auto refresh scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(vscode.commands.executeCommand).mockReset().mockResolvedValue(undefined);
    refreshSingleQuotaSafelyMock.mockReset().mockResolvedValue(true);
    maybeAutoSwitchForActiveQuotaMock.mockReset().mockResolvedValue(false);
    maybeWarnForActiveQuotaMock.mockReset().mockResolvedValue(undefined);
    refreshTokensMock
      .mockReset()
      .mockResolvedValue({ accessToken: "fresh", idToken: "fresh-id", refreshToken: "rotated" });
    needsTokenRefreshMock.mockReset().mockReturnValue(true);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "autoRefreshMinutes") return 0;
        if (key === "autoRefreshCurrentMinutes") return 1;
        return fallback;
      }),
      update: vi.fn(),
      inspect: vi.fn()
    } as never);
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockReturnValue({ dispose: vi.fn() } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("evaluates auto switch immediately after each timed current-account refresh", async () => {
    const current = { id: "active", isActive: true, enabled: true };
    const repo = { listAccounts: vi.fn(async () => [current]) } as unknown as AccountsRepository;
    const onRefresh = vi.fn();
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh,
      canRefreshAccount: () => true
    });

    expect(refreshSingleQuotaSafelyMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() =>
      expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledWith(repo, expect.anything(), current.id, {
        allowTokenRefresh: true,
        forceRefresh: true,
        announceFailure: false,
        skipDisabled: false,
        canUseAccount: expect.any(Function)
      })
    );
    await vi.waitFor(() =>
      expect(maybeAutoSwitchForActiveQuotaMock).toHaveBeenCalledWith(repo, expect.anything(), {
        canUseAccount: expect.any(Function)
      })
    );
    expect(maybeWarnForActiveQuotaMock).toHaveBeenCalledWith(repo);

    expect(refreshSingleQuotaSafelyMock.mock.invocationCallOrder[0]).toBeLessThan(
      maybeAutoSwitchForActiveQuotaMock.mock.invocationCallOrder[0]!
    );
    disposable.dispose();
  });

  it("does not poll a current account owned by another PC", async () => {
    const current = { id: "foreign-owned", isActive: true, enabled: true };
    const repo = { listAccounts: vi.fn(async () => [current]) } as unknown as AccountsRepository;
    const canRefreshAccount = vi.fn(() => false);
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh: vi.fn(),
      canRefreshAccount
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(canRefreshAccount).toHaveBeenCalledWith(current.id));
    expect(refreshSingleQuotaSafelyMock).not.toHaveBeenCalled();
    expect(maybeAutoSwitchForActiveQuotaMock).not.toHaveBeenCalled();
    disposable.dispose();
  });

  it("refreshes an enabled account once when its known quota reset time is reached", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) =>
        key === "autoRefreshMinutes" ? 5 : key === "autoRefreshCurrentMinutes" ? 0 : fallback
    } as never);
    const resetAt = Date.now() / 1_000 + 5;
    const account = {
      id: "reset-due",
      email: "reset-due@example.com",
      isActive: false,
      enabled: true,
      quotaSummary: {
        hourlyPercentage: 0,
        hourlyResetTime: resetAt,
        hourlyWindowPresent: true,
        hourlyWindowMinutes: 300
      }
    };
    const repo = { listAccounts: vi.fn(async () => [account]) } as unknown as AccountsRepository;
    const onRefresh = vi.fn();
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh,
      canRefreshAccount: () => true
    });

    await vi.advanceTimersByTimeAsync(6_000);
    await vi.waitFor(() =>
      expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledWith(repo, expect.anything(), account.id, {
        allowTokenRefresh: true,
        forceRefresh: true,
        announceFailure: false,
        skipDisabled: true,
        canUseAccount: expect.any(Function)
      })
    );
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(1);
    disposable.dispose();
  });

  it("refreshes only the account whose cached reset is already due at startup", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) =>
        key === "autoRefreshMinutes" ? 5 : key === "autoRefreshCurrentMinutes" ? 0 : fallback
    } as never);
    const due = {
      id: "due-at-start",
      email: "due-at-start@example.com",
      isActive: false,
      enabled: true,
      quotaSummary: { hourlyResetTime: Date.now() / 1_000 - 1 }
    };
    const fresh = {
      id: "still-fresh",
      email: "still-fresh@example.com",
      isActive: false,
      enabled: true,
      quotaSummary: { hourlyResetTime: Date.now() / 1_000 + 3_600 }
    };
    const repo = { listAccounts: vi.fn(async () => [due, fresh]) } as unknown as AccountsRepository;
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh: vi.fn(),
      canRefreshAccount: () => true
    });

    await vi.waitFor(() => expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(1));
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledWith(repo, expect.anything(), due.id, expect.any(Object));
    expect(refreshSingleQuotaSafelyMock).not.toHaveBeenCalledWith(repo, expect.anything(), fresh.id, expect.anything());
    disposable.dispose();
  });

  it("retries a failed due-reset refresh without acknowledging the failed snapshot", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) =>
        key === "autoRefreshMinutes" ? 5 : key === "autoRefreshCurrentMinutes" ? 0 : fallback
    } as never);
    const account = { id: "reset-retry", enabled: true, quotaSummary: { weeklyResetTime: Date.now() / 1_000 - 2 } };
    const repo = { listAccounts: vi.fn(async () => [account]) } as unknown as AccountsRepository;
    refreshSingleQuotaSafelyMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh: vi.fn()
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(1);
    expect(maybeAutoSwitchForActiveQuotaMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(2);
    expect(maybeAutoSwitchForActiveQuotaMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(2);
    disposable.dispose();
  });

  it("bounds reset failures and leaves continued recovery to the configured cadence", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) =>
        key === "autoRefreshMinutes" ? 5 : key === "autoRefreshCurrentMinutes" ? 0 : fallback
    } as never);
    const resetAt = Date.now() / 1_000 - 2;
    const repo = {
      listAccounts: vi.fn(async () => [
        { id: "bounded-reset", enabled: true, quotaSummary: { weeklyResetTime: resetAt } }
      ])
    } as unknown as AccountsRepository;
    refreshSingleQuotaSafelyMock.mockResolvedValue(false);
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh: vi.fn()
    });
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(6);
    expect(maybeAutoSwitchForActiveQuotaMock).not.toHaveBeenCalled();
    disposable.dispose();
  });

  it("backs off a transient reset snapshot read failure", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) =>
        key === "autoRefreshMinutes" ? 5 : key === "autoRefreshCurrentMinutes" ? 0 : fallback
    } as never);
    const account = { id: "read-retry", enabled: true, quotaSummary: { weeklyResetTime: Date.now() / 1_000 - 2 } };
    const listAccounts = vi
      .fn()
      .mockResolvedValue([account])
      .mockResolvedValueOnce([account])
      .mockRejectedValueOnce(new Error("Temporary storage failure"));
    const repo = { listAccounts } as unknown as AccountsRepository;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh: vi.fn()
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshSingleQuotaSafelyMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(refreshSingleQuotaSafelyMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(1);
    disposable.dispose();
  });

  it("does not refresh a due reset when both configured quota cadences are off", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) =>
        key === "autoRefreshMinutes" || key === "autoRefreshCurrentMinutes" ? 0 : fallback
    } as never);
    const repo = {
      listAccounts: vi.fn(async () => [
        {
          id: "disabled-cadence",
          isActive: true,
          enabled: true,
          quotaSummary: { weeklyResetTime: Date.now() / 1_000 - 2 }
        }
      ])
    } as unknown as AccountsRepository;
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh: vi.fn()
    });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refreshSingleQuotaSafelyMock).not.toHaveBeenCalled();
    expect(maybeAutoSwitchForActiveQuotaMock).not.toHaveBeenCalled();
    disposable.dispose();
  });

  it("does not poll an inactive reset through the current-account cadence", async () => {
    const repo = {
      listAccounts: vi.fn(async () => [
        { id: "inactive", isActive: false, enabled: true, quotaSummary: { weeklyResetTime: Date.now() / 1_000 - 2 } }
      ])
    } as unknown as AccountsRepository;
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh: vi.fn()
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshSingleQuotaSafelyMock).not.toHaveBeenCalled();
    disposable.dispose();
  });

  it("does not recreate quota-reset timers after disposal", async () => {
    const resetAt = Date.now() / 1_000 + 5;
    const account = {
      id: "reset-dispose",
      email: "reset-dispose@example.com",
      isActive: false,
      enabled: true,
      quotaSummary: { hourlyResetTime: resetAt }
    };
    const repo = { listAccounts: vi.fn(async () => [account]) } as unknown as AccountsRepository;
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh: vi.fn()
    });
    disposable.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshSingleQuotaSafelyMock).not.toHaveBeenCalled();
  });

  it("pauses the periodic all-account sweep when safety refresh is enabled", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "autoRefreshMinutes") return 5;
        if (key === "autoRefreshCurrentMinutes") return 0;
        if (key === "autoSwitchRefreshAllBeforeSwitchEnabled" || key === "autoSwitchEnabled") return true;
        return fallback;
      }),
      update: vi.fn(),
      inspect: vi.fn()
    } as never);
    const executeCommand = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const repo = { listAccounts: vi.fn(async () => []) } as unknown as AccountsRepository;
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh: vi.fn()
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(executeCommand).not.toHaveBeenCalledWith("codexManager.refreshAllQuotas", expect.anything());
    disposable.dispose();
  });

  it("resumes an all-account sweep, including the active account, while every account is below auto-switch limits", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "autoRefreshMinutes") return 5;
        if (key === "autoRefreshCurrentMinutes") return 0;
        if (key === "autoSwitchRefreshAllBeforeSwitchEnabled" || key === "autoSwitchEnabled") return true;
        if (key === "autoSwitchHourlyThreshold") return 20;
        if (key === "autoSwitchWeeklyThreshold") return 20;
        if (key === "hourlyQuotaControlEnabled") return false;
        return fallback;
      }),
      update: vi.fn(),
      inspect: vi.fn()
    } as never);
    const executeCommand = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const accounts = [
      {
        id: "active",
        isActive: true,
        enabled: true,
        lastQuotaAt: Date.now(),
        quotaSummary: { weeklyPercentage: 5, weeklyWindowMinutes: 10_080, weeklyWindowPresent: true }
      },
      {
        id: "candidate",
        isActive: false,
        enabled: true,
        lastQuotaAt: Date.now(),
        quotaSummary: { weeklyPercentage: 10, weeklyWindowMinutes: 10_080, weeklyWindowPresent: true }
      }
    ];
    const repo = { listAccounts: vi.fn(async () => accounts) } as unknown as AccountsRepository;
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh: vi.fn()
    });

    expect(executeCommand).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() =>
      expect(executeCommand).toHaveBeenCalledWith("codexManager.refreshAllQuotas", {
        silent: true,
        forceRefresh: true,
        excludeCurrent: false,
        respectQuotaCheckGap: false
      })
    );

    accounts[1].quotaSummary.weeklyPercentage = 50;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    disposable.dispose();
  });

  it("refreshes the active account even when local enablement is disabled", async () => {
    const current = { id: "active", isActive: true, enabled: false };
    const repo = { listAccounts: vi.fn(async () => [current]) } as unknown as AccountsRepository;
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh: vi.fn(),
      canRefreshAccount: () => true
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(refreshSingleQuotaSafelyMock).toHaveBeenCalled());
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledWith(repo, expect.anything(), current.id, {
      allowTokenRefresh: true,
      forceRefresh: true,
      announceFailure: false,
      skipDisabled: false,
      canUseAccount: expect.any(Function)
    });
    disposable.dispose();
  });

  it("does not evaluate auto switch after a failed timed refresh", async () => {
    refreshSingleQuotaSafelyMock.mockResolvedValue(false);
    const current = { id: "active", isActive: true, enabled: true };
    const repo = { listAccounts: vi.fn(async () => [current]) } as unknown as AccountsRepository;
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh: vi.fn(),
      canRefreshAccount: () => true
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(refreshSingleQuotaSafelyMock).toHaveBeenCalled());
    expect(maybeAutoSwitchForActiveQuotaMock).not.toHaveBeenCalled();
    disposable.dispose();
  });

  it("checks quota warnings when auto-switch does not run", async () => {
    const current = { id: "active", isActive: true, enabled: true };
    const repo = { listAccounts: vi.fn(async () => [current]) } as unknown as AccountsRepository;
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh: vi.fn(),
      canRefreshAccount: () => true
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(maybeWarnForActiveQuotaMock).toHaveBeenCalledWith(repo));
    disposable.dispose();
  });

  it("does not show a quota warning after the timed refresh auto-switches accounts", async () => {
    maybeAutoSwitchForActiveQuotaMock.mockResolvedValue(true);
    const current = { id: "active", isActive: true, enabled: true };
    const repo = { listAccounts: vi.fn(async () => [current]) } as unknown as AccountsRepository;
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh: vi.fn(),
      canRefreshAccount: () => true
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(maybeAutoSwitchForActiveQuotaMock).toHaveBeenCalled());
    expect(maybeWarnForActiveQuotaMock).not.toHaveBeenCalled();
    disposable.dispose();
  });

  it("uses a five-times delay after failure and resets it after success", async () => {
    const callTimes: number[] = [];
    refreshSingleQuotaSafelyMock.mockReset().mockImplementation(async () => {
      callTimes.push(Date.now());
      return callTimes.length > 1;
    });
    const current = { id: "active", isActive: true, enabled: true };
    const repo = { listAccounts: vi.fn(async () => [current]) } as unknown as AccountsRepository;
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh: vi.fn(),
      canRefreshAccount: () => true
    });

    expect(callTimes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(callTimes).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(callTimes).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(callTimes).toHaveLength(3);

    disposable.dispose();
  });

  it.each(["disabled", "unowned", "disposed", "config-changed"])(
    "stops a token refresh changed during the token read: %s",
    async (change) => {
      let releaseTokens: ((tokens: { accessToken: string; idToken: string; refreshToken: string }) => void) | undefined;
      let configurationChanged: ((event: vscode.ConfigurationChangeEvent) => void) | undefined;
      vi.mocked(vscode.workspace.onDidChangeConfiguration).mockImplementation((listener) => {
        configurationChanged = listener;
        return { dispose: vi.fn() };
      });
      const account = { id: "token-guard", enabled: true, tokenRefreshEnabled: true };
      const repo = {
        listAccounts: vi.fn(async () => [account]),
        getAccount: vi.fn(async () => account),
        getTokens: vi.fn(
          () =>
            new Promise((resolve) => {
              releaseTokens = resolve;
            })
        ),
        updateTokens: vi.fn()
      } as unknown as AccountsRepository;
      let owned = true;
      const disposable = registerTokenRefreshScheduler({
        context: { subscriptions: [] } as never,
        repo,
        view: { refresh: vi.fn() },
        checkIntervalMs: 60_000,
        skewSeconds: 300,
        canRefreshAccount: () => owned
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(repo.getTokens).toHaveBeenCalledTimes(1));
      if (change === "disabled") account.tokenRefreshEnabled = false;
      if (change === "unowned") owned = false;
      if (change === "disposed") disposable.dispose();
      if (change === "config-changed") configurationChanged?.({ affectsConfiguration: () => true } as never);
      releaseTokens?.({ accessToken: "old", idToken: "id", refreshToken: "old-refresh" });
      await vi.advanceTimersByTimeAsync(0);
      expect(refreshTokensMock).not.toHaveBeenCalled();
      expect(repo.updateTokens).not.toHaveBeenCalled();
      disposable.dispose();
    }
  );

  it("persists an already issued refresh result after disposal and stops the rest of the sweep", async () => {
    let releaseRefresh: ((tokens: { accessToken: string; idToken: string; refreshToken: string }) => void) | undefined;
    refreshTokensMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRefresh = resolve;
        })
    );
    const accounts = ["first", "second"].map((id) => ({ id, enabled: true, tokenRefreshEnabled: true }));
    const repo = {
      listAccounts: vi.fn(async () => accounts),
      getAccount: vi.fn(async (id: string) => accounts.find((account) => account.id === id)),
      getTokens: vi.fn(async () => ({ accessToken: "old", idToken: "id", refreshToken: "old-refresh" })),
      updateTokens: vi.fn(async () => accounts[0])
    } as unknown as AccountsRepository;
    const view = { refresh: vi.fn() };
    const disposable = registerTokenRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      view,
      checkIntervalMs: 60_000,
      skewSeconds: 300
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(refreshTokensMock).toHaveBeenCalledTimes(1));
    disposable.dispose();
    releaseRefresh?.({ accessToken: "fresh", idToken: "fresh-id", refreshToken: "rotated" });
    await vi.advanceTimersByTimeAsync(0);
    expect(repo.updateTokens).toHaveBeenCalledWith("first", expect.objectContaining({ refreshToken: "rotated" }));
    expect(repo.getTokens).toHaveBeenCalledTimes(1);
    expect(view.refresh).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not create a token timer for an invalid interval %s",
    async (interval) => {
      const repo = { listAccounts: vi.fn(async () => []) } as unknown as AccountsRepository;
      const disposable = registerTokenRefreshScheduler({
        context: { subscriptions: [] } as never,
        repo,
        view: { refresh: vi.fn() },
        checkIntervalMs: interval,
        skewSeconds: 300
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(repo.listAccounts).not.toHaveBeenCalled();
      disposable.dispose();
    }
  );

  it("does not start extension-managed token refresh when the setting is unset", async () => {
    const repo = { listAccounts: vi.fn(async () => []) } as unknown as AccountsRepository;
    const disposable = registerTokenRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      view: { refresh: vi.fn() },
      checkIntervalMs: 60_000,
      skewSeconds: 300
    });

    await Promise.resolve();
    expect(repo.listAccounts).not.toHaveBeenCalled();
    disposable.dispose();
  });

  it("does not refresh accounts that have not explicitly opted into token automation", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => (key === "backgroundTokenRefreshEnabled" ? true : fallback)),
      update: vi.fn(),
      inspect: vi.fn()
    } as never);
    const repo = {
      listAccounts: vi.fn(async () => [{ id: "legacy", enabled: true }]),
      getTokens: vi.fn()
    } as unknown as AccountsRepository;
    const disposable = registerTokenRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      view: { refresh: vi.fn() },
      checkIntervalMs: 60_000,
      skewSeconds: 300
    });

    expect(repo.listAccounts).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(repo.listAccounts).toHaveBeenCalled());
    expect(repo.getTokens).not.toHaveBeenCalled();
    disposable.dispose();
  });

  it("does not rotate tokens for an account owned by another PC", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => (key === "backgroundTokenRefreshEnabled" ? true : fallback)),
      update: vi.fn(),
      inspect: vi.fn()
    } as never);
    const repo = {
      listAccounts: vi.fn(async () => [{ id: "foreign-owned", enabled: true, tokenRefreshEnabled: true }]),
      getTokens: vi.fn()
    } as unknown as AccountsRepository;
    const canRefreshAccount = vi.fn(() => false);
    const disposable = registerTokenRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      view: { refresh: vi.fn() },
      checkIntervalMs: 60_000,
      skewSeconds: 300,
      canRefreshAccount
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(canRefreshAccount).toHaveBeenCalledWith("foreign-owned"));
    expect(repo.getTokens).not.toHaveBeenCalled();
    disposable.dispose();
  });
});
