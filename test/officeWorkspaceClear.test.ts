import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteStateStore, configureSqliteStateStore } from '../src/storage/sqliteState';
import { configureCrossWindowOperationCoordinator } from '../src/utils/crossWindowOperations';
import { clearOfficeWorkspace } from '../src/services/officeWorkspaceClear';
import type { OfficeUser } from '../src/services/officeUsers';
import { removeTestDirectory } from './testFilesystem';

let root: string, database: SqliteStateStore, user: OfficeUser;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-clear-'));
  database = await SqliteStateStore.open(path.join(root, 'state.sqlite')); configureSqliteStateStore(database);
  await configureCrossWindowOperationCoordinator(root);
  user = { id: 'alex', username: 'alex@example.test', role: 'user', enabled: true, features: ['generalChat', 'files'], workspacePath: path.join(root, 'alex') } as OfficeUser;
  await fs.mkdir(user.workspacePath);
});
afterEach(async () => { vi.restoreAllMocks(); configureSqliteStateStore(undefined); database.close(); await removeTestDirectory(root); });
const session = (id = 'chat', owner = user.id, turns: unknown[] = []) => database.set(`office-sessions:${owner}`, id, { owner, turns, title: id });
async function write(file: string) { const target = path.join(user.workspacePath, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, 'saved contents'); return target; }
async function clear(kind: 'chats' | 'files') { const preview = await clearOfficeWorkspace(user, { kind }, true); return clearOfficeWorkspace(user, { ...preview, confirmed: true }); }

it('previews without deletion, requires explicit confirmation, and clears only this owner’s chat records', async () => {
  session(); session('retained'); session('other-chat', 'other');
  database.set(`office-session-requests:${user.id}`, 'request', 'chat'); database.set(`office-session-revisions:${user.id}`, 'chat', 1);
  const file = await write('project/result.txt');
  const preview = await clearOfficeWorkspace(user, { kind: 'chats' }, true);
  expect(preview.count).toBe(2); expect(database.keys(`office-sessions:${user.id}`)).toHaveLength(2);
  await expect(clearOfficeWorkspace(user, preview)).rejects.toThrow('confirm');
  await expect(clearOfficeWorkspace({ ...user, role: 'admin' }, { ...preview, confirmed: true })).rejects.toThrow('unavailable');
  await clearOfficeWorkspace(user, { ...preview, confirmed: true });
  for (const ns of ['office-sessions', 'office-session-requests', 'office-session-revisions']) expect(database.keys(`${ns}:${user.id}`)).toEqual([]);
  expect(database.keys('office-sessions:other')).toEqual(['other-chat']); expect(await fs.readFile(file, 'utf8')).toBe('saved contents');
});
it.each(['queued', 'waiting', 'working'])('refuses to clear chats or files while work is %s', async state => {
  session('chat', user.id, [{ state }]); const file = await write('keep.txt');
  for (const kind of ['chats', 'files']) await expect(clearOfficeWorkspace(user, { kind }, true)).rejects.toThrow('Stop running and queued');
  expect(await fs.readFile(file, 'utf8')).toBe('saved contents');
});
it('refuses a live lease and stale confirmations without deleting anything', async () => {
  session('chat', user.id, [{ state: 'cancelled', leaseUntil: Date.now() + 30000 }]);
  await expect(clearOfficeWorkspace(user, { kind: 'chats' }, true)).rejects.toThrow('Stop running');
  session(); const preview = await clearOfficeWorkspace(user, { kind: 'chats' }, true); session('new-chat');
  await expect(clearOfficeWorkspace(user, { ...preview, confirmed: true })).rejects.toThrow('changed');
  expect(database.keys(`office-sessions:${user.id}`)).toHaveLength(2);
});
it('clears uploads, project files, saved versions and Trash while preserving chats, folders and other users', async () => {
  session(); const targets = await Promise.all(['project/result.txt', 'uploads/input.txt', '.workspace-history/version', '.workspace-trash/removed'].map(write));
  database.set('office-file-history:alex', 'version', { path: 'project/result.txt' });
  await fs.writeFile(path.join(root, 'other-user.txt'), 'private');
  expect((await clear('files')).count).toBe(4);
  for (const target of targets) await expect(fs.stat(target)).rejects.toThrow();
  expect(await fs.stat(path.join(user.workspacePath, 'project'))).toBeDefined();
  expect(database.keys('office-file-history:alex')).toEqual([]); expect(database.keys('office-sessions:alex')).toEqual(['chat']);
  expect(await fs.readFile(path.join(root, 'other-user.txt'), 'utf8')).toBe('private');
});
it('rejects changed files and linked directories without following them', async () => {
  const file = await write('keep.txt'), preview = await clearOfficeWorkspace(user, { kind: 'files' }, true);
  await fs.writeFile(file, 'changed');
  await expect(clearOfficeWorkspace(user, { ...preview, confirmed: true })).rejects.toThrow('changed');
  const outside = path.join(root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'private.txt'), 'private');
  await fs.symlink(outside, path.join(user.workspacePath, 'linked'), 'junction');
  await expect(clearOfficeWorkspace(user, { kind: 'files' }, true)).rejects.toThrow('Linked');
  expect(await fs.readFile(file, 'utf8')).toBe('changed'); expect(await fs.readFile(path.join(outside, 'private.txt'), 'utf8')).toBe('private');
});
it('reports partial file deletion and permits a fresh preview after a failure', async () => {
  const first = await write('a.txt'), second = await write('b.txt');
  const unlink = fs.unlink;
  vi.spyOn(fs, 'unlink').mockImplementationOnce(unlink).mockRejectedValueOnce(new Error('File is busy.'));
  await expect(clear('files')).rejects.toThrow('1 of 2 files permanently deleted. File is busy.');
  await expect(fs.stat(first)).rejects.toThrow(); expect(await fs.readFile(second, 'utf8')).toBe('saved contents');
  expect((await clearOfficeWorkspace(user, { kind: 'files' }, true)).count).toBe(1);
});
