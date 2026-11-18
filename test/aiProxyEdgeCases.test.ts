import { expect, it } from 'vitest';
import { AiStream, aiUsage, completedAiResponse, normalizeAiRequest } from '../src/services/aiProxyProtocol';
import { aiEvents } from '../src/services/aiProxy';

const request = (extra: Record<string, unknown> = {}) => ({ model: 'fixture', max_tokens: 100, messages: [{ role: 'user', content: 'Hello' }], ...extra });
const tool = { type: 'function_call', name: 'lookup', call_id: 'call-1', arguments: '{}' };
const response = (output: unknown[], status = 'completed') => ({ id: 'resp-1', model: 'fixture', status, output, usage: { input_tokens: 8, output_tokens: 2 } });
const records = (wire: string) => wire.split('\n\n').flatMap(record => {
  const data = record.split('\n').find(line => line.startsWith('data: '))?.slice(6);
  return data && data !== '[DONE]' ? [JSON.parse(data)] : [];
});

it.each(['chat', 'responses', 'claude'] as const)('preserves empty %s tool results', protocol => {
  const messages = protocol === 'chat'
    ? [{ role: 'tool', tool_call_id: 'call-1', content: '' }]
    : [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1' }] }];
  const normalized = normalizeAiRequest(protocol === 'responses'
    ? { model: 'fixture', input: [{ type: 'function_call_output', call_id: 'call-1', output: '' }] }
    : request({ messages }), protocol);
  expect(normalized.body.input).toMatchObject([{ type: 'function_call_output', call_id: 'call-1', output: '' }]);
});

it('keeps image-only tool results separate from tool text', () => {
  const normalized = normalizeAiRequest(request({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } }] }] }] }), 'claude');
  expect(normalized.body.input).toMatchObject([{ type: 'function_call_output', output: '' }, { role: 'user', content: [{ type: 'input_text' }, { type: 'input_image', image_url: 'https://example.test/image.png' }] }]);
});

it.each(['auto', 'any', 'tool'] as const)('honors Claude %s parallel-tool restrictions', type => {
  expect(normalizeAiRequest(request({ tool_choice: { type, name: 'lookup', disable_parallel_tool_use: true } }), 'claude').body).toMatchObject({ parallel_tool_calls: false });
});

it('maps JSON schema output and preserves adaptive reasoning when effort is absent', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const result = normalizeAiRequest(request({ output_config: { format: { type: 'json_schema', schema } }, thinking: { type: 'adaptive' } }), 'claude');
  expect(result.body).toMatchObject({ text: { format: { type: 'json_schema', schema, strict: true } }, reasoning: { effort: 'high' } });
});

it('supports Claude thinking modes, budgets, update display, and metadata without dropping fields', () => {
  const result = normalizeAiRequest(request({
    max_tokens: 4096,
    metadata: { user_id: 'opaque-id' },
    thinking: { type: 'enabled', budget_tokens: 1024, display: 'updates' }
  }), 'claude');
  expect(result.body).toMatchObject({ metadata: { user_id: 'opaque-id' }, reasoning: { effort: 'high' } });
  expect(() => normalizeAiRequest(request({ thinking: { type: 'enabled', budget_tokens: 100 }, max_tokens: 4096 }), 'claude')).toThrow(/budget_tokens/);
  expect(() => normalizeAiRequest(request({ thinking: { type: 'adaptive', budget_tokens: 1024 } }), 'claude')).toThrow(/only valid/);
  expect(normalizeAiRequest(request({ thinking: { type: 'between_tools' } }), 'claude').body).toMatchObject({ reasoning: { effort: 'high' } });
});

it('honors omitted thinking for streaming and completed messages', () => {
  expect(normalizeAiRequest(request({ thinking: { type: 'adaptive', display: 'omitted' } }), 'claude').omitThinking).toBe(true);
  const stream = new AiStream('claude', 'fixture', false, true);
  expect(stream.event({ type: 'response.reasoning_summary_text.delta', delta: 'Private summary' })).not.toContain('Private summary');
  const result = completedAiResponse(response([{ type: 'reasoning', summary: [{ text: 'Private summary' }] }]), 'claude', 'fixture', true);
  expect(result.content).toEqual([]);
});

it('preserves completed content order and reasoning summaries', () => {
  const result = completedAiResponse(response([{ type: 'reasoning', summary: [{ text: 'Plan' }] }, { type: 'message', content: [{ type: 'output_text', text: 'Before' }] }, tool, { type: 'message', content: [{ type: 'output_text', text: 'After' }] }]), 'claude', 'fixture');
  expect(result.content).toMatchObject([{ type: 'thinking', thinking: 'Plan' }, { type: 'text', text: 'Before' }, { type: 'tool_use', id: 'call-1' }, { type: 'text', text: 'After' }]);
  expect(completedAiResponse(response([{ type: 'reasoning', summary: [{ text: 'Plan' }] }]), 'chat', 'fixture')).toMatchObject({ choices: [{ message: { reasoning_content: 'Plan' } }] });
});

it.each(['chat', 'claude'] as const)('reports truncated %s tool responses as incomplete', protocol => {
  const result = completedAiResponse(response([tool], 'incomplete'), protocol, 'fixture');
  if (protocol === 'claude') expect(result.stop_reason).toBe('max_tokens');
  else expect(result.choices).toMatchObject([{ finish_reason: 'length' }]);
  const wire = new AiStream(protocol, 'fixture', false).event({ type: 'response.incomplete', response: response([tool], 'incomplete') });
  expect(wire).toContain(protocol === 'claude' ? 'max_tokens' : 'length');
});

it.each(['null', '[]', '1', '{broken'])('rejects malformed backend tool arguments %s', argumentsText => {
  expect(() => completedAiResponse(response([{ ...tool, arguments: argumentsText }]), 'claude', 'fixture')).toThrow(/invalid tool arguments/);
});

it('closes text before a tool starts and does not close unrelated text on a reasoning item completion', () => {
  const stream = new AiStream('claude', 'fixture', false);
  stream.event({ type: 'response.output_text.delta', output_index: 1, delta: 'Before' });
  const unrelated = stream.event({ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning' } });
  expect(unrelated).not.toContain('content_block_stop');
  const wire = records(stream.event({ type: 'response.output_item.added', output_index: 2, item: tool }));
  expect(wire.slice(0, 2)).toMatchObject([{ type: 'content_block_stop', index: 0 }, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use' } }]);
});

it('releases SSE parsing when backend cancellation never settles', async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n')); }, cancel() { return new Promise(() => undefined); } });
  const parser = aiEvents(body, new AbortController().signal);
  expect((await parser.next()).value).toMatchObject({ type: 'response.completed' });
  await expect(parser.return()).resolves.toMatchObject({ done: true });
});

it.each(['chat', 'claude'] as const)('preserves final-only %s tool arguments without duplicating streamed fragments', protocol => {
  const stream = new AiStream(protocol, 'fixture', false);
  stream.event({ type: 'response.output_item.added', output_index: 0, item: tool });
  // The full arguments supplied at item start were already sent.
  const done = stream.event({ type: 'response.output_item.done', output_index: 0, item: tool });
  expect(done).not.toContain('input_json_delta');
  const finalOnly = new AiStream(protocol, 'fixture', false);
  const wire = finalOnly.event({ type: 'response.completed', response: response([tool]) });
  expect(wire).toContain('lookup');
  expect(wire).toContain(protocol === 'claude' ? '"partial_json":"{}"' : '"arguments":"{}"');
});

it.each(['chat', 'claude'] as const)('keeps final-only %s text and fills missing suffixes once', protocol => {
  const stream = new AiStream(protocol, 'fixture', false);
  stream.event({ type: 'response.output_text.delta', output_index: 0, delta: 'Hello' });
  const end = stream.event({ type: 'response.completed', response: response([{ type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] }]) });
  expect(end).toContain(' world');
  expect(end).not.toContain('Hello');
  expect(new AiStream(protocol, 'fixture', false).event({ type: 'response.completed', response: response([{ type: 'message', content: [{ type: 'output_text', text: 'Final only' }] }]) })).toContain('Final only');
});

it('keeps invalid usage out of translated totals', () => {
  expect(aiUsage({ usage: { input_tokens: -1, output_tokens: 0.5 } })).toEqual({ input: 0, output: 0, cached: 0 });
  expect(aiUsage({ usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 50 } } })).toEqual({ input: 10, output: 2, cached: 10 });
});

it.each(['input_audio', 'document'] as const)('explicitly rejects unsupported %s instead of dropping it', type => {
  expect(() => normalizeAiRequest(request({ messages: [{ role: 'user', content: [{ type, data: 'private data' }] }] }), 'claude')).toThrow(/Unsupported content block/);
});

it('rejects unsupported context editing instead of silently promising server compaction', () => {
  expect(() => normalizeAiRequest(request({ context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] } }), 'claude')).toThrow(/supports only clear_thinking/);
});
