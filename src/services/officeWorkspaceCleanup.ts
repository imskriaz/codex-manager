import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {OfficeUser} from './officeUsers';
import {getSqliteStateStore} from '../storage/sqliteState';
import {runCrossWindowExclusive} from '../utils/crossWindowOperations';
import {readWorkspaceProjects} from './workspaceProjects';

export function officeSessionFolder(id: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('This conversation is unavailable.');
  return `.workspace-sessions/${id}`;
}

/** Only expired, explicitly deleted session folders are eligible. Saved projects never enter this tree. */
export async function cleanupOfficeDeletedSessions(user: OfficeUser, retentionDays: number, now = Date.now()): Promise<void> {
  const store = getSqliteStateStore();
  if (!store) return;
  const namespace = `office-sessions:${user.id}`;
  const cutoff = now - Math.max(1, retentionDays) * 86_400_000;
  const expired = store.keys(namespace).filter(id => {
    const session = store.get<{deletedAt?: number; owner: string}>(namespace, id);
    return session?.owner === user.id && session.deletedAt !== undefined && session.deletedAt <= cutoff;
  }).slice(0, 50);
  if (!expired.length) return;
  await runCrossWindowExclusive(`office-storage:${user.id}`, 'Clean deleted conversation storage', async () => {
    let root: string | undefined;
    try { root = await fs.realpath(user.workspacePath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const id of expired) {
      const session = store.get<{deletedAt?: number; owner: string}>(namespace, id);
      if (session?.owner !== user.id || session.deletedAt === undefined || session.deletedAt > cutoff) continue;
      if (root) {
        const target = path.resolve(root, officeSessionFolder(id));
        if (!target.startsWith(root + path.sep)) throw new Error('Conversation storage access denied.');
        if (readWorkspaceProjects(`office-projects:${user.id}`).some(project => {
          const relative = path.relative(target, path.resolve(project.path));
          return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative);
        })) throw new Error('A saved project overlaps conversation storage. Cleanup was deferred.');
        try {
          for (const current of [path.dirname(target), target]) {
            const stat = await fs.lstat(current);
            if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Linked conversation storage cannot be removed.');
          }
          if (await fs.realpath(target) !== target) throw new Error('Conversation storage access denied.');
          await fs.rm(target, {recursive: true, force: true});
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      store.transaction(() => {
        store.set(namespace, id, undefined);
        store.set(`office-session-revisions:${user.id}`, id, undefined);
        for (const key of store.keys(`office-session-requests:${user.id}`)) {
          if (store.get<string>(`office-session-requests:${user.id}`, key) === id) store.set(`office-session-requests:${user.id}`, key, undefined);
        }
      });
    }
  }, {waitMs: 100});
}
