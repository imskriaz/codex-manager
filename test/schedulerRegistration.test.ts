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
  isAutoSwitchWaitingForSessions: vi.fn(() => false),
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
import { isAutoSwitchWaitingForSessions } from "../src/application/accounts/quota";
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

  it("retries a deferred switch even with quota timers disabled and stops on disposal", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (_key: string, fallback: unknown) => typeof fallback === "number" ? 0 : fallback } as never);
    vi.mocked(isAutoSwitchWaitingForSessions).mockReturnValue(true);
    const scheduler = registerAutoRefreshScheduler({ context: { subscriptions: [] } as never, repo: { listAccounts: async () => [] } as never, onRefresh: vi.fn() });
    await vi.advanceTimersByTimeAsync(5000);
    expect(maybeAutoSwitchForActiveQuotaMock).toHaveBeenCalledTimes(1);
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(maybeAutoSwitchForActiveQuotaMock).toHaveBeenCalledTimes(1);
    vi.mocked(isAutoSwitchWaitingForSessions).mockReturnValue(false);
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

  it("re-evaluates cached quota immediately when Auto Switch settings change", async () => {
    let configurationChanged: ((event: vscode.ConfigurationChangeEvent) => void) | undefined;
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockImplementation((listener) => {
      configurationChanged = listener;
      return { dispose: vi.fn() };
    });
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => key === "autoSwitchEnabled" ? true : fallback),
      update: vi.fn(),
      inspect: vi.fn()
    } as never);
    const repo = { listAccounts: vi.fn(async () => []) } as unknown as AccountsRepository;
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh: vi.fn(),
      canRefreshAccount: () => true
    });

    configurationChanged?.({
      affectsConfiguration: (section: string) => section === "codexManager.autoSwitchHourlyThreshold"
    } as never);
    await vi.waitFor(() => expect(maybeAutoSwitchForActiveQuotaMock).toHaveBeenCalledWith(
      repo,
      expect.anything(),
      { canUseAccount: expect.any(Function) }
    ));
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
    refreshSingleQuotaSafelyMock.mockImplementationOnce(async () => {
      account.quotaSummary.hourlyPercentage = 100;
      account.quotaSummary.hourlyResetTime = Date.now() / 1000 + 3600;
      return true;
    });
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh,
      canRefreshAccount: () => true
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(refreshSingleQuotaSafelyMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
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

  it("refreshes a due reset once even when both periodic quota cadences are off", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) =>
        key === "autoRefreshMinutes" || key === "autoRefreshCurrentMinutes" ? 0 : fallback
    } as never);
    const resetAt = Date.now() / 1_000 - 2;
    const repo = {
      listAccounts: vi.fn(async () => [
        {
          id: "disabled-cadence",
          isActive: true,
          enabled: true,
          quotaSummary: { weeklyResetTime: resetAt }
        }
      ])
    } as unknown as AccountsRepository;
    const disposable = registerAutoRefreshScheduler({
      context: { subscriptions: [] } as never,
      repo,
      onRefresh: vi.fn()
    });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledOnce();
    expect(maybeAutoSwitchForActiveQuotaMock).toHaveBeenCalledOnce();
    disposable.dispose();
  });

  it("refreshes an inactive account on expiry when only current-account auto-refresh is enabled", async () => {
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
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledWith(repo, expect.anything(), "inactive", expect.anything());
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(1);
    disposable.dispose();
  });

  it.each(["review", "additional-hourly", "additional-weekly"])("refreshes when the %s countdown expires", async (window) => {
    const resetAt = Date.now() / 1_000 + 3;
    const quotaSummary = window === "review"
      ? { codeReviewWindowPresent: true, codeReviewResetTime: resetAt }
      : { additionalRateLimits: [{
          limitName: "Model quota",
          hourlyWindowPresent: window === "additional-hourly",
          hourlyResetTime: resetAt,
          weeklyWindowPresent: window === "additional-weekly",
          weeklyResetTime: resetAt
        }] };
    const repo = { listAccounts: vi.fn(async () => [{ id: window, enabled: true, quotaSummary }]) } as unknown as AccountsRepository;
    const scheduler = registerAutoRefreshScheduler({ context: { subscriptions: [] } as never, repo, onRefresh: vi.fn() });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(refreshSingleQuotaSafelyMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it("ignores missing, invalid, hidden and disabled reset windows", async () => {
    const due = Date.now() / 1_000 - 2;
    const accounts = [
      { id: "missing", enabled: true },
      { id: "invalid", enabled: true, quotaSummary: { hourlyResetTime: Number.NaN, weeklyResetTime: Number.POSITIVE_INFINITY, codeReviewWindowPresent: true, codeReviewResetTime: -1 } },
      { id: "hidden", enabled: true, quotaSummary: { hourlyWindowPresent: false, hourlyResetTime: due, weeklyWindowPresent: false, weeklyResetTime: due, codeReviewWindowPresent: false, codeReviewResetTime: due, additionalRateLimits: [
        { limitName: "Model quota", hourlyWindowPresent: false, hourlyResetTime: due },
        { limitName: "Reserve quota", weeklyWindowPresent: true, weeklyResetTime: due }
      ] } },
      { id: "disabled", enabled: false, isActive: false, quotaSummary: { weeklyResetTime: due } }
    ];
    const repo = { listAccounts: vi.fn(async () => accounts) } as unknown as AccountsRepository;
    const scheduler = registerAutoRefreshScheduler({ context: { subscriptions: [] } as never, repo, onRefresh: vi.fn() });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refreshSingleQuotaSafelyMock).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("discovers an account added after startup and schedules changed reset deadlines", async () => {
    const accounts = [] as Array<{ id: string; enabled: boolean; quotaSummary: { weeklyResetTime: number } }>;
    const repo = { listAccounts: vi.fn(async () => accounts) } as unknown as AccountsRepository;
    const scheduler = registerAutoRefreshScheduler({ context: { subscriptions: [] } as never, repo, onRefresh: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    accounts.push({ id: "imported", enabled: true, quotaSummary: { weeklyResetTime: (Date.now() + 8_000) / 1_000 } });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(1);
    accounts[0].quotaSummary.weeklyResetTime = (Date.now() + 4_000) / 1_000;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it.each(["removed", "disabled", "postponed"])("rechecks a deadline whose account was %s", async (change) => {
    const accounts = [{ id: "changed", enabled: true, quotaSummary: { weeklyResetTime: (Date.now() + 3_000) / 1_000 } }];
    const repo = { listAccounts: vi.fn(async () => accounts) } as unknown as AccountsRepository;
    const scheduler = registerAutoRefreshScheduler({ context: { subscriptions: [] } as never, repo, onRefresh: vi.fn() });
    await vi.advanceTimersByTimeAsync(1_000);
    if (change === "removed") accounts.pop();
    if (change === "disabled") accounts[0].enabled = false;
    if (change === "postponed") accounts[0].quotaSummary.weeklyResetTime += 3_600;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(refreshSingleQuotaSafelyMock).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("recovers a failed initial snapshot read without waiting for the periodic cadence", async () => {
    const account = { id: "initial-read-retry", enabled: true, quotaSummary: { weeklyResetTime: Date.now() / 1_000 - 2 } };
    const repo = { listAccounts: vi.fn().mockResolvedValue([account]).mockRejectedValueOnce(new Error("Storage unavailable")) } as unknown as AccountsRepository;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const scheduler = registerAutoRefreshScheduler({ context: { subscriptions: [] } as never, repo, onRefresh: vi.fn() });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(refreshSingleQuotaSafelyMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it("refreshes after ownership returns without exhausting failure retries while unowned", async () => {
    let owned = false;
    const account = { id: "ownership-recovery", enabled: true, quotaSummary: { weeklyResetTime: Date.now() / 1_000 - 2 } };
    const repo = { listAccounts: vi.fn(async () => [account]) } as unknown as AccountsRepository;
    const scheduler = registerAutoRefreshScheduler({ context: { subscriptions: [] } as never, repo, onRefresh: vi.fn(), canRefreshAccount: () => owned });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(refreshSingleQuotaSafelyMock).not.toHaveBeenCalled();
    owned = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it("shares simultaneous deadlines and does not duplicate an in-flight expiry refresh", async () => {
    let finish: ((value: boolean) => void) | undefined;
    refreshSingleQuotaSafelyMock.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const due = Date.now() / 1_000 - 2;
    const account = { id: "in-flight", enabled: true, quotaSummary: { hourlyResetTime: due, weeklyResetTime: due, codeReviewWindowPresent: true, codeReviewResetTime: due } };
    const repo = { listAccounts: vi.fn(async () => [account]) } as unknown as AccountsRepository;
    const scheduler = registerAutoRefreshScheduler({ context: { subscriptions: [] } as never, repo, onRefresh: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(1);
    finish?.(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it("keeps a pending countdown refresh when periodic polling is turned off", async () => {
    let enabled = true;
    let configurationChanged: ((event: vscode.ConfigurationChangeEvent) => void) | undefined;
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) => key === "autoRefreshMinutes" ? (enabled ? 5 : 0) : key === "autoRefreshCurrentMinutes" ? 0 : fallback
    } as never);
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockImplementation((listener) => {
      configurationChanged = listener;
      return { dispose: vi.fn() };
    });
    const account = { id: "config-reset", enabled: true, quotaSummary: { weeklyResetTime: (Date.now() + 3_000) / 1_000 } };
    const repo = { listAccounts: vi.fn(async () => [account]) } as unknown as AccountsRepository;
    const scheduler = registerAutoRefreshScheduler({ context: { subscriptions: [] } as never, repo, onRefresh: vi.fn() });
    await vi.advanceTimersByTimeAsync(1_000);
    enabled = false;
    configurationChanged?.({ affectsConfiguration: (key: string) => key === "codexManager.autoRefreshMinutes" } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(1);
    enabled = true;
    configurationChanged?.({ affectsConfiguration: (key: string) => key === "codexManager.autoRefreshMinutes" } as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it("retries an expired countdown that still reports zero, then stops after quota recovers", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback: unknown) =>
      key === "autoRefreshMinutes" || key === "autoRefreshCurrentMinutes" ? 0 : fallback } as never);
    const account = { id: "still-zero", enabled: true, lastQuotaAt: Date.now(),
      quotaSummary: { weeklyPercentage: 0, weeklyResetTime: Date.now() / 1000 - 2 } };
    const repo = { listAccounts: vi.fn(async () => [account]) } as unknown as AccountsRepository;
    const scheduler = registerAutoRefreshScheduler({ context: { subscriptions: [] } as never, repo, onRefresh: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledOnce();
    refreshSingleQuotaSafelyMock.mockImplementationOnce(async () => {
      account.quotaSummary.weeklyPercentage = 100;
      account.quotaSummary.weeklyResetTime = Date.now() / 1000 + 3600;
      account.lastQuotaAt = Date.now();
      return true;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it("reuses a successful post-reset refresh without another request after startup", async () => {
    const account = { id: "already-refreshed", enabled: true, lastQuotaAt: Date.now(),
      quotaSummary: { weeklyPercentage: 100, weeklyResetTime: Date.now() / 1000 - 2 } };
    const scheduler = registerAutoRefreshScheduler({ context: { subscriptions: [] } as never,
      repo: { listAccounts: async () => [account] } as never, onRefresh: vi.fn() });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refreshSingleQuotaSafelyMock).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("recovers an expired account after an extended outage when no periodic fallback covers it", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback: unknown) =>
      key === "autoRefreshMinutes" || key === "autoRefreshCurrentMinutes" ? 0 : fallback } as never);
    const account = { id: "outage-reset", enabled: true, quotaSummary: { weeklyPercentage: 0, weeklyResetTime: Date.now() / 1000 - 2 } };
    const scheduler = registerAutoRefreshScheduler({ context: { subscriptions: [] } as never,
      repo: { listAccounts: async () => [account] } as never, onRefresh: vi.fn() });
    refreshSingleQuotaSafelyMock.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(17 * 60_000);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(6);
    refreshSingleQuotaSafelyMock.mockImplementationOnce(async () => {
      account.quotaSummary.weeklyPercentage = 100;
      account.quotaSummary.weeklyResetTime = Date.now() / 1000 + 3600;
      return true;
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(refreshSingleQuotaSafelyMock).toHaveBeenCalledTimes(7);
    expect(maybeAutoSwitchForActiveQuotaMock).toHaveBeenCalledOnce();
    scheduler.dispose();
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
      refreshAccountTokens: vi.fn(async (id: string) => { const tokens = await refreshTokensMock(); await repo.updateTokens(id, tokens); return tokens; }),
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
