import { beforeEach, expect, it, vi } from 'vitest';
import { sessionQuestionReply } from '../src/domain/sessionQuestions';
const storage = vi.hoisted(() => ({ records: new Map<string, unknown>(), get: vi.fn(), set: vi.fn() }));
vi.mock('../src/storage/sqliteState', () => ({ getSqliteStateStore: () => ({ get: storage.get, set: storage.set }) }));
import { sendCodexQuestionReply } from '../src/services/codexQuestionReply';

const ask = { id: 'ask', text: '', questions: [{ title: 'Continue?' }] };
const reply = sessionQuestionReply(ask, { '0': 'Yes' });
const messages = vi.fn(), send = vi.fn();
beforeEach(() => {
  storage.records.clear(); storage.get.mockReset().mockImplementation((_namespace, key) => storage.records.get(key));
  storage.set.mockReset().mockImplementation((_namespace, key, value) => storage.records.set(key, value));
  messages.mockReset().mockResolvedValue([ask]); send.mockReset().mockResolvedValue(undefined);
});
const deliver = (text = reply, id = 'session') => sendCodexQuestionReply('home', id, text, messages, send);

it('fences queued and push replies by question identity before dispatch', async () => {
  send.mockImplementation(async () => { expect(storage.set.mock.calls.length).toBe(send.mock.calls.length); });
  await deliver();
  await expect(deliver(sessionQuestionReply(ask, { '0': 'No' }))).rejects.toThrow(/already sent/);
  expect(send).toHaveBeenCalledOnce();
  await deliver(reply, 'other-session'); expect(send).toHaveBeenCalledTimes(2);
});
it('retains a durable fence after an uncertain failure', async () => {
  send.mockImplementation(async onAttempt => { onAttempt(true); throw new Error('Connection lost'); });
  await expect(deliver()).rejects.toThrow(/not confirmed/);
  await expect(deliver()).rejects.toThrow(/awaiting confirmation/);
  expect(send).toHaveBeenCalledOnce();
});
it('allows a reviewed retry after validation fails before delivery starts', async () => {
  send.mockRejectedValueOnce(new Error('The owning session changed. No answer sent.'));
  await expect(deliver()).rejects.toThrow(/No answer sent/);
  await deliver(); expect(send).toHaveBeenCalledTimes(2);
});
it('refuses duplicates found in history and fails closed on unreadable or full storage', async () => {
  messages.mockResolvedValueOnce([{ id: 'answer', role: 'user', text: reply }]);
  await expect(deliver()).rejects.toThrow(/already sent/); expect(send).not.toHaveBeenCalled();
  messages.mockRejectedValueOnce(new Error('History offline'));
  await expect(deliver()).rejects.toThrow(/History offline/); expect(storage.records.size).toBe(0);
  storage.set.mockImplementationOnce(() => { throw new Error('Disk full'); });
  await expect(deliver()).rejects.toThrow(/Disk full/); expect(send).not.toHaveBeenCalled();
  await deliver(); expect(send).toHaveBeenCalledOnce();
});
it('leaves ordinary messages on their existing send path', async () => {
  await deliver('Continue working'); expect(messages).not.toHaveBeenCalled(); expect(storage.set).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledOnce();
});
