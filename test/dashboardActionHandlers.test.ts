import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { DashboardActionContext } from "../src/presentation/dashboard/actionHandlers";

const { consumeResetCreditMock } = vi.hoisted(() => ({
  consumeResetCreditMock: vi.fn().mockResolvedValue(undefined)
}));
const { unloadAuthFileMock } = vi.hoisted(() => ({
  unloadAuthFileMock: vi.fn()
}));
const { readCodexCliSessionsMock, readCodexCliSessionSummaryMock, readCodexCliSessionMessagesMock } = vi.hoisted(
  () => ({
    readCodexCliSessionsMock: vi.fn(),
    readCodexCliSessionSummaryMock: vi.fn(),
    readCodexCliSessionMessagesMock: vi.fn()
  })
);

vi.mock("../src/services/quota", async () => {
  const actual = await vi.importActual<typeof import("../src/services/quota")>("../src/services/quota");
  return {
    ...actual,
    consumeResetCredit: consumeResetCreditMock
  };
});

vi.mock("../src/codex", async () => {
  const actual = await vi.importActual<typeof import("../src/codex")>("../src/codex");
  return {
    ...actual,
    unloadAuthFile: unloadAuthFileMock
  };
});

vi.mock("../src/services/codexSessionResume", async () => {
  const actual = await vi.importActual<typeof import("../src/services/codexSessionResume")>(
    "../src/services/codexSessionResume"
  );
  return {
    ...actual,
    readCodexCliSessions: readCodexCliSessionsMock,
    readCodexCliSessionSummary: readCodexCliSessionSummaryMock,
    readCodexCliSessionMessages: readCodexCliSessionMessagesMock
  };
});

import { executeDashboardActionMessage, isSafeExternalUrl } from "../src/presentation/dashboard/actionHandlers";
import {
  CrossWindowOperationBusyError,
  CrossWindowOperationCoordinator,
  configureCrossWindowOperationCoordinator
} from "../src/utils/crossWindowOperations";
import { removeTestDirectory } from "./testFilesystem";
import { setCurrentWindowRuntimeAccountId } from "../src/presentation/workbench/windowRuntimeAccount";
import { APIError } from "../src/core/errors";

let operationDirectory: string;

beforeAll(async () => {
  operationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-actions-"));
  await configureCrossWindowOperationCoordinator(operationDirectory);
});

beforeEach(() => {
  unloadAuthFileMock.mockReset().mockResolvedValue(undefined);
});

afterAll(async () => {
  await removeTestDirectory(operationDirectory);
});

describe("isSafeExternalUrl", () => {
  it("allows ordinary HTTP(S) URLs and rejects executable or credential-bearing schemes", () => {
    expect(isSafeExternalUrl("https://openai.com/research")).toBe(true);
    expect(isSafeExternalUrl("http://localhost:3000/help")).toBe(true);
    expect(isSafeExternalUrl("http://example.com/help")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("file:///tmp/auth.json")).toBe(false);
    expect(isSafeExternalUrl("https://user:password@example.com/private")).toBe(false);
  });
});

describe("executeDashboardActionMessage", () => {
  it.each([true, false])("saves cross-PC sync as %s and reports completion", async (enabled) => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
      get: vi.fn(),
      update,
      inspect: vi.fn()
    } as never);
    const context = createContext();
    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "setCrossPcSyncEnabled",
      requestId: "sync-toggle",
      payload: { enabled }
    });
    expect(update).toHaveBeenCalledWith("encryptedSyncEnabled", enabled, vscode.ConfigurationTarget.Global);
    expect(context.schedulePublishState).toHaveBeenCalledOnce();
    expect(result.status).toBe("completed");
    expect(result.payload?.notice?.message).toContain(`Cross-PC claim checks ${enabled ? "enabled" : "disabled"}`);
  });

  it("returns cross-PC sync save failures to the initiating dashboard", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
      get: vi.fn(),
      update: vi.fn().mockRejectedValue(new Error("Settings are read-only")),
      inspect: vi.fn()
    } as never);
    const context = createContext();
    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "setCrossPcSyncEnabled",
      requestId: "sync-toggle-failed",
      payload: { enabled: false }
    });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("Settings are read-only");
    expect(context.schedulePublishState).not.toHaveBeenCalled();
  });

  it("rejects an invalid cross-PC sync toggle", async () => {
    const result = await executeDashboardActionMessage(createContext(), {
      type: "dashboard:action",
      action: "setCrossPcSyncEnabled",
      requestId: "sync-toggle-invalid"
    });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("request is invalid");
  });
  it("updates shared privacy mode and returns visible completion feedback", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
      get: vi.fn(),
      update,
      inspect: vi.fn()
    } as never);
    const context = createContext();

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "setPrivacyMode",
      requestId: "req-privacy-on",
      payload: { privacyMode: true }
    });

    expect(update).toHaveBeenCalledWith("privacyMode", true, vscode.ConfigurationTarget.Global);
    expect(context.schedulePublishState).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "completed",
      payload: { notice: { level: "info", message: "Privacy mode enabled across Codex Manager." } }
    });
  });

  it("returns a visible failure when shared privacy mode cannot be saved", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
      get: vi.fn(),
      update: vi.fn().mockRejectedValue(new Error("settings are read-only")),
      inspect: vi.fn()
    } as never);
    const context = createContext();

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "setPrivacyMode",
      requestId: "req-privacy-failed",
      payload: { privacyMode: true }
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("settings are read-only");
    expect(context.schedulePublishState).not.toHaveBeenCalled();
  });

  it("unloads live auth, clears runtime state, and returns visible reload feedback", async () => {
    const workspaceUpdate = vi.fn().mockResolvedValue(undefined);
    const syncActiveAccountFromAuthFile = vi.fn().mockResolvedValue(undefined);
    const context = {
      ...createContext(),
      context: { workspaceState: { update: workspaceUpdate } } as unknown as DashboardActionContext["context"],
      repo: {
        listAccounts: vi
          .fn()
          .mockResolvedValue([{ id: "active-account", email: "active@example.com", isActive: true, enabled: true }]),
        setAccountEnabled: vi.fn().mockResolvedValue(undefined),
        syncActiveAccountFromAuthFile,
        flush: vi.fn().mockResolvedValue(undefined)
      } as unknown as DashboardActionContext["repo"]
    };

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "unloadAuth",
      requestId: "req-unload-auth"
    });

    expect(unloadAuthFileMock).toHaveBeenCalledOnce();
    expect(context.repo.setAccountEnabled).toHaveBeenCalledWith("active-account", false);
    expect(syncActiveAccountFromAuthFile).toHaveBeenCalledOnce();
    expect(workspaceUpdate).toHaveBeenCalledWith("codexManager.currentWindowRuntimeAccountId", undefined);
    expect(context.schedulePublishState).toHaveBeenCalledOnce();
    expect(result.status).toBe("completed");
    expect(result.payload?.notice).toEqual({
      level: "info",
      message: "Codex auth unloaded and the account was disabled on this PC. Its sync release is queued; reloading now."
    });
  });

  it("returns a visible failure when live auth cannot be unloaded", async () => {
    unloadAuthFileMock.mockRejectedValueOnce(new Error("auth.json is locked"));
    const context = {
      ...createContext(),
      context: { workspaceState: { update: vi.fn() } } as unknown as DashboardActionContext["context"],
      repo: {
        listAccounts: vi.fn().mockResolvedValue([]),
        setAccountEnabled: vi.fn(),
        syncActiveAccountFromAuthFile: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined)
      } as unknown as DashboardActionContext["repo"]
    };

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "unloadAuth",
      requestId: "req-unload-auth-failed"
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("auth.json is locked");
    expect(context.repo.syncActiveAccountFromAuthFile).not.toHaveBeenCalled();
    expect(context.schedulePublishState).not.toHaveBeenCalled();
  });

  it("opens the canonical Web Dashboard route with visible completion feedback", async () => {
    vi.mocked(vscode.commands.executeCommand).mockReset().mockResolvedValueOnce("opened");

    const result = await executeDashboardActionMessage(createContext(), {
      type: "dashboard:action",
      action: "openWebDashboard",
      requestId: "req-open-cli-sessions",
      payload: { path: "/" }
    });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("codexManager.openWebDashboard", { pathname: "/" });
    expect(result.status).toBe("completed");
    expect(result.payload?.notice).toEqual({ level: "info", message: "Opened the Web Dashboard." });
  });

  it("returns a visible failure and does not open an archived session", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
      get: (key: string, fallback?: unknown) => (key === "cliIntegrationEnabled" ? true : fallback)
    } as unknown as vscode.WorkspaceConfiguration);
    readCodexCliSessionSummaryMock.mockResolvedValueOnce({
      id: "01a04882-d037-7a42-ad24-9afb61901188",
      title: "Archived demo",
      status: "idle",
      archived: true
    });
    readCodexCliSessionMessagesMock.mockClear();

    const result = await executeDashboardActionMessage(createContext(), {
      type: "dashboard:action",
      action: "getCodexCliSessionMessages",
      requestId: "req-archived-session",
      payload: { sessionId: "01a04882-d037-7a42-ad24-9afb61901188" }
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/archived sessions cannot be opened/i);
    expect(readCodexCliSessionMessagesMock).not.toHaveBeenCalled();
  });

  it("rejects a session opened through a different project without reading its messages", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
      get: (key: string, fallback?: unknown) => (key === "cliIntegrationEnabled" ? true : fallback)
    } as unknown as vscode.WorkspaceConfiguration);
    const sessionProject = await fs.mkdtemp(path.join(os.tmpdir(), "codex-session-project-"));
    const requestedProject = await fs.mkdtemp(path.join(os.tmpdir(), "codex-request-project-"));
    readCodexCliSessionSummaryMock.mockResolvedValueOnce({
      id: "01a04882-d037-7a42-ad24-9afb61901189",
      title: "Project-scoped demo",
      status: "idle",
      archived: false,
      projectPath: sessionProject
    });
    readCodexCliSessionMessagesMock.mockClear();

    try {
      const result = await executeDashboardActionMessage(createContext(), {
        type: "dashboard:action",
        action: "getCodexCliSessionMessages",
        requestId: "req-wrong-project",
        payload: {
          sessionId: "01a04882-d037-7a42-ad24-9afb61901189",
          projectPath: requestedProject
        }
      });

      expect(result.status).toBe("failed");
      expect(result.errorMessage).toMatch(/different project/i);
      expect(readCodexCliSessionMessagesMock).not.toHaveBeenCalled();
    } finally {
      await Promise.all([removeTestDirectory(sessionProject), removeTestDirectory(requestedProject)]);
    }
  });

  it("returns captured output and success feedback for a workspace terminal command", async () => {
    const command =
      process.platform === "win32" ? "Write-Output dashboard-terminal-success" : "printf dashboard-terminal-success";
    const result = await executeDashboardActionMessage(createContext(), {
      type: "dashboard:action",
      action: "runWorkspaceTerminalCommand",
      requestId: "req-terminal-success",
      payload: { command, projectPath: process.cwd(), terminalId: "dashboard-terminal-success" }
    });

    expect(result.status).toBe("completed");
    expect(result.payload?.terminalResult).toMatchObject({ status: "completed", exitCode: 0 });
    expect(result.payload?.terminalResult?.output).toContain("dashboard-terminal-success");
    expect(result.payload?.notice?.message).toBe("Terminal command completed.");
  });

  it("keeps terminal output while returning a truthful failed action state", async () => {
    const command =
      process.platform === "win32"
        ? "Write-Error dashboard-terminal-failed; exit 9"
        : "printf dashboard-terminal-failed >&2; exit 9";
    const result = await executeDashboardActionMessage(createContext(), {
      type: "dashboard:action",
      action: "runWorkspaceTerminalCommand",
      requestId: "req-terminal-failure",
      payload: { command, projectPath: process.cwd(), terminalId: "dashboard-terminal-failure" }
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("exit code 9");
    expect(result.payload?.terminalResult).toMatchObject({ status: "failed", exitCode: 9 });
    expect(result.payload?.terminalResult?.output).toContain("dashboard-terminal-failed");
  });

  it("returns visible completion feedback when the overview lock is set or removed", async () => {
    const account = { id: "lock-account", email: "lock@example.com" };
    const context = {
      ...createContext(),
      repo: { getAccount: vi.fn().mockResolvedValue(account) } as unknown as DashboardActionContext["repo"]
    };

    const locked = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "setAutoSwitchLock",
      requestId: "req-lock",
      accountId: account.id,
      payload: { lockMinutes: 15 }
    });
    const unlocked = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "setAutoSwitchLock",
      requestId: "req-unlock",
      accountId: account.id,
      payload: { lockMinutes: 0 }
    });

    expect(locked.status).toBe("completed");
    expect(locked.payload?.notice).toEqual({ level: "info", message: "Auto-switch locked for 15 minutes." });
    expect(unlocked.status).toBe("completed");
    expect(unlocked.payload?.notice).toEqual({ level: "info", message: "Auto-switch lock removed." });
    expect(context.schedulePublishState).toHaveBeenCalledTimes(2);
  });

  it("opens the VS Code account picker when overview Switch has no preset target", async () => {
    vi.mocked(vscode.commands.executeCommand).mockReset().mockResolvedValue({ status: "cancelled" });
    const context = { ...createContext(), hostKind: "webview" as const };

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "switch",
      requestId: "req-switch-picker"
    });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("codexManager.switchAccount", undefined);
    expect(result.status).toBe("completed");
    expect(result.payload?.notice).toEqual({ level: "warning", message: "Account switch cancelled." });
    expect(context.schedulePublishState).toHaveBeenCalled();
  });

  it("requires the browser account picker to supply a switch target", async () => {
    const result = await executeDashboardActionMessage(
      { ...createContext(), hostKind: "browser" },
      {
        type: "dashboard:action",
        action: "switch",
        requestId: "req-browser-switch-missing"
      }
    );

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/choose an account/i);
  });

  it("returns a visible reload outcome when the VS Code reload prompt is postponed", async () => {
    setCurrentWindowRuntimeAccountId("account-before-reload");
    vi.mocked(vscode.window.showInformationMessage)
      .mockReset()
      .mockResolvedValue("Later" as never);
    const account = { id: "account-next", email: "next@example.com" };
    const context = {
      ...createContext(),
      hostKind: "webview" as const,
      repo: { getAccount: vi.fn().mockResolvedValue(account) } as unknown as DashboardActionContext["repo"]
    };

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "reloadPrompt",
      requestId: "req-reload-later",
      accountId: account.id
    });

    expect(result.status).toBe("completed");
    expect(result.payload?.notice?.level).toBe("warning");
    expect(result.payload?.notice?.message).toMatch(/not started|postponed/i);
  });

  it("requires in-page confirmation before a browser reload", async () => {
    setCurrentWindowRuntimeAccountId("account-before-reload");
    vi.mocked(vscode.commands.executeCommand).mockClear();
    const account = { id: "account-next", email: "next@example.com" };
    const context = {
      ...createContext(),
      hostKind: "browser" as const,
      repo: { getAccount: vi.fn().mockResolvedValue(account) } as unknown as DashboardActionContext["repo"]
    };

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "reloadPrompt",
      requestId: "req-browser-reload-unconfirmed",
      accountId: account.id
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/confirm the reload/i);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.restartExtensionHost");
  });

  it("forces a reload when the VS Code dashboard Reload button is clicked", async () => {
    vi.mocked(vscode.commands.executeCommand).mockReset().mockResolvedValue(undefined);
    const account = { id: "account-next", email: "next@example.com" };
    const context = {
      ...createContext(),
      hostKind: "webview" as const,
      repo: { getAccount: vi.fn().mockResolvedValue(account) } as unknown as DashboardActionContext["repo"]
    };

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "reloadPrompt",
      requestId: "req-reload-force",
      accountId: account.id,
      payload: { forceReload: true }
    });

    expect(result.status).toBe("completed");
    expect(result.payload?.notice?.message).toMatch(/reloading/i);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("workbench.action.restartExtensionHost");
  });

  it("switches directly for the port dashboard and schedules reload after its response", async () => {
    setCurrentWindowRuntimeAccountId("current-window-account");
    vi.mocked(vscode.commands.executeCommand).mockClear();
    const account = {
      id: "browser-target",
      email: "browser@example.com",
      isActive: false,
      tokenRefreshEnabled: false
    };
    const repo = {
      getAccount: vi.fn().mockResolvedValue(account),
      switchAccount: vi.fn().mockResolvedValue({ ...account, isActive: true }),
      flush: vi.fn().mockResolvedValue(undefined)
    } as unknown as DashboardActionContext["repo"];
    const context = { ...createContext(), repo, hostKind: "browser" as const };

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "switch",
      requestId: "req-browser-switch",
      accountId: account.id
    });

    expect(result.status).toBe("completed");
    expect(repo.switchAccount).toHaveBeenCalledWith(account.id, { forceTokenRefresh: false });
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("codexManager.switchAccount", expect.anything());
    expect(result.payload).toMatchObject({
      reloadScheduled: true,
      notice: { level: "info", message: `Switched to ${account.email}. Reloading Codex…` }
    });
    expect(result.payload?.reloadRequired).toBeUndefined();
    setCurrentWindowRuntimeAccountId(undefined);
  });

  it("revalidates a browser switch target and avoids switching an account that became active", async () => {
    const stale = {
      id: "browser-race-target",
      email: "race@example.com",
      isActive: false,
      tokenRefreshEnabled: false
    };
    const current = { ...stale, isActive: true };
    const repo = {
      getAccount: vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(current),
      switchAccount: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined)
    } as unknown as DashboardActionContext["repo"];
    const context = { ...createContext(), repo, hostKind: "browser" as const };

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "switch",
      requestId: "req-browser-switch-race",
      accountId: stale.id
    });

    expect(result.status).toBe("completed");
    expect(repo.switchAccount).not.toHaveBeenCalled();
    expect(result.payload?.notice?.message).toBe("race@example.com is already active.");
  });

  it("keeps the VS Code webview switch on the registered VS Code command", async () => {
    vi.mocked(vscode.commands.executeCommand).mockReset().mockResolvedValue(undefined);
    const account = { id: "webview-target", email: "webview@example.com", isActive: false };
    const repo = {
      getAccount: vi.fn().mockResolvedValue(account),
      switchAccount: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined)
    } as unknown as DashboardActionContext["repo"];

    const result = await executeDashboardActionMessage(
      { ...createContext(), repo, hostKind: "webview" },
      {
        type: "dashboard:action",
        action: "switch",
        requestId: "req-webview-switch",
        accountId: account.id
      }
    );

    expect(result.status).toBe("completed");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("codexManager.switchAccount", account);
    expect(repo.switchAccount).not.toHaveBeenCalled();
  });

  it("requires browser confirmation and removes directly after it is supplied", async () => {
    vi.mocked(vscode.window.showWarningMessage).mockClear();
    const account = { id: "remove-target", email: "remove@example.com" };
    const repo = {
      getAccount: vi.fn().mockResolvedValue(account),
      removeAccount: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined)
    } as unknown as DashboardActionContext["repo"];
    const context = { ...createContext(), repo, hostKind: "browser" as const };

    const unconfirmed = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "remove",
      requestId: "req-browser-remove-unconfirmed",
      accountId: account.id
    });
    const confirmed = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "remove",
      requestId: "req-browser-remove-confirmed",
      accountId: account.id,
      payload: { confirmed: true }
    });

    expect(unconfirmed.status).toBe("failed");
    expect(confirmed.status).toBe("completed");
    expect(repo.removeAccount).toHaveBeenCalledTimes(1);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(confirmed.payload?.notice?.message).toContain("remove@example.com");
  });

  it("accepts a confirmed remove from the VS Code dashboard popover without opening a native prompt", async () => {
    const account = { id: "webview-remove-target", email: "webview-remove@example.com" };
    const repo = {
      getAccount: vi.fn().mockResolvedValue(account),
      removeAccount: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined)
    } as unknown as DashboardActionContext["repo"];
    const context = { ...createContext(), repo, hostKind: "webview" as const };
    vi.mocked(vscode.window.showWarningMessage).mockClear();

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "remove",
      requestId: "req-webview-remove-confirmed",
      accountId: account.id,
      payload: { confirmed: true }
    });

    expect(result.status).toBe("completed");
    expect(repo.removeAccount).toHaveBeenCalledWith(account.id);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("accepts submitted tags from the VS Code dashboard popover without opening a native prompt", async () => {
    const account = { id: "webview-tags-target", email: "tags@example.com", tags: ["old"] };
    const repo = {
      getAccount: vi.fn().mockResolvedValue(account),
      setAccountTags: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined)
    } as unknown as DashboardActionContext["repo"];
    const context = { ...createContext(), repo, hostKind: "webview" as const };
    vi.mocked(vscode.window.showInputBox).mockClear();

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "updateTags",
      requestId: "req-webview-tags-submitted",
      accountId: account.id,
      payload: { mode: "set", submittedTags: ["team", "priority"] }
    });

    expect(result.status).toBe("completed");
    expect(repo.setAccountTags).toHaveBeenCalledWith(account.id, ["team", "priority"]);
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  });

  it("uses the port host encrypted-sync callbacks instead of VS Code prompts", async () => {
    vi.mocked(vscode.commands.executeCommand).mockClear();
    const configureEncryptedSync = vi.fn().mockResolvedValue(true);
    const context = {
      ...createContext(),
      hostKind: "browser" as const,
      configureEncryptedSync
    };

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "configureEncryptedSync",
      requestId: "req-browser-configure-sync",
      payload: { passphrase: "secret-passphrase", passphraseConfirmation: "secret-passphrase" }
    });

    expect(result.status).toBe("completed");
    expect(configureEncryptedSync).toHaveBeenCalledWith("secret-passphrase", "secret-passphrase", undefined);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("codexManager.configureEncryptedSync");
    expect(result.payload?.notice?.message).toMatch(/password saved/i);
  });

  it("imports backup accounts without applying settings or switching accounts in ordinary import mode", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn()
    } as never);
    const repo = {
      importSharedAccountsWithSummary: vi.fn().mockResolvedValue({
        successCount: 0,
        overwriteCount: 0,
        invalidCount: 0,
        failures: []
      }),
      restoreAccountsFromSharedJson: vi.fn(),
      getAccount: vi.fn(),
      switchAccount: vi.fn()
    } as unknown as DashboardActionContext["repo"];
    const backup = {
      format: "codex-manager-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      accounts: [],
      activeAccountId: "account-1",
      settings: { dashboardTheme: "dark" },
      logs: []
    };

    const result = await executeDashboardActionMessage(
      { ...createContext(), repo },
      {
        type: "dashboard:action",
        action: "importSharedJson",
        requestId: "req-safe-backup-import",
        payload: { jsonText: JSON.stringify(backup) }
      }
    );

    expect(result.status).toBe("completed");
    expect(repo.importSharedAccountsWithSummary).toHaveBeenCalledWith([]);
    expect(repo.restoreAccountsFromSharedJson).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(repo.switchAccount).not.toHaveBeenCalled();
  });

  it("applies backup settings and the active account only in explicit recovery mode", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn(),
      update,
      inspect: vi.fn()
    } as never);
    const repo = {
      importSharedAccountsWithSummary: vi.fn(),
      restoreAccountsFromSharedJson: vi.fn().mockResolvedValue({ restoredCount: 0 }),
      getAccount: vi.fn().mockResolvedValue({ id: "account-1" }),
      switchAccount: vi.fn().mockResolvedValue(undefined)
    } as unknown as DashboardActionContext["repo"];
    const backup = {
      format: "codex-manager-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      accounts: [],
      activeAccountId: "account-1",
      settings: { dashboardTheme: "dark" },
      logs: []
    };

    const result = await executeDashboardActionMessage(
      { ...createContext(), repo },
      {
        type: "dashboard:action",
        action: "importSharedJson",
        requestId: "req-recovery-import",
        payload: { jsonText: JSON.stringify(backup), recoveryMode: true }
      }
    );

    expect(result.status).toBe("completed");
    expect(repo.restoreAccountsFromSharedJson).toHaveBeenCalledWith([]);
    expect(repo.importSharedAccountsWithSummary).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith("dashboardTheme", "dark", vscode.ConfigurationTarget.Global);
    expect(repo.switchAccount).toHaveBeenCalledWith("account-1");
  });

  it("does not block a reload prompt when another window already has the same action in flight", async () => {
    const blocker = new CrossWindowOperationCoordinator(operationDirectory);
    let releaseBlocker!: () => void;
    let blockerStarted!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const started = new Promise<void>((resolve) => {
      blockerStarted = resolve;
    });
    const heldAction = blocker.runExclusive("dashboard:reloadPrompt:account-1", "Reload prompt", async () => {
      blockerStarted();
      await blocked;
    });
    await started;

    setCurrentWindowRuntimeAccountId("account-before-reload");
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue("Later" as never);
    const account = { id: "account-1", email: "dev@example.com" };
    const context = {
      ...createContext(),
      repo: {
        getAccount: vi.fn().mockResolvedValue(account)
      } as unknown as DashboardActionContext["repo"]
    };

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "reloadPrompt",
      requestId: "req-reload-unblocked",
      accountId: account.id
    });

    expect(result.status).toBe("completed");
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
    releaseBlocker();
    await heldAction;
  });

  it("forces a panel state publish for refreshView", async () => {
    const publishState = vi.fn().mockResolvedValue(undefined);
    const result = await executeDashboardActionMessage(
      {
        context: {} as DashboardActionContext["context"],
        repo: {} as DashboardActionContext["repo"],
        resolveLanguage: () => "en",
        schedulePublishState: vi.fn(),
        publishState,
        oauth: {} as DashboardActionContext["oauth"],
        announcements: {} as DashboardActionContext["announcements"],
        getAnnouncementOptions: () => ({
          version: "0.1.15",
          locale: "en"
        })
      },
      {
        type: "dashboard:action",
        action: "refreshView",
        requestId: "req-1"
      }
    );

    expect(publishState).toHaveBeenCalledWith(true);
    expect(result.status).toBe("completed");
  });

  it("waits for quota refresh after consuming a reset credit", async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Reset Rate Limit" as never);
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined);
    const executeCommandMock = vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    const repo = {
      getAccount: vi.fn(async () => ({
        id: "account-1",
        email: "dev@example.com",
        accountId: "acct-1",
        quotaSummary: {
          resetCreditsAvailable: 1
        }
      })),
      getTokens: vi.fn(async () => ({
        accessToken: "access-token"
      }))
    } as unknown as DashboardActionContext["repo"];

    const result = await executeDashboardActionMessage(
      {
        context: {} as DashboardActionContext["context"],
        repo,
        resolveLanguage: () => "en",
        schedulePublishState: vi.fn(),
        publishState: vi.fn(),
        oauth: {} as DashboardActionContext["oauth"],
        announcements: {} as DashboardActionContext["announcements"],
        getAnnouncementOptions: () => ({
          version: "0.1.15",
          locale: "en"
        })
      },
      {
        type: "dashboard:action",
        action: "consumeResetCredit",
        requestId: "req-2",
        accountId: "account-1"
      }
    );

    expect(executeCommandMock).toHaveBeenCalledWith(
      "codexManager.refreshQuota",
      expect.objectContaining({ id: "account-1" })
    );
    expect(result.status).toBe("completed");
  });

  it("fences an ineligible reset credit by ID and publishes the updated count", async () => {
    const ineligible = new APIError("Consume reset credit returned 403: rate_limit_reset_ineligible", {
      statusCode: 403,
      context: { errorCode: "rate_limit_reset_ineligible" }
    });
    consumeResetCreditMock.mockReset().mockRejectedValueOnce(ineligible);
    const excludeResetCredit = vi.fn().mockResolvedValue(undefined);
    const schedulePublishState = vi.fn();
    const repo = {
      getAccount: vi.fn(async () => ({
        id: "account-1",
        email: "dev@example.com",
        accountId: "acct-1",
        quotaSummary: {
          resetCreditsAvailable: 2,
          resetCreditsAvailableIds: ["old-credit", "new-credit"]
        }
      })),
      getTokens: vi.fn(async () => ({ accessToken: "access-token" })),
      excludeResetCredit
    } as unknown as DashboardActionContext["repo"];

    const result = await executeDashboardActionMessage(
      {
        context: {} as DashboardActionContext["context"],
        repo,
        resolveLanguage: () => "en",
        schedulePublishState,
        publishState: vi.fn(),
        oauth: {} as DashboardActionContext["oauth"],
        announcements: {} as DashboardActionContext["announcements"],
        getAnnouncementOptions: () => ({ version: "0.1.15", locale: "en" })
      },
      {
        type: "dashboard:action",
        action: "consumeResetCredit",
        requestId: "req-ineligible",
        accountId: "account-1",
        payload: { confirmed: true }
      }
    );

    expect(excludeResetCredit).toHaveBeenCalledWith("account-1", "old-credit");
    expect(schedulePublishState).toHaveBeenCalled();
    expect(result.status).toBe("failed");
    consumeResetCreditMock.mockReset().mockResolvedValue(undefined);
  });

  it("keeps dashboard refresh separate from encrypted sync when enabled", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
      get: (key: string, fallback?: unknown) => (key === "encryptedSyncEnabled" ? true : fallback)
    } as unknown as vscode.WorkspaceConfiguration);
    const context = createContext();

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "refreshView",
      requestId: "req-global-refresh"
    });

    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("codexManager.syncNow");
    expect(context.publishState).toHaveBeenCalledWith(true);
    expect(result.status).toBe("completed");
    expect(result.payload?.notice).toBeUndefined();
  });

  it("uses the refreshed dashboard state as quota refresh feedback", async () => {
    const context = createContext();
    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "refreshAll",
      requestId: "req-quota-refresh"
    });

    expect(result.status).toBe("completed");
    expect(result.payload?.notice).toBeUndefined();
  });

  it("reports an inconclusive manual encrypted sync as a failed action", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(false);
    const context = createContext();

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "syncNow",
      requestId: "req-sync"
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/did not complete/i);
    expect(context.schedulePublishState).toHaveBeenCalled();
  });

  it("requires the dashboard password modal instead of opening a native prompt", async () => {
    vi.mocked(vscode.commands.executeCommand).mockClear();
    vi.mocked(vscode.window.showInputBox).mockClear();
    const context = createContext();

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "configureEncryptedSync",
      requestId: "req-configure-sync"
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/dashboard/i);
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("codexManager.configureEncryptedSync");
    expect(context.schedulePublishState).toHaveBeenCalled();
  });

  it("reports stale and missing account targets instead of completing silently", async () => {
    const repo = {
      getAccount: vi.fn().mockResolvedValue(undefined)
    } as unknown as DashboardActionContext["repo"];

    const missingTarget = await executeDashboardActionMessage(
      { ...createContext(), repo },
      {
        type: "dashboard:action",
        action: "refresh",
        requestId: "req-missing-target"
      }
    );
    const staleTarget = await executeDashboardActionMessage(
      { ...createContext(), repo },
      {
        type: "dashboard:action",
        action: "refresh",
        requestId: "req-stale-target",
        accountId: "deleted-account"
      }
    );

    expect(missingTarget.status).toBe("failed");
    expect(missingTarget.errorMessage).toMatch(/requires an account/i);
    expect(staleTarget.status).toBe("failed");
    expect(staleTarget.errorMessage).toMatch(/no longer exists/i);
  });

  it("reports invalid action input instead of completing silently", async () => {
    const result = await executeDashboardActionMessage(createContext(), {
      type: "dashboard:action",
      action: "copyText",
      requestId: "req-copy"
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/no text/i);
  });

  it("updates account claim enablement and republishes dashboard state", async () => {
    vi.mocked(vscode.workspace.getConfiguration)
      .mockReset()
      .mockReturnValue({
        get: (_key: string, fallback?: unknown) => fallback
      } as unknown as vscode.WorkspaceConfiguration);
    vi.mocked(vscode.commands.executeCommand).mockReset().mockResolvedValue(undefined);
    const account = { id: "account-1", email: "dev@example.com", enabled: false };
    const repo = {
      getAccount: vi.fn().mockResolvedValue(account),
      setAccountEnabled: vi.fn().mockResolvedValue({ ...account, enabled: true })
    } as unknown as DashboardActionContext["repo"];
    const context = { ...createContext(), repo };

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "toggleAccountEnabled",
      requestId: "req-enable",
      accountId: account.id
    });

    expect(repo.setAccountEnabled).toHaveBeenCalledWith(account.id, true);
    expect(context.schedulePublishState).toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect(result.payload?.notice?.message).toContain("enabled on this PC");
  });

  it("honors an explicit enable request when synchronized account state is stale", async () => {
    const account = { id: "account-rescue", email: "rescue@example.com", enabled: true };
    const repo = {
      getAccount: vi.fn().mockResolvedValue(account),
      setAccountEnabled: vi.fn().mockResolvedValue(account)
    } as unknown as DashboardActionContext["repo"];
    const context = { ...createContext(), repo };

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "toggleAccountEnabled",
      requestId: "req-explicit-rescue-enable",
      accountId: account.id,
      payload: { enabled: true }
    });

    expect(repo.setAccountEnabled).toHaveBeenCalledWith(account.id, true);
    expect(context.schedulePublishState).toHaveBeenCalled();
    expect(result.status).toBe("completed");
  });

  it("completes an account toggle without waiting for encrypted sync", async () => {
    vi.mocked(vscode.workspace.getConfiguration)
      .mockReset()
      .mockReturnValue({
        get: (key: string, fallback?: unknown) => (key === "encryptedSyncEnabled" ? true : fallback)
      } as unknown as vscode.WorkspaceConfiguration);
    vi.mocked(vscode.commands.executeCommand).mockReset().mockResolvedValue(true);
    const account = { id: "account-1", email: "dev@example.com", enabled: true };
    const repo = {
      getAccount: vi.fn().mockResolvedValue(account),
      setAccountEnabled: vi.fn().mockResolvedValue({ ...account, enabled: false })
    } as unknown as DashboardActionContext["repo"];
    const context = { ...createContext(), repo };

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "toggleAccountEnabled",
      requestId: "req-disable-sync",
      accountId: account.id
    });

    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith("codexManager.syncNow", expect.anything());
    expect(result.status).toBe("completed");
    expect(result.payload?.notice?.message).toContain("disabled on this PC");
  });

  it("asks whether to unload after disabling the current account", async () => {
    const account = {
      id: "current-account",
      email: "current@example.com",
      enabled: true,
      isActive: true
    };
    const repo = {
      getAccount: vi.fn().mockResolvedValue(account),
      setAccountEnabled: vi.fn().mockResolvedValue({ ...account, enabled: false })
    } as unknown as DashboardActionContext["repo"];

    const result = await executeDashboardActionMessage(
      { ...createContext(), repo },
      {
        type: "dashboard:action",
        action: "toggleAccountEnabled",
        requestId: "req-disable-current",
        accountId: account.id,
        payload: { enabled: false }
      }
    );

    expect(result.status).toBe("completed");
    expect(result.payload?.notice).toBeUndefined();
    expect(result.payload?.actionPrompts).toEqual([
      expect.objectContaining({
        kind: "disabledActiveAccount",
        accountId: account.id,
        unloadLabel: "Unload",
        keepUsingLabel: "Later"
      })
    ]);
  });

  it("does not block an account toggle while a background account task is running", async () => {
    const blocker = new CrossWindowOperationCoordinator(operationDirectory);
    const account = { id: "account-toggle", email: "toggle@example.com", enabled: true };
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = blocker.runExclusive(`background:quota-refresh:${account.id}`, "Quota refresh", async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await startedPromise;
    const repo = {
      getAccount: vi.fn().mockResolvedValue(account),
      setAccountEnabled: vi.fn().mockResolvedValue({ ...account, enabled: false })
    } as unknown as DashboardActionContext["repo"];

    const result = await executeDashboardActionMessage(
      { ...createContext(), repo },
      {
        type: "dashboard:action",
        action: "toggleAccountEnabled",
        requestId: "req-toggle-background-busy",
        accountId: account.id
      }
    );

    expect(result.status).toBe("completed");
    expect(repo.setAccountEnabled).toHaveBeenCalledWith(account.id, false);
    release();
    await held;
  });

  it("completes an account toggle locally when another window already owns sync", async () => {
    vi.mocked(vscode.workspace.getConfiguration)
      .mockReset()
      .mockReturnValue({
        get: (key: string, fallback?: unknown) => (key === "encryptedSyncEnabled" ? true : fallback)
      } as unknown as vscode.WorkspaceConfiguration);
    vi.mocked(vscode.commands.executeCommand)
      .mockReset()
      .mockRejectedValue(new CrossWindowOperationBusyError("Encrypted account sync"));
    const account = { id: "account-1", email: "dev@example.com", enabled: true };
    const repo = {
      getAccount: vi.fn().mockResolvedValue(account),
      setAccountEnabled: vi.fn().mockResolvedValue({ ...account, enabled: false })
    } as unknown as DashboardActionContext["repo"];
    const context = { ...createContext(), repo };

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "toggleAccountEnabled",
      requestId: "req-disable-sync-busy",
      accountId: account.id
    });

    expect(repo.setAccountEnabled).toHaveBeenCalledWith(account.id, false);
    expect(context.schedulePublishState).toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect(result.payload?.notice?.message).toContain("disabled on this PC");
  });

  it("returns account claim enablement failures to the dashboard", async () => {
    const account = { id: "account-1", email: "dev@example.com", enabled: true };
    const repo = {
      getAccount: vi.fn().mockResolvedValue(account),
      setAccountEnabled: vi.fn().mockRejectedValue(new Error("local index is read-only"))
    } as unknown as DashboardActionContext["repo"];
    const context = { ...createContext(), repo };

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "toggleAccountEnabled",
      requestId: "req-disable",
      accountId: account.id
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/read-only/i);
    expect(context.schedulePublishState).toHaveBeenCalled();
  });

  it("defers the onboarding network sync after saving its passphrase", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(true);
    const context = createContext();

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "configureEncryptedSync",
      requestId: "req-configure-sync-deferred",
      payload: {
        passphrase: "secret-passphrase",
        passphraseConfirmation: "secret-passphrase",
        deferSync: true
      }
    });

    expect(result.status).toBe("completed");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("codexManager.configureEncryptedSync", {
      passphrase: "secret-passphrase",
      confirmation: "secret-passphrase",
      deferSync: true
    });
    expect(result.payload?.notice?.message).toMatch(/continuing in the background/i);
  });

  it("persists onboarding completion and returns visible terminal feedback", async () => {
    const context = createContext();
    const update = vi.fn().mockResolvedValue(undefined);
    context.context = { globalState: { update } } as unknown as DashboardActionContext["context"];

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "completeOnboarding",
      requestId: "req-complete-onboarding"
    });

    expect(result.status).toBe("completed");
    expect(result.payload?.notice?.message).toMatch(/stay dismissed after extension updates/i);
    expect(update).toHaveBeenCalledWith("codexManager.onboarding.v1.completed", true);
    expect(context.schedulePublishState).toHaveBeenCalled();
  });

  it("disables every saved account and reports the completed bulk action", async () => {
    const accounts = [
      { id: "account-enabled", email: "enabled@example.com", enabled: true },
      { id: "account-disabled", email: "disabled@example.com", enabled: false }
    ];
    const repo = {
      listAccounts: vi.fn().mockResolvedValue(accounts),
      setAccountEnabled: vi.fn().mockResolvedValue(undefined)
    } as unknown as DashboardActionContext["repo"];
    const context = { ...createContext(), repo };

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "disableAll",
      requestId: "req-disable-all"
    });

    expect(repo.setAccountEnabled).toHaveBeenCalledTimes(1);
    expect(repo.setAccountEnabled).toHaveBeenCalledWith("account-enabled", false);
    expect(context.schedulePublishState).toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect(result.payload?.batchResult).toMatchObject({
      kind: "disable_all",
      successCount: 2,
      failedCount: 0,
      failures: []
    });
    expect(result.payload?.notice?.message).toBe("Disabled 2 accounts.");
  });

  it("enables every valid account while skipping accounts that need reauthorization", async () => {
    const accounts = [
      { id: "valid-disabled", email: "valid@example.com", enabled: false },
      { id: "valid-enabled", email: "already@example.com", enabled: true },
      {
        id: "invalid-auth",
        email: "invalid@example.com",
        enabled: false,
        quotaError: { code: "unauthorized", message: "401 unauthorized", timestamp: Date.now() }
      },
      { id: "missing-credentials", email: "missing@example.com", enabled: false }
    ];
    const repo = {
      listAccounts: vi.fn().mockResolvedValue(accounts),
      getTokens: vi.fn(async (id: string) =>
        id === "missing-credentials" ? undefined : { accessToken: "access", idToken: "id", refreshToken: "refresh" }
      ),
      setAccountEnabled: vi.fn().mockResolvedValue(undefined)
    } as unknown as DashboardActionContext["repo"];
    const context = { ...createContext(), repo };

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "enableAllValid",
      requestId: "req-enable-all-valid"
    });

    expect(repo.getTokens).toHaveBeenCalledTimes(4);
    expect(repo.setAccountEnabled).toHaveBeenCalledTimes(1);
    expect(repo.setAccountEnabled).toHaveBeenCalledWith("valid-disabled", true);
    expect(context.schedulePublishState).toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect(result.payload?.batchResult).toMatchObject({
      kind: "enable_all_valid",
      successCount: 2,
      failedCount: 0,
      failures: []
    });
    expect(result.payload?.notice).toEqual({
      level: "info",
      message: "Enabled 2 valid accounts; skipped 2 invalid accounts."
    });
  });

  it("reports accounts that encrypted sync prevents Enable All from claiming", async () => {
    const account = { id: "foreign-claim", email: "claimed@example.com", enabled: false };
    const repo = {
      listAccounts: vi.fn().mockResolvedValue([account]),
      getTokens: vi.fn().mockResolvedValue({ accessToken: "access", idToken: "id", refreshToken: "refresh" }),
      setAccountEnabled: vi.fn().mockRejectedValue(new Error("Account is claimed by another PC."))
    } as unknown as DashboardActionContext["repo"];

    const result = await executeDashboardActionMessage(
      { ...createContext(), repo },
      {
        type: "dashboard:action",
        action: "enableAllValid",
        requestId: "req-enable-all-valid-partial"
      }
    );

    expect(result.status).toBe("completed");
    expect(result.payload?.batchResult).toMatchObject({
      kind: "enable_all_valid",
      successCount: 0,
      failedCount: 1,
      failures: [{ accountId: "foreign-claim", message: "Account is claimed by another PC." }]
    });
    expect(result.payload?.notice).toEqual({
      level: "warning",
      message:
        "Enabled 0 valid accounts; skipped 0 invalid accounts. 1 account failed. First error: Account is claimed by another PC."
    });
  });

  it("keeps Disable All completed but warns when one account cannot be disabled", async () => {
    const accounts = [
      { id: "account-good", email: "good@example.com", enabled: true },
      { id: "account-bad", email: "bad@example.com", enabled: true }
    ];
    const repo = {
      listAccounts: vi.fn().mockResolvedValue(accounts),
      setAccountEnabled: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("local index is read-only"))
    } as unknown as DashboardActionContext["repo"];
    const context = { ...createContext(), repo };

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "disableAll",
      requestId: "req-disable-all-partial"
    });

    expect(result.status).toBe("completed");
    expect(result.payload?.notice).toBeUndefined();
    expect(result.payload?.batchResult).toMatchObject({
      kind: "disable_all",
      successCount: 1,
      failedCount: 1,
      failures: [{ accountId: "account-bad", email: "bad@example.com", message: "local index is read-only" }]
    });
    expect(context.schedulePublishState).toHaveBeenCalled();
  });

  it("returns password-gated claim bypass outcomes to the dashboard", async () => {
    const context = createContext();
    vi.mocked(vscode.commands.executeCommand).mockResolvedValueOnce(true);

    const enabled = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "setEncryptedSyncRegistryOverride",
      requestId: "req-bypass-on",
      payload: { enabled: true, passphrase: "dashboard password" }
    });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("codexManager.setEncryptedSyncRegistryOverride", true, {
      passphrase: "dashboard password"
    });
    expect(enabled.status).toBe("completed");
    expect(enabled.payload?.notice).toBeUndefined();
    expect(context.schedulePublishState).toHaveBeenCalled();

    vi.mocked(vscode.commands.executeCommand).mockResolvedValueOnce(true);
    const disabled = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "setEncryptedSyncRegistryOverride",
      requestId: "req-bypass-off",
      payload: { enabled: false }
    });

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "codexManager.setEncryptedSyncRegistryOverride",
      false,
      { passphrase: undefined }
    );
    expect(disabled.status).toBe("completed");
    expect(disabled.payload?.notice).toBeUndefined();

    vi.mocked(vscode.commands.executeCommand).mockResolvedValueOnce(false);
    const rejected = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "setEncryptedSyncRegistryOverride",
      requestId: "req-bypass-rejected",
      payload: { enabled: true }
    });

    expect(rejected.status).toBe("failed");
    expect(rejected.errorMessage).toMatch(/not enabled/i);
  });

  it("allows duplicate refresh-view requests while another window is refreshing", async () => {
    const context = createContext();
    context.publishState = vi.fn().mockResolvedValue(undefined);

    const first = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "refreshView",
      requestId: "req-refresh-first"
    });
    const duplicate = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "refreshView",
      requestId: "req-refresh-duplicate"
    });

    expect(first.status).toBe("completed");
    expect(duplicate.status).toBe("completed");
    expect(context.publishState).toHaveBeenCalledTimes(2);
  });

  it("loads daily usage only for an explicit account action and caps the requested window", async () => {
    const context = createContext();
    context.context = {
      globalState: {
        get: vi.fn().mockReturnValue([]),
        update: vi.fn().mockResolvedValue(undefined)
      }
    } as unknown as DashboardActionContext["context"];
    const account = { id: "usage-account", email: "usage@example.com" };
    context.repo = {
      getAccount: vi.fn().mockResolvedValue(account),
      getTokens: vi.fn().mockResolvedValue({
        accessToken: "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.",
        idToken: "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0."
      })
    } as unknown as DashboardActionContext["repo"];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ days: 30, daily_usage: [{ date: "2026-08-28", total_tokens: 42 }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "getDailyUsage",
      accountId: account.id,
      requestId: "req-daily-usage",
      payload: { days: 365 }
    });

    expect(result.status).toBe("completed");
    expect(result.payload?.dailyUsage?.points[0]?.totalTokens).toBe(42);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("days=30");
    vi.unstubAllGlobals();
  });

  it("returns a visible failure when daily usage has no access token", async () => {
    const context = createContext();
    context.repo = {
      getAccount: vi.fn().mockResolvedValue({ id: "usage-account", email: "usage@example.com" }),
      getTokens: vi.fn().mockResolvedValue(undefined)
    } as unknown as DashboardActionContext["repo"];

    const result = await executeDashboardActionMessage(context, {
      type: "dashboard:action",
      action: "getDailyUsage",
      accountId: "usage-account",
      requestId: "req-daily-usage-missing-token"
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/access token/i);
  });
});

function createContext(): DashboardActionContext {
  return {
    context: {} as DashboardActionContext["context"],
    repo: {} as DashboardActionContext["repo"],
    resolveLanguage: () => "en",
    schedulePublishState: vi.fn(),
    publishState: vi.fn(),
    oauth: {} as DashboardActionContext["oauth"],
    announcements: {} as DashboardActionContext["announcements"],
    getAnnouncementOptions: () => ({
      version: "1.0.0",
      locale: "en"
    })
  };
}
