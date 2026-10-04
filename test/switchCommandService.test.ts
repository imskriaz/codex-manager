import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { AccountsCommandService, canIncludeInRefreshAll } from "../src/application/accounts/commandService";
import type { CodexManagerAccountRecord } from "../src/core/types";
import type { AccountsRepository } from "../src/storage";
import { setCurrentWindowRuntimeAccountId } from "../src/presentation/workbench/windowRuntimeAccount";

const { fetchResetCreditsMock, consumeResetCreditMock, refreshQuotaMock } = vi.hoisted(() => ({
  fetchResetCreditsMock: vi.fn(), consumeResetCreditMock: vi.fn(), refreshQuotaMock: vi.fn()
}));
vi.mock("../src/services/quota", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/services/quota")>(),
  fetchResetCredits: fetchResetCreditsMock,
  consumeResetCredit: consumeResetCreditMock,
  refreshQuota: refreshQuotaMock
}));

describe("manual account switch command", () => {
  beforeEach(() => {
    vi.mocked(vscode.commands.executeCommand).mockReset();
    vi.mocked(vscode.workspace.getConfiguration).mockReset().mockReturnValue({
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      update: vi.fn(),
      inspect: vi.fn()
    } as never);
    vi.mocked(vscode.window.showQuickPick).mockReset();
    vi.mocked(vscode.window.showInputBox).mockReset();
    vi.mocked(vscode.window.showInformationMessage).mockReset();
    setCurrentWindowRuntimeAccountId(undefined);
  });

  it("reports picker cancellation as a terminal user-visible outcome", async () => {
    const account = createAccount();
    const service = createService([account]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    await expect(service.switchAccount()).resolves.toEqual({ status: "cancelled" });

    expect(vscode.window.showQuickPick).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Switch account cancelled.");
  });

  it("returns the selected account and reports success when no reload is needed", async () => {
    const account = createAccount();
    const { service, repo } = createServiceWithRepo([account]);
    setCurrentWindowRuntimeAccountId(account.id);
    vi.mocked(vscode.window.showQuickPick).mockImplementation(async (items) => (items as never[])[0] as never);

    await expect(service.switchAccount()).resolves.toMatchObject({
      status: "switched",
      account: { id: account.id, email: account.email },
      reloadNeeded: false,
      reloaded: false
    });

    expect(repo.switchAccount).toHaveBeenCalledWith(account.id, { forceTokenRefresh: false });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(`Switched to ${account.email}.`);
  });

  it("switches and reloads Codex as one manual user action", async () => {
    const account = createAccount();
    const { service, repo } = createServiceWithRepo([account]);
    setCurrentWindowRuntimeAccountId("account-before-switch");
    vi.mocked(vscode.window.showQuickPick).mockImplementation(async (items) => (items as never[])[0] as never);
    enableAutomaticReload();
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);

    await expect(service.switchAccount()).resolves.toMatchObject({
      status: "switched",
      account: { id: account.id, email: account.email },
      reloadNeeded: true,
      reloaded: true
    });

    expect(repo.switchAccount).toHaveBeenCalledWith(account.id, { forceTokenRefresh: false });
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      `Switched to ${account.email}. Reloading Codex…`
    );
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(
      1,
      "codexManager.prepareDashboardForExtensionHostRestart",
      { autoResume: true }
    );
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(2, "notifications.clearAll");
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(3, "workbench.action.restartExtensionHost");
  });

  it("reports partial completion when the account switches but Codex cannot reload", async () => {
    const account = createAccount();
    const { service, repo } = createServiceWithRepo([account]);
    setCurrentWindowRuntimeAccountId("account-before-switch");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(vscode.window.showQuickPick).mockImplementation(async (items) => (items as never[])[0] as never);
    enableAutomaticReload();
    vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command: string) => {
      if (command === "workbench.action.restartExtensionHost" || command === "workbench.action.reloadWindow") {
        throw new Error("reload unavailable");
      }
      return undefined;
    });

    await expect(service.switchAccount()).rejects.toThrow(
      `Switched to ${account.email}, but VS Code could not reload: reload unavailable.`
    );

    expect(repo.switchAccount).toHaveBeenCalledOnce();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow");
  });

  it("revalidates a stale selected account before switching", async () => {
    const item = { ...createAccount(), isActive: false };
    const current = { ...item, isActive: true };
    const { service, repo } = createServiceWithRepo([current]);
    repo.getAccount.mockResolvedValue(current);

    await expect(service.switchAccount(item)).resolves.toMatchObject({ status: "already-active" });

    expect(repo.switchAccount).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(`${current.email} is already the active account`);
  });

  it("password-enables Rescue before a Command Palette switch to a claimed account", async () => {
    const account = createAccount();
    const { repo } = createServiceWithRepo([account]);
    const enableRescue = vi.fn().mockResolvedValue(true);
    const service = new AccountsCommandService(
      {} as vscode.ExtensionContext,
      repo,
      { refresh: vi.fn(), markObservedAuthIdentity: vi.fn() },
      () => false,
      undefined,
      () => false,
      enableRescue
    );
    setCurrentWindowRuntimeAccountId(account.id);
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("shared-password");

    await expect(service.switchAccount(account)).resolves.toMatchObject({ status: "switched" });

    expect(vscode.window.showInputBox).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Switch claimed account", password: true })
    );
    expect(enableRescue).toHaveBeenCalledWith("shared-password");
    expect(repo.switchAccount).toHaveBeenCalledWith(account.id, { forceTokenRefresh: false });
  });
});

function enableAutomaticReload(): void {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: (key: string, defaultValue?: unknown) => key === "autoSwitchReloadWindowEnabled" ? true : defaultValue,
    update: vi.fn(),
    inspect: vi.fn()
  } as never);
}

describe("refresh all quota eligibility", () => {
  it("skips an account when its foreign claim is enforced with rescue off", () => {
    const canRefreshAccount = vi.fn().mockReturnValue(false);

    expect(canIncludeInRefreshAll({ id: "claimed-account" }, canRefreshAccount)).toBe(false);
    expect(canRefreshAccount).toHaveBeenCalledWith("claimed-account");
  });

  it("includes an account when rescue permits refreshing its foreign claim", () => {
    expect(canIncludeInRefreshAll({ id: "rescued-account" }, () => true)).toBe(true);
  });
});

function createService(accounts: CodexManagerAccountRecord[]): AccountsCommandService {
  return createServiceWithRepo(accounts).service;
}

function createServiceWithRepo(accounts: CodexManagerAccountRecord[]) {
  const repo = {
    listAccounts: vi.fn().mockResolvedValue(accounts),
    getAccount: vi.fn(async (id: string) => accounts.find((account) => account.id === id)),
    switchAccount: vi.fn().mockResolvedValue(accounts[0])
  } as unknown as AccountsRepository & { switchAccount: ReturnType<typeof vi.fn> };
  const service = new AccountsCommandService(
    {} as vscode.ExtensionContext,
    repo,
    { refresh: vi.fn(), markObservedAuthIdentity: vi.fn() }
  );
  return { service, repo };
}

function createAccount(): CodexManagerAccountRecord {
  return {
    id: "account-next",
    email: "next@example.com",
    isActive: false,
    enabled: true,
    tokenRefreshEnabled: false,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z"
  } as CodexManagerAccountRecord;
}

describe("manual quota reset command", () => {
  beforeEach(() => {
    fetchResetCreditsMock.mockReset();
    consumeResetCreditMock.mockReset().mockResolvedValue(undefined);
    refreshQuotaMock.mockReset();
    vi.mocked(vscode.window.showWarningMessage).mockReset().mockResolvedValue("Reset Rate Limit" as never);
    vi.mocked(vscode.window.showInformationMessage).mockReset();
    vi.mocked(vscode.window.showQuickPick).mockReset();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (_key: string, fallback?: unknown) => fallback
    } as never);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("reports verified completion after durable redemption and fresh quota while Auto Reset is off", async () => {
    const { account, repo, service } = createManualResetService();
    await service.consumeResetCredit(account);
    expect(consumeResetCreditMock).toHaveBeenCalledWith("manual-reset-access", undefined, expect.stringMatching(/^cr-/));
    expect(refreshQuotaMock).toHaveBeenCalledOnce();
    expect(repo.beginResetCreditAttempt).toHaveBeenCalledOnce();
    expect(repo.completeResetCreditAttempt).toHaveBeenCalledOnce();
    expect(account.resetCreditAttempt).toBeUndefined();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(`Quota reset verified for ${account.email}.`);
  });

  it("reports confirmation cancellation without requesting a reset", async () => {
    const { account, service } = createManualResetService();
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined);
    await service.consumeResetCredit(account);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Quota reset cancelled.");
    expect(fetchResetCreditsMock).not.toHaveBeenCalled();
    expect(consumeResetCreditMock).not.toHaveBeenCalled();
  });

  it("reports account picker cancellation as a terminal outcome", async () => {
    const { service } = createManualResetService();
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);
    await service.consumeResetCredit();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Quota reset cancelled.");
    expect(consumeResetCreditMock).not.toHaveBeenCalled();
  });

  it("revalidates a stale item against the current reserve before confirmation", async () => {
    const { account, service } = createManualResetService();
    const stale = { ...account, quotaSummary: { ...account.quotaSummary!, resetCreditsAvailable: 9 } };
    account.quotaSummary!.resetCreditsAvailable = 0;
    await expect(service.consumeResetCredit(stale)).rejects.toThrow("No reset credits available");
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(consumeResetCreditMock).not.toHaveBeenCalled();
  });

  it("retains uncertainty through retries after a lost POST response", async () => {
    const { account, repo, service } = createManualResetService();
    consumeResetCreditMock.mockRejectedValueOnce(new Error("POST response lost"));
    await expect(service.consumeResetCredit(account)).rejects.toThrow("POST response lost");
    await expect(service.consumeResetCredit(account)).rejects.toThrow("unverified outcome");
    expect(consumeResetCreditMock).toHaveBeenCalledOnce();
    expect(account.resetCreditAttempt).toBeDefined();
    expect(repo.completeResetCreditAttempt).not.toHaveBeenCalled();
  });

  it("does not claim verified success when the post-reset refresh fails", async () => {
    const { account, repo, service } = createManualResetService();
    refreshQuotaMock.mockRejectedValueOnce(new Error("verification offline"));
    await expect(service.consumeResetCredit(account)).rejects.toThrow("verification offline");
    expect(account.resetCreditAttempt).toBeDefined();
    expect(repo.completeResetCreditAttempt).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(expect.stringContaining("verified"));
  });

  it("does not report verified success when the reserve expires while its fence is stored", async () => {
    const { account, repo, service } = createManualResetService();
    const startedAt = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    fetchResetCreditsMock.mockReset().mockResolvedValue({ availableCount: 1,
      credits: [{ id: "expiring-manual-credit", status: "available" }], nextExpiresAt: startedAt / 1000 + 0.5 });
    repo.beginResetCreditAttempt.mockImplementationOnce(async (_id, requestId, availableBefore) => {
      account.resetCreditAttempt = { requestId, attemptedAt: startedAt, availableBefore };
      now.mockReturnValue(startedAt + 1000);
    });
    await expect(service.consumeResetCredit(account)).rejects.toThrow(/cancelled|expired|no usable/i);
    expect(consumeResetCreditMock).not.toHaveBeenCalled();
    expect(account.resetCreditAttempt).toBeUndefined();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalledWith(expect.stringContaining("verified"));
  });
});

let manualResetFixtureId = 0;
function createManualResetService() {
  const quota = () => ({ hourlyPercentage: 90, hourlyWindowMinutes: 300, hourlyWindowPresent: true,
    weeklyPercentage: 90, weeklyWindowMinutes: 10080, weeklyWindowPresent: true, codeReviewPercentage: 0 });
  const account: CodexManagerAccountRecord = {
    id: `manual-reset-${++manualResetFixtureId}`, email: "reset@example.com", createdAt: 1, updatedAt: 1,
    lastQuotaAt: Date.now(), isActive: false,
    quotaSummary: { ...quota(), hourlyPercentage: 0, weeklyPercentage: 0, resetCreditsAvailable: 1 }
  };
  fetchResetCreditsMock.mockResolvedValue({ availableCount: 0, credits: [] })
    .mockResolvedValueOnce({ availableCount: 1, credits: [{ id: "manual-credit", status: "available" }] });
  refreshQuotaMock.mockImplementation(async () => ({ quota: quota(), requestStartedAt: Date.now() }));
  const flush = vi.fn(async () => undefined);
  const repo = {
    listAccounts: vi.fn(async () => [account]),
    getAccount: vi.fn(async () => account),
    getTokens: vi.fn(async () => ({ idToken: "id", accessToken: "manual-reset-access" })),
    updateQuota: vi.fn(async (_id: string, next: CodexManagerAccountRecord["quotaSummary"], error?: CodexManagerAccountRecord["quotaError"]) => {
      account.quotaSummary = next; account.quotaError = error; account.lastQuotaAt = Date.now(); return account;
    }),
    refreshSubscriptionState: vi.fn(async () => undefined),
    updateResetCreditsSnapshot: vi.fn(async (_id: string, count: number, expiry?: number, ids?: string[]) => {
      Object.assign(account.quotaSummary!, { resetCreditsAvailable: count, resetCreditsNextExpiresAt: expiry,
        resetCreditsAvailableIds: ids ?? [] });
    }),
    beginResetCreditAttempt: vi.fn(async (_id: string, requestId: string, availableBefore: number) => {
      account.resetCreditAttempt = { requestId, attemptedAt: Date.now(), availableBefore }; await flush();
    }),
    completeResetCreditAttempt: vi.fn(async (_id: string, requestId: string) => {
      if (account.resetCreditAttempt?.requestId === requestId) delete account.resetCreditAttempt; await flush();
    }),
    flush
  };
  const service = new AccountsCommandService({} as vscode.ExtensionContext, repo as unknown as AccountsRepository,
    { refresh: vi.fn(), markObservedAuthIdentity: vi.fn() });
  return { service, repo, account };
}
