import { beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ cached: vi.fn(), discover: vi.fn(), sessions: vi.fn() }));
vi.mock('../src/services/claudeCliRuntime', () => ({ cachedClaudeConnection: native.cached, discoverClaudeModels: native.discover, claudeConfigHome: () => 'native-test', claudeAccountKey: (account?: {email?: string}) => account?.email }));
vi.mock('../src/services/claudeSessions', () => ({ listClaudeSessions: native.sessions }));
import { claudeDashboardAccount, isClaudeAccount, refreshClaudeDashboardAccount } from '../src/application/dashboard/claudeAccount';
beforeEach(() => { vi.clearAllMocks(); native.sessions.mockReturnValue([]); native.cached.mockReturnValue(undefined); native.discover.mockResolvedValue({ models: [] }); });
it('keeps native discovery optional and adds no account before detection', () => { expect(claudeDashboardAccount()).toBeUndefined(); expect(native.discover).toHaveBeenCalled(); });
it('keeps native login and reported quota separate from Codex automation', () => {
  native.cached.mockReturnValue({ models: [{ id: 'claude-code/opus' }], account: { email: 'native@example.test', subscriptionType: 'Pro' } });
  native.sessions.mockReturnValue([{ nativeQuota: { checkedAt: 100, accountKey: 'native@example.test', limits: [{ kind: 'five_hour', usedPercent: 25 }, { kind: 'seven_day', status: 'allowed' }] } }]);
  const account = claudeDashboardAccount()!;
  expect(account).toMatchObject({ provider: 'claude', email: 'native@example.test', enabled: false, canRefreshToken: false, metrics: [{ key: 'five_hour', percentage: 75 }, { key: 'seven_day', percentage: undefined }] });
  expect(isClaudeAccount(account.id)).toBe(true); expect(isClaudeAccount('claude:another-config')).toBe(false);
});
it('does not assign a previous native login quota to the current account', () => {
  native.cached.mockReturnValue({ models: [{}], account: { email: 'new@example.test' } });
  native.sessions.mockReturnValue([{ nativeQuota: { checkedAt: 100, accountKey: 'old@example.test', limits: [{ kind: 'five_hour', usedPercent: 90 }] } }]);
  expect(claudeDashboardAccount()?.metrics).toEqual([]);
});
it('preserves native refresh failures and explains quota refresh limitations', async () => {
  native.discover.mockResolvedValueOnce({ models: [], warning: 'Native authentication failed' });
  await expect(refreshClaudeDashboardAccount()).rejects.toThrow('Native authentication failed');
  native.discover.mockResolvedValueOnce({ models: [{}] });
  expect(await refreshClaudeDashboardAccount()).toMatchObject({ message: expect.stringContaining('does not query subscription quota') });
});
