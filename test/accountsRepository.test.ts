import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { CodexTokens } from "../src/core/types";

const { writeAuthFileMock, readAuthFileMock } = vi.hoisted(() => ({
  writeAuthFileMock: vi.fn(),
  readAuthFileMock: vi.fn()
}));

vi.mock("../src/codex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codex")>();
  return {
    ...actual,
    readAuthFile: readAuthFileMock,
    writeAuthFile: writeAuthFileMock
  };
});

import { AccountsRepository } from "../src/storage";
import { buildAccountStorageId } from "../src/utils/accountIdentity";
import { removeTestDirectory } from "./testFilesystem";

function createJwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

function createTokens(
  accountId = "acct_123",
  email = "dev@example.com",
  options: {
    organizationId?: string;
    userId?: string;
  } = {}
): CodexTokens {
  const authPayload: Record<string, unknown> = {
    chatgpt_account_id: accountId
  };
  if (options.organizationId) {
    authPayload["organization_id"] = options.organizationId;
  }
  if (options.userId) {
    authPayload["chatgpt_user_id"] = options.userId;
  }

  return {
    idToken: createJwt({
      email,
      "https://api.openai.com/auth": authPayload
    }),
    accessToken: createJwt({
      "https://api.openai.com/auth": authPayload
    }),
    refreshToken: "refresh-token",
    accountId
  };
}

describe("AccountsRepository token persistence", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-manager-test-"));
    writeAuthFileMock.mockReset();
    readAuthFileMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await removeTestDirectory(tempDir);
  }, 15_000);

  it("syncs active auth.json when quota refresh produces updated tokens", async () => {
    const secrets = new Map<string, string>();
    const context = {
      globalStorageUri: {
        fsPath: tempDir
      },
      secrets: {
        get: vi.fn(async (key: string) => secrets.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          secrets.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          secrets.delete(key);
        })
      }
    } as unknown as vscode.ExtensionContext;
    await fs.writeFile(
      path.join(tempDir, "accounts-index.json"),
      JSON.stringify({
        currentAccountId: "account-1",
        accounts: [
          {
            id: "account-1",
            email: "dev@example.com",
            accountName: "Dev",
            accountId: "acct_123",
            isActive: true,
            createdAt: 1,
            updatedAt: 1,
            quotaError: {
              message: "Token expired",
              timestamp: 1
            }
          }
        ]
      }),
      "utf8"
    );

    const repo = new AccountsRepository(context);
    const updatedTokens = createTokens("acct_123");

    await repo.updateQuota("account-1", undefined, undefined, updatedTokens);

    expect(writeAuthFileMock).toHaveBeenCalledWith(updatedTokens);
    expect(JSON.parse(secrets.get("codex.account.account-1") ?? "{}")).toMatchObject({
      refreshToken: "refresh-token",
      accountId: "acct_123"
    });
    expect((await repo.getAccount("account-1"))?.quotaError).toBeUndefined();

    repo.dispose();
  });

  it("reports every durable vault mutation while leaving local-only changes out", async () => {
    const secrets = new Map<string, string>();
    const context = {
      globalStorageUri: { fsPath: tempDir },
      secrets: {
        get: vi.fn(async (key: string) => secrets.get(key)),
        store: vi.fn(async (key: string, value: string) => secrets.set(key, value)),
        delete: vi.fn(async (key: string) => secrets.delete(key))
      }
    } as unknown as vscode.ExtensionContext;
    const onAccountsMutated = vi.fn();
    const onVaultMutation = vi.fn();
    const repo = new AccountsRepository(context);
    repo.setAccountSwitchCoordinator({
      prepareAccountSwitch: vi.fn(async () => undefined),
      completeAccountSwitch: vi.fn(async () => undefined),
      cancelAccountSwitch: vi.fn(async () => undefined),
      onAccountsMutated,
      onVaultMutation
    });

    const account = await repo.upsertFromTokens(createTokens("acct_durable", "durable@example.com"));
    expect(onAccountsMutated).toHaveBeenCalledWith({ addedAccountIds: [account.id], removedAccountIds: [] });

    onVaultMutation.mockClear();
    await repo.updateTokens(account.id, {
      ...createTokens("acct_durable", "durable@example.com"),
      refreshToken: "replacement-refresh-token"
    });
    expect(onVaultMutation).toHaveBeenCalledWith("credentials-changed");

    onVaultMutation.mockClear();
    await repo.setAccountTokenRefreshEnabled(account.id, true);
    expect(onVaultMutation).toHaveBeenCalledWith("token-refresh-setting-changed");

    onVaultMutation.mockClear();
    await repo.setAccountQueuePriority(account.id, true);
    expect(onVaultMutation).not.toHaveBeenCalled();
    repo.dispose();
  });

  it("hydrates stored tokens from external auth.json changes without rewriting auth.json", async () => {
    const secrets = new Map<string, string>();
    const context = {
      globalStorageUri: {
        fsPath: tempDir
      },
      secrets: {
        get: vi.fn(async (key: string) => secrets.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          secrets.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          secrets.delete(key);
        })
      }
    } as unknown as vscode.ExtensionContext;
    const storageId = buildAccountStorageId("dev@example.com", "acct_123", undefined);
    await fs.writeFile(
      path.join(tempDir, "accounts-index.json"),
      JSON.stringify({
        currentAccountId: undefined,
        accounts: [
          {
            id: storageId,
            email: "dev@example.com",
            accountName: "Dev",
            accountId: "acct_123",
            isActive: false,
            createdAt: 1,
            updatedAt: 1,
            quotaError: {
              message: "Token expired",
              timestamp: 1
            }
          }
        ]
      }),
      "utf8"
    );
    await context.secrets.store(`codex.account.${storageId}`, JSON.stringify(createTokens("acct_123")));

    const externalTokens = createTokens("acct_123");
    externalTokens.accessToken = createJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123"
      }
    });
    externalTokens.refreshToken = "refreshed-token";
    readAuthFileMock.mockResolvedValue({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: externalTokens.idToken,
        access_token: externalTokens.accessToken,
        refresh_token: externalTokens.refreshToken,
        account_id: externalTokens.accountId
      },
      last_refresh: new Date().toISOString()
    });

    const repo = new AccountsRepository(context);
    await repo.syncActiveAccountFromAuthFile();

    expect(writeAuthFileMock).not.toHaveBeenCalled();
    expect(JSON.parse(secrets.get(`codex.account.${storageId}`) ?? "{}")).toMatchObject({
      refreshToken: "refreshed-token",
      accountId: "acct_123"
    });
    expect((await repo.getAccount(storageId))?.isActive).toBe(true);
    expect((await repo.getAccount(storageId))?.quotaError).toBeUndefined();

    repo.dispose();
  });

  it("repairs status visibility when force-activating an OAuth account", async () => {
    const secrets = new Map<string, string>();
    const context = {
      globalStorageUri: {
        fsPath: tempDir
      },
      secrets: {
        get: vi.fn(async (key: string) => secrets.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          secrets.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          secrets.delete(key);
        })
      }
    } as unknown as vscode.ExtensionContext;
    const activeId = buildAccountStorageId("oauth@example.com", "acct_oauth", undefined);
    await fs.writeFile(
      path.join(tempDir, "accounts-index.json"),
      JSON.stringify({
        currentAccountId: activeId,
        accounts: [
          {
            id: activeId,
            email: "oauth@example.com",
            accountId: "acct_oauth",
            isActive: true,
            showInStatusBar: false,
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: "extra-visible",
            email: "extra@example.com",
            isActive: false,
            showInStatusBar: true,
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }),
      "utf8"
    );

    const repo = new AccountsRepository(context);
    const imported = await repo.upsertFromTokens(createTokens("acct_new", "new@example.com"), true);
    const accounts = await repo.listAccounts();

    expect(imported.isActive).toBe(true);
    expect(accounts.find((account) => account.id === imported.id)?.showInStatusBar).toBe(false);
    expect(accounts.find((account) => account.id === activeId)?.showInStatusBar).toBe(true);

    repo.dispose();
  });

  it("imports new and overwrites existing exported accounts when old tokens lack email claims", async () => {
    const secrets = new Map<string, string>();
    const context = {
      globalStorageUri: {
        fsPath: tempDir
      },
      secrets: {
        get: vi.fn(async (key: string) => secrets.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          secrets.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          secrets.delete(key);
        })
      }
    } as unknown as vscode.ExtensionContext;
    const repo = new AccountsRepository(context);
    const existing = await repo.upsertFromTokens(createTokens("acct_existing", "existing@example.com"));
    const oldIdToken = createJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_existing"
      }
    });

    const result = await repo.importSharedAccountsWithSummary({
      id: existing.id,
      email: existing.email,
      account_id: "acct_existing",
      tokens: {
        id_token: oldIdToken,
        access_token: "invalidated-opaque-access-token",
        refresh_token: "replacement-refresh-token",
        account_id: "acct_existing"
      }
    });

    expect(result).toMatchObject({
      total: 1,
      successCount: 1,
      overwriteCount: 1,
      failedCount: 0
    });
    expect(await repo.listAccounts()).toHaveLength(1);
    expect((await repo.getTokens(existing.id))?.refreshToken).toBe("replacement-refresh-token");

    const newResult = await repo.importSharedAccountsWithSummary({
      email: "new-legacy@example.com",
      account_id: "acct_new_legacy",
      tokens: {
        id_token: createJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct_new_legacy"
          }
        }),
        access_token: "another-invalidated-opaque-access-token",
        refresh_token: "new-refresh-token",
        account_id: "acct_new_legacy"
      }
    });

    expect(newResult).toMatchObject({
      total: 1,
      successCount: 1,
      overwriteCount: 0,
      failedCount: 0
    });
    expect(await repo.listAccounts()).toHaveLength(2);

    repo.dispose();
  });

  it("clears a stale auth error only when shared import replaces the credentials", async () => {
    const secrets = new Map<string, string>();
    const context = {
      globalStorageUri: {
        fsPath: tempDir
      },
      secrets: {
        get: vi.fn(async (key: string) => secrets.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          secrets.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          secrets.delete(key);
        })
      }
    } as unknown as vscode.ExtensionContext;
    const repo = new AccountsRepository(context);
    const originalTokens = createTokens("acct_sync", "sync@example.com");
    const account = await repo.upsertFromTokens(originalTokens);
    const authError = {
      code: "unauthorized",
      message: "API returned 401: token expired",
      timestamp: 100
    };

    await repo.updateQuota(account.id, undefined, authError);
    await repo.importSharedAccountsWithSummary({
      id: account.id,
      email: account.email,
      account_id: account.accountId,
      tokens: {
        id_token: originalTokens.idToken,
        access_token: originalTokens.accessToken,
        refresh_token: originalTokens.refreshToken,
        account_id: originalTokens.accountId
      }
    });
    expect((await repo.getAccount(account.id))?.quotaError).toEqual(authError);

    const replacementTokens = { ...originalTokens, refreshToken: "reauthorized-refresh-token" };
    await repo.importSharedAccountsWithSummary({
      id: account.id,
      email: account.email,
      account_id: account.accountId,
      tokens: {
        id_token: replacementTokens.idToken,
        access_token: replacementTokens.accessToken,
        refresh_token: replacementTokens.refreshToken,
        account_id: replacementTokens.accountId
      }
    });
    expect((await repo.getAccount(account.id))?.quotaError).toBeUndefined();

    repo.dispose();
  });

  it("keeps reset credits expiry when snapshot refresh still has available credits but no expiry", async () => {
    const secrets = new Map<string, string>();
    const context = {
      globalStorageUri: {
        fsPath: tempDir
      },
      secrets: {
        get: vi.fn(async (key: string) => secrets.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          secrets.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          secrets.delete(key);
        })
      }
    } as unknown as vscode.ExtensionContext;
    await fs.writeFile(
      path.join(tempDir, "accounts-index.json"),
      JSON.stringify({
        accounts: [
          {
            id: "account-1",
            email: "dev@example.com",
            isActive: false,
            createdAt: 1,
            updatedAt: 1,
            quotaSummary: {
              hourlyPercentage: 90,
              hourlyWindowPresent: true,
              weeklyPercentage: 95,
              weeklyWindowPresent: true,
              codeReviewPercentage: 0,
              resetCreditsAvailable: 1,
              resetCreditsNextExpiresAt: 1_785_109_796
            }
          }
        ]
      }),
      "utf8"
    );

    const repo = new AccountsRepository(context);
    await repo.updateResetCreditsSnapshot("account-1", 1, undefined);

    expect((await repo.getAccount("account-1"))?.quotaSummary?.resetCreditsNextExpiresAt).toBe(1_785_109_796);

    await repo.updateResetCreditsSnapshot("account-1", 0, undefined);

    expect((await repo.getAccount("account-1"))?.quotaSummary?.resetCreditsNextExpiresAt).toBeUndefined();

    repo.dispose();
  });
});
