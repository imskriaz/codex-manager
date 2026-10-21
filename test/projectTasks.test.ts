import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureSqliteStateStore, SqliteStateStore } from '../src/storage/sqliteState';
import { saveProjectTask, readProjectTask, readProjectTasks, syncProjectSessions, addProjectComment, claimProjectTaskStart, finishProjectTaskStart, resetProjectTaskStart, createProjectShare, getProjectShare, revokeProjectShares, publicProjectBoard, projectTaskKey } from '../src/services/projectTasks';
import { projectTaskStages, sessionTaskStage, type ProjectBoard } from '../src/domain/projectTasks';
import { removeTestDirectory } from './testFilesystem';

let root: string, store: SqliteStateStore;
const sessionId = '11111111-1111-4111-8111-111111111111';
it('keeps completed sessions distinct from interrupted and unfinished goals', () => {
  expect(sessionTaskStage({ id: sessionId, title: 'Done', status: 'idle' })).toBe('completed');
  expect(sessionTaskStage({ id: sessionId, title: 'Stopped', status: 'idle', interrupted: true })).toBe('planned');
  expect(sessionTaskStage({ id: sessionId, title: 'Goal', status: 'idle', goal: { objective: 'Finish', status: 'paused' } })).toBe('planned');
});
const draft = (id: string, expectedRevision = 0) => ({ id, title: id, prompt: 'Do this work', stage: 'planned' as const, expectedRevision });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'manager-tasks-')); store = await SqliteStateStore.open(join(root, 'manager.sqlite')); configureSqliteStateStore(store); });
afterEach(async () => { vi.restoreAllMocks(); configureSqliteStateStore(undefined); store.close(); await removeTestDirectory(root); });

it('persists custom tasks and native identities exactly once, including nesting and later title changes', () => {
  const parent = saveProjectTask(root, draft('parent'));
  syncProjectSessions(root, root, [{ id: sessionId, title: 'Original', status: 'running' }]);
  const native = readProjectTasks(root).tasks.find(task => task.sessionId)!;
  saveProjectTask(root, { ...native, parentTaskId: parent.id, expectedRevision: native.revision });
  syncProjectSessions(root, root, [{ id: sessionId, title: 'Renamed', status: 'idle', interrupted: true }]);
  const tasks = readProjectTasks(root).tasks;
  expect(tasks).toHaveLength(2);
  expect(tasks.find(task => task.id === native.id)).toMatchObject({ title: 'Renamed', parentTaskId: parent.id, stage: 'planned' });
  const grouped = readProjectTask(root, native.id)!;
  saveProjectTask(root, { ...grouped, parentTaskId: null, expectedRevision: grouped.revision });
  expect(readProjectTask(root, native.id)?.parentTaskId).toBeUndefined();
  syncProjectSessions(root, join(root, 'other-home'), [{ id: sessionId, title: 'Other home', status: 'idle' }]);
  expect(readProjectTasks(root).tasks.filter(task => task.sessionId)).toHaveLength(2);
});

it('rejects cycles, missing and foreign parents, forged session tasks, and stale revisions atomically', () => {
  saveProjectTask(root, draft('a'));
  saveProjectTask(root, { ...draft('b'), parentTaskId: 'a' });
  saveProjectTask(join(root, 'other'), draft('foreign'));
  expect(() => saveProjectTask(root, { ...draft('a', 1), parentTaskId: 'b' })).toThrow(/descendants/);
  expect(() => saveProjectTask(root, { ...draft('a', 1), parentTaskId: 'foreign' })).toThrow(/another project/);
  expect(() => saveProjectTask(root, draft(`session:${sessionId}`))).toThrow(/discovery/);
  expect(() => saveProjectTask(root, { ...draft('a'), title: 'Overwrite' })).toThrow(/changed/);
  expect(readProjectTask(root, 'a')).toMatchObject({ revision: 1, title: 'a' });
  expect(() => saveProjectTask(root, { ...draft('a', 1), stage: 'completed' })).toThrow(/unfinished subtasks/);
  expect(() => saveProjectTask(root, { ...draft('manual'), stage: 'running' })).toThrow(/Start the task/);
});

it('retries acknowledged drafts and comments without duplicate writes or author replacement', () => {
  const task = saveProjectTask(root, draft('a'));
  expect(saveProjectTask(root, draft('a'))).toEqual(task);
  const input = { id: 'comment', taskId: task.id, text: 'Review this', author: 'Guest' };
  const comment = addProjectComment(root, input);
  expect(addProjectComment(root, { ...input, author: 'Owner' })).toEqual(comment);
  expect(() => addProjectComment(root, { ...input, text: 'Different' })).toThrow(/already used/);
  expect(() => addProjectComment(root, { ...input, id: 'other', taskId: 'missing' })).toThrow(/missing/);
  expect(readProjectTasks(root).comments).toHaveLength(1);
});

it('fences unconfirmed startup across reload and attaches the discovered session as a child', () => {
  const task = saveProjectTask(root, draft('a'));
  claimProjectTaskStart(root, task.id, task.revision);
  expect(() => claimProjectTaskStart(root, task.id, task.revision)).toThrow(/changed/);
  expect(() => saveProjectTask(root, draft('a', 2))).toThrow(/unconfirmed/);
  syncProjectSessions(root, root, [{ id: sessionId, title: 'Started session', status: 'running' }]);
  finishProjectTaskStart(root, task.id, sessionId, root);
  const rows = readProjectTasks(root).tasks;
  expect(rows).toHaveLength(2);
  expect(rows.find(item => item.sessionId === sessionId)).toMatchObject({ parentTaskId: 'a', sourceHome: root });
  expect(readProjectTask(root, 'a')?.launchPending).toBe(false);
  expect(projectTaskStages(rows).get('a')).toBe('running');
  expect(() => resetProjectTaskStart(root, 'a', 3)).toThrow(/unconfirmed/);
});

it('requires the reviewed revision to reset an uncertain launch', () => {
  saveProjectTask(root, draft('a')); claimProjectTaskStart(root, 'a', 1);
  expect(() => resetProjectTaskStart(root, 'a', 1)).toThrow(/reviewed/);
  resetProjectTaskStart(root, 'a', 2);
  expect(readProjectTask(root, 'a')).toMatchObject({ revision: 3, launchPending: false });
});

it('migrates prototype task IDs and comments transactionally without losing native grouping', () => {
  const key = projectTaskKey(root);
  store.set(`project:${key}:tasks`, 'legacy', { ...draft('legacy'), revision: 1, sessionId, createdAt: 1, updatedAt: 1 });
  store.set(`project:${key}:comments`, 'note', { id: 'note', taskId: 'legacy', author: 'Owner', text: 'Keep me', createdAt: 1 });
  syncProjectSessions(root, root, [{ id: sessionId, title: 'Session', status: 'idle' }]);
  expect(readProjectTasks(root).tasks).toHaveLength(1);
  expect(readProjectTask(root, 'legacy')?.sessionId).toBe(sessionId);
  expect(readProjectTasks(root).comments[0]?.taskId).toBe('legacy');
});

it('keeps saved data on a failed write and rejects invalid or full storage', () => {
  const task = saveProjectTask(root, draft('a'));
  store.database.exec("CREATE TRIGGER task_disk_full BEFORE UPDATE ON project_tasks BEGIN SELECT RAISE(ABORT,'disk full'); END");
  expect(() => saveProjectTask(root, { ...draft('a', 1), title: 'Changed' })).toThrow(/disk full/);
  expect(readProjectTask(root, 'a')).toEqual(task);
  expect(() => saveProjectTask(root, { ...draft('bad'), title: 'x'.repeat(241) })).toThrow(/title/);
  configureSqliteStateStore(undefined);
  expect(() => saveProjectTask(root, draft('offline'))).toThrow(/unavailable/);
});

it('hashes public links, enforces expiry and project revocation, and omits unshared comments', () => {
  saveProjectTask(root, draft('a')); addProjectComment(root, { id: 'c', taskId: 'a', text: 'Private comment' });
  const link = createProjectShare(root, ['activities', 'embed'], 1);
  const other = createProjectShare(join(root, 'other'), [], 30);
  expect(store.keys('project-shares')).not.toContain(link.token);
  const share = getProjectShare(link.token)!;
  const board: ProjectBoard = { projectPath: root, ...readProjectTasks(root), sessions: [], updatedAt: 1 };
  expect(publicProjectBoard(board, share)).toMatchObject({ comments: [], permissions: ['activities','embed','messages'] });
  expect(() => createProjectShare(root, ['unknown' as never])).toThrow(/permissions/);
  vi.spyOn(Date, 'now').mockReturnValue(link.expiresAt);
  expect(getProjectShare(link.token)).toBeUndefined(); vi.restoreAllMocks();
  revokeProjectShares(root);
  expect(getProjectShare(link.token)).toBeUndefined(); expect(getProjectShare(other.token)).toBeDefined();
});

it('does not treat unknown or idle work as completed, and propagates verified running descendants', () => {
  const parent = { ...draft('parent'), stage: 'completed' as const, revision: 1, createdAt: 1, updatedAt: 1 };
  const child = { ...parent, id: 'child', parentTaskId: 'parent', stage: 'running' as const, sessionStatus: 'unknown' as const };
  expect(projectTaskStages([parent, child]).get('parent')).toBe('planned');
  expect(projectTaskStages([parent, { ...child, sessionStatus: 'running' }]).get('parent')).toBe('running');
});
