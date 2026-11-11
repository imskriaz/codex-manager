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
it.each(['.', '..', '../escape', 'a/b', 'a\\b', 'CON', 'nul.txt', 'trailing.', ' space', 'bad:name', 'x'.repeat(121), null, 10])('rejects invalid names: %s', async name => {
  await expect(createWorkspaceProject(name, root)).rejects.toThrow('project name');
  expect(readWorkspaceProjects()).toEqual([]);
});
it.each(['', 'relative/path', null, 12])('rejects a non-absolute parent: %s', async folder => {
  await expect(createWorkspaceProject('new', folder)).rejects.toThrow('absolute parent');
});
it('rejects missing parents and file destinations without changing them', async () => {
  await expect(createWorkspaceProject('new', path.join(root, 'missing'))).rejects.toThrow();
  const file = path.join(root, 'existing'); await fs.writeFile(file, 'kept');
  await expect(createWorkspaceProject('new', file)).rejects.toThrow();
  await expect(createWorkspaceProject('existing', root)).rejects.toThrow('already exists');
  expect(await fs.readFile(file, 'utf8')).toBe('kept'); expect(readWorkspaceProjects()).toEqual([]);
});
it('reuses the same folder for concurrent creation requests', async () => {
  const results = await Promise.allSettled([createWorkspaceProject('duplicate', root), createWorkspaceProject('duplicate', root)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2); expect(readWorkspaceProjects()).toHaveLength(1);
});
it.each(['', undefined])('registers the selected folder without creating a child when the name is %s', async name => {
  await fs.writeFile(path.join(root, 'keep.txt'), 'kept');
  const mkdir = vi.spyOn(fs, 'mkdir');
  const project = await createWorkspaceProject(name, root);
  expect(project).toEqual({ id: await fs.realpath(root), label: path.basename(root), path: await fs.realpath(root) });
  expect(mkdir).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(root, 'keep.txt'), 'utf8')).toBe('kept');
  expect(readWorkspaceProjects()).toEqual([project]);
});
it('adopts an existing named folder and deduplicates direct selection after reopening storage', async () => {
  const target = path.join(root, 'existing'); await fs.mkdir(target); await fs.writeFile(path.join(target, 'keep.txt'), 'kept');
  const project = await createWorkspaceProject('existing', root);
  configureSqliteStateStore(undefined); store.close(); store = await SqliteStateStore.open(path.join(root, 'manager.sqlite')); configureSqliteStateStore(store);
  expect(await createWorkspaceProject('', target)).toEqual(project);
  expect(await createWorkspaceProject('existing', root)).toEqual(project);
  expect(readWorkspaceProjects()).toEqual([project]);
  expect(await fs.readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('kept');
});
it.each(['ENOSPC', 'EACCES'])('retains the error and saves no project when mkdir fails: %s', async code => {
  vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(Object.assign(new Error(code), { code }));
  await expect(createWorkspaceProject('new', root)).rejects.toThrow(code); expect(readWorkspaceProjects()).toEqual([]);
});
it('leaves the created folder intact and reports its location if saving fails', async () => {
  vi.spyOn(store, 'set').mockImplementationOnce(() => { throw new Error('Storage full'); });
  await expect(createWorkspaceProject('retained', root)).rejects.toThrow(`folder was created at ${path.join(root, 'retained')}`);
  expect((await fs.stat(path.join(root, 'retained'))).isDirectory()).toBe(true);
  expect(await createWorkspaceProject('retained', root)).toEqual(expect.objectContaining({ path: path.join(root, 'retained') }));
  expect(readWorkspaceProjects()).toHaveLength(1);
});
it('reports existing-folder save failures accurately and permits retry', async () => {
  await fs.writeFile(path.join(root, 'keep.txt'), 'kept');
  vi.spyOn(store, 'set').mockImplementationOnce(() => { throw new Error('Storage full'); });
  await expect(createWorkspaceProject('', root)).rejects.toThrow(`existing folder is unchanged at ${root}`);
  expect(readWorkspaceProjects()).toEqual([]);
  expect(await createWorkspaceProject('', root)).toEqual(expect.objectContaining({ path: root }));
  expect(await fs.readFile(path.join(root, 'keep.txt'), 'utf8')).toBe('kept');
});
it('allows a saved project at capacity but refuses a new existing-folder registration', async () => {
  const project = await createWorkspaceProject('saved', root);
  vi.spyOn(store, 'keys').mockReturnValue(Array.from({ length: 200 }, (_, index) => String(index)));
  expect(await createWorkspaceProject('', project.path)).toEqual(project);
  await expect(createWorkspaceProject('', root)).rejects.toThrow('list is full');
});
it.each(['ENOENT', 'EACCES'])('does not register an existing folder if its final validation fails: %s', async code => {
  const stat = fs.stat.bind(fs);
  vi.spyOn(fs, 'stat').mockImplementationOnce(stat).mockRejectedValueOnce(Object.assign(new Error(code), { code }));
  await expect(createWorkspaceProject('', root)).rejects.toThrow(code);
  expect(readWorkspaceProjects()).toEqual([]);
});
it('times out an unresponsive destination without registering it', async () => {
  vi.spyOn(fs, 'stat').mockResolvedValueOnce(await fs.stat(root));
  vi.spyOn(fs, 'realpath').mockResolvedValueOnce(root).mockImplementationOnce(() => new Promise(() => {}));
  vi.useFakeTimers();
  const result = expect(createWorkspaceProject('', root)).rejects.toThrow('project folder did not respond');
  await vi.advanceTimersByTimeAsync(5_000); await result;
  expect(readWorkspaceProjects()).toEqual([]);
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
