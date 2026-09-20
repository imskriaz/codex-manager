import { AccountError, ErrorCode } from "../core/errors";
import type { CodexManagerAccountRecord, CodexManagerIndex } from "../core/types";
import { markActive } from "./accountsIndex";
import { reconcileStatusBarSelections } from "./accountMetadata";

export function dismissAccountHealthIssue(
  index: CodexManagerIndex,
  accountId: string,
  issueKey: string | undefined,
  now: number
): CodexManagerAccountRecord | undefined {
  const account = index.accounts.find((item) => item.id === accountId);
  if (!account) {
    return undefined;
  }

  account.dismissedHealthIssueKey = issueKey?.trim() ?? undefined;
  account.updatedAt = now;
  return account;
}

export function switchActiveAccount(
  index: CodexManagerIndex,
  accountId: string,
  now = Date.now(),
  codexHomeKey?: string
): CodexManagerAccountRecord | undefined {
  const account = index.accounts.find((item) => item.id === accountId);
  if (!account) {
    return undefined;
  }

  const previousActiveId = index.currentAccountId;
  markActive(index, accountId, now, codexHomeKey);
  reconcileStatusBarSelections(index, accountId, previousActiveId);
  return index.accounts.find((item) => item.id === accountId);
}

export function setAccountEnabled(
  index: CodexManagerIndex,
  accountId: string,
  enabled: boolean,
  _now: number
): CodexManagerAccountRecord | undefined {
  const account = index.accounts.find((item) => item.id === accountId);
  if (!account) {
    return undefined;
  }

  account.enabled = enabled;
  return account;
}

export function setAccountQueuePriority(
  index: CodexManagerIndex,
  accountId: string,
  queuePriority: boolean,
  _now: number
): CodexManagerAccountRecord | undefined {
  const account = index.accounts.find((item) => item.id === accountId);
  if (!account) {
    return undefined;
  }

  account.queuePriority = queuePriority;
  return account;
}

export function setAccountTokenRefreshEnabled(
  index: CodexManagerIndex,
  accountId: string,
  enabled: boolean,
  now: number
): CodexManagerAccountRecord | undefined {
  const account = index.accounts.find((item) => item.id === accountId);
  if (!account) {
    return undefined;
  }

  account.tokenRefreshEnabled = enabled;
  account.updatedAt = now;
  return account;
}

export function removeAccountFromIndex(index: CodexManagerIndex, accountId: string): boolean {
  const before = index.accounts.length;
  index.accounts = index.accounts.filter((item) => item.id !== accountId);

  if (index.currentAccountId === accountId) {
    index.currentAccountId = undefined;
  }
  if (index.activeAccountIdsByCodexHome) {
    for (const [codexHomeKey, activeAccountId] of Object.entries(index.activeAccountIdsByCodexHome)) {
      if (activeAccountId === accountId) delete index.activeAccountIdsByCodexHome[codexHomeKey];
    }
  }

  return index.accounts.length !== before;
}

export function setStatusBarVisibility(
  index: CodexManagerIndex,
  accountId: string,
  visible: boolean,
  now: number
): CodexManagerAccountRecord | undefined {
  const account = index.accounts.find((item) => item.id === accountId);
  if (!account) {
    return undefined;
  }

  if (account.isActive) {
    account.showInStatusBar = false;
  } else if (visible) {
    const enabledCount = index.accounts.filter((item) => !item.isActive && item.showInStatusBar).length;
    if (enabledCount >= 2) {
      throw new AccountError("Only 2 extra accounts can be shown in the status popup", {
        code: ErrorCode.ACCOUNT_INVALID_DATA,
        i18nKey: "status.limitTip"
      });
    }
    account.showInStatusBar = true;
  } else {
    account.showInStatusBar = false;
  }

  account.updatedAt = now;
  return account;
}
