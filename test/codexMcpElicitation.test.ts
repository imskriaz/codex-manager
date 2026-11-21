import { describe, expect, it } from 'vitest';
import { mcpElicitationContent, mcpElicitationRequest } from '../src/domain/codexMcpElicitation';
import { canAnswerCodexPrompt } from '../webview-src/dashboard/codexSessionPrompts';

const form = (properties: Record<string, unknown>, required = Object.keys(properties), mode = 'form') => mcpElicitationRequest({ serverName: 'demo', mode, message: 'Review this request', requestedSchema: { type: 'object', properties, required } });
describe('MCP elicitation forms', () => {
  it.each(['form', 'openai/form', 'openaiForm'])('supports standard typed fields in %s without silently applying defaults', mode => {
    const request = form({ text: { type: 'string', minLength: 2 }, number: { type: 'number', minimum: 0, maximum: 3 }, integer: { type: 'integer' }, enabled: { type: 'boolean', default: true }, choice: { type: 'string', oneOf: [{ const: 'a', title: 'Alpha' }] }, many: { type: 'array', items: { anyOf: [{ const: 'x', title: 'X' }, { const: 'y', title: 'Y' }] }, minItems: 1, maxItems: 2 }, optional: { type: 'string' } }, ['text', 'number', 'integer', 'enabled', 'choice', 'many'], mode);
    expect(request.mcp?.mode).toBe('form');
    const entry = { request: { ...request, id: 'id', threadId: 'thread' }, answers: {} };
    expect(canAnswerCodexPrompt(entry)).toBe(false);
    const answers = { text: '  exact  ', number: '1.5', integer: '2', enabled: 'false', choice: 'a', many: '["x","y"]' };
    expect(mcpElicitationContent(request.questions!, answers)).toEqual({ text: '  exact  ', number: 1.5, integer: 2, enabled: false, choice: 'a', many: ['x', 'y'] });
    expect(canAnswerCodexPrompt({ ...entry, answers })).toBe(true);
  });
  it.each([
    [{ type: 'integer' }, '1.5'], [{ type: 'number' }, 'Infinity'], [{ type: 'number' }, '   '],
    [{ type: 'number', maximum: 2 }, '3'], [{ type: 'string', minLength: 2 }, 'a'],
    [{ type: 'string', maxLength: 1 }, 'ab'], [{ type: 'string', enum: ['a'] }, 'b'],
    [{ type: 'boolean' }, 'yes'], [{ type: 'string', format: 'email' }, 'invalid'],
    [{ type: 'string', format: 'uri' }, 'not a URL'], [{ type: 'string', format: 'date' }, '2026-02-30'],
    [{ type: 'string', format: 'date-time' }, 'tomorrow'],
    [{ type: 'array', items: { type: 'string', enum: ['a'] } }, '["a","a"]'],
    [{ type: 'array', items: { type: 'string', enum: ['a'] } }, '["b"]'],
    [{ type: 'array', items: { type: 'string', enum: ['a'] }, minItems: 1 }, '[]']
  ])('validates %j against the submitted value', (schema, answer) => {
    const request = form({ value: schema });
    expect(() => mcpElicitationContent(request.questions!, { value: answer })).toThrow(/value/);
  });
  it('supports legacy enums, optional fields, empty approvals, and exact Unicode length', () => {
    const request = form({ choice: { type: 'string', enum: ['a'], enumNames: ['Alpha'] }, emoji: { type: 'string', maxLength: 1 } }, []);
    expect(request.questions![0]!.options).toEqual([{ label: 'a', description: 'Alpha' }]);
    expect(mcpElicitationContent(request.questions!, { emoji: '🙂' })).toEqual({ emoji: '🙂' });
    expect(mcpElicitationContent(form({}).questions!, {})).toEqual({});
  });
  it.each([{ type: 'object' }, { type: 'openai/imagePicker' }, { type: 'string', pattern: '^a' }, { type: 'array', items: { type: 'object' } }])('hands unsupported controls to Codex visibly: %j', schema => {
    const request = form({ value: schema });
    expect(request.mcp).toMatchObject({ mode: 'external', warning: expect.stringContaining('owning Codex') });
    expect(canAnswerCodexPrompt({ request: { ...request, id: 'id', threadId: 'thread' }, answers: {} })).toBe(false);
  });
  it('never exposes verification challenges or unsafe external links', () => {
    const request = mcpElicitationRequest({ mode: 'openai/userVerification', challenge: 'private-proof', title: 'Verify device', description: 'Confirm identity' });
    expect(request.mcp?.warning).toContain('Device verification');
    expect(JSON.stringify(request)).not.toContain('private-proof');
    for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///private', 'https://user:pass@example.com/']) expect(mcpElicitationRequest({ mode: 'url', url }).mcp?.mode).toBe('external');
    expect(mcpElicitationRequest({ mode: 'url', url: 'https://example.com/verify' }).mcp).toEqual({ mode: 'url', url: 'https://example.com/verify' });
  });
});
