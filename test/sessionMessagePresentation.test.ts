import { describe, expect, it } from 'vitest';
import { formatActivityCode, messageAgentIds } from '../src/domain/sessionMessagePresentation';
import { commandChoices } from '../webview-src/dashboard/composerCommands';

describe('readable activity payloads', () => {
  it('formats JSON without losing large integers, escapes, empty values or source whitespace', () => {
    const raw = '{"integer":90071992547409931234,"escaped":"a\\n\\\"b","items":[{},[],null,true]}';
    const formatted = formatActivityCode(raw);
    expect(formatted).toContain('\n  "integer": 90071992547409931234,');
    expect(formatted).toContain('"escaped": "a\\n\\\"b"');
    expect(JSON.parse(formatted)).toEqual(JSON.parse(raw));
    expect(raw).not.toContain('\n');
    expect(formatActivityCode('\r\n\r\nhello\r\nworld\r\n')).toBe('hello\nworld');
  });
  it('keeps partial, deep, huge and HTML-like output as plain source', () => {
    for (const text of ['{"partial":', '<script>alert(1)</script>', '['.repeat(34) + '1' + ']'.repeat(34), JSON.stringify({ huge: 'x'.repeat(64000) })]) expect(formatActivityCode(text)).toBe(text);
    expect(formatActivityCode('   \n')).toBe('');
  });
  it('links protocol recipients while ignoring sender IDs, prose IDs, and unrelated tools', () => {
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sender = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    expect(messageAgentIds({ id: 'call', kind: 'collaboration', text: '', debug: JSON.stringify({ senderThreadId: sender, receiverThreadIds: [id], agentsStates: { [id]: 'completed' } }) })).toEqual([id]);
    expect(messageAgentIds({ id: 'send', kind: 'tool-call', title: 'Used send_message', text: '', arguments: JSON.stringify({ target: id }), result: JSON.stringify({ agent_id: id }) })).toEqual([id]);
    expect(messageAgentIds({ id: 'other', kind: 'tool-call', title: 'exec', text: id, result: JSON.stringify({ agent_id: id }) })).toEqual([]);
    expect(messageAgentIds({ id: 'partial', kind: 'collaboration', text: id, debug: '{"agent_id":' })).toEqual([]);
  });
  it('discovers commands and skills without executing a turn', () => {
    const skills = [{ name: 'review', description: 'Review the current changes' }];
    expect(commandChoices('/', skills).map(choice => choice.name)).toEqual(['model', 'permissions', 'skills', 'review']);
    expect(commandChoices('/skills', skills)).toEqual([{ ...skills[0], skill: true }]);
    expect(commandChoices('/changes', skills)).toHaveLength(1);
    expect(commandChoices('/unknown', skills)).toEqual([]);
  });
});
