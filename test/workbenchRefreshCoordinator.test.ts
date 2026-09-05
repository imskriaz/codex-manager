import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchRefreshCoordinator } from "../src/presentation/workbench/refreshCoordinator";
import { refreshImportedAccountQuota } from "../src/commands";
import { readAuthFile } from "../src/codex";
import { autoReloadWindowForAccount, promptWindowReloadForAccount } from "../src/application/accounts/switchEffects";
import { readCurrentAuthAccountStorageId } from "../src/utils/accountIdentity";
import { setCurrentWindowRuntimeAccountId } from "../src/presentation/workbench/windowRuntimeAccount";

vi.mock("../src/application/accounts/switchEffects", () => ({
  autoReloadWindowForAccount: vi.fn(),
  promptWindowReloadForAccount: vi.fn()
}));

vi.mock("../src/utils/accountIdentity", () => ({
  readCurrentAuthAccountStorageId: vi.fn()
}));

vi.mock("../src/commands", () => ({
  refreshImportedAccountQuota: vi.fn()
}));

vi.mock("../src/codex", () => ({
  getAuthJsonPath: vi.fn(() => "C:/Users/test/.codex/auth.json"),
  readAuthFile: vi.fn()
}));

vi.mock("../src/presentation/dashboard", () => ({
  refreshQuotaSummaryPanel: vi.fn()
}));

vi.mock("../src/ui", () => ({
  AccountsStatusBarProvider: class {},
  refreshDetailsPanel: vi.fn()
}));

type ExternalChangeSync = {
  syncActiveAccountFromExternalChange: (
    view: { refresh: () => void; markObservedAuthIdentity: (accountId?: string) => void },
    markVisible: () => void,
    markHidden: () => void,
    isVisible: () => boolean
  ) => Promise<void>;
};

describe("workbench external account synchronization", () => {
  beforeEach(() => {
    vi.mocked(autoReloadWindowForAccount).mockReset();
    vi.mocked(promptWindowReloadForAccount).mockReset();
    vi.mocked(readCurrentAuthAccountStorageId).mockReset();
    vi.mocked(readAuthFile).mockReset();
    vi.mocked(refreshImportedAccountQuota).mockReset();
    vi.mocked(vscode.window.showInformationMessage).mockReset();
    vi.mocked(vscode.window.showWarningMessage).mockReset();
    vi.mocked(vscode.window.showErrorMessage).mockReset();
    setCurrentWindowRuntimeAccountId("old-account");
  });

  it("automatically binds local auth.json and refreshes quota without notifications", async () => {
    vi.mocked(readAuthFile).mockResolvedValue({
      tokens: { id_token: "id-token", access_token: "access-token" }
    } as never);
    vi.mocked(refreshImportedAccountQuota).mockResolvedValue({ error: undefined } as never);

    const account = {
      id: "local-account",
      email: "local@example.com",
      isActive: true,
      createdAt: 1,
      updatedAt: 2
    };
    const repo = {
      listAccounts: vi.fn(async () => []),
      importCurrentAuth: vi.fn(async () => account)
    };
    const view = { refresh: vi.fn(), markObservedAuthIdentity: vi.fn() };
    const coordinator = new WorkbenchRefreshCoordinator({} as vscode.ExtensionContext, repo as never, {} as never);

    await coordinator.autoImportCurrentAccountIfNeeded(view);

    expect(repo.importCurrentAuth).toHaveBeenCalledTimes(1);
    expect(refreshImportedAccountQuota).toHaveBeenCalledWith(repo, account.id);
    expect(view.refresh).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it("binds local auth.json without polling an account owned by another PC", async () => {
    vi.mocked(readAuthFile).mockResolvedValue({
      tokens: { id_token: "id-token", access_token: "access-token" }
    } as never);
    const account = {
      id: "foreign-owned",
      email: "foreign@example.com",
      isActive: true,
      createdAt: 1,
      updatedAt: 2
    };
    const repo = {
      listAccounts: vi.fn(async () => []),
      importCurrentAuth: vi.fn(async () => account)
    };
    const view = { refresh: vi.fn(), markObservedAuthIdentity: vi.fn() };
    const canAutomateAccount = vi.fn(() => false);
    const coordinator = new WorkbenchRefreshCoordinator(
      {} as vscode.ExtensionContext,
      repo as never,
      {} as never,
      canAutomateAccount
    );

    await coordinator.autoImportCurrentAccountIfNeeded(view);

    expect(repo.importCurrentAuth).toHaveBeenCalledOnce();
    expect(canAutomateAccount).toHaveBeenCalledWith(account.id);
    expect(refreshImportedAccountQuota).not.toHaveBeenCalled();
    expect(view.refresh).toHaveBeenCalledOnce();
  });

  it("keeps background binding failures quiet and leaves diagnostics in the log", async () => {
    vi.mocked(readAuthFile).mockResolvedValue({
      tokens: { id_token: "id-token", access_token: "access-token" }
    } as never);
    const importError = new Error("keychain unavailable");
    const repo = {
      listAccounts: vi.fn(async () => []),
      importCurrentAuth: vi.fn(async () => {
        throw importError;
      })
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await new WorkbenchRefreshCoordinator(
      {} as vscode.ExtensionContext,
      repo as never,
      {} as never
    ).autoImportCurrentAccountIfNeeded({ refresh: vi.fn(), markObservedAuthIdentity: vi.fn() });

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("automatic local auth.json binding skipped"),
      "keychain unavailable"
    );
    warn.mockRestore();
  });

  it("reloads a window changed by another window without showing a notification", async () => {
    vi.mocked(readCurrentAuthAccountStorageId).mockResolvedValue("new-account");
    vi.mocked(autoReloadWindowForAccount).mockResolvedValue(true);

    const accounts = [
      { id: "old-account", email: "old@example.com", isActive: false, createdAt: 1, updatedAt: 1 },
      { id: "new-account", email: "new@example.com", isActive: true, createdAt: 1, updatedAt: 2 }
    ];
    const repo = {
      syncActiveAccountFromAuthFile: vi.fn(async () => undefined),
      listAccounts: vi.fn(async () => accounts)
    };
    const coordinator = new WorkbenchRefreshCoordinator(
      {} as vscode.ExtensionContext,
      repo as never,
      {} as never
    ) as unknown as ExternalChangeSync & { lastObservedAuthIdentity?: string };
    coordinator.lastObservedAuthIdentity = "old-account";

    const view = { refresh: vi.fn(), markObservedAuthIdentity: vi.fn() };
    const markVisible = vi.fn();
    const markHidden = vi.fn();
    await coordinator.syncActiveAccountFromExternalChange(view, markVisible, markHidden, () => false);

    expect(repo.syncActiveAccountFromAuthFile).toHaveBeenCalledTimes(1);
    expect(view.refresh).toHaveBeenCalledTimes(1);
    expect(autoReloadWindowForAccount).toHaveBeenCalledWith("new-account");
    expect(markVisible).toHaveBeenCalledTimes(1);
    expect(markHidden).toHaveBeenCalledTimes(1);
    expect(promptWindowReloadForAccount).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("shows a recoverable error when the automatic reload fails", async () => {
    vi.mocked(readCurrentAuthAccountStorageId).mockResolvedValue("new-account");
    vi.mocked(autoReloadWindowForAccount).mockRejectedValue(new Error("restart unavailable"));

    const repo = {
      syncActiveAccountFromAuthFile: vi.fn(async () => undefined),
      listAccounts: vi.fn(async () => [
        { id: "old-account", email: "old@example.com", isActive: false, createdAt: 1, updatedAt: 1 },
        { id: "new-account", email: "new@example.com", isActive: true, createdAt: 1, updatedAt: 2 }
      ])
    };
    const coordinator = new WorkbenchRefreshCoordinator(
      {} as vscode.ExtensionContext,
      repo as never,
      {} as never
    ) as unknown as ExternalChangeSync & { lastObservedAuthIdentity?: string };
    coordinator.lastObservedAuthIdentity = "old-account";

    await coordinator.syncActiveAccountFromExternalChange(
      { refresh: vi.fn(), markObservedAuthIdentity: vi.fn() },
      vi.fn(),
      vi.fn(),
      () => false
    );

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("restart unavailable"));
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });
});
