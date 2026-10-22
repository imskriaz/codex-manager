import { expect, it } from 'vitest';
import { projectTaskActivity } from '../src/domain/projectTaskActivity';
import type { DashboardCliSessionMessage } from '../src/domain/dashboard/types';

it('keeps meaningful task activity without thinking, compaction, empty events or failed attempts', () => {
  const messages: DashboardCliSessionMessage[] = [
    { id: 'prompt', text: 'Build this', role: 'user' },
    { id: 'think', text: 'Thinking', kind: 'reasoning' },
    { id: 'compact', text: 'History compacted', kind: 'compaction' },
    ...(['failed', 'declined', 'interrupted'] as const).map(status => ({ id: status, text: 'Tool attempt', kind: 'tool-call' as const, status })),
    { id: 'exit', text: 'Command', kind: 'command', exitCode: 1 },
    { id: 'empty', text: '  ' },
    { id: 'done', text: 'Result', kind: 'tool-call', status: 'completed' },
    { id: 'legacy', text: '', kind: 'command', command: 'pwd' },
    { id: 'running', text: 'Editing', kind: 'file-change', status: 'inProgress' },
    { id: 'issue', text: 'Session disconnected', kind: 'error', status: 'failed' },
    { id: 'attachment', text: '', images: [{ src: 'https://example.test/image.png' }] },
    { id: 'reply', text: 'Finished', role: 'assistant' },
  ];
  const original = structuredClone(messages);
  expect(projectTaskActivity(messages, []).map(event => event.message?.id)).toEqual(['prompt', 'done', 'legacy', 'running', 'issue', 'attachment', 'reply']);
  expect(messages).toEqual(original);
});

it('interleaves comments with dated activity and puts unsynced comments last', () => {
  const result = projectTaskActivity([
    { id: 'one', text: 'Start', timestamp: '2026-10-22T10:00:00Z' },
    { id: 'two', text: 'Finish', timestamp: '2026-10-22T11:00:00Z' },
  ], [
    { id: 'pending', taskId: 't', author: 'You · pending', text: 'Draft', createdAt: 0 },
    { id: 'review', taskId: 't', author: 'Reviewer', text: 'Review', createdAt: Date.parse('2026-10-22T10:30:00Z') },
  ]);
  expect(result.map(item => item.id)).toEqual(['message:one', 'comment:review', 'message:two', 'comment:pending']);
  expect(result[3]?.timestamp).toBeUndefined();
  expect(result[1]?.label).toBe('Reviewer');
});

it('preserves transcript order with missing, invalid and backwards timestamps without inventing displayed dates', () => {
  const result = projectTaskActivity([
    { id: 'one', text: 'First' },
    { id: 'two', text: 'Second', timestamp: '2026-10-22T11:00:00Z' },
    { id: 'three', text: 'Third', timestamp: 'not a date' },
    { id: 'four', text: 'Fourth', timestamp: '2026-10-22T10:00:00Z' },
  ], []);
  expect(result.map(item => item.message?.id)).toEqual(['one', 'two', 'three', 'four']);
  expect(result[0]?.timestamp).toBeUndefined();
  expect(result[2]?.timestamp).toBeUndefined();
  expect(projectTaskActivity([], [])).toEqual([]);
});
