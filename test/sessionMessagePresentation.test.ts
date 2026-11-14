import { describe, expect, it } from 'vitest';
import { agentActivityLabel, formatActivityCode, messageAgentIds } from '../src/domain/sessionMessagePresentation';
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
    expect(commandChoices('/', skills).map(choice => choice.name)).toEqual([]);
    expect(commandChoices('/skills', skills)).toEqual([{ ...skills[0], skill: true }]);
    expect(commandChoices('/changes', skills)).toHaveLength(0);
    expect(commandChoices('/rev', skills).map(choice => choice.name)).toEqual(['review']);
    expect(commandChoices('/mo', skills).map(choice => choice.name)).toEqual(['model']);
    expect(commandChoices('/unknown', skills)).toEqual([]);
  });
  it('names recipient conversations for sent messages and confirmed completions without linking call IDs', () => {
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', call = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const message = { id: call, kind: 'tool-call' as const, title: 'Used send_input', text: '', arguments: JSON.stringify({ id, message: 'Review this' }), debug: JSON.stringify({ id: call }), status: 'completed' as const };
    expect(messageAgentIds(message)).toEqual([id]);
    expect(agentActivityLabel(message, { [id]: 'Correct BOM libraries' })).toBe('Sent message to Correct BOM libraries');
    expect(agentActivityLabel({ ...message, status: 'inProgress' }, { [id]: 'Reviewer' })).toBe('Sending message to Reviewer');
    expect(agentActivityLabel({ ...message, status: 'failed' }, { [id]: 'Reviewer' })).toBe('Message to Reviewer failed');
    expect(agentActivityLabel({ ...message, status: 'unknown' }, { [id]: 'Reviewer' })).toBeUndefined();
    const completed = { ...message, kind: 'collaboration' as const, title: 'Agent finished', arguments: undefined, debug: JSON.stringify({ receiverThreadIds: [id], agentName: 'Reviewer' }) };
    expect(agentActivityLabel(completed, {})).toBe('Completed Reviewer');
    const wait = { ...message, title: 'Used wait_agent', arguments: JSON.stringify({ ids: [id] }), result: JSON.stringify({ status: { [id]: { completed: 'Reviewed' } } }) };
    expect(agentActivityLabel(wait, { [id]: 'Reviewer' })).toBe('Completed Reviewer');
    expect(agentActivityLabel({ ...wait, result: JSON.stringify({ status: { [id]: 'running' } }) }, {})).toBeUndefined();
    expect(messageAgentIds({ ...message, arguments: '{broken' })).toEqual([]);
  });
  it('uses agent names embedded in arguments when the session list is incomplete', () => {
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const message = { id: 'call', kind: 'collaboration' as const, title: 'Agent finished', text: '', arguments: JSON.stringify({ receiverThreadIds: [id], agentNickname: 'Reviewer' }), status: 'completed' as const };
    expect(agentActivityLabel(message, {})).toBe('Completed Reviewer');
  });
});
