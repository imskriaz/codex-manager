import type { DashboardAccountViewModel } from "../../domain/dashboard/types";
import { activeApiAccount, apiAccountCredential, listApiAccounts } from "../../services/apiAccounts";

function apiKeyHint(account: Parameters<typeof apiAccountCredential>[0]): string {
  try {
    const key = apiAccountCredential(account);
    return key.length > 4 ? `${key.slice(0, 3)}••••${key.slice(-4)}` : "••••";
  } catch {
    return "••••";
  }
}

export function apiDashboardAccounts(): DashboardAccountViewModel[] {
  return listApiAccounts().map((account) => {
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
      queuePriority: false,
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
