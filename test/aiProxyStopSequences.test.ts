import { expect, it } from 'vitest';
import { StopSequenceMatcher } from '../src/services/aiProxyStopSequences';
import { AiStream, completedAiResponse, normalizeAiRequest } from '../src/services/aiProxyProtocol';

it('matches stops at every possible delta boundary without leaking a prefix or suffix', () => {
  const text = 'Allowed</decision>discard';
  for (let index = 0; index <= text.length; index++) {
    const stop = new StopSequenceMatcher(['</decision>']);
    expect(stop.write(text.slice(0, index)) + stop.write(text.slice(index)) + stop.flush()).toBe('Allowed');
    expect(stop.matched).toBe('</decision>');
  }
});

it.each(['', 'Unchanged 🌍', 'An incomplete </dec', 'A similar </decoy>'])('preserves unmatched text: %s', text => {
  const stop = new StopSequenceMatcher(['</decision>']);
  expect([...text].map(character => stop.write(character)).join('') + stop.flush()).toBe(text);
  expect(stop.matched).toBeUndefined();
});

it('uses the first completed sequence regardless of delta boundaries', () => {
  for (const chunks of [['abc'], ['ab', 'c'], ['a', 'b', 'c']]) {
    const stop = new StopSequenceMatcher(['abc', 'b']);
    expect(chunks.map(chunk => stop.write(chunk)).join('') + stop.flush()).toBe('a');
    expect(stop.matched).toBe('b');
  }
});

it.each([null, 'STOP', [''], [1]])('rejects invalid stop_sequences: %j', stop_sequences => {
  expect(() => normalizeAiRequest({ model: 'claude-opus', max_tokens: 100, messages: [{ role: 'user', content: 'Hello' }], stop_sequences }, 'claude')).toThrow();
});

it('implements stops locally without changing the forwarded prompt, tools or reasoning', () => {
  const request = { model: 'claude-opus', max_tokens: 100, messages: [{ role: 'user', content: 'Full prompt' }], thinking: { type: 'adaptive' } };
  const plain = normalizeAiRequest(request, 'claude');
  const stopped = normalizeAiRequest({ ...request, stop_sequences: ['STOP'] }, 'claude');
  expect(stopped.body).toEqual(plain.body);
  expect(stopped.stopSequences).toEqual(['STOP']);
});

it('streams a split stop once and omits subsequent text and tools', () => {
  const stream = new AiStream('claude', 'claude-opus', false, false, ['</decision>']);
  let wire = '';
  for (const delta of ['Allow', 'ed</dec', 'ision>discard']) wire += stream.event({ type: 'response.output_text.delta', delta });
  wire += stream.event({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'hidden', name: 'Hidden', arguments: '{}' } });
  wire += stream.event({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Allowed</decision>discard' }] }], usage: { input_tokens: 50, output_tokens: 20 } } });
  const records = wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  expect(records.filter(row => row.delta?.type === 'text_delta').map(row => row.delta.text).join('')).toBe('Allowed');
  expect(records.find(row => row.type === 'message_delta')).toMatchObject({ delta: { stop_reason: 'stop_sequence', stop_sequence: '</decision>' }, usage: { input_tokens: 50, output_tokens: 20 } });
  expect(wire).not.toContain('Hidden');
  expect(records.filter(row => row.type === 'message_stop')).toHaveLength(1);
});

it('flushes an unfinished prefix and leaves thinking and tool arguments untouched', () => {
  const stream = new AiStream('claude', 'claude-opus', false, false, ['STOP']);
  let wire = stream.event({ type: 'response.reasoning_summary_text.delta', delta: 'STOP is a marker.' });
  wire += stream.event({ type: 'response.output_text.delta', delta: 'ST' });
  wire += stream.event({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'tool', name: 'Tool', arguments: '{"text":"STOP"}' } });
  expect(wire).toContain('STOP is a marker.');
  expect(wire).toContain('"text":"ST"');
  expect(wire).toContain('STOP');
});

it('reports matched stops for a nonstreaming incomplete response and preserves usage', () => {
  const result = completedAiResponse({ status: 'incomplete', output: [{ type: 'message', content: [{ type: 'output_text', text: 'AllowedSTOPdiscard' }] }], usage: { input_tokens: 10, output_tokens: 5 } }, 'claude', 'claude-opus', false, ['STOP']);
  expect(result).toMatchObject({ content: [{ type: 'text', text: 'Allowed' }], stop_reason: 'stop_sequence', stop_sequence: 'STOP', usage: { input_tokens: 10, output_tokens: 5 } });
});

it.each(['not JSON', '[]', 'null'])('preserves final streaming tool validation without a duplicate response translation: %s', args => {
  const stream = new AiStream('claude', 'claude-opus', false);
  stream.event({ type: 'response.output_item.added', item: { type: 'function_call', call_id: 'tool', name: 'Tool', arguments: '' } });
  stream.event({ type: 'response.function_call_arguments.delta', delta: args });
  expect(() => stream.event({ type: 'response.completed', response: { output: [{ type: 'function_call', call_id: 'tool', name: 'Tool', arguments: args }] } })).toThrow(/invalid tool arguments/);
});
