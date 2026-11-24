import type { DashboardSettings } from "../../src/domain/dashboard/types";

export const SETTINGS_MODULE_KEYS: Record<string, keyof DashboardSettings> = {
  dashboard: "webDashboardEnabled", sessions: "cliIntegrationEnabled", connections: "webSocketServerEnabled",
  sync: "encryptedSyncEnabled", desktop: "codexAppRestartEnabled", usage: "dailyTokenUsageEnabled",
  "system-log": "persistentLoggingEnabled", users: "teamWorkspaceEnabled", workspace: "teamWorkspaceEnabled",
  mcp: "teamWorkspaceEnabled", database: "teamWorkspaceEnabled", logs: "teamWorkspaceEnabled", proxy: "apiAccessEnabled"
};

export function settingsGroup(section: string): string {
  if (['dashboard', 'connections', 'sync'].includes(section)) return 'connections';
  if (['sessions', 'desktop'].includes(section)) return 'sessions';
  if (['data', 'usage', 'system-log'].includes(section)) return 'data';
  if (['users', 'workspace', 'mcp', 'database', 'logs', 'proxy'].includes(section)) return 'users';
  return section;
}

export function isSettingsSectionEnabled(section: string, settings: DashboardSettings, canManageTeam: boolean): boolean {
  if (["users", "workspace", "mcp", "database", "logs", "proxy"].includes(section) && !canManageTeam) return false;
  if (section === "proxy") return settings.apiAccessEnabled === true;
  const key = SETTINGS_MODULE_KEYS[section];
  if (section === "connections") return settings.webSocketServerEnabled === true;
  return !key || settings[key] === true;
}

export function matchesSettingsSearch(text: string, query: string): boolean {
  const normalized = text.toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/).every(word => normalized.includes(word));
}

export function resolveSettingsModuleKey(section: string, settings: DashboardSettings): keyof DashboardSettings | undefined {
  if (["users", "workspace", "mcp", "database", "logs", "proxy"].includes(section)) {
    if (!settings.webDashboardEnabled) return "webDashboardEnabled";
    if (settings.teamWorkspaceEnabled !== true) return "teamWorkspaceEnabled";
  }
  return SETTINGS_MODULE_KEYS[section];
}
