import { beforeEach, expect, it, vi } from 'vitest';
const flow = vi.hoisted(() => ({ listen: vi.fn(), prepare: vi.fn() }));
vi.mock('vscode', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('../tools/node-vscode-shim/vscode.js');
});
vi.mock('../src/auth/oauth', () => ({ listenForPreparedOAuthLoginSession: flow.listen, prepareOAuthLoginSession: flow.prepare, completeOAuthLoginSession: vi.fn() }));
vi.mock('../src/application/accounts/quota', () => ({ refreshImportedAccountQuota: vi.fn().mockResolvedValue({}) }));
vi.mock('../src/application/accounts/queuedAccountActivation', () => ({ activateQueuedAccountIfCurrentMissing: vi.fn().mockResolvedValue({ status: 'not-needed' }) }));
import { DashboardOAuthCoordinator } from '../src/presentation/dashboard/oauthCoordinator';
beforeEach(() => { vi.clearAllMocks(); flow.prepare.mockReturnValue({ authUrl: 'https://auth.example.test', redirectUri: 'http://localhost/callback', state: 'state', verifier: 'verifier' }); });
it('runs standalone browser authorization through the actual Node adapter and saves the account once', async () => {
  flow.listen.mockImplementation(async (_session, token) => {
    expect(token.isCancellationRequested).toBe(false); expect(typeof token.onCancellationRequested).toBe('function');
    return { idToken: 'id', accessToken: 'access', refreshToken: 'refresh' };
  });
  const repo = { upsertFromTokens: vi.fn().mockResolvedValue({ id: 'new', email: 'account@example.invalid' }) };
  const coordinator = new DashboardOAuthCoordinator(repo as never, vi.fn());
  try {
    const id = coordinator.prepareSession(key => key)?.oauthSession?.sessionId;
    const [first, duplicate] = await Promise.all([coordinator.startAutoFlow(id, key => key), coordinator.startAutoFlow(id, key => key)]);
    expect(first?.email).toBe('account@example.invalid'); expect(duplicate?.email).toBe(first?.email);
    expect(repo.upsertFromTokens).toHaveBeenCalledOnce(); expect(flow.listen).toHaveBeenCalledOnce();
  } finally { coordinator.dispose(); }
});
it('cancels a standalone callback listener on close without saving an account', async () => {
  flow.listen.mockImplementation((_session, token) => new Promise((_resolve, reject) => { token.onCancellationRequested(() => reject(new Error('OAuth login cancelled by user.'))); }));
  const repo = { upsertFromTokens: vi.fn() }, coordinator = new DashboardOAuthCoordinator(repo as never, vi.fn());
  try {
    const id = coordinator.prepareSession(key => key)?.oauthSession?.sessionId;
    const pending = coordinator.startAutoFlow(id, key => key); coordinator.cancelSession(id);
    await expect(pending).resolves.toBeUndefined(); expect(repo.upsertFromTokens).not.toHaveBeenCalled();
  } finally { coordinator.dispose(); }
});
