import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { configureSqliteStateStore, SqliteStateStore } from '../src/storage/sqliteState';
import { readProjectBoard, readProjectTaskDetails, readSharedProjectTask } from '../src/services/projectBoard';
import { taskSessionAgents } from '../src/domain/projectTasks';
import { saveProjectTask, readProjectTasks } from '../src/services/projectTasks';
import * as sessions from '../src/services/codexSessionResume';
import * as workspace from '../src/services/workspaceTools';
import { removeTestDirectory } from './testFilesystem';
import { saveSessionLive } from '../src/storage/sqliteSessions';

const state = vi.hoisted(() => ({ project: '', home: '', id: '11111111-1111-4111-8111-111111111111' }));
vi.mock('../src/services/codexSessionResume', () => ({
  resolveCodexHome: vi.fn(() => state.home),
  readCodexCliSessionInitialPrompt: vi.fn(async () => 'Initial user request'),
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
  await readProjectTaskDetails(root, task.id, 'files'); expect(workspace.listWorkspaceFiles).not.toHaveBeenCalled();
  await readProjectTaskDetails(root, task.id, 'changes'); expect(workspace.readWorkspaceEnvironment).toHaveBeenCalledOnce();
});

it('loads bounded environment metadata for Overview without requesting a branch diff or bypassing public permissions', async () => {
  const board = await readProjectBoard(root), task = board.tasks[0]!;
  expect(await readProjectTaskDetails(root, task.id, 'overview')).toMatchObject({ taskId: task.id, environment: { changes: 1 }, initialPrompt: expect.any(String) });
  expect(workspace.readWorkspaceEnvironment).toHaveBeenCalledWith(root, false);
  await expect(readSharedProjectTask({ projectPath: root, expiresAt: Date.now() + 60000, permissions: ['activities'] } as never, task.id, 'overview')).rejects.toThrow('not enabled');
});

it('enforces shared features at the service boundary and exposes one combined activity view', async () => {
  const board = await readProjectBoard(root), task = board.tasks[0]!;
  const share = { projectPath: root, expiresAt: Date.now() + 60000, permissions: ['activities' as const, 'messages' as const] };
  await expect(readSharedProjectTask(share, task.id, 'files', undefined, 'src/app.ts')).rejects.toThrow(/not enabled/);
  expect(workspace.readWorkspaceFile).not.toHaveBeenCalled();
  const messages = await readSharedProjectTask(share, task.id, 'messages') as { messages: unknown[] };
  expect(messages.messages).toHaveLength(2); expect(messages.messages[0]).toMatchObject({ text: 'Answer' });
  expect(await readSharedProjectTask({ ...share, permissions: ['activities'] }, task.id, 'activities')).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ command: 'echo test', output: 'Command output' })]) });
  expect(await readSharedProjectTask({ ...share, permissions: ['messages'] }, task.id, 'activities')).toMatchObject({ messages: [{ text: 'Answer' }] });
  await expect(readSharedProjectTask({ ...share, permissions: ['git'] }, task.id, 'git')).rejects.toThrow(/not enabled/);
  await expect(readSharedProjectTask({ ...share, expiresAt: Date.now() - 1 }, task.id, 'activities')).rejects.toThrow(/expired/);
});

it('preserves tasks when discovery fails and reports optional detail failures without claiming completion', async () => {
  saveProjectTask(root, { id: 'draft', title: 'Saved', prompt: 'Prompt', stage: 'planned', expectedRevision: 0 });
  vi.mocked(sessions.readCodexCliSessions).mockRejectedValueOnce(new Error('Discovery offline'));
  await expect(readProjectBoard(root)).rejects.toThrow(/offline/);
  expect(readProjectTasks(root).tasks[0]?.title).toBe('Saved');
  vi.mocked(workspace.listWorkspaceFiles).mockRejectedValueOnce(new Error('Storage busy'));
  expect(await readProjectTaskDetails(root, 'draft', 'files')).toMatchObject({ warnings: [], files: [] });
});

it('keeps tool fields private on message-only links even when a mixed transcript row contains them', async () => {
  const board = await readProjectBoard(root), task = board.tasks[0]!;
  vi.mocked(sessions.readCodexCliSessionMessagePage).mockResolvedValueOnce({ messages: [{ id: 'mixed', kind: 'message', role: 'assistant', text: 'Answer', command: 'private command', output: 'private output', result: 'private result', arguments: 'private arguments' }], warnings: [] });
  const shared = await readSharedProjectTask({ projectPath: root, expiresAt: Date.now() + 60000, permissions: ['messages'] }, task.id, 'activities') as { messages: Array<Record<string, unknown>> };
  expect(shared.messages).toHaveLength(1);
  expect(shared.messages[0]).toMatchObject({ text: 'Answer' });
  for (const field of ['command','output','result','arguments']) expect(shared.messages[0]).not.toHaveProperty(field);
});

it('rejects an account-home change during discovery instead of importing the old catalogue into the new identity', async () => {
  vi.mocked(sessions.readCodexCliSessions).mockImplementationOnce(async () => { state.home = join(root, 'changed'); return []; });
  await expect(readProjectBoard(root)).rejects.toThrow(/home changed/);
  expect(readProjectTasks(root).tasks).toEqual([]);
});

it('does not turn conversation-file sharing into unrestricted project file access', async () => {
  const board = await readProjectBoard(root), task = board.tasks[0]!;
  const share = { projectPath: root, expiresAt: Date.now() + 60000, permissions: ['files' as const] };
  await expect(readSharedProjectTask(share, task.id, 'files', undefined, 'private.env')).rejects.toThrow(/not part/);
  expect(workspace.readWorkspaceFile).not.toHaveBeenCalled();
});

it('previews conversation uploads as snapshots and gates public image/data exposure behind Files permission', async () => {
  const board = await readProjectBoard(root), task = board.tasks[0]!;
  const image = 'data:image/png;base64,iVBORw0KGgo=', page = { messages: [{ id: 'upload', kind: 'message' as const, role: 'user' as const,
    text: 'Review\n\n<attached_file name="private.env">\nPRIVATE UPLOAD', textAttachments: [{ name: 'private.env', text: 'PRIVATE UPLOAD' }],
    images: [{ src: image, alt: 'Screenshot' }, { src: 'file:///private/missing.png', alt: 'Missing' }] }], warnings: [], olderThan: '100' };
  const share = { projectPath: root, expiresAt: Date.now() + 60000, permissions: ['messages' as const] };
  vi.mocked(sessions.readCodexCliSessionMessagePage).mockResolvedValueOnce(page);
  const privateFiles = await readProjectTaskDetails(root, task.id, 'files');
  expect(privateFiles.files.map(file => file.name)).toEqual(['private.env', 'Screenshot', 'Missing']);
  vi.mocked(sessions.readCodexCliSessionMessagePage).mockResolvedValueOnce(page);
  const messageOnly = JSON.stringify(await readSharedProjectTask(share, task.id, 'activities'));
  for (const secret of ['PRIVATE UPLOAD', image, 'file:///private']) expect(messageOnly).not.toContain(secret);
  vi.mocked(sessions.readCodexCliSessionMessagePage).mockResolvedValueOnce(page);
  expect(await readSharedProjectTask({ ...share, permissions: ['messages', 'files'] }, task.id, 'activities')).toMatchObject({ messages: [{ text: 'Review', images: [{ src: image }] }] });
  for (const [index, expected] of [[0, { path: 'private.env', content: 'PRIVATE UPLOAD', kind: 'text' }], [1, { path: 'Screenshot', dataUrl: image, kind: 'image' }]] as const) {
    vi.mocked(sessions.readCodexCliSessionMessagePage).mockResolvedValueOnce(page);
    expect(await readSharedProjectTask({ ...share, permissions: ['files'] }, task.id, 'files', undefined, privateFiles.files[index]!.path)).toMatchObject({ file: expected });
  }
  vi.mocked(sessions.readCodexCliSessionMessagePage).mockResolvedValueOnce(page);
  await expect(readSharedProjectTask({ ...share, permissions: ['files'] }, task.id, 'files', undefined, privateFiles.files[2]!.path)).rejects.toThrow(/unavailable/);
  vi.mocked(sessions.readCodexCliSessionMessagePage).mockResolvedValueOnce({ messages: [], warnings: [] });
  await expect(readSharedProjectTask({ ...share, permissions: ['files'] }, task.id, 'files', '100', privateFiles.files[0]!.path)).rejects.toThrow(/not part/);
  expect(workspace.readWorkspaceFile).not.toHaveBeenCalled();
});

it('merges bounded live activity and file changes without modifying older history pages', async () => {
  const board = await readProjectBoard(root), task = board.tasks[0]!;
  saveSessionLive(store, root, { sessionId: state.id, streamId: '22222222-2222-4222-8222-222222222222', sequence: 1, updatedAt: Date.now(), status: 'running', truncated: true, messages: [
    { id: 'message', kind: 'message', role: 'assistant', text: 'Live answer' },
    { id: 'edit', kind: 'file-change', text: 'Edited', changes: [{ path: 'src/live.ts', kind: 'update' }] }
  ] });
  const details = await readProjectTaskDetails(root, task.id);
  expect(details.messages.map(message => message.id)).toEqual(['message','tool','edit']);
  expect(details.messages[0]?.text).toBe('Live answer');
  expect((await readProjectTaskDetails(root, task.id, 'files')).files).toMatchObject([{ path: 'src/live.ts' }]);
  expect((await readProjectTaskDetails(root, task.id, 'activities', '100')).messages[0]?.text).toBe('Answer');
  const shared = await readSharedProjectTask({ projectPath: root, expiresAt: Date.now() + 60000, permissions: ['messages'] }, task.id, 'activities') as { messages: Array<{ text: string }> };
  expect(shared.messages).toEqual([expect.objectContaining({ text: 'Live answer' })]);
});

it('retains live activity when saved history fails and ignores another home or newer native turn', async () => {
  const board = await readProjectBoard(root), task = board.tasks[0]!;
  const live = { sessionId: state.id, streamId: '22222222-2222-4222-8222-222222222222', sequence: 1, updatedAt: Date.now(), status: 'running' as const, messages: [{ id: 'live', text: 'Live only', role: 'assistant' as const }] };
  saveSessionLive(store, join(root, 'other-home'), live);
  expect((await readProjectTaskDetails(root, task.id)).messages.some(message => message.id === 'live')).toBe(false);
  saveSessionLive(store, root, live);
  vi.mocked(sessions.readCodexCliSessionMessagePage).mockRejectedValueOnce(new Error('Transcript busy'));
  expect(await readProjectTaskDetails(root, task.id)).toMatchObject({ messages: [{ text: 'Live only' }], warnings: ['Transcript busy'] });
  vi.mocked(sessions.readCodexCliSessionSummary).mockResolvedValueOnce({ id: state.id, projectPath: root, status: 'running', updatedAt: new Date(live.updatedAt + 1000).toISOString() });
  expect((await readProjectTaskDetails(root, task.id)).messages.some(message => message.id === 'live')).toBe(false);
});

it('lists every task agent once, including nested agents, without mixing systems or cycling', () => {
  const rows = [
    { id: 'main', status: 'idle' as const, title: 'Main', parentSessionId: 'nested' },
    { id: 'child', status: 'running' as const, title: 'Child', parentSessionId: 'main' },
    { id: 'nested', status: 'idle' as const, title: 'Nested', parentSessionId: 'child' },
    { id: 'foreign', status: 'running' as const, title: 'Foreign', parentSessionId: 'main', deviceId: 'another-pc' }
  ];
  expect(taskSessionAgents([...rows, rows[1]!], 'main').map(row => row.id)).toEqual(['child', 'nested']);
  expect(taskSessionAgents(rows, undefined)).toEqual([]);
  expect(taskSessionAgents(rows, 'main', 'another-pc').map(row => row.id)).toEqual(['foreign']);
});

it('refuses direct public reads for hidden sessions while retaining owner access', async () => {
  const board = await readProjectBoard(root);
  const task = board.tasks.find(task => task.sessionId)!;
  saveProjectTask(root, { ...task, expectedRevision: task.revision, hidden: true });
  const share = { projectPath: root, expiresAt: Date.now() + 60000, permissions: ['activities','files','changes'] as const };
  for (const view of ['activities','files','changes']) await expect(readSharedProjectTask(share as never, task.id, view)).rejects.toThrow(/unavailable/);
  expect((await readProjectTaskDetails(root, task.id)).task?.hidden).toBe(true);
});

it('enforces public permissions on links without an expiry', async () => {
  const board = await readProjectBoard(root), task = board.tasks[0]!;
  const share = { projectPath:root, expiresAt:0, permissions:['messages' as const] };
  expect(await readSharedProjectTask(share,task.id,'activities')).toMatchObject({messages:[{text:'Answer'}]});
  await expect(readSharedProjectTask(share,task.id,'files')).rejects.toThrow(/not enabled/);
});
