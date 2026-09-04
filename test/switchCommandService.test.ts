import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { AccountsCommandService, canIncludeInRefreshAll } from "../src/application/accounts/commandService";
import type { CodexManagerAccountRecord } from "../src/core/types";
import type { AccountsRepository } from "../src/storage";
import { setCurrentWindowRuntimeAccountId } from "../src/presentation/workbench/windowRuntimeAccount";

describe("manual account switch command", () => {
  beforeEach(() => {
    vi.mocked(vscode.commands.executeCommand).mockReset();
    vi.mocked(vscode.workspace.getConfiguration).mockReset().mockReturnValue({
      get: (_key: string, defaultValue?: unknown) => defaultValue,
      update: vi.fn(),
      inspect: vi.fn()
    } as never);
    vi.mocked(vscode.window.showQuickPick).mockReset();
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
      "codexManager.prepareDashboardForExtensionHostRestart"
    );
    expect(vscode.commands.executeCommand).toHaveBeenNthCalledWith(2, "workbench.action.restartExtensionHost");
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
