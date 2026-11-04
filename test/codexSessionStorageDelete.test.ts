import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStateStore, configureSqliteStateStore } from '../src/storage/sqliteState';
import { deleteCodexSessionFromStorage } from '../src/services/codexSessionStorageDelete';
import { removeTestDirectory } from './testFilesystem';
let home: string, db: DatabaseSync, store: SqliteStateStore, file: string;
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'codex-direct-delete-'));
  await mkdir(path.join(home, 'archived_sessions'));
  file = path.join(home, 'archived_sessions', `rollout-${id}.jsonl`);
  await writeFile(file, 'saved transcript');
  db = new DatabaseSync(path.join(home, 'state_1.sqlite'));
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, archived INTEGER); CREATE TABLE thread_attachments(thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT); CREATE TABLE thread_read_receipts(thread_id TEXT);');
  db.prepare('INSERT INTO threads VALUES(?,?,1)').run(id, file);
  db.prepare('INSERT INTO thread_attachments VALUES(?)').run(id);
  db.prepare('INSERT INTO thread_read_receipts VALUES(?)').run(id);
  const goals = new DatabaseSync(path.join(home, 'goals_1.sqlite')); goals.exec('CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY, objective TEXT)'); goals.prepare('INSERT INTO thread_goals VALUES(?,?)').run(id, 'Finish task'); goals.close();
  store = await SqliteStateStore.open(path.join(home, 'manager.sqlite')); configureSqliteStateStore(store);
});
afterEach(async () => { vi.restoreAllMocks(); configureSqliteStateStore(undefined); store?.close(); db?.close(); await removeTestDirectory(home); });
it('deletes the native row and dependent data, removes its transcript, and tolerates retry', async () => {
  expect(await deleteCodexSessionFromStorage(home, id, true)).toBe(true);
  for (const name of ['threads', 'thread_attachments', 'thread_read_receipts']) expect(db.prepare(`SELECT * FROM ${name}`).all()).toEqual([]);
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await deleteCodexSessionFromStorage(home, id, true)).toBe(false);
  expect(store.keys('session-file-cleanup')).toEqual([]);
  const goals = new DatabaseSync(path.join(home, 'goals_1.sqlite')); expect(goals.prepare('SELECT * FROM thread_goals').all()).toEqual([]); goals.close();
});
it.each(['active', 'child', 'outside', 'storage-full', 'busy'])('keeps conversation data on %s', async scenario => {
  if (scenario === 'active') db.prepare('UPDATE threads SET archived=0').run();
  if (scenario === 'child') { const child = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; db.prepare('INSERT INTO threads VALUES(?,?,1)').run(child, file); db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?,?)').run(id, child, 'completed'); }
  if (scenario === 'outside') db.prepare('UPDATE threads SET rollout_path=?').run(path.join(home, `rollout-${id}.jsonl`));
  if (scenario === 'storage-full') vi.spyOn(store, 'set').mockImplementation(() => { throw new Error('Storage full'); });
  if (scenario === 'busy') db.exec('BEGIN IMMEDIATE');
  try { await expect(deleteCodexSessionFromStorage(home, id, true)).rejects.toThrow(); }
  finally { if (scenario === 'busy') db.exec('ROLLBACK'); }
  expect(db.prepare('SELECT id FROM threads WHERE id=?').get(id)).toBeDefined();
  expect((await stat(file)).size).toBeGreaterThan(0);
});
it('retains a durable cleanup record when bookkeeping fails after deletion, then finishes after restart', async () => {
  const original = store.set.bind(store);
  vi.spyOn(store, 'set').mockImplementation((namespace, key, value) => { if (namespace === 'deleted-codex-sessions') throw new Error('Storage full'); original(namespace, key, value); });
  await expect(deleteCodexSessionFromStorage(home, id, true)).rejects.toThrow('Storage full');
  expect(db.prepare('SELECT id FROM threads WHERE id=?').get(id)).toBeUndefined();
  expect(store.keys('session-file-cleanup')).toHaveLength(1);
  vi.restoreAllMocks(); store.close(); store = await SqliteStateStore.open(path.join(home, 'manager.sqlite')); configureSqliteStateStore(store);
  expect(await deleteCodexSessionFromStorage(home, id, true)).toBe(true);
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(store.keys('session-file-cleanup')).toEqual([]);
});
it('does not delete a replaced transcript during a cleanup retry', async () => {
  const original = store.set.bind(store);
  vi.spyOn(store, 'set').mockImplementation((namespace, key, value) => { if (namespace === 'deleted-codex-sessions') throw new Error('Storage full'); original(namespace, key, value); });
  await expect(deleteCodexSessionFromStorage(home, id, true)).rejects.toThrow();
  vi.restoreAllMocks(); await writeFile(file, 'new writer data must be kept');
  await expect(deleteCodexSessionFromStorage(home, id, true)).rejects.toThrow('transcript changed');
  expect((await stat(file)).size).toBe(28);
});
