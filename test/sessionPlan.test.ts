import { expect, it } from 'vitest';
import { messageSessionPlan, readSessionPlan, sessionPlanMessage } from '../src/domain/sessionPlan';
import { parseCodexAppServerThreadItems } from '../src/services/codexSessionResume';
import { consolidateSessionMessages, groupCompletedTurns } from '../webview-src/dashboard/cliSessionsModal';
import { userSessionActivity } from '../src/domain/teamWorkspacePresentation';

const plan = { plan: [{ step: 'Read files', status: 'completed' }, { step: 'Make changes', status: 'in_progress' }, { step: 'Check results', status: 'pending' }] };
it('normalizes native plan tool and notification states and rejects malformed or unbounded input', () => {
  expect(readSessionPlan(JSON.stringify(plan))?.steps[1]?.status).toBe('inProgress');
  for (const input of ['{', { plan: [] }, { plan: Array(101).fill(plan.plan[0]) }, { plan: [{ step: '', status: 'pending' }] }, { plan: [{ step: 'Unsafe', status: 'made-up' }] }, { plan: [{ step: 'x'.repeat(1001), status: 'pending' }] }, { plan: [plan.plan[1], plan.plan[1]] }]) expect(readSessionPlan(input)).toBeUndefined();
});
it('reads native update_plan activities and retains incomplete steps in completed histories', () => {
  const messages = parseCodexAppServerThreadItems({ thread: { turns: [{ id: 'turn-1', status: 'completed', items: [{ id: 'plan-1', type: 'dynamicToolCall', tool: 'update_plan', arguments: JSON.stringify(plan) }] }] } });
  expect(messages[0]).toMatchObject({ kind: 'plan', status: 'unknown', turnId: 'turn-1' });
  expect(messageSessionPlan(messages[0]!)?.steps).toEqual([{ step: 'Read files', status: 'completed' }, { step: 'Make changes', status: 'inProgress' }, { step: 'Check results', status: 'pending' }]);
});
it('keeps standalone native tool outputs visible',()=>{
  const messages=parseCodexAppServerThreadItems({thread:{turns:[{status:'completed',items:[{type:'functionCallOutput',id:'output',output:'Confirmed result'}]}]}});
  expect(messages).toMatchObject([{kind:'tool-call',result:'Confirmed result',status:'completed'}]);
});
it('keeps only the latest checklist per user turn and keeps it outside collapsed activity groups', () => {
  const first = sessionPlanMessage('old', readSessionPlan(plan)!);
  const latest = sessionPlanMessage('latest', { steps: readSessionPlan(plan)!.steps.map(step => ({ ...step, status: 'completed' })) });
  const items = consolidateSessionMessages([{ id: 'user', role: 'user', text: 'Do work' }, first, { id: 'tool', kind: 'tool-call', text: 'Saved', status: 'completed' }, latest, { id: 'answer', role: 'assistant', text: 'Done' }]);
  expect(items.map(item => item.id)).toEqual(['user', 'activity-group-tool', 'latest', 'answer']);
  expect(groupCompletedTurns(items, false)[1]).toMatchObject({ items: expect.arrayContaining([latest]) });
});
it('masks host paths in checklist titles without losing structured step states', () => {
  const activity = sessionPlanMessage('plan', { steps: [{ step: 'Read C:/private/alex/notes.txt', status: 'inProgress' }] });
  const safe = userSessionActivity(activity, ['C:/private/alex']);
  expect(messageSessionPlan(safe)?.steps).toEqual([{ step: 'Read alex/notes.txt', status: 'inProgress' }]);
  expect(JSON.stringify(safe)).not.toContain('C:/');
});
