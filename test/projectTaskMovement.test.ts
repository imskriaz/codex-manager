import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DashboardCliSessionSummary } from '../src/domain/dashboard/types';
import { configureSqliteStateStore, SqliteStateStore } from '../src/storage/sqliteState';
import { saveProjectTask, readProjectTask, readProjectTasks, syncProjectSessions } from '../src/services/projectTasks';
import { moveProjectTask, startProjectTaskSession } from '../src/services/projectTaskMovement';
import { removeTestDirectory } from './testFilesystem';

const id = '11111111-1111-4111-8111-111111111111', newId = '22222222-2222-4222-8222-222222222222';
const state = vi.hoisted(() => ({ home: '', sessions: new Map<string, DashboardCliSessionSummary>(), start: vi.fn(), stop: vi.fn(), send: vi.fn(), resume: vi.fn() }));
vi.mock('../src/services/codexSessionResume', () => ({
  resolveCodexHome: () => state.home,
  readCodexCliSessionSummary: vi.fn(async (id: string) => state.sessions.get(id)),
  readNewCodexCliSessionSummary: (id: string) => state.sessions.get(id),
  startCodexCliSession: state.start, cancelCodexCliSessionTurn: state.stop, sendCodexCliSessionMessage: state.send,
  unarchiveCodexCliSession: vi.fn(async (id: string) => { state.sessions.get(id)!.archived = false; })
}));
vi.mock('../src/services/codexSessionRecovery', () => ({ resumeCodexSessionWork: state.resume }));
vi.mock('../src/services/projectBoard', () => ({ readSavedProjectBoard: (projectPath: string) => ({ projectPath, ...readProjectTasks(projectPath), sessions: [...state.sessions.values()], updatedAt: Date.now() }) }));
vi.mock('../src/utils/crossWindowOperations', () => ({ runCrossWindowExclusive: async (_key: string, _label: string, work: (signal: AbortSignal) => Promise<unknown>) => work(new AbortController().signal) }));
vi.mock('../src/utils/persistentLog', () => ({ recordPersistentEvent: vi.fn() }));
let root: string, store: SqliteStateStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'manager-task-movement-')); state.home = root;
  store = await SqliteStateStore.open(join(root, 'manager.sqlite')); configureSqliteStateStore(store);
  state.sessions.clear(); state.start.mockReset(); state.stop.mockReset(); state.send.mockReset(); state.resume.mockReset();
  state.sessions.set(id, { id, title: 'Session', status: 'idle', interrupted: true, goal: null, projectPath: root, canStop: true });
  state.stop.mockImplementation(async (id: string) => { state.sessions.get(id)!.status = 'idle'; return true; });
  state.send.mockImplementation(async (options: { sessionId: string; onStarted: () => void }) => { state.sessions.get(options.sessionId)!.status = 'running'; options.onStarted(); });
  state.start.mockImplementation(async () => { state.sessions.set(newId, { id: newId, title: 'New session', status: 'running', projectPath: root, canStop: true }); return newId; });
  state.resume.mockImplementation(async (id: string) => { state.sessions.get(id)!.status = 'running'; return 'goal'; });
});
afterEach(async () => { vi.useRealTimers(); configureSqliteStateStore(undefined); store.close(); await removeTestDirectory(root); });
const custom = (name = 'task') => saveProjectTask(root, { id: name, title: name, prompt: 'Build the task', stage: 'planned', expectedRevision: 0 });
function sessionTask() { syncProjectSessions(root, root, [state.sessions.get(id)!]); return readProjectTasks(root).tasks.find(task => task.sessionId === id)!; }

it('starts only through an explicit start action and preserves its uncertain-start fence', async () => {
  const task = custom(); state.start.mockRejectedValueOnce(new Error('Capacity unavailable'));
  await expect(startProjectTaskSession(root, task.id, task.revision)).rejects.toThrow('Capacity');
  expect(readProjectTask(root, task.id)?.launchPending).toBe(true);
  await expect(startProjectTaskSession(root, task.id, task.revision)).rejects.toThrow(/changed/);
  expect(state.start).toHaveBeenCalledOnce();
});

it('starts additional subtasks from a custom container, with the original prompt as description', async () => {
  const task = saveProjectTask(root, { id:'container',title:'Container',prompt:'',stage:'idea',expectedRevision:0 });
  await startProjectTaskSession(root, task.id, task.revision, 'Original session request');
  expect(state.start).toHaveBeenCalledWith({ projectPath: root, text: 'Original session request' });
  expect(readProjectTasks(root).tasks.find(task => task.sessionId === newId)).toMatchObject({ parentTaskId: task.id, prompt: 'Original session request' });
  await expect(startProjectTaskSession(root, task.id, task.revision, 'Duplicate')).rejects.toThrow(/changed/);
  expect(state.start).toHaveBeenCalledOnce();
});

it.each(['idea','planned','running','completed'] as const)('classifies running work as %s without starting, resuming, stopping or changing its goal', async stage => {
  state.sessions.get(id)!.status = 'running'; state.sessions.get(id)!.goal={objective:'Keep this goal paused',status:'paused'}; const task = sessionTask();
  await moveProjectTask(root, task.id, task.revision, stage);
  expect(readProjectTask(root, task.id)).toMatchObject({ stage,manualStage:stage });
  expect(state.sessions.get(id)).toMatchObject({status:'running',goal:{status:'paused'}});
  expect(state.stop).not.toHaveBeenCalled();expect(state.send).not.toHaveBeenCalled();expect(state.resume).not.toHaveBeenCalled();expect(state.start).not.toHaveBeenCalled();
  syncProjectSessions(root,root,[{...state.sessions.get(id)!,title:'Still running'}]);
  expect(readProjectTask(root,task.id)?.stage).toBe(stage);
});

it('moves and detaches an unverified session using its DB identity without native discovery', async () => {
  const parent=custom(), task=sessionTask();saveProjectTask(root,{...task,parentTaskId:parent.id,expectedRevision:task.revision});state.sessions.clear();
  await moveProjectTask(root,task.id,task.revision+1,'idea',true);
  expect(readProjectTask(root,task.id)).toMatchObject({stage:'idea',manualStage:'idea'});expect(readProjectTask(root,task.id)?.parentTaskId).toBeUndefined();
  expect(state.send).not.toHaveBeenCalled();expect(state.stop).not.toHaveBeenCalled();
});

it('moves a custom task with running children without native operations and rejects stale retries', async () => {
  const parent=custom();state.sessions.get(id)!.status='running';const child=sessionTask();saveProjectTask(root,{...child,parentTaskId:parent.id,expectedRevision:child.revision});
  await moveProjectTask(root,parent.id,parent.revision,'completed');
  expect(readProjectTask(root,parent.id)?.stage).toBe('completed');expect(readProjectTask(root,child.id)?.stage).toBe('running');
  expect(state.stop).not.toHaveBeenCalled();expect(state.start).not.toHaveBeenCalled();
  await expect(moveProjectTask(root,parent.id,parent.revision,'idea')).rejects.toThrow(/changed/);
});

it('does not change a card when movement storage is full', async () => {
  const task=custom();store.database.exec("CREATE TRIGGER reject_task_write BEFORE UPDATE ON project_tasks BEGIN SELECT RAISE(ABORT,'storage full'); END");
  await expect(moveProjectTask(root,task.id,task.revision,'running')).rejects.toThrow('storage full');
  expect(readProjectTask(root,task.id)?.stage).toBe('planned');expect(state.start).not.toHaveBeenCalled();
});

it('does not dispatch a session start when the durable claim cannot be stored', async () => {
  const task=custom();store.database.exec("CREATE TRIGGER reject_task_write BEFORE UPDATE ON project_tasks BEGIN SELECT RAISE(ABORT,'storage full'); END");
  await expect(startProjectTaskSession(root,task.id,task.revision,'Create a subtask')).rejects.toThrow('storage full');expect(state.start).not.toHaveBeenCalled();
});

it('keeps an accepted start unlinked when the account home changes, and prevents blind retry', async () => {
  const task=custom();state.start.mockImplementation(async()=>{state.home=join(root,'another-home');return newId;});
  await expect(startProjectTaskSession(root,task.id,task.revision)).rejects.toThrow(/home changed/);expect(readProjectTask(root,task.id)?.launchPending).toBe(true);
});
