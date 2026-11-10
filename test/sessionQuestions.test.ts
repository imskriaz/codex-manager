import { notificationTargetUrl } from '../src/domain/notificationTarget';
import { coalesceSessionQuestionMessages, sessionQuestionText } from '../src/domain/sessionQuestions';
import { expect, it } from 'vitest';
import { activeSessionQuestion, answeredSessionQuestionIds, readSessionQuestions, sessionQuestionReply, unansweredSessionQuestions } from '../src/domain/sessionQuestions';
import { parseCodexTokenUsage, validMessage } from '../src/domain/codexSessionLive';
import { parseCodexAppServerThreadItems } from '../src/services/codexSessionResume';
import { cliContextUsage, resolveCliComposerSettings } from '../webview-src/dashboard/cliSessionComposerState';

it('shows a question once and coalesces exact answer mirrors even across command activity and turns', () => {
  const question = { id: 'ask', turnId: 'one', role: 'assistant' as const, text: 'Open which view?\n- Details\n- Table', questions: [{ title: 'Open which view?', options: ['Details', 'Table'] }] };
  const reply = { id: 'reply', turnId: 'two', role: 'user' as const, text: sessionQuestionReply(question, { 0: 'Details' }) };
  const command = { id: 'command', kind: 'command' as const, text: 'build' };
  const values = [question, { ...question, id: 'ask-mirror' }, reply, command, { ...reply, id: 'reply-mirror', turnId: 'three' }];
  expect(coalesceSessionQuestionMessages(values)).toEqual([question, reply, command]);
  expect(sessionQuestionText(question)).toBe('');
  expect(sessionQuestionText({ ...question, text: 'Context for the question.' })).toBe('Context for the question.');
  expect(coalesceSessionQuestionMessages([reply, { ...reply, id: 'correction', text: sessionQuestionReply(question, { 0: 'Table' }) }])).toHaveLength(2);
  expect(coalesceSessionQuestionMessages([question, { ...question, turnId: 'another', id: 'ask-again' }])).toHaveLength(2);
  const proseQuestion = { ...question, questions: undefined };
  expect(coalesceSessionQuestionMessages([proseQuestion, command, { ...proseQuestion, id: 'native-mirror' }])).toEqual([proseQuestion, command]);
});
it('keeps malformed replies and ordinary repeated prose and normalizes native question IDs', () => {
  const malformed = { id: 'bad', role: 'user' as const, text: '<send_user_message_question_reply>{partial}</send_user_message_question_reply>' };
  const reply = (questionItemId: string) => `<send_user_message_question_reply>${JSON.stringify({ questionItemId, question: 'Choose?', answer: 'Yes' })}</send_user_message_question_reply>`;
  const first = { id: 'one', role: 'user' as const, text: reply('["request_user_input_async", "ask", 0]') };
  const second = { ...first, id: 'two', text: reply('["request_user_input_async","ask",0]') };
  expect(coalesceSessionQuestionMessages([malformed, first, second])).toHaveLength(2);
  const prose = { id: 'prose', role: 'assistant' as const, text: 'Working on this.' };
  expect(coalesceSessionQuestionMessages([prose, { ...prose, id: 'later' }])).toHaveLength(2);
});

it('detects native answers with formatted IDs and surrounding follow-up text without hiding unrelated questions', () => {
  const question = { id: 'ask', role: 'assistant' as const, text: '', questions: [{ title: 'First?' }, { title: 'Second?' }] };
  const text = '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: '["request_user_input_async", "ask", 0]', answer: 'Yes' }]) + '\n</send_user_message_question_reply>\nPlease continue.';
  const reply = { id: 'reply', role: 'user' as const, text };
  const answered = answeredSessionQuestionIds([question, reply]);
  expect(answered.has(JSON.stringify(['request_user_input_async', 'ask', 0]))).toBe(true);
  expect(answered.has(JSON.stringify(['request_user_input_async', 'ask', 1]))).toBe(false);
  expect(unansweredSessionQuestions([question, reply])).toEqual([question]);
  expect(answeredSessionQuestionIds([{ ...reply, role: 'assistant' }]).size).toBe(0);
  expect(answeredSessionQuestionIds([{ ...reply, text: text.replace('"Yes"', '" "') }]).size).toBe(0);
});

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

it('only interrupts for a recent question with no newer activity and keeps old questions answerable', () => {
  const now = Date.now();
  const ask = { id: 'ask', role: 'assistant' as const, text: '', timestamp: new Date(now - 119_999).toISOString(), questions: [{ title: 'Continue?' }] };
  expect(activeSessionQuestion([ask], now)).toEqual(ask);
  expect(activeSessionQuestion([ask], now + 1)).toBeUndefined();
  for (const later of [{ id: 'command', kind: 'command' as const, text: 'working' }, { id: 'reply', role: 'user' as const, text: 'Next task' }, { ...ask, id: 'next' }]) expect(activeSessionQuestion([ask, later], now)?.id).not.toBe(ask.id);
  for (const timestamp of [undefined, 'invalid', new Date(now + 1).toISOString()]) expect(activeSessionQuestion([{ ...ask, timestamp }], now)).toBeUndefined();
  expect(unansweredSessionQuestions([ask, { id: 'later', text: 'More work' }])).toEqual([ask]);
});

it('replies only to remaining questions without renumbering their native identities', () => {
  const ask = { id: 'partial', text: '', questions: [{ title: 'First?' }, { title: 'Second?' }] };
  const reply = sessionQuestionReply(ask, { '1': 'Second answer' });
  expect(reply).not.toContain('First?');
  expect(reply).toContain('Second?');
  expect(unansweredSessionQuestions([{ ...ask, role: 'assistant' }, { id: 'reply', role: 'user', text: reply }])).toHaveLength(1);
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

it('uses confirmed Codex permissions instead of stale composer overrides', () => {
  const config = { models: [], defaultSandboxMode: 'workspace-write' as const };
  expect(resolveCliComposerSettings(undefined, config, { sandboxMode: 'read-only' }).sandboxMode).toBe('read-only');
  expect(resolveCliComposerSettings({ text: '', attachments: [], sandboxMode: 'danger-full-access' }, config, { sandboxMode: 'read-only' }).sandboxMode).toBe('read-only');
  expect(resolveCliComposerSettings({ text: '', attachments: [], sandboxMode: 'danger-full-access' }, config).sandboxMode).toBe('danger-full-access');
});


it('keeps all push destinations inside the dashboard while retaining the owning device', () => {
  expect(notificationTargetUrl('/tasks?device=worker')).toBe('/tasks?device=worker');
  expect(notificationTargetUrl('/workspace/11111111-1111-4111-8111-111111111111', 'worker')).toBe('/workspace/11111111-1111-4111-8111-111111111111?device=worker');
  for (const url of ['https://outside.test/', '//outside.test/', '/api/message', '/\\outside.test/']) expect(notificationTargetUrl(url)).toBe('/');
});
