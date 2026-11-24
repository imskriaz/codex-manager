import type { DashboardAccountViewModel } from "../../domain/dashboard/types";
import { activeApiAccount, apiAccountCredential, listApiAccounts } from "../../services/apiAccounts";
import { getSqliteStateStore } from '../../storage/sqliteState';
import { readApiAccountTokenUsage } from '../../storage/sqliteSessions';

function apiKeyHint(account: Parameters<typeof apiAccountCredential>[0]): string {
  try {
    const key = apiAccountCredential(account);
    return key.length > 4 ? `${key.slice(0, 3)}••••${key.slice(-4)}` : "••••";
  } catch {
    return "••••";
  }
}

export function apiDashboardAccounts(): DashboardAccountViewModel[] {
  const accounts = listApiAccounts();
  const store = getSqliteStateStore();
  const usage = accounts.length && store ? readApiAccountTokenUsage(store) : undefined;
  return accounts.map((account) => {
    const isCurrent = account.enabled !== false && activeApiAccount(account.provider)?.id === account.id;
    return {
      id: account.id,
      provider: account.provider === "anthropic" ? "claude" : "codex",
      authMode: "apiKey",
      displayName: account.name,
      email: account.name,
      updatedAt: account.updatedAt,
      apiBaseUrl: account.baseUrl,
      apiKeyHint: apiKeyHint(account),
      apiTokenUsage: usage?.get(account.id),
      authProviderLabel: account.provider === "openai" ? "OpenAI" : "Anthropic",
      accountStructureLabel: "API key",
      workspaceLabel: "",
      isTeamWorkspace: false,
      subscriptionText: "API key",
      subscriptionTitle: account.baseUrl,
      addMethodLabel: "API key",
      addedAt: account.createdAt,
      addedAtLabel: new Date(account.createdAt).toLocaleDateString(),
      planTypeLabel: "API",
      isActive: isCurrent,
      switchQueued: false,
      isCurrentWindowAccount: isCurrent,
      enabled: account.enabled !== false,
      queuePriority: account.queuePriority === true,
      tokenRefreshEnabled: false,
      canRefreshToken: false,
      showInStatusBar: false,
      canToggleStatusBar: false,
      statusToggleTitle: "API account",
      hasQuota402: false,
      healthKind: "healthy",
      healthLabel: "API key saved",
      dismissedHealth: false,
      metrics: []
    };
  });
}
