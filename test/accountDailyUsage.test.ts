import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAccountDailyUsage } from '../src/services/usage';
import type { AccountsRepository } from '../src/storage/accounts';
import type { CodexManagerAccountRecord } from '../src/core/types';

vi.mock('../src/utils/network', async importOriginal => ({
  ...await importOriginal<typeof import('../src/utils/network')>(),
  fetchWithTimeout: (url: string, options: RequestInit) => fetch(url, options)
}));

const jwt = (expires: number) => `e30.${Buffer.from(JSON.stringify({ sub: 'test', exp: expires })).toString('base64url')}.`;
const fresh = { accessToken: jwt(Math.floor(Date.now() / 1000) + 3600), idToken: jwt(1), refreshToken: 'refresh', accountId: 'workspace' };
const account = { id: 'a', accountId: 'workspace', tokenRefreshEnabled: true } as CodexManagerAccountRecord;
const response = () => new Response(JSON.stringify({ data: [{ date: '2026-10-15', total_tokens: 100, clients: [{ client_id: 'codex_ide_vscode', text_total_tokens: 42 }, { client_id: 'cli', text_total_tokens: 58 }] }] }));
const setup = () => {
  const repo = { getTokens: vi.fn().mockResolvedValue(fresh), getAccount: vi.fn().mockResolvedValue(account), refreshAccountTokens: vi.fn().mockResolvedValue(fresh) };
  const fetch = vi.fn().mockImplementation(async () => response());
  vi.stubGlobal('fetch', fetch);
  return { repo, fetch, load: (selected = account, signal?: AbortSignal) => fetchAccountDailyUsage(repo as unknown as AccountsRepository, selected, 30, signal) };
};
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('account usage credentials and recovery', () => {
  it('keeps only verified VS Code counts when other-client attribution is incomplete', async () => {
    const { fetch, load } = setup();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ date: '2026-10-15', total_tokens: 100, clients: [
      { client_id: 'codex_ide_vscode', text_total_tokens: 42 }, { client_id: 'web', credits: 3 }
    ] }] })));
    await expect(load()).resolves.toEqual({ days: 30, points: [{ date: '2026-10-15', unit: 'tokens', totalTokens: 42, extensionTokens: 42 }] });
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ date: '2026-10-15', total_tokens: 100 }] })));
    await expect(load()).rejects.toThrow('no verified VS Code');
  });
  it('renews expired credentials through the repository before requesting usage', async () => {
    const { repo, fetch, load } = setup();
    repo.getTokens.mockResolvedValue({ ...fresh, accessToken: jwt(1) });
    await expect(load()).resolves.toMatchObject({ points: [{ totalTokens: 42 }] });
    expect(repo.refreshAccountTokens).toHaveBeenCalledExactlyOnceWith('a', { force: false });
    expect(fetch.mock.calls[0]?.[1]?.headers.get('Authorization')).toBe(`Bearer ${fresh.accessToken}`);
  });
  it('retries a rejected token once and never loops on a second rejection', async () => {
    const { repo, fetch, load } = setup();
    fetch.mockResolvedValueOnce(new Response('revoked', { status: 401 }));
    await expect(load()).resolves.toMatchObject({ points: [{ totalTokens: 42 }] });
    expect(repo.refreshAccountTokens).toHaveBeenCalledExactlyOnceWith('a', { force: true });
    fetch.mockReset().mockImplementation(async () => new Response('revoked', { status: 401 }));
    repo.refreshAccountTokens.mockClear();
    await expect(load()).rejects.toThrow('401');
    expect(repo.refreshAccountTokens).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not force another rotation after renewing an expired token', async () => {
    const { repo, fetch, load } = setup();
    repo.getTokens.mockResolvedValue({ ...fresh, accessToken: jwt(1) });
    fetch.mockResolvedValueOnce(new Response('revoked', { status: 401 }));
    await expect(load()).rejects.toThrow('401');
    expect(repo.refreshAccountTokens).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([403, 429, 503])('does not rotate credentials for HTTP %i', async status => {
    const { repo, fetch, load } = setup(); fetch.mockResolvedValueOnce(new Response('failed', { status }));
    await expect(load()).rejects.toThrow(String(status));
    expect(repo.refreshAccountTokens).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce();
  });
  it('honors disabled renewal and missing refresh credentials', async () => {
    const { repo, fetch, load } = setup(); fetch.mockImplementation(async () => new Response('revoked', { status: 401 }));
    await expect(load({ ...account, tokenRefreshEnabled: false })).rejects.toThrow('reauthorize');
    repo.getTokens.mockResolvedValue({ ...fresh, refreshToken: '' });
    await expect(load()).rejects.toThrow('reauthorize');
    expect(repo.refreshAccountTokens).not.toHaveBeenCalled();
  });
  it('rejects missing, foreign and newly rotated foreign credentials before sending them', async () => {
    const { repo, fetch, load } = setup();
    repo.getTokens.mockResolvedValueOnce(undefined);
    await expect(load()).rejects.toThrow('access token');
    repo.getTokens.mockResolvedValueOnce({ ...fresh, accountId: 'other' });
    await expect(load()).rejects.toThrow('different account');
    repo.getTokens.mockResolvedValueOnce({ ...fresh, accessToken: jwt(1) });
    repo.refreshAccountTokens.mockResolvedValueOnce({ ...fresh, accountId: 'other' });
    await expect(load()).rejects.toThrow('different account'); expect(fetch).not.toHaveBeenCalled();
  });
  it('uses the selected workspace and keeps already loaded history when the account is deleted', async () => {
    const { repo, fetch, load } = setup();
    repo.getTokens.mockResolvedValue({ ...fresh, accountId: undefined });
    await load(); expect(fetch.mock.calls[0]?.[1]?.headers.get('ChatGPT-Account-Id')).toBe('workspace');
    repo.getAccount.mockResolvedValueOnce(undefined);
    await expect(load()).resolves.toEqual({ days: 30, points: [{ date: '2026-10-15', unit: 'tokens', totalTokens: 42, extensionTokens: 42 }] });
  });
  it('bounds an unconfirmed rotation without replaying it or sending stale credentials', async () => {
    vi.useFakeTimers();
    const { repo, fetch, load } = setup(); repo.getTokens.mockResolvedValue({ ...fresh, accessToken: jwt(1) });
    repo.refreshAccountTokens.mockReturnValueOnce(new Promise(() => {}));
    const failed = expect(load()).rejects.toThrow('still refreshing');
    await vi.advanceTimersByTimeAsync(5000); await failed;
    expect(repo.refreshAccountTokens).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  });
  it('does not request or rotate credentials after cancellation', async () => {
    const { repo, fetch, load } = setup(); const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(load(account, controller.signal)).rejects.toThrow('cancelled');
    expect(repo.getTokens).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
