import { createHash, randomBytes } from 'crypto';
import * as path from 'path';
import { publishDashboardRealtime } from './dashboardRealtime';
import { getSqliteStateStore, type SqliteStateStore } from '../storage/sqliteState';
import type { ProjectTask, ProjectComment, ProjectTaskMutation, ProjectBoard, ProjectSharePermission } from '../domain/projectTasks';
import { sessionTaskStage, projectTaskStages, PROJECT_SHARE_FEATURES } from '../domain/projectTasks';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function projectTaskKey(project: string): string {
  const resolved = path.resolve(project);
  return digest(process.platform === 'win32' ? resolved.toLowerCase() : resolved);
}
function storage(): SqliteStateStore {
  const store = getSqliteStateStore();
  if (!store) throw new Error('Project storage is unavailable. Your draft was kept; reconnect and retry.');
  return store;
}
const initialized = new WeakSet<SqliteStateStore>();
const imported = new WeakMap<SqliteStateStore, Map<string, string>>();
function projectStorage(project: string): { store: SqliteStateStore; key: string } {
  const store = storage(), key = projectTaskKey(project);
  if (!initialized.has(store)) {
    store.database.exec(`CREATE TABLE IF NOT EXISTS project_tasks (
      project TEXT NOT NULL,id TEXT NOT NULL,parent_id TEXT,source TEXT,updated_at REAL NOT NULL,data TEXT NOT NULL,
      PRIMARY KEY(project,id), UNIQUE(project,source));
      CREATE INDEX IF NOT EXISTS project_task_parent ON project_tasks(project,parent_id,updated_at DESC);
      CREATE TABLE IF NOT EXISTS project_comments (
      project TEXT NOT NULL,id TEXT NOT NULL,task_id TEXT NOT NULL,created_at REAL NOT NULL,data TEXT NOT NULL,PRIMARY KEY(project,id));
      CREATE INDEX IF NOT EXISTS project_comment_task ON project_comments(project,task_id,created_at);`);
    store.watchTable('project_tasks', 'state'); store.watchTable('project_comments', 'state');
    for (const table of ['project_tasks','project_comments']) for (const operation of ['INSERT','UPDATE','DELETE']) {
      const row = operation === 'DELETE' ? 'OLD' : 'NEW';
      store.database.exec(`CREATE TRIGGER IF NOT EXISTS manager_${table}_project_${operation} AFTER ${operation} ON ${table}
        BEGIN INSERT INTO manager_revisions(topic,revision) VALUES('project:'||${row}.project,1)
        ON CONFLICT(topic) DO UPDATE SET revision=revision+1; END`);
    }
    initialized.add(store);
  }
  if (!store.get('project-migrations', key)) store.transaction(() => {
    for (const task of store.recent<ProjectTask>(`project:${key}:tasks`, 500)) putTask(store, key, task);
    for (const comment of store.recent<ProjectComment>(`project:${key}:comments`, 2000))
      store.prepare('INSERT OR IGNORE INTO project_comments VALUES(?,?,?,?,?)').run(key, comment.id, comment.taskId, comment.createdAt, JSON.stringify(comment));
    store.set('project-migrations', key, true);
  });
  return { store, key };
}
function identifier(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(id)) throw new Error('The task identifier is invalid.');
}
function getTask(store: SqliteStateStore, key: string, id: string): ProjectTask | undefined {
  const row = store.prepare('SELECT data FROM project_tasks WHERE project=? AND id=?').get(key, id);
  return row ? JSON.parse(String(row['data'])) as ProjectTask : undefined;
}
function putTask(store: SqliteStateStore, key: string, task: ProjectTask): void {
  store.prepare(`INSERT INTO project_tasks VALUES(?,?,?,?,?,?) ON CONFLICT(project,id) DO UPDATE SET
    parent_id=excluded.parent_id,source=excluded.source,updated_at=excluded.updated_at,data=excluded.data WHERE data!=excluded.data`)
    .run(key, task.id, task.parentTaskId ?? null, task.sourceKey ?? null, task.updatedAt, JSON.stringify(task));
}
export function readProjectTask(project: string, id: string): ProjectTask | undefined {
  identifier(id); const { store, key } = projectStorage(project); return getTask(store, key, id);
}
export function readProjectTasks(project: string): { tasks: ProjectTask[]; comments: ProjectComment[]; revision: number } {
  const { store, key } = projectStorage(project);
  return store.transaction(() => ({
    tasks: store.prepare('SELECT data FROM project_tasks WHERE project=? ORDER BY updated_at DESC,id LIMIT 30000').all(key).map(row => JSON.parse(String(row['data'])) as ProjectTask),
    comments: store.prepare('SELECT data FROM project_comments WHERE project=? ORDER BY created_at,id LIMIT 2000').all(key).map(row => JSON.parse(String(row['data'])) as ProjectComment),
    revision: store.revision('state')
  }), 'read');
}
export function syncProjectSessions(project: string, home: string, sessions: ProjectBoard['sessions']): void {
  const { store, key } = projectStorage(project);
  const homeKey = projectTaskKey(home), importKey = `${key}:${homeKey}`;
  const fingerprint = digest(JSON.stringify(sessions.map(session => [session.id, session.title, sessionTaskStage(session), session.status, session.archived === true])));
  const previous = imported.get(store) ?? new Map<string, string>();
  if (previous.get(importKey) === fingerprint) return;
  store.transaction(() => {
    const existing = store.prepare('SELECT data FROM project_tasks WHERE project=?').all(key).map(row => JSON.parse(String(row['data'])) as ProjectTask);
    const sources = new Map(existing.filter(task => task.sourceKey).map(task => [task.sourceKey, task]));
    const legacyLinks = new Map(existing.filter(task => !task.sourceKey && task.sessionId).map(task => [task.sessionId, task]));
    let count = existing.length;
    for (const session of sessions) {
      const sourceKey = `${homeKey}:${session.id.toLowerCase()}`;
      const current = sources.get(sourceKey) ?? legacyLinks.get(session.id);
      if (!current && ++count > 30000) throw new Error('Project task storage is full. Saved tasks were preserved.');
      const stage = session.status === 'unknown' && current ? current.stage : sessionTaskStage(session);
      const title = session.title;
      if (current?.sourceKey === sourceKey && current.title === title && current.stage === stage && current.sessionArchived === (session.archived === true)) continue;
      const next: ProjectTask = { ...current, id: current?.id ?? `session:${digest(sourceKey).slice(0, 16)}:${session.id}`, title,
        prompt: current?.prompt ?? '', sessionId: session.id, sourceKey, sourceHome: home, stage, sessionArchived: session.archived === true, revision: (current?.revision ?? 0) + 1,
        createdAt: current?.createdAt ?? Date.now(), updatedAt: Date.now() };
      putTask(store, key, next);
    }
  });
  if (previous.size >= 64) previous.delete(previous.keys().next().value!);
  previous.set(importKey, fingerprint); imported.set(store, previous);
}
export function saveProjectTask(project: string, input: ProjectTaskMutation): ProjectTask {
  identifier(input?.id);
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 240 ||
      typeof input.prompt !== 'string' || input.prompt.length > 32_000 || !['idea','planned','running','completed'].includes(input.stage) ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error('Enter a title and keep the task prompt under 32,000 characters.');
  if (input.parentTaskId !== undefined && input.parentTaskId !== null) identifier(input.parentTaskId);
  const { store, key } = projectStorage(project);
  const task = store.transaction(() => {
    const current = getTask(store, key, input.id);
    const parentTaskId = input.parentTaskId === null ? undefined : input.parentTaskId ?? current?.parentTaskId;
    if (current && current.revision === input.expectedRevision + 1 && current.title === input.title.trim() && current.prompt === input.prompt && current.stage === input.stage && current.parentTaskId === parentTaskId) return current;
    if ((current?.revision ?? 0) !== input.expectedRevision) throw new Error('This task changed in another browser. Your draft was kept; refresh and review it before saving.');
    if (!current && input.id.startsWith('session:')) throw new Error('Session tasks are created by discovery. Refresh the project first.');
    if (!current && Number(store.prepare('SELECT COUNT(*) AS n FROM project_tasks WHERE project=? AND source IS NULL').get(key)?.['n']) >= 500) throw new Error('This project already has 500 custom tasks. Project task storage is full.');
    if (current?.launchPending) throw new Error('Task startup is unconfirmed. Check the session list before changing this task.');
    if (current?.sourceKey && (input.title !== current.title || input.prompt !== current.prompt || input.stage !== current.stage)) throw new Error('Session titles and state are managed in the conversation. Only task grouping can be changed here.');
    if (!current?.sessionId && input.stage === 'running') throw new Error('Start the task in Codex to mark it running.');
    let ancestor = parentTaskId;
    const seen = new Set([input.id]);
    while (ancestor) {
      if (seen.has(ancestor)) throw new Error('A task cannot be moved beneath itself or its descendants.');
      seen.add(ancestor);
      const parent = getTask(store, key, ancestor);
      if (!parent) throw new Error('The parent task is missing or belongs to another project.');
      ancestor = parent.parentTaskId;
    }
    if (input.stage === 'completed' && current?.stage !== 'completed') {
      const descendants = store.prepare(`WITH RECURSIVE children(id,data) AS (SELECT id,data FROM project_tasks WHERE project=? AND parent_id=? UNION ALL SELECT t.id,t.data FROM project_tasks t JOIN children c ON t.parent_id=c.id WHERE t.project=?) SELECT data FROM children`).all(key, input.id, key);
      if (descendants.some(row => (JSON.parse(String(row['data'])) as { stage?: unknown }).stage !== 'completed')) throw new Error('Complete unfinished subtasks before completing this parent.');
    }
    const task: ProjectTask = { ...current, id: input.id, title: input.title.trim(), prompt: input.prompt, stage: input.stage, parentTaskId,
      revision: (current?.revision ?? 0) + 1, createdAt: current?.createdAt ?? Date.now(), updatedAt: Date.now() };
    putTask(store, key, task); return task;
  });
  publishDashboardRealtime({ type: 'dashboard:project-changed', projectPath: project });
  return task;
}
export function addProjectComment(project: string, input: { id: string; taskId: string; text: string; author?: string }): ProjectComment {
  identifier(input?.id); identifier(input?.taskId);
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8000 || (input.author !== undefined && typeof input.author !== 'string')) throw new Error('Write a comment under 8,000 characters.');
  const { store, key } = projectStorage(project);
  const comment = store.transaction(() => {
    const row = store.prepare('SELECT data FROM project_comments WHERE project=? AND id=?').get(key, input.id);
    if (row) {
      const existing = JSON.parse(String(row['data'])) as ProjectComment;
      if (existing.taskId !== input.taskId || existing.text !== input.text.trim()) throw new Error('This request identifier was already used for another comment.');
      return existing;
    }
    if (!getTask(store, key, input.taskId)) throw new Error('This task is missing or belongs to another project.');
    if (Number(store.prepare('SELECT COUNT(*) AS n FROM project_comments WHERE project=?').get(key)?.['n']) >= 2000) throw new Error('Project comment storage is full. The comment was kept in your browser.');
    const comment = { id: input.id, taskId: input.taskId, text: input.text.trim(), author: (input.author || 'Owner').slice(0, 80), createdAt: Date.now() };
    store.prepare('INSERT INTO project_comments VALUES(?,?,?,?,?)').run(key, comment.id, comment.taskId, comment.createdAt, JSON.stringify(comment));
    return comment;
  });
  publishDashboardRealtime({ type: 'dashboard:project-changed', projectPath: project });
  return comment;
}
export function claimProjectTaskStart(project: string, id: string, expectedRevision: number | undefined): ProjectTask {
  identifier(id);
  const { store, key } = projectStorage(project);
  const task = store.transaction(() => {
    const task = getTask(store, key, id);
    if (!Number.isSafeInteger(expectedRevision) || task?.revision !== expectedRevision) throw new Error('This task changed. Review the latest prompt before starting it.');
    if (!task || task.stage !== 'planned' || task.sessionId || task.launchPending) throw new Error('This task already started or its startup is unconfirmed. Refresh sessions before retrying.');
    if (!task.prompt.trim()) throw new Error('Add a prompt before starting this task.');
    const next = { ...task, launchPending: true, revision: task.revision + 1, updatedAt: Date.now() };
    putTask(store, key, next); return next;
  });
  publishDashboardRealtime({ type: 'dashboard:project-changed', projectPath: project });
  return task;
}
export function resetProjectTaskStart(project: string, id: string, expectedRevision?: number): void {
  const { store, key } = projectStorage(project);
  store.transaction(() => {
    const task = readProjectTask(project, id);
    if (!task?.launchPending || task.sessionId || task.revision !== expectedRevision) throw new Error('This task does not have the reviewed unconfirmed start. Refresh before retrying.');
    putTask(store, key, { ...task, launchPending: false, revision: task.revision + 1, updatedAt: Date.now() });
  });
  publishDashboardRealtime({ type: 'dashboard:project-changed', projectPath: project });
}
export function finishProjectTaskStart(project: string, id: string, sessionId: string, home: string): void {
  const { store, key } = projectStorage(project);
  store.transaction(() => {
    const task = getTask(store, key, id);
    if (!task?.launchPending) throw new Error('Task startup could not be recorded. Check sessions before retrying.');
    const sourceKey = `${projectTaskKey(home)}:${sessionId.toLowerCase()}`;
    const existing = store.prepare('SELECT data FROM project_tasks WHERE project=? AND source=?').get(key, sourceKey);
    const child = existing ? JSON.parse(String(existing['data'])) as ProjectTask : undefined;
    putTask(store, key, { ...child, id: child?.id ?? `session:${digest(sourceKey).slice(0,16)}:${sessionId}`, title: child?.title ?? task.title, prompt: '',
      sessionId, sourceKey, sourceHome: home, parentTaskId: id, stage: 'running', revision: (child?.revision ?? 0) + 1, createdAt: child?.createdAt ?? Date.now(), updatedAt: Date.now() });
    putTask(store, key, { ...task, launchPending: false, revision: task.revision + 1, updatedAt: Date.now() });
  });
  publishDashboardRealtime({ type: 'dashboard:project-changed', projectPath: project });
}

export type ProjectShare = { projectPath: string; expiresAt: number; permissions: ProjectSharePermission[] };
export function createProjectShare(projectPath: string, permissions: ProjectSharePermission[] = ['activities','comments','submissions'], days = 7): { token: string; expiresAt: number; permissions: ProjectSharePermission[] } {
  if (!Array.isArray(permissions) || permissions.length > PROJECT_SHARE_FEATURES.length || permissions.some(permission => !PROJECT_SHARE_FEATURES.some(feature => feature.key === permission)) || ![1,7,30].includes(days)) throw new Error('Choose valid share permissions and an expiry of 1, 7, or 30 days.');
  permissions = [...new Set(permissions)];
  // The combined Activities tab grants both parts; existing links retain their original grants.
  if (permissions.includes('activities')) permissions.push('messages');
  const store = storage(), token = randomBytes(32).toString('hex'), expiresAt = Date.now() + days * 24 * 60 * 60_000;
  store.transaction(() => {
    const records = store.keys('project-shares');
    for (const key of records) if ((store.get<ProjectShare>('project-shares', key)?.expiresAt ?? 0) <= Date.now()) store.set('project-shares', key, undefined);
    if (store.keys('project-shares').length >= 32) throw new Error('Shared link storage is full. Revoke an old project link first.');
    store.set('project-shares', digest(token), { projectPath, expiresAt, permissions });
  });
  return { token, expiresAt, permissions };
}
export function getProjectShare(token: string): ProjectShare | undefined {
  if (!/^[a-f0-9]{64}$/.test(token)) return undefined;
  const share = storage().get<ProjectShare>('project-shares', digest(token));
  return share && share.expiresAt > Date.now() ? { ...share, permissions: share.permissions ?? ['messages','activities','comments','submissions'] } : undefined;
}
export function revokeProjectShares(project: string): void {
  const store = storage();
  store.transaction(() => { for (const key of store.keys('project-shares')) {
    const share = store.get<ProjectShare>('project-shares', key);
    if (share && projectTaskKey(share.projectPath) === projectTaskKey(project)) store.set('project-shares', key, undefined);
  } });
}
export function publicProjectBoard(board: ProjectBoard, share: ProjectShare): unknown {
  const stages = projectTaskStages(board.tasks);
  return { title: path.basename(board.projectPath), tasks: board.tasks.map(({ id, title, prompt, stage, parentTaskId, sessionArchived }) => ({ id, title, prompt, stage: stages.get(id) ?? stage, parentTaskId, sessionArchived })),
    comments: share.permissions.includes('comments') ? board.comments : [], permissions: share.permissions, expiresAt: share.expiresAt, updatedAt: board.updatedAt };
}
