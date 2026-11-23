import { createHash } from 'crypto';
import type { DashboardAccountViewModel } from '../../domain/dashboard/types';
import { cachedClaudeConnection, claudeConfigHome, claudeAccountKey, discoverClaudeModels } from '../../services/claudeCliRuntime';
import { listClaudeSessions } from '../../services/claudeSessions';

const accountId = () => 'claude:' + createHash('sha256').update(claudeConfigHome()).digest('hex');
export function isClaudeAccount(id: string): boolean { return id === accountId(); }

/** Native login stays in Claude Code; Manager stores no copy of its credentials. */
export function claudeDashboardAccount(): DashboardAccountViewModel | undefined {
  void discoverClaudeModels();
  const connection = cachedClaudeConnection();
  if (!connection?.models.length) return undefined;
  const key = claudeAccountKey(connection.account);
  const quota = listClaudeSessions().map(session => session.nativeQuota).filter((value): value is NonNullable<typeof value> => value !== undefined && key !== undefined && value.accountKey === key)
    .sort((a, b) => b.checkedAt - a.checkedAt)[0];
  const metrics = (quota?.limits ?? []).map(limit => ({ key: limit.kind, label: limit.kind === 'five_hour' ? '5h' : limit.kind === 'seven_day' ? 'Weekly' : limit.kind.replace(/_/g, ' '),
    percentage: limit.resetsAt && limit.resetsAt * 1000 <= Date.now() || limit.usedPercent === undefined ? undefined : Math.max(0, 100 - limit.usedPercent),
    resetAt: limit.resetsAt === undefined ? undefined : limit.resetsAt * 1000, visible: true }));
  return { id: accountId(), provider: 'claude', displayName: 'Claude Code', email: connection.account?.email ?? 'Claude Code',
    authProviderLabel: 'Claude', accountStructureLabel: 'Native Claude Code login', workspaceLabel: '', isTeamWorkspace: false,
    subscriptionText: connection.account?.subscriptionType ?? 'Native login', subscriptionTitle: 'Managed by Claude Code',
    addMethodLabel: 'Native Claude Code', addedAtLabel: '', planTypeLabel: connection.account?.subscriptionType ?? 'Claude',
    isActive: false, switchQueued: false, isCurrentWindowAccount: false, enabled: false, queuePriority: false,
    tokenRefreshEnabled: false, canRefreshToken: false, showInStatusBar: false, canToggleStatusBar: false,
    statusToggleTitle: 'Choose a Claude model to use this native login', hasQuota402: false, healthKind: 'healthy',
    healthLabel: 'Native login', dismissedHealth: false, lastQuotaAt: quota?.checkedAt, metrics };
}

export async function refreshClaudeDashboardAccount() {
  const connection = await discoverClaudeModels(true);
  if (connection.warning) throw new Error(connection.warning);
  if (!connection.models.length) throw new Error('Claude Code was not found. Install and sign in to Claude Code, then refresh.');
  return { level: 'info' as const, message: 'Claude connection refreshed. Quota updates when the native runtime reports usage limits; this refresh does not query subscription quota.' };
}
