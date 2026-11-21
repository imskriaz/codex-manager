import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureSqliteStateStore, SqliteStateStore } from '../src/storage/sqliteState';
import { adoptCodexAttachmentFiles, maintainAttachmentStorage, saveCodexAttachmentFiles } from '../src/services/projectTaskAttachments';
import { DatabaseSync } from 'node:sqlite';
import { addProjectCommentWithAttachments, deleteProjectTask, projectTaskKey, saveProjectTaskWithAttachments, readProjectTasks } from '../src/services/projectTasks';
import { removeDeletedSessionCache } from '../src/storage/sqliteSessions';
import { getCodexHomeStateKey } from '../src/codex/authFile';
import { removeTestDirectory } from './testFilesystem';

vi.mock('../src/utils/crossWindowOperations', () => ({
  runCrossWindowExclusive: async (_key: string, _label: string, work: (signal: AbortSignal) => Promise<unknown>) => work(new AbortController().signal),
  CrossWindowOperationBusyError: class extends Error {}
}));
let root: string, store: SqliteStateStore;
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const file = { id: 'file', name: 'brief.md', kind: 'text' as const, mimeType: 'text/plain', data: 'Keep this attachment', size: 20 };
const draft = { id: 'task', title: 'Task', prompt: 'Read', stage: 'planned' as const, expectedRevision: 0, uploads: [file] };
const folder = () => path.join(root, 'manager', 'attachments', projectTaskKey(root));
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'manager-attachment-cleanup-'));
  store = await SqliteStateStore.open(path.join(root, 'manager.sqlite')); configureSqliteStateStore(store);
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); configureSqliteStateStore(undefined); store.close(); await removeTestDirectory(root); });
const sweep = () => maintainAttachmentStorage(store, new AbortController().signal);

it('removes task and comment files on deletion while retaining content shared by another task', async () => {
  const first = await saveProjectTaskWithAttachments(root, draft);
  const second = await saveProjectTaskWithAttachments(root, { ...draft, id: 'keep', archived: true });
  const comment = await addProjectCommentWithAttachments(root, { id: 'comment', taskId: first.id, text: '', uploads: [{ ...file, data: 'Comment only' }] });
  expect(await deleteProjectTask(root, first.id, first.revision)).toBeUndefined();
  await expect(fs.stat(path.join(folder(), comment.attachments![0]!.hash))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(folder(), second.attachments![0]!.hash), 'utf8')).toBe(file.data);
  expect(await deleteProjectTask(root, second.id, second.revision)).toBeUndefined();
  await expect(fs.stat(folder())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('sweeps replaced and failed uploads, expired temporary files and empty folders after restart', async () => {
  const task = await saveProjectTaskWithAttachments(root, draft);
  await saveProjectTaskWithAttachments(root, { ...draft, expectedRevision: task.revision, uploads: [] });
  const stale = path.join(folder(), `${'c'.repeat(64)}.${randomUUID()}.tmp`);
  const fresh = path.join(folder(), `${'d'.repeat(64)}.${randomUUID()}.tmp`);
  await fs.writeFile(stale, 'old'); await fs.utimes(stale, new Date(0), new Date(0)); await fs.writeFile(fresh, 'active');
  store.close(); store = await SqliteStateStore.open(path.join(root, 'manager.sqlite')); configureSqliteStateStore(store);
  await sweep();
  expect(await fs.readdir(folder())).toEqual([path.basename(fresh)]);
  await fs.unlink(fresh); await sweep();
  await expect(fs.stat(folder())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reports completed task deletion with a cleanup warning and retries file removal later', async () => {
  const task = await saveProjectTaskWithAttachments(root, draft);
  vi.spyOn(fs, 'unlink').mockRejectedValueOnce(Object.assign(new Error('File is busy'), { code: 'EBUSY' }));
  expect(await deleteProjectTask(root, task.id, task.revision)).toMatch(/Task deleted.*cleanup is pending/);
  expect(readProjectTasks(root).tasks).toEqual([]);
  expect(await fs.readdir(folder())).toHaveLength(1);
  vi.restoreAllMocks(); await sweep();
  await expect(fs.stat(folder())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('bounds optional post-delete cleanup to one second and lets the owned cleanup finish safely', async () => {
  const task = await saveProjectTaskWithAttachments(root, draft);
  vi.useFakeTimers();
  const unlink = fs.unlink.bind(fs);
  let release!: () => void;
  vi.spyOn(fs, 'unlink').mockImplementationOnce(async target => { await new Promise<void>(resolve => { release = resolve; }); await unlink(target); });
  const deletion = deleteProjectTask(root, task.id, task.revision);
  await vi.waitFor(() => expect(release).toBeDefined());
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await deletion).toMatch(/Task deleted.*still pending/);
  expect(readProjectTasks(root).tasks).toEqual([]);
  release();
  await vi.waitFor(async () => { await expect(fs.stat(path.join(folder(), task.attachments![0]!.hash))).rejects.toMatchObject({ code: 'ENOENT' }); });
  vi.useRealTimers();
  await sweep();
});

it('keeps referenced session files, archived fork references, other homes and unclassified legacy folders', async () => {
  await fs.writeFile(path.join(root, 'session_index.jsonl'), '');
  const [saved] = await saveCodexAttachmentFiles(root, [file], undefined, { home: root, sessionId: id });
  await fs.mkdir(path.join(root, 'archived_sessions'));
  const inherited = path.join(root, 'archived_sessions', 'fork.jsonl');
  await fs.writeFile(inherited, JSON.stringify({ text: saved!.path }));
  await sweep(); expect(await fs.readFile(saved!.path, 'utf8')).toBe(file.data);
  const other = await saveCodexAttachmentFiles(root, [file], undefined, { home: root + '-other', sessionId: id });
  removeDeletedSessionCache(store, root, [id], undefined, Date.now() + 1, true);
  await sweep(); expect(await fs.readFile(saved!.path, 'utf8')).toBe(file.data);
  await fs.unlink(inherited); await sweep();
  await expect(fs.stat(saved!.path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(other[0]!.path, 'utf8')).toBe(file.data);
  const legacy = path.join(root, 'manager', 'attachments', 'e'.repeat(64));
  await fs.mkdir(legacy); await fs.writeFile(path.join(legacy, 'f'.repeat(64)), 'Unknown history');
  await sweep(); expect(await fs.readdir(legacy)).toHaveLength(1);
});

it('preserves session files when native history is missing or unreadable and rejects uploads for deleted sessions', async () => {
  const [saved] = await saveCodexAttachmentFiles(root, [file], undefined, { home: root, sessionId: id });
  removeDeletedSessionCache(store, root, [id], undefined, Date.now() + 1, true);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await sweep(); expect(await fs.readFile(saved!.path, 'utf8')).toBe(file.data); expect(warn).toHaveBeenCalled();
  await expect(saveCodexAttachmentFiles(root, [file], undefined, { home: root, sessionId: id })).rejects.toThrow('deleted');
});

it('removes confirmed session metadata while preserving the same ID in another home', () => {
  for (const home of [root, root + '-other']) {
    const key = `${getCodexHomeStateKey(home)}:${id}`;
    for (const namespace of ['codex-session-preferences', 'codex-session-title-overrides', 'session-goal-explicit-pause']) store.set(namespace, key, { keep: true });
    store.set('session-access', JSON.stringify([path.resolve(home), id]), { keep: true });
  }
  removeDeletedSessionCache(store, root, [id], undefined, Date.now() + 1, true);
  for (const namespace of ['codex-session-preferences', 'codex-session-title-overrides', 'session-goal-explicit-pause', 'session-access']) expect(store.keys(namespace)).toHaveLength(1);
});

it('keeps files when attachment reference metadata is corrupt or a sweep is cancelled', async () => {
  await saveProjectTaskWithAttachments(root, draft);
  store.prepare("UPDATE project_tasks SET data='broken' WHERE project=?").run(projectTaskKey(root));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await sweep(); expect(await fs.readdir(folder())).toHaveLength(1);
  const abort = new AbortController(); abort.abort();
  await expect(maintainAttachmentStorage(store, abort.signal)).rejects.toThrow();
  expect(await fs.readdir(folder())).toHaveLength(1);
});

it('expires abandoned startup uploads after one day and transfers confirmed uploads to their session', async () => {
  await fs.writeFile(path.join(root, 'session_index.jsonl'), '');
  const pendingId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const [abandoned] = await saveCodexAttachmentFiles(root, [file], undefined, { home: root, sessionId: pendingId, pending: true });
  const [adopted] = await saveCodexAttachmentFiles(root, [file], undefined, { home: root, sessionId: id, pending: true });
  adoptCodexAttachmentFiles(root, id, 'cccccccc-cccc-cccc-cccc-cccccccccccc');
  await sweep(); expect(await fs.readFile(abandoned!.path, 'utf8')).toBe(file.data);
  store.set('pending-session-attachments', JSON.stringify([getCodexHomeStateKey(root), pendingId]), { expiresAt: Date.now() - 1 });
  await sweep();
  await expect(fs.stat(abandoned!.path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(adopted!.path, 'utf8')).toBe(file.data);
});

it('keeps orphan uploads when a native transcript is outside the scanned folders', async () => {
  const [saved] = await saveCodexAttachmentFiles(root, [file], undefined, { home: root, sessionId: id });
  removeDeletedSessionCache(store, root, [id], undefined, Date.now() + 1, true);
  const db = new DatabaseSync(path.join(root, 'state_1.sqlite'));
  db.exec('CREATE TABLE threads(rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES(?)').run(path.join(root, 'outside.jsonl')); db.close();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await sweep(); expect(await fs.readFile(saved!.path, 'utf8')).toBe(file.data);
});
