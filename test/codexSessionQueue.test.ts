import { expect, it } from 'vitest';
import { nextQueuedSessions } from '../src/services/codexSessionQueue';
import type { DashboardCliSessionSummary } from '../src/domain/dashboard/types';
import type { CodexSessionPreference } from '../src/services/codexSessionPreferences';
const row = (id: string, patch: Partial<DashboardCliSessionSummary> = {}): DashboardCliSessionSummary => ({ id, title: id, status: 'idle', interrupted: true, ...patch });
const preferences = new Map<string, CodexSessionPreference>([['a', { queue: true, priority: 2 }], ['b', { queue: true, priority: 1 }], ['c', { queue: true, priority: 1 }]]);

it('waits for verified active work, including child agents, and inconclusive running state', () => {
  for (const active of [row('active', { status: 'running' }), row('child', { status: 'running', subAgent: true }), row('unknown', { status: 'unknown' })]) expect(nextQueuedSessions([row('b'), active], preferences)).toEqual([]);
});
it('starts equal priorities together before the next priority and skips archived/child work', () => {
  const sessions = [row('a'), row('b'), row('c')];
  expect(nextQueuedSessions(sessions, preferences).map(item => item.id)).toEqual(['b','c']);
  expect(nextQueuedSessions([row('a'), row('b', { archived: true }), row('c', { parentSessionId: 'parent' })], preferences).map(item => item.id)).toEqual(['a']);
});
it('never blindly replays a claimed or failed start after restart', () => {
  for (const uncertain of [{ queue: true, queueClaimedAt: 1 }, { queue: true, queueError: 'Unconfirmed' }]) expect(nextQueuedSessions([row('a'),row('b')], new Map([...preferences, ['b', uncertain]]))).toEqual([]);
});
