import { notificationTargetUrl } from '../src/domain/notificationTarget';
import { expect, it } from 'vitest';
import { readSessionQuestions, sessionQuestionReply, unansweredSessionQuestions } from '../src/domain/sessionQuestions';
import { parseCodexTokenUsage, validMessage } from '../src/domain/codexSessionLive';
import { parseCodexAppServerThreadItems } from '../src/services/codexSessionResume';
import { cliContextUsage, resolveCliComposerSettings } from '../webview-src/dashboard/cliSessionComposerState';

it('preserves async Codex questions and sends native question IDs with selectable or typed answers', () => {
  const messages = parseCodexAppServerThreadItems({ thread: { turns: [{ id: 'turn', items: [{ id: 'ask', type: 'agentMessage', text: '', questions: [{ title: 'Which layout?', options: ['Compact','Spacious'] }] }] }] } });
  expect(messages).toHaveLength(1); expect(messages[0]?.questions).toEqual([{ title: 'Which layout?', options: ['Compact','Spacious'] }]);
  const ask = messages[0]!;
  expect(validMessage(ask)).toBe(true);
  const reply = sessionQuestionReply(ask, { '0': 'Compact' });
  expect(reply).toContain('questionItemId'); expect(reply).toContain('request_user_input_async');
  expect(unansweredSessionQuestions([ask, { id: 'answer', role: 'user', text: reply }])).toEqual([]);
  expect(unansweredSessionQuestions([ask, { id: 'answer', role: 'user', text: 'Compact' }])).toEqual([ask]);
});

it('keeps all unanswered prompts and rejects malformed question payloads at the peer boundary', () => {
  const first = { id: 'one', text: '', role: 'assistant' as const, questions: [{ title: 'One?' }] };
  const second = { ...first, id: 'two', questions: [{ title: 'Two?' }] };
  expect(unansweredSessionQuestions([first,second])).toEqual([first,second]);
  expect(unansweredSessionQuestions([first,{ id: 'partial', role: 'user', text: '<send_user_message_question_reply>{bad}</send_user_message_question_reply>' }])).toEqual([first]);
  expect(validMessage({ ...first, questions: [{ title: 42 }] })).toBe(false);
  expect(validMessage({ ...first, questions: [{ title: 'One?', options: [42] }] })).toBe(false);
  expect(readSessionQuestions([{ title: 'One?', options: [{ label: 'Yes' }] },null,{ title: 42 }])).toEqual([{ title: 'One?', options: ['Yes'] }]);
});

it('tracks cumulative session totals separately from the last context measurement, including after compaction', () => {
  const usage = parseCodexTokenUsage({ total: { totalTokens: 9000, inputTokens: 8000, cachedInputTokens: 6000, outputTokens: 1000 }, last: { totalTokens: 200 }, modelContextWindow: 1000 });
  expect(usage).toMatchObject({ total: 9000, input: 8000, output: 1000, cachedInput: 6000, contextTokens: 200 });
  expect(cliContextUsage(usage)).toEqual({ used: 200, limit: 1000, percent: 20 });
  expect(cliContextUsage({ ...usage, contextTokens: 0 })?.percent).toBe(0);
  expect(parseCodexTokenUsage({ total_token_usage: { total_tokens: 9000 }, last_token_usage: { total_tokens: 200 }, model_context_window: 1000 })).toMatchObject({ total: 9000, contextTokens: 200, contextWindow: 1000 });
  expect(parseCodexTokenUsage({ total: { totalTokens: -1 }, modelContextWindow: Infinity })).toMatchObject({ total: undefined, contextWindow: undefined });
});

it('initializes editable permissions from Codex rather than the global default and keeps a deliberate override', () => {
  const config = { models: [], defaultSandboxMode: 'workspace-write' as const };
  expect(resolveCliComposerSettings(undefined, config, { sandboxMode: 'read-only' }).sandboxMode).toBe('read-only');
  expect(resolveCliComposerSettings({ text: '', attachments: [], sandboxMode: 'danger-full-access' }, config, { sandboxMode: 'read-only' }).sandboxMode).toBe('danger-full-access');
});


it('keeps all push destinations inside the dashboard while retaining the owning device', () => {
  expect(notificationTargetUrl('/tasks?device=worker')).toBe('/tasks?device=worker');
  expect(notificationTargetUrl('/workspace/11111111-1111-4111-8111-111111111111', 'worker')).toBe('/workspace/11111111-1111-4111-8111-111111111111?device=worker');
  for (const url of ['https://outside.test/', '//outside.test/', '/api/message', '/\\outside.test/']) expect(notificationTargetUrl(url)).toBe('/');
});
