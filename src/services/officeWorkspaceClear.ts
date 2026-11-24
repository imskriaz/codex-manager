import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getSqliteStateStore } from '../storage/sqliteState';
import { runCrossWindowExclusive } from '../utils/crossWindowOperations';
import { waitWithin } from '../utils/concurrency';
import type { OfficeUser } from './officeUsers';
import { userWorkspaceNotice } from '../domain/teamWorkspacePresentation';

type Kind = 'chats' | 'files';
type Session = { owner: string; turns: Array<{ state: string; leaseUntil?: number }> };
const stamp = (stat: Awaited<ReturnType<typeof fs.lstat>>) => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
const revision = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
function store() { const value = getSqliteStateStore(); if (!value) throw new Error('Workspace storage is unavailable. Please try again.'); return value; }
function sessions(user: OfficeUser) {
  const rows = store().entries<Session>(`office-sessions:${user.id}`);
  if (rows.some(([, session]) => session.owner !== user.id)) throw new Error('Conversation ownership could not be verified. Nothing was cleared.');
  if (rows.some(([, session]) => session.turns.some(turn => ['queued', 'waiting', 'working'].includes(turn.state) || (turn.leaseUntil ?? 0) > Date.now()))) throw new Error('Stop running and queued chats before clearing workspace data.');
  return rows;
}
async function files(user: OfficeUser, deadline: number) {
  const bounded = <T>(work: Promise<T>) => waitWithin(work, Math.max(1, deadline - Date.now()), 'Checking files timed out. Nothing was cleared.');
  const rootStat = await bounded(fs.lstat(user.workspacePath));
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Linked workspace storage cannot be cleared.');
  const root = await bounded(fs.realpath(user.workspacePath));
  if (root === path.parse(root).root) throw new Error('The filesystem root cannot be cleared.');
  const pending = [root], entries: Array<{ file: string; stamp: string }> = [];
  let count = 0;
  while (pending.length) {
    const folder = pending.pop()!;
    for (const name of await bounded(fs.readdir(folder))) {
      if (++count > 20000 || Date.now() >= deadline) throw new Error('There are too many files to clear at once. Remove smaller folders first.');
      const file = path.resolve(folder, name), relative = path.relative(root, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Workspace access denied.');
      const stat = await bounded(fs.lstat(file));
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1 || !stat.isDirectory() && !stat.isFile()) throw new Error('Linked or special files cannot be cleared. Nothing was cleared.');
      if (stat.isDirectory()) pending.push(file);
      else entries.push({ file, stamp: stamp(stat) });
    }
  }
  entries.sort((a, b) => a.file.localeCompare(b.file));
  return { root, entries };
}

/** Preview and deletion use the same user storage lock as uploads and accepted chat messages. */
export async function clearOfficeWorkspace(user: OfficeUser, input: Record<string, unknown>, preview = false) {
  const kind = input['kind'];
  if (!user.enabled || user.role !== 'user' || kind !== 'chats' && kind !== 'files' || kind === 'files' && !user.features.includes('files') || kind === 'chats' && !user.features.some(feature => feature === 'generalChat' || feature === 'tasks')) throw new Error('This clear action is unavailable in your workspace.');
  if (!preview && (input['confirmed'] !== true || typeof input['revision'] !== 'string')) throw new Error('Review and confirm what to clear first.');
  return runCrossWindowExclusive(`office-storage:${user.id}`, 'Clear workspace data', async () => {
    const deadline = Date.now() + 8000;
    const rows = sessions(user);
    const snapshot = kind === 'files' ? await files(user, deadline) : undefined;
    const currentRevision = revision([user.id, kind, snapshot ?? rows]);
    const count = snapshot ? snapshot.entries.length : rows.length;
    if (preview) return { kind: kind as Kind, count, revision: currentRevision };
    if (input['revision'] !== currentRevision) throw new Error('Your workspace changed. Review the clear action again before deleting.');
    if (kind === 'chats') {
      store().transaction(() => {
        if (revision([user.id, kind, sessions(user)]) !== currentRevision) throw new Error('Your chats changed. Review the clear action again.');
        for (const name of ['office-sessions', 'office-session-requests', 'office-session-revisions']) {
          const ns = `${name}:${user.id}`;
          for (const key of store().keys(ns)) store().set(ns, key, undefined);
        }
        const ns = `office-preferences:${user.id}`;
        store().set(ns, 'email-watches', undefined);
      });
    } else {
      let removed = 0;
      try {
        // Check every path again before deleting; unlink never recursively follows a folder or link.
        const checked = await files(user, deadline);
        if (revision([user.id, kind, checked]) !== currentRevision) throw new Error('Your files changed. Review the clear action again.');
        sessions(user);
        for (const entry of checked.entries) {
          if (Date.now() >= deadline) throw new Error('Clearing files reached its time limit.');
          if (await fs.realpath(path.dirname(entry.file)) !== path.dirname(entry.file)) throw new Error('Linked file storage cannot be cleared.');
          const stat = await fs.lstat(entry.file);
          if (!stat.isFile() || stat.nlink > 1 || stamp(stat) !== entry.stamp) throw new Error('A file changed while clearing.');
          await fs.unlink(entry.file); removed++;
        }
        const ns = `office-file-history:${user.id}`;
        for (const key of store().keys(ns)) store().set(ns, key, undefined);
      } catch (error) {
        throw new Error(`${removed} of ${count} files permanently deleted. ${userWorkspaceNotice(error instanceof Error ? error.message : 'Clearing could not be completed.')} Refresh Library and review before retrying.`);
      }
    }
    return { kind: kind as Kind, count, revision: currentRevision, message: `${count} ${count === 1 ? kind.slice(0, -1) : kind} permanently deleted.` };
  }, { waitMs: 1000 });
}
