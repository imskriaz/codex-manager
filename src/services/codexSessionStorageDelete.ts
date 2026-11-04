import * as fs from 'node:fs/promises';
import path from 'node:path';
import { getCodexHomeStateKey } from '../codex/authFile';
import { getSqliteStateStore } from '../storage/sqliteState';
import { removeDeletedSessionCache } from '../storage/sqliteSessions';

type Cleanup = { path: string; size: number; mtimeMs: number; ino: number };
type Database = { exec(sql: string): void; prepare(sql: string): { all(...args: string[]): Record<string, unknown>[]; get(...args: string[]): Record<string, unknown> | undefined; run(...args: string[]): unknown }; close(): void };

/** Bulk cleanup uses native SQLite transactions and retains unfinished file cleanup across restarts. */
export async function deleteCodexSessionFromStorage(home: string, id: string, archivedOnly: boolean): Promise<boolean> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error('Invalid session identifier.');
  const names = (await fs.readdir(home)).filter(name => /^state_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
  if (!names[0]) return false;
  const file = path.join(home, names[0]), info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Session database is not a regular file. Conversations were kept.');
  const store = getSqliteStateStore();
  if (!store) throw new Error('Cleanup storage is unavailable. Conversations were kept.');
  const key = `${getCodexHomeStateKey(home)}:${id.toLowerCase()}`;
  let cleanup = store.get<Cleanup>('session-file-cleanup', key);
  const moduleName = 'node:sqlite';
  const sqlite = await import(moduleName) as { DatabaseSync: new (file: string, options: { readOnly: boolean }) => Database };
  const db = new sqlite.DatabaseSync(file, { readOnly: false });
  const startedAt = Date.now();
  let removed = false;
  const safePath = async (candidate: string): Promise<string> => {
    const root = await fs.realpath(home), resolved = path.resolve(candidate);
    const relative = path.relative(root, resolved);
    if (!/^(?:sessions|archived_sessions)[\\/]/.test(relative) || relative.split(/[\\/]/).includes('..') || !path.basename(resolved).includes(id) || !resolved.endsWith('.jsonl')) throw new Error('Transcript path is outside session storage. Conversation was kept.');
    const parent = await fs.realpath(path.dirname(resolved)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (parent && path.relative(root, parent) !== path.dirname(relative)) throw new Error('Transcript directory changed. Conversation was kept.');
    return resolved;
  };
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000');
    const goalFiles = (await fs.readdir(home)).filter(name => /^goals_\d+\.sqlite$/.test(name)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    let goals = false;
    if (goalFiles[0]) {
      const goalFile = path.join(home, goalFiles[0]), info = await fs.lstat(goalFile);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Goal storage changed. Conversation was kept.');
      db.prepare('ATTACH DATABASE ? AS goal_cleanup').run(goalFile);
      goals = Boolean(db.prepare("SELECT 1 FROM goal_cleanup.sqlite_master WHERE type='table' AND name='thread_goals'").get());
    }
    const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row['name']));
    if (!['id', 'rollout_path', 'archived'].every(column => columns.has(column))) return false;
    const row = db.prepare('SELECT rollout_path,archived FROM threads WHERE id=?').get(id);
    if (!row && !cleanup) return false;
    removed = !row;
    if (row) {
      if (row['archived'] !== 1 && !archivedOnly) return false;
      if (archivedOnly && row['archived'] !== 1) throw new Error('This conversation is no longer archived. It was kept.');
      if (typeof row['rollout_path'] !== 'string') throw new Error('Transcript location is unavailable. Conversation was kept.');
      const transcript = await safePath(row['rollout_path']);
      const stat = await fs.lstat(transcript).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Transcript is not a regular file. Conversation was kept.');
      cleanup = { path: transcript, size: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0, ino: stat?.ino ?? 0 };
      store.set('session-file-cleanup', key, cleanup);
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = db.prepare('SELECT rollout_path,archived FROM threads WHERE id=?').get(id);
        if (!current || current['rollout_path'] !== row['rollout_path'] || current['archived'] !== row['archived']) throw new Error('Conversation changed during cleanup. It was kept.');
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_spawn_edges'").get()) {
          if (db.prepare('SELECT 1 FROM thread_spawn_edges JOIN threads ON threads.id=child_thread_id WHERE parent_thread_id=? LIMIT 1').get(id)) throw new Error('Delete child conversations before their parent. This conversation was kept.');
          db.prepare('DELETE FROM thread_spawn_edges WHERE parent_thread_id=? OR child_thread_id=?').run(id, id);
        }
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_read_receipts'").get()) db.prepare('DELETE FROM thread_read_receipts WHERE thread_id=?').run(id);
        if (goals) db.prepare('DELETE FROM goal_cleanup.thread_goals WHERE thread_id=?').run(id);
        db.prepare('DELETE FROM threads WHERE id=?').run(id);
        db.exec('COMMIT');
        removed = true;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    if (!row && goals) db.prepare('DELETE FROM goal_cleanup.thread_goals WHERE thread_id=?').run(id);
    removeDeletedSessionCache(store, home, [id], undefined, startedAt, true);
    if (cleanup) {
      const transcript = await safePath(cleanup.path);
      const stat = await fs.lstat(transcript).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (stat) {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== cleanup.size || stat.mtimeMs !== cleanup.mtimeMs || stat.ino !== cleanup.ino) throw new Error('Session row was deleted, but its transcript changed. Review remaining storage before retrying.');
        await fs.unlink(transcript);
      }
    }
    store.set('session-file-cleanup', key, undefined);
    return true;
  } catch (error) {
    if (removed) throw new Error(`Conversation was deleted from the database, but cleanup is unfinished: ${error instanceof Error ? error.message : String(error)} Retry the cleanup to finish removing saved files.`);
    throw error;
  } finally { db.close(); }
}
