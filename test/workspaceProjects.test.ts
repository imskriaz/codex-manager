import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureSqliteStateStore, SqliteStateStore } from '../src/storage/sqliteState';
import { browseWorkspaceFolders, createWorkspaceProject, readWorkspaceProjects } from '../src/services/workspaceProjects';
import { removeTestDirectory } from './testFilesystem';

let root: string, store: SqliteStateStore;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'manager-projects-'));
  store = await SqliteStateStore.open(path.join(root, 'manager.sqlite'));
  configureSqliteStateStore(store);
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); configureSqliteStateStore(undefined); store.close(); await removeTestDirectory(root); });

it('creates and remembers a named folder across storage reopen without changing existing files', async () => {
  await fs.writeFile(path.join(root, 'keep.txt'), 'kept');
  const project = await createWorkspaceProject('My project', root);
  expect(project).toEqual({ id: path.join(root, 'My project'), label: 'My project', path: path.join(root, 'My project') });
  expect((await fs.stat(project.path)).isDirectory()).toBe(true);
  configureSqliteStateStore(undefined); store.close(); store = await SqliteStateStore.open(path.join(root, 'manager.sqlite')); configureSqliteStateStore(store);
  expect(readWorkspaceProjects()).toEqual([project]);
  expect(await fs.readFile(path.join(root, 'keep.txt'), 'utf8')).toBe('kept');
});
it.each(['', '.', '..', '../escape', 'a/b', 'a\\b', 'CON', 'nul.txt', 'trailing.', ' space', 'bad:name', 'x'.repeat(121), null, 10])('rejects invalid names: %s', async name => {
  await expect(createWorkspaceProject(name, root)).rejects.toThrow('project name');
  expect(readWorkspaceProjects()).toEqual([]);
});
it.each(['', 'relative/path', null, 12])('rejects a non-absolute parent: %s', async folder => {
  await expect(createWorkspaceProject('new', folder)).rejects.toThrow('absolute parent');
});
it('rejects missing parents, files and duplicate destinations without adopting them', async () => {
  await expect(createWorkspaceProject('new', path.join(root, 'missing'))).rejects.toThrow();
  const file = path.join(root, 'existing'); await fs.writeFile(file, 'kept');
  await expect(createWorkspaceProject('new', file)).rejects.toThrow();
  await expect(createWorkspaceProject('existing', root)).rejects.toThrow('already exists');
  expect(await fs.readFile(file, 'utf8')).toBe('kept'); expect(readWorkspaceProjects()).toEqual([]);
});
it('allows only one concurrent creation of a folder', async () => {
  const results = await Promise.allSettled([createWorkspaceProject('duplicate', root), createWorkspaceProject('duplicate', root)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(readWorkspaceProjects()).toHaveLength(1);
});
it.each(['ENOSPC', 'EACCES'])('retains the error and saves no project when mkdir fails: %s', async code => {
  vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(Object.assign(new Error(code), { code }));
  await expect(createWorkspaceProject('new', root)).rejects.toThrow(code); expect(readWorkspaceProjects()).toEqual([]);
});
it('leaves the created folder intact and reports its location if saving fails', async () => {
  vi.spyOn(store, 'set').mockImplementationOnce(() => { throw new Error('Storage full'); });
  await expect(createWorkspaceProject('retained', root)).rejects.toThrow(`folder was created at ${path.join(root, 'retained')}`);
  expect((await fs.stat(path.join(root, 'retained'))).isDirectory()).toBe(true);
});
it('refuses missing storage and a full registry before creating a folder', async () => {
  configureSqliteStateStore(undefined); await expect(createWorkspaceProject('new', root)).rejects.toThrow('No folder was created');
  configureSqliteStateStore(store);
  vi.spyOn(store, 'keys').mockReturnValue(Array.from({ length: 200 }, (_, index) => String(index)));
  await expect(createWorkspaceProject('new', root)).rejects.toThrow('list is full');
  await expect(fs.stat(path.join(root, 'new'))).rejects.toThrow();
});

it('browses only folders with a canonical parent and never creates or registers anything', async () => {
  await fs.mkdir(path.join(root, 'child')); await fs.writeFile(path.join(root, 'file.txt'), 'keep');
  const listing = await browseWorkspaceFolders(root);
  expect(listing.path).toBe(await fs.realpath(root)); expect(listing.parent).toBe(path.dirname(await fs.realpath(root)));
  expect(listing.folders).toEqual([{ name: 'child', path: path.join(await fs.realpath(root), 'child') }]);
  expect(readWorkspaceProjects()).toEqual([]);
});
it.each(['relative', 12, null, 'bad\0path'])('rejects invalid browse paths: %s', async value => {
  await expect(browseWorkspaceFolders(value)).rejects.toThrow('absolute folder');
});
it('preserves missing-folder and permission errors without falling back to another folder', async () => {
  await expect(browseWorkspaceFolders(path.join(root, 'missing'))).rejects.toThrow();
  vi.spyOn(fs, 'opendir').mockRejectedValueOnce(new Error('EACCES'));
  await expect(browseWorkspaceFolders(root)).rejects.toThrow('EACCES');
});
it('bounds large folder listings and tells users when the list is partial', async () => {
  await Promise.all(Array.from({ length: 201 }, (_, i) => fs.mkdir(path.join(root, `folder-${i}`))));
  const listing = await browseWorkspaceFolders(root);
  expect(listing.folders).toHaveLength(200); expect(listing.warning).toContain('200');
});
