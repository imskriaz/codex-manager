import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStateStore, configureSqliteStateStore } from '../src/storage/sqliteState';
import { readNativeCodexSessionRunning } from '../src/services/codexNativeSessionStatus';
import { flushSessionRecording } from '../src/services/sessionRecording';
import * as sessions from '../src/services/codexSessionResume';
import { getCodexSessionLiveState } from '../src/services/codexSessionLive';
import { providerConversation, providerHistoryPage, presentProviderLive, presentProviderSessions, saveProviderConversation } from '../src/services/sessionProviders';
import { subscribeDashboardRealtime } from '../src/services/dashboardRealtime';

const mocks = vi.hoisted(() => ({ open: vi.fn(), query: vi.fn(), messages: new Map<string, any[]>(), renameSession: vi.fn(), deleteSession: vi.fn() }));
vi.mock('../src/services/claudeCliRuntime', () => ({ claudeConfigHome: () => 'claude-provider-test', claudeEnvironment: () => ({}), claudeAccountKey: () => 'account', resolveClaudeCliExecutable: async () => 'claude.exe', claudeSdk: async () => ({ ...mocks, getSessionMessages: async (id: string) => mocks.messages.get(id) ?? [] }) }));
vi.mock('../src/services/codexAppServerRpc', async original => ({ ...await original<typeof import('../src/services/codexAppServerRpc')>(), CodexAppServerRpc: { open: mocks.open } }));
let root: string, previousHome: string | undefined, store: SqliteStateStore;
const sent: Array<{ provider: string; text: string }> = [];
beforeEach(async () => {
  vi.clearAllMocks(); mocks.messages.clear(); sent.length = 0;
  root = await mkdtemp(path.join(tmpdir(), 'manager-providers-'));
  store = await SqliteStateStore.open(path.join(root, 'manager.sqlite')); configureSqliteStateStore(store);
  previousHome = process.env['CODEX_HOME']; process.env['CODEX_HOME'] = root;
  vi.mocked(readNativeCodexSessionRunning).mockResolvedValue(false);
  await mkdir(path.join(root, 'sessions'));
  mocks.query.mockImplementation(({ prompt, options }) => {
    const id = options.sessionId ?? options.resume;
    return { initializationResult: async () => ({ models: [{ value: 'opus', displayName: 'Opus', supportedEffortLevels: ['high'] }] }), close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        const user = (await prompt[Symbol.asyncIterator]().next()).value;
        sent.push({ provider: 'claude', text: user.message.content[0].text });
        const assistant = { type: 'assistant', session_id: id, uuid: randomUUID(), message: { id: randomUUID(), content: [{ type: 'text', text: 'Claude reply' }] } };
        const replay = { ...user, session_id: id };
        mocks.messages.set(id, [...(mocks.messages.get(id) ?? []), replay, assistant]);
        yield replay; yield assistant;
        yield { type: 'result', session_id: id, is_error: false, usage: { output_tokens: 1 }, modelUsage: {}, queued_turn_count: 0 };
      }
    };
  });
  mocks.open.mockImplementation(async () => {
    let id: string;
    const listeners = new Set<(method: string, params: unknown) => void>();
    return {
      onNotification: (listener: any) => { listeners.add(listener); return () => listeners.delete(listener); }, onServerRequest: () => () => {}, onDisconnect: () => () => {}, close: vi.fn(),
      request: vi.fn(async (method: string, params: any) => {
        if (method === 'thread/start') {
          id = randomUUID();
          await appendFile(path.join(root, 'session_index.jsonl'), JSON.stringify({ id, thread_name: 'Native Codex title' }) + '\n');
          await writeFile(path.join(root, 'sessions', `rollout-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: root } }) + '\n');
        }
        return { thread: { id: id ?? params.threadId }, permissions: ':danger-full-access', approvalPolicy: 'on-request' };
      }),
      startAndWaitForTurn: vi.fn(async (nativeId: string, params: any, _timeout: number, started: (id: string) => void) => {
        const text = params.input[0].text;
        sent.push({ provider: 'codex', text });
        await appendFile(path.join(root, 'sessions', `rollout-${nativeId}.jsonl`), [
          { type: 'turn_context', payload: { model: 'gpt-test', sandbox_policy: { type: 'dangerFullAccess' }, approval_policy: 'on-request' } },
          { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
          { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Codex reply' }] } }
        ].map(row => JSON.stringify(row)).join('\n') + '\n');
        started(randomUUID());
      })
    };
  });
});
afterEach(async () => {
  flushSessionRecording(); configureSqliteStateStore(undefined); store.close();
  if (previousHome === undefined) delete process.env['CODEX_HOME']; else process.env['CODEX_HOME'] = previousHome;
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const idle = async (id: string) => expect.poll(async () => (await sessions.readCodexCliSessionSummary(id))?.status, { timeout: 5000 }).toBe('idle');

it.each(['codex', 'claude'])('switches %s to the other provider and back in one visible conversation', async provider => {
  const firstModel = provider === 'claude' ? 'claude-code/opus' : 'gpt-test';
  const nextModel = provider === 'claude' ? 'gpt-test' : 'claude-code/opus';
  const id = await sessions.startCodexCliSession({ text: 'Original request', model: firstModel, sandboxMode: 'danger-full-access', autoApprove: false, projectPath: root });
  await idle(id);
  const events: any[] = [], off = subscribeDashboardRealtime(event => events.push(event));
  try {
    await sessions.sendCodexCliSessionMessage({ sessionId: id, text: 'Continue on the other provider', model: nextModel, projectPath: root });
    await idle(id);
    expect(await sessions.readCodexCliSessionSummary(id)).toMatchObject({ id, model: nextModel });
    const conversation = providerConversation(id)!;
    expect(conversation.activeId).not.toBe(id);
    const text = sent.at(-1)!.text;
    const match = /from ("[^\n]+") before responding/.exec(text)!;
    const context = JSON.parse(await readFile(JSON.parse(match[1]!), 'utf8'));
    expect(context.messages.some((message: any) => message.text === 'Original request')).toBe(true);
    expect(context.currentRequest).toBe('Continue on the other provider');
    const history = await sessions.readCodexCliSessionMessages(id);
    expect(history.filter(message => message.role === 'user').map(message => message.text)).toEqual(['Original request', 'Continue on the other provider']);
    expect(history.some(message => message.text.includes('[Manager conversation handoff'))).toBe(false);
    expect(getCodexSessionLiveState(id)?.sessionId).toBe(id);
    expect(events.filter(event => event.type === 'dashboard:codex-session-live').every(event => event.state.sessionId === id)).toBe(true);
    expect((await sessions.readCodexCliSessions()).filter(row => conversation.nativeIds.includes(row.id))).toHaveLength(1);
    await sessions.renameCodexCliSession(id, 'One conversation');
    expect(await sessions.readCodexCliSessionSummary(id)).toMatchObject({ id, title: 'One conversation' });
    await sessions.sendCodexCliSessionMessage({ sessionId: id, text: 'Back to the first provider', model: firstModel, projectPath: root });
    await idle(id);
    expect(await sessions.readCodexCliSessionSummary(id)).toMatchObject({ id, model: firstModel, title: 'One conversation' });
    expect((await sessions.readCodexCliSessionMessages(id)).filter(message => message.role === 'user').map(message => message.text)).toEqual(['Original request', 'Continue on the other provider', 'Back to the first provider']);
    expect(await sessions.readCodexCliSessionInitialPrompt(id)).toBe('Original request');
  } finally { off(); }
});

it('pages the saved prefix without dropping, repeating, or exposing inactive native streams', async () => {
  const id = randomUUID(), activeId = randomUUID();
  const history = Array.from({ length: 450 }, (_, index) => ({ id: String(index), role: 'user' as const, text: String(index) }));
  saveProviderConversation({ id, activeId, nativeIds: [id, activeId], title: 'Chat', history, bootstrap: 'private seed', input: { text: 'New request' } });
  const read = vi.fn(async () => ({ messages: [{ id: 'new', role: 'user' as const, text: 'private seed full context' }], warnings: [] }));
  const latest = await providerHistoryPage(id, undefined, read);
  const middle = await providerHistoryPage(id, latest.olderThan, read);
  const oldest = await providerHistoryPage(id, middle.olderThan, read);
  expect([...oldest.messages, ...middle.messages, ...latest.messages].map(message => message.text)).toEqual([...history.map(message => message.text), 'New request']);
  expect(read).toHaveBeenCalledOnce();
  expect(presentProviderLive({ sessionId: id } as any)).toBeUndefined();
  expect(presentProviderSessions([{ id }, { id: activeId }] as any).map(row => row.id)).toEqual([id]);
  await expect(providerHistoryPage(id, 'provider:999999', read)).rejects.toThrow('changed');
});
