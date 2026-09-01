import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { unloadDisabledActiveAccountOnStartup } from "../src/presentation/workbench/startupAccountSafety";

describe("disabled active account startup safety", () => {
  it("automatically unloads an account that stayed disabled across restart", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const unload = vi.fn().mockResolvedValue(undefined);
    const repo = {
      listAccounts: vi.fn().mockResolvedValue([
        { id: "active", email: "active@example.com", isActive: true, enabled: false }
      ]),
      syncActiveAccountFromAuthFile: vi.fn().mockResolvedValue(undefined)
    };
    const context = { workspaceState: { update } } as unknown as vscode.ExtensionContext;

    await expect(
      unloadDisabledActiveAccountOnStartup(context, repo as never, unload, async () => "active")
    ).resolves.toBe(true);

    expect(unload).toHaveBeenCalledOnce();
    expect(repo.syncActiveAccountFromAuthFile).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith("codexManager.currentWindowRuntimeAccountId", undefined);
  });

  it("leaves an enabled current account loaded", async () => {
    const unload = vi.fn().mockResolvedValue(undefined);
    const repo = {
      listAccounts: vi.fn().mockResolvedValue([
        { id: "active", email: "active@example.com", isActive: true, enabled: true }
      ]),
      syncActiveAccountFromAuthFile: vi.fn()
    };
    const context = { workspaceState: { update: vi.fn() } } as unknown as vscode.ExtensionContext;

    await expect(
      unloadDisabledActiveAccountOnStartup(context, repo as never, unload, async () => "active")
    ).resolves.toBe(false);
    expect(unload).not.toHaveBeenCalled();
    expect(repo.syncActiveAccountFromAuthFile).not.toHaveBeenCalled();
  });

  it("does not unload a different account because of stale index state", async () => {
    const unload = vi.fn().mockResolvedValue(undefined);
    const repo = {
      listAccounts: vi.fn().mockResolvedValue([
        { id: "old-active", email: "old@example.com", isActive: true, enabled: false },
        { id: "loaded", email: "loaded@example.com", isActive: false, enabled: true }
      ]),
      syncActiveAccountFromAuthFile: vi.fn()
    };
    const context = { workspaceState: { update: vi.fn() } } as unknown as vscode.ExtensionContext;

    await expect(
      unloadDisabledActiveAccountOnStartup(context, repo as never, unload, async () => "loaded")
    ).resolves.toBe(false);
    expect(unload).not.toHaveBeenCalled();
  });
});
