import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { configureSqliteStateStore, SqliteStateStore } from '../src/storage/sqliteState';
import { readProjectBoard, readProjectTaskDetails, readSharedProjectTask } from '../src/services/projectBoard';
import { saveProjectTask, readProjectTasks } from '../src/services/projectTasks';
import * as sessions from '../src/services/codexSessionResume';
import * as workspace from '../src/services/workspaceTools';
import { removeTestDirectory } from './testFilesystem';

const state = vi.hoisted(() => ({ project: '', home: '', id: '11111111-1111-4111-8111-111111111111' }));
vi.mock('../src/services/codexSessionResume', () => ({
  resolveCodexHome: vi.fn(() => state.home),
  readCodexCliSessions: vi.fn(async () => [{ id: state.id, title: 'Session', status: 'running', projectPath: state.project }]),
  readCodexCliSessionSummary: vi.fn(async () => ({ id: state.id, projectPath: state.project, status: 'idle' })),
  readCodexCliSessionMessagePage: vi.fn(async () => ({ messages: [{ id: 'message', kind: 'message', role: 'assistant', text: 'Answer' }, { id: 'tool', kind: 'command', text: 'Run', output: 'Command output', command: 'echo test' }], olderThan: '200', warnings: [] }))
}));
vi.mock('../src/services/workspaceTools', () => ({
  resolveWorkspaceProjectPathAsync: vi.fn(async (project: string) => project),
  listWorkspaceFiles: vi.fn(async () => [{ path: 'src/app.ts', type: 'file' }]),
  readWorkspaceFile: vi.fn(async () => ({ path: 'src/app.ts', content: 'Source code' })),
  readWorkspaceEnvironment: vi.fn(async () => ({ isGitRepository: true, changes: 1 })),
  readWorkspaceGitHistory: vi.fn(async () => [{ hash: 'abcdef', author: 'Owner', date: '2026-10-20', subject: 'Change' }])
}));
let root: string, store: SqliteStateStore;
beforeEach(async () => { vi.clearAllMocks(); root = await mkdtemp(join(tmpdir(), 'manager-board-')); state.project = root; state.home = root; store = await SqliteStateStore.open(join(root, 'manager.sqlite')); configureSqliteStateStore(store); });
afterEach(async () => { configureSqliteStateStore(undefined); store.close(); await removeTestDirectory(root); });

it('imports native sessions into the database and reads each detail tab only when requested', async () => {
  const board = await readProjectBoard(root), task = board.tasks[0]!;
  expect(task.sessionId).toBe(state.id); expect(task.sessionStatus).toBe('running');
  expect(await readProjectTaskDetails(root, task.id)).toMatchObject({ olderThan: '200', messages: [{ id: 'message' }, { id: 'tool' }] });
  expect(workspace.listWorkspaceFiles).not.toHaveBeenCalled(); expect(workspace.readWorkspaceEnvironment).not.toHaveBeenCalled();
  await readProjectTaskDetails(root, task.id, 'files'); expect(workspace.listWorkspaceFiles).toHaveBeenCalledOnce();
  await readProjectTaskDetails(root, task.id, 'git'); expect(workspace.readWorkspaceGitHistory).toHaveBeenCalledOnce();
});

it('enforces shared features at the service boundary and filters message versus activity contents', async () => {
  const board = await readProjectBoard(root), task = board.tasks[0]!;
  const share = { projectPath: root, expiresAt: Date.now() + 60000, permissions: ['messages' as const] };
  await expect(readSharedProjectTask(share, task.id, 'files', undefined, 'src/app.ts')).rejects.toThrow(/not enabled/);
  expect(workspace.readWorkspaceFile).not.toHaveBeenCalled();
  const messages = await readSharedProjectTask(share, task.id, 'messages') as { messages: unknown[] };
  expect(messages.messages).toHaveLength(1); expect(messages.messages[0]).toMatchObject({ text: 'Answer' });
  expect(await readSharedProjectTask({ ...share, permissions: ['activities'] }, task.id, 'activities')).toMatchObject({ messages: [{ command: 'echo test', output: 'Command output' }] });
  await expect(readSharedProjectTask({ ...share, expiresAt: Date.now() - 1 }, task.id, 'messages')).rejects.toThrow(/expired/);
});

it('preserves tasks when discovery fails and reports optional detail failures without claiming completion', async () => {
  saveProjectTask(root, { id: 'draft', title: 'Saved', prompt: 'Prompt', stage: 'planned', expectedRevision: 0 });
  vi.mocked(sessions.readCodexCliSessions).mockRejectedValueOnce(new Error('Discovery offline'));
  await expect(readProjectBoard(root)).rejects.toThrow(/offline/);
  expect(readProjectTasks(root).tasks[0]?.title).toBe('Saved');
  vi.mocked(workspace.listWorkspaceFiles).mockRejectedValueOnce(new Error('Storage busy'));
  expect(await readProjectTaskDetails(root, 'draft', 'files')).toMatchObject({ warnings: ['Storage busy'], files: [] });
});

it('rejects an account-home change during discovery instead of importing the old catalogue into the new identity', async () => {
  vi.mocked(sessions.readCodexCliSessions).mockImplementationOnce(async () => { state.home = join(root, 'changed'); return []; });
  await expect(readProjectBoard(root)).rejects.toThrow(/home changed/);
  expect(readProjectTasks(root).tasks).toEqual([]);
});
