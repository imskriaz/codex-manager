import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ messages: vi.fn(), summary: vi.fn(), send: vi.fn(), steer: vi.fn() }));
vi.mock('../src/services/codexSessionResume', () => ({ resolveCodexHome: () => 'home', readCodexCliSessionMessages: mocks.messages, readCodexCliSessionSummary: mocks.summary, sendCodexCliSessionMessage: mocks.send, steerCodexCliSessionTurn: mocks.steer }));
import { syncAsyncCodexQuestions } from '../src/services/codexSessionQuestions';
import { cancelCodexAppServerPrompts, listPendingCodexAppServerPrompts, respondCodexAppServerPrompt } from '../src/services/codexAppServerPrompts';
let session = '', sequence = 0;
let message: { id: string; text: string; role: 'assistant'; questions: Array<{ title: string; options: string[] }> };
beforeEach(() => {
  session = 'session-' + ++sequence; message = { id: 'question-' + sequence, role: 'assistant', text: '', questions: [{ title: 'Which layout?', options: ['Compact','Spacious'] }] };
  mocks.messages.mockReset().mockResolvedValue([message]); mocks.summary.mockReset().mockResolvedValue({ id: session, status: 'idle', projectPath: 'project' });
  mocks.send.mockReset().mockImplementation(async options => { options.onStarted(); }); mocks.steer.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { cancelCodexAppServerPrompts(session); vi.useRealTimers(); });
const prompt = () => listPendingCodexAppServerPrompts().find(request => request.threadId === session)!;
it('mirrors async questions once and sends a reviewed native reply as soon as Codex accepts it', async () => {
  let finish: () => void;
  mocks.send.mockImplementation(options => new Promise<void>(resolve => { finish = resolve; options.onStarted(); }));
  syncAsyncCodexQuestions('home', session, [message]); const request = prompt();
  syncAsyncCodexQuestions('home', session, [message]); expect(prompt().id).toBe(request.id);
  expect(request).toMatchObject({ sourceMessageId: message.id, kind: 'question' });
  await respondCodexAppServerPrompt(request.id, 'approve', { [request.questions![0]!.id]: 'Compact' });
  expect(mocks.send).toHaveBeenCalledOnce(); expect(mocks.send.mock.calls[0]![0].text).toContain('questionItemId'); expect(prompt()).toBeUndefined();
  syncAsyncCodexQuestions('home', session, [message]); expect(prompt()).toBeUndefined(); finish!();
});
it('uses verified steering for a running owner and refuses to reply to an already answered question', async () => {
  mocks.summary.mockResolvedValue({ id: session, status: 'running', steerTurnId: 'active-turn' });
  syncAsyncCodexQuestions('home', session, [message]); const request = prompt();
  await respondCodexAppServerPrompt(request.id, 'approve', { [request.questions![0]!.id]: 'Spacious' });
  expect(mocks.steer).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session, expectedTurnId: 'active-turn' })); expect(mocks.send).not.toHaveBeenCalled();
  message = { ...message, id: 'another' }; syncAsyncCodexQuestions('home', session, [message]); const stale = prompt(); mocks.messages.mockResolvedValue([]);
  await expect(respondCodexAppServerPrompt(stale.id, 'approve', { [stale.questions![0]!.id]: 'Compact' })).rejects.toThrow(/already answered/);
  expect(mocks.steer).toHaveBeenCalledOnce();
});
it('keeps disconnected owners and uncertain sends from being retried automatically', async () => {
  vi.useFakeTimers(); mocks.summary.mockResolvedValue({ id: session, status: 'running' });
  syncAsyncCodexQuestions('home', session, [message]); const request = prompt();
  await expect(respondCodexAppServerPrompt(request.id, 'approve', { [request.questions![0]!.id]: 'Compact' })).rejects.toThrow(/unavailable/); expect(mocks.send).not.toHaveBeenCalled();
  mocks.summary.mockResolvedValue({ id: session, status: 'idle' }); mocks.send.mockImplementation(() => new Promise(() => {}));
  const pending = expect(respondCodexAppServerPrompt(request.id, 'approve', { [request.questions![0]!.id]: 'Compact' })).rejects.toThrow(/not confirmed/);
  await vi.advanceTimersByTimeAsync(12_000); await pending;
  await expect(respondCodexAppServerPrompt(request.id, 'approve', { [request.questions![0]!.id]: 'Compact' })).rejects.toThrow(/not confirmed/); expect(mocks.send).toHaveBeenCalledOnce();
});

