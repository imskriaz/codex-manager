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

it('allows only session children under custom parents and rejects stale or foreign grouping atomically', () => {
  saveProjectTask(root, draft('a')); saveProjectTask(root, draft('b'));
  expect(() => saveProjectTask(root, { ...draft('b',1), parentTaskId: 'a' })).toThrow(/top-level/);
  syncProjectSessions(root, root, [{ id: sessionId, title: 'Child', status: 'idle', interrupted: true }]);
  const child = readProjectTasks(root).tasks.find(task => task.sessionId)!;
  saveProjectTask(join(root, 'other'), draft('foreign'));
  expect(() => saveProjectTask(root, { ...child, expectedRevision: child.revision, parentTaskId: 'foreign' })).toThrow(/another project/);
  expect(() => saveProjectTask(root, { ...child, expectedRevision: child.revision, parentTaskId: child.id })).toThrow(/descendants/);
  saveProjectTask(root, { ...child, expectedRevision: child.revision, parentTaskId: 'a' });
  expect(() => saveProjectTask(root, { ...draft('b',1), parentTaskId: child.id })).toThrow(/top-level/);
  expect(() => saveProjectTask(root, draft(`session:${sessionId}`))).toThrow(/discovery/);
  expect(() => saveProjectTask(root, { ...draft('a'), title: 'Overwrite' })).toThrow(/changed/);
  expect(saveProjectTask(root, { ...draft('a', 1), stage: 'completed' })).toMatchObject({stage:'completed',manualStage:'completed'});
  expect(saveProjectTask(root, { ...draft('manual'), stage: 'running' })).toMatchObject({stage:'running',manualStage:'running'});
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
  expect(projectTaskStages(rows).get('a')).toBe('planned'); expect(rows.find(item=>item.sessionId===sessionId)?.stage).toBe('running');
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

it('preserves an explicit board column when native work resumes', () => {
  syncProjectSessions(root, root, [{ id: sessionId, title: 'Work', status: 'running' }]);
  const task = readProjectTasks(root).tasks.find(task => task.sessionId)!;
  store.prepare("UPDATE project_tasks SET data=json_set(data,'$.manualStage','idea','$.stage','idea') WHERE project=? AND id=?").run(projectTaskKey(root),task.id);
  syncProjectSessions(root, root, [{ id: sessionId, title: 'Work', status: 'idle', interrupted: true }]);
  expect(readProjectTask(root, task.id)).toMatchObject({ stage:'idea',manualStage:'idea' });
  syncProjectSessions(root, root, [{ id: sessionId, title: 'Work', status: 'running' }]);
  expect(readProjectTask(root, task.id)).toMatchObject({stage:'idea',manualStage:'idea'});
});

it('creates additional session subtasks from completed custom containers and preserves their initial prompt', () => {
  const task = saveProjectTask(root, { ...draft('container'), stage:'completed' });
  claimProjectTaskStart(root,task.id,task.revision,true);
  finishProjectTaskStart(root,task.id,sessionId,root,'Original subtask prompt','Subtask title');
  const child = readProjectTasks(root).tasks.find(task => task.sessionId)!;
  expect(child).toMatchObject({ title:'Subtask title',prompt:'Original subtask prompt',parentTaskId:task.id });
  expect(() => claimProjectTaskStart(root,child.id,child.revision,true)).toThrow(/already started/);
});

it('promotes legacy custom nesting without losing its description or comments', () => {
  const key=projectTaskKey(root);
  store.set(`project:${key}:tasks`,'parent',{...draft('parent'),revision:1,createdAt:1,updatedAt:1});
  store.set(`project:${key}:tasks`,'nested',{...draft('nested'),revision:1,parentTaskId:'parent',createdAt:1,updatedAt:1});
  store.set(`project:${key}:comments`,'comment',{id:'comment',taskId:'nested',author:'Owner',text:'Keep this comment',createdAt:1});
  expect(readProjectTask(root,'nested')).toMatchObject({prompt:'Do this work',revision:2});
  expect(readProjectTask(root,'nested')?.parentTaskId).toBeUndefined();
  expect(readProjectTasks(root).comments[0]?.text).toBe('Keep this comment');
});

it('archives and restores custom tasks without changing children or their workflow classification', () => {
  const task=saveProjectTask(root,draft('archive-container'));
  syncProjectSessions(root,root,[{id:sessionId,title:'Running child',status:'running'}]);const child=readProjectTasks(root).tasks.find(task=>task.sessionId)!;
  saveProjectTask(root,{...child,parentTaskId:task.id,expectedRevision:child.revision});
  const archived=saveProjectTask(root,{...task,expectedRevision:task.revision,archived:true});
  expect(archived).toMatchObject({archived:true,stage:'planned',manualStage:'planned'});
  expect(projectTaskStages(readProjectTasks(root).tasks).get(task.id)).toBe('completed');
  const restored=saveProjectTask(root,{...archived,expectedRevision:archived.revision,archived:false});
  expect(restored).toMatchObject({archived:false,stage:'planned'});expect(readProjectTask(root,child.id)?.stage).toBe('running');
});

it('persists session visibility through discovery and reload, with safe retry and restore', async () => {
  const parent = saveProjectTask(root, draft('group'));
  syncProjectSessions(root, root, [{ id: sessionId, title: 'Running', status: 'running' }]);
  const native = readProjectTasks(root).tasks.find(task => task.sessionId)!;
  const grouped = saveProjectTask(root, { ...native, expectedRevision: native.revision, parentTaskId: parent.id });
  const request = { ...grouped, expectedRevision: grouped.revision, hidden: true };
  const hidden = saveProjectTask(root, request);
  expect(saveProjectTask(root, request)).toEqual(hidden);
  expect(() => saveProjectTask(root, { ...request, hidden: false })).toThrow(/changed/);
  syncProjectSessions(root, root, [{ id: sessionId, title: 'Renamed', status: 'idle', interrupted: true }]);
  expect(readProjectTask(root, native.id)).toMatchObject({ hidden: true, title: 'Renamed', parentTaskId: parent.id, stage: 'planned', sessionArchived: false });
  store.close(); store = await SqliteStateStore.open(join(root, 'manager.sqlite')); configureSqliteStateStore(store);
  const reloaded = readProjectTask(root, native.id)!;
  expect(reloaded.hidden).toBe(true);
  const restored = saveProjectTask(root, { ...reloaded, expectedRevision: reloaded.revision, hidden: false });
  expect(restored).toMatchObject({ hidden: false, parentTaskId: parent.id, sessionId, stage: 'planned', sessionArchived: false });
  expect(() => saveProjectTask(root, { ...draft('custom-hidden'), hidden: true })).toThrow(/Only session/);
  expect(() => saveProjectTask(root, { ...restored, expectedRevision: restored.revision, hidden: 'true' as never })).toThrow(/hidden/);
});

it('omits hidden sessions and their comments from public boards', () => {
  syncProjectSessions(root, root, [{ id: sessionId, title: 'Private', status: 'running' }]);
  const native = readProjectTasks(root).tasks[0]!;
  saveProjectTask(root, { ...native, expectedRevision: native.revision, hidden: true });
  addProjectComment(root, { id: 'hidden-comment', taskId: native.id, text: 'Not on public board' });
  const visible = saveProjectTask(root, draft('visible'));
  addProjectComment(root, { id: 'visible-comment', taskId: visible.id, text: 'Visible' });
  const board = { projectPath: root, ...readProjectTasks(root), sessions: [], updatedAt: 1 };
  const share = createProjectShare(root, ['activities','comments'], 1);
  expect(publicProjectBoard(board, share)).toMatchObject({ tasks: [expect.objectContaining({ id: visible.id })], comments: [expect.objectContaining({ id: 'visible-comment' })] });
});
