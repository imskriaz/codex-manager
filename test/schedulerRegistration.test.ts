import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

const { refreshSingleQuotaSafelyMock, maybeAutoSwitchForActiveQuotaMock, maybeWarnForActiveQuotaMock } = vi.hoisted(() => ({
  refreshSingleQuotaSafelyMock: vi.fn(),
  maybeAutoSwitchForActiveQuotaMock: vi.fn(),
  maybeWarnForActiveQuotaMock: vi.fn()
}));

vi.mock("../src/application/accounts/quota", () => ({
  refreshSingleQuotaSafely: refreshSingleQuotaSafelyMock,
  maybeAutoSwitchForActiveQuota: maybeAutoSwitchForActiveQuotaMock,
  maybeWarnForActiveQuota: maybeWarnForActiveQuotaMock
}));

import {
  registerAutoRefreshScheduler,
  registerTokenRefreshScheduler
} from "../src/presentation/workbench/schedulerRegistration";
import type { AccountsRepository } from "../src/storage";

describe("auto refresh scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refreshSingleQuotaSafelyMock.mockReset().mockResolvedValue(true);
    maybeAutoSwitchForActiveQuotaMock.mockReset().mockResolvedValue(false);
    maybeWarnForActiveQuotaMock.mockReset().mockResolvedValue(undefined);
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
        allowTokenRefresh: false,
        forceRefresh: true,
        announceFailure: false,
        skipDisabled: false
      })
    );
    await vi.waitFor(() => expect(maybeAutoSwitchForActiveQuotaMock).toHaveBeenCalledWith(repo, expect.anything()));
    expect(maybeWarnForActiveQuotaMock).toHaveBeenCalledWith(repo);

    expect(refreshSingleQuotaSafelyMock.mock.invocationCallOrder[0]).toBeLessThan(
      maybeAutoSwitchForActiveQuotaMock.mock.invocationCallOrder[0]!
    );
    disposable.dispose();
  });

  it("pauses the periodic all-account sweep when safety refresh is enabled", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, fallback?: unknown) => {
        if (key === "autoRefreshMinutes") return 5;
        if (key === "autoRefreshCurrentMinutes") return 0;
        if (key === "autoSwitchRefreshAllBeforeSwitchEnabled") return true;
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
        if (key === "autoSwitchRefreshAllBeforeSwitchEnabled") return true;
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
        quotaSummary: { weeklyPercentage: 5, weeklyWindowMinutes: 10_080, weeklyWindowPresent: true }
      },
      {
        id: "candidate",
        isActive: false,
        enabled: true,
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
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledWith("codexManager.refreshAllQuotas", {
      silent: true,
      forceRefresh: true,
      excludeCurrent: false,
      respectQuotaCheckGap: false
    }));

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
      allowTokenRefresh: false,
      forceRefresh: true,
      announceFailure: false,
      skipDisabled: false
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
});
