import * as vscode from 'vscode';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDetailsPanel } from '../src/ui/details';
import * as history from '../src/services/dashboardUsageHistory';
import { loadDailyTokenUsage } from '../src/services/dailyTokenUsage';

vi.mock('../src/services/dailyTokenUsage', () => ({ loadDailyTokenUsage: vi.fn() }));
let dispose: () => void, receive: (message: unknown) => Promise<void>;
const windowMock = vscode.window as unknown as Record<string, unknown>;
const uriMock = vscode.Uri as unknown as Record<string, unknown>;
const panel = { title: '', webview: { html: '', asWebviewUri: (uri: unknown) => String(uri), onDidReceiveMessage: vi.fn((callback: typeof receive) => { receive = callback; }) }, onDidDispose: vi.fn((callback: () => void) => { dispose = callback; }), reveal: vi.fn(), dispose: vi.fn(() => dispose()) };
const saved = { accountId: 'a', fetchedAt: Date.now() - 1000, usage: { days: 30, points: [{ date: '2026-10-15', unit: 'tokens' as const, totalTokens: 100, extensionTokens: 42 }] } };
const account = { id: 'a', email: 'test@example.test', createdAt: 1, updatedAt: 1, isActive: false };
const repo = { getAccount: vi.fn(async () => account), getTokens: vi.fn(async () => undefined) };
const context = { extensionUri: {}, globalState: { get: vi.fn(), update: vi.fn() } };
beforeEach(() => {
  vi.mocked(loadDailyTokenUsage).mockReset();
  windowMock.createWebviewPanel = vi.fn(() => panel);
  uriMock.joinPath = vi.fn(() => 'asset');
  vi.mocked(vscode.workspace.onDidChangeConfiguration).mockReturnValue({ dispose: vi.fn() });
  vi.spyOn(history, 'readDashboardDailyUsage').mockReturnValue(saved);
  vi.mocked(loadDailyTokenUsage).mockRejectedValue(new Error('HTTP 401: reauthorize <account>'));
  repo.getAccount.mockResolvedValue(account); repo.getTokens.mockResolvedValue(undefined);
  panel.webview.html = '';
});
afterEach(() => { dispose?.(); delete windowMock.createWebviewPanel; delete uriMock.joinPath; vi.restoreAllMocks(); });

it('shows a safe failure, retains verified saved usage and retries from the initiating panel', async () => {
  openDetailsPanel(context as never, repo as never, account);
  await vi.waitFor(() => expect(panel.webview.html).toContain('HTTP 401: reauthorize &lt;account&gt;'));
  expect(panel.webview.html).toContain('saved history kept');
  expect(panel.webview.html).toContain('data-role="retry-usage"');
  expect(panel.webview.html).toContain('42');
  expect(panel.webview.html).not.toContain('total_tokens');
  vi.mocked(loadDailyTokenUsage).mockResolvedValueOnce({ ...saved, usage: { days: 30, points: [] } });
  await receive({ type: 'details:retry-usage', accountId: 'a' });
  expect(loadDailyTokenUsage).toHaveBeenCalledTimes(2);
  expect(panel.webview.html).not.toContain('HTTP 401');
});

it('ignores an old account retry and does not let a late response replace the selected account', async () => {
  let finish!: (entry: typeof saved) => void;
  vi.mocked(loadDailyTokenUsage).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  openDetailsPanel(context as never, repo as never, account);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const other = { ...account, id: 'b', email: 'other@example.test' };
  repo.getAccount.mockResolvedValue(other);
  openDetailsPanel(context as never, repo as never, other);
  await vi.waitFor(() => expect(panel.webview.html).toContain('HTTP 401'));
  const calls = vi.mocked(loadDailyTokenUsage).mock.calls.length;
  await receive({ type: 'details:retry-usage', accountId: 'a' });
  expect(loadDailyTokenUsage).toHaveBeenCalledTimes(calls);
  finish({ ...saved, usage: { days: 30, points: [] } });
  await new Promise(resolve => setImmediate(resolve));
  expect(panel.webview.html).toContain('HTTP 401');
});

it('finishes loading visibly when credentials and saved history are missing', async () => {
  vi.mocked(history.readDashboardDailyUsage).mockReturnValue(undefined);
  vi.mocked(loadDailyTokenUsage).mockRejectedValueOnce(new Error('No access token is available. Reauthorize this account.'));
  openDetailsPanel(context as never, repo as never, account);
  await vi.waitFor(() => expect(panel.webview.html).toContain('No access token is available.'));
  expect(panel.webview.html).not.toContain('Loading daily usage');
});
