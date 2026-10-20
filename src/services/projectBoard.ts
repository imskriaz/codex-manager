import type { ProjectBoard, ProjectTaskDetails } from '../domain/projectTasks';
import { projectTaskKey, readProjectTasks, readProjectTask, syncProjectSessions } from './projectTasks';
import { readCodexCliSessions, readCodexCliSessionSummary, readCodexCliSessionMessagePage, resolveCodexHome } from './codexSessionResume';
import { resolveWorkspaceProjectPathAsync, readWorkspaceEnvironment, readWorkspaceGitHistory } from './workspaceTools';
import { waitWithin } from '../utils/concurrency';
import type { ProjectShare } from './projectTasks';
import { readWorkspaceFile } from './workspaceTools';

const savedSessions = new Map<string, { sessions: ProjectBoard['sessions']; checkedAt: number }>();
function boardSnapshot(project: string, home: string, sessions: ProjectBoard['sessions'], checkedAt = Date.now()): ProjectBoard {
  const rows = readProjectTasks(project), homeKey = projectTaskKey(home);
  const byId = new Map(sessions.map(session => [session.id, session]));
  rows.tasks = rows.tasks.map(task => task.sessionId ? { ...task, sessionStatus: Date.now() - checkedAt < 5000 && task.sourceKey?.startsWith(`${homeKey}:`) ? byId.get(task.sessionId)?.status ?? 'unknown' : 'unknown' } : task);
  return { projectPath: project, ...rows, sessions, updatedAt: Date.now(), homeKey };
}

/** A committed task edit never waits for optional native session discovery. */
export function readSavedProjectBoard(project: string, session?: ProjectBoard['sessions'][number]): ProjectBoard {
  const home = resolveCodexHome(), saved = savedSessions.get(`${projectTaskKey(project)}:${projectTaskKey(home)}`);
  const sessions = session ? [session, ...(saved?.sessions ?? []).filter(item => item.id !== session.id)] : saved?.sessions ?? [];
  return boardSnapshot(project, home, sessions, session ? Date.now() : saved?.checkedAt ?? 0);
}

export async function readSharedProjectTask(share: ProjectShare, taskId: string, view: string, before?: string, filePath?: string): Promise<unknown> {
  if (share.expiresAt <= Date.now()) throw new Error('This project link expired.');
  if (!['messages','activities','files','changes','git'].includes(view) || !share.permissions.includes(view as NonNullable<import('../domain/dashboard/types').DashboardActionPayload['taskView']>)) throw new Error('This feature is not enabled for this shared link.');
  const details = await readProjectTaskDetails(share.projectPath, taskId, view as NonNullable<import('../domain/dashboard/types').DashboardActionPayload['taskView']>, before);
  if (filePath !== undefined) {
    if (view !== 'files') throw new Error('File access is not enabled for this view.');
    return { file: await readWorkspaceFile(share.projectPath, filePath) };
  }
  return {
    messages: details.messages.filter(item => view === 'messages' ? !item.kind || item.kind === 'message' : view === 'activities' ? item.kind && item.kind !== 'message' && item.kind !== 'file-change' : view === 'changes' && item.changes?.length).map(item => ({
      id: item.id, role: item.role, kind: item.kind, text: item.text, title: item.title, status: item.status,
      ...(view === 'activities' ? { command: item.command, output: item.output, result: item.result, arguments: item.arguments } : {}),
      ...(view === 'changes' ? { changes: item.changes } : {})
    })),
    files: details.files, history: details.history, isGitRepository: details.environment?.isGitRepository,
    changes: details.environment?.changes, additions: details.environment?.additions, deletions: details.environment?.deletions,
    olderThan: details.olderThan, warnings: details.warnings
  };
}

export async function readProjectBoard(projectPath: string | undefined): Promise<ProjectBoard> {
  const project = await resolveWorkspaceProjectPathAsync(projectPath);
  const home = resolveCodexHome();
  const sessions = (await waitWithin(readCodexCliSessions(home), 10000, 'Session discovery is still pending. Saved tasks were preserved.')).filter(session => session.projectPath && !session.subAgent && !session.parentSessionId && projectTaskKey(session.projectPath) === projectTaskKey(project));
  if (resolveCodexHome() !== home) throw new Error('The active account home changed during discovery. Refresh the project.');
  syncProjectSessions(project, home, sessions);
  const key = `${projectTaskKey(project)}:${projectTaskKey(home)}`;
  if (savedSessions.size >= 8) savedSessions.delete(savedSessions.keys().next().value!);
  savedSessions.set(key, { sessions, checkedAt: Date.now() });
  return boardSnapshot(project, home, sessions);
}
export async function readProjectTaskDetails(projectPath: string, taskId: string, view: 'messages' | 'activities' | 'files' | 'changes' | 'git' = 'messages', before?: string): Promise<ProjectTaskDetails> {
  if (!['messages','activities','files','changes','git'].includes(view)) throw new Error('Unknown task detail view.');
  const project = await resolveWorkspaceProjectPathAsync(projectPath);
  const task = readProjectTask(project, taskId);
  const sessionId = task?.sessionId;
  if (!task) throw new Error('This task was not found. Refresh the project.');
  if (sessionId) {
    const session = await waitWithin(readCodexCliSessionSummary(sessionId, task.sourceHome), 5000, 'The session project could not be verified.');
    if (!session?.projectPath || projectTaskKey(session.projectPath) !== projectTaskKey(project)) throw new Error('This session does not belong to this project.');
  }
  const result: ProjectTaskDetails = { task, taskId, messages: [], files: [], history: [], warnings: [] };
  try {
    if (view === 'messages' || view === 'activities' || view === 'changes') {
      if (sessionId) Object.assign(result, await waitWithin(readCodexCliSessionMessagePage(sessionId, before, task.sourceHome), 5000, 'Task activity is still loading. Retry shortly.'));
    }
    if (view === 'files' && sessionId) {
      const page = await waitWithin(readCodexCliSessionMessagePage(sessionId, before, task.sourceHome), 5000, 'Chat files are still loading. Retry shortly.');
      Object.assign(result, page);
      const files = new Map<string, ProjectTaskDetails['files'][number]>();
      for (const message of page.messages) for (const change of message.changes ?? []) {
        if (!files.has(change.path)) files.set(change.path, { path: change.path, name: change.path.split(/[\\/]/).pop() ?? change.path, type: 'file', depth: change.path.split(/[\\/]/).length - 1 });
      }
      result.files = [...files.values()];
    }
    if (view === 'changes' || view === 'git') {
      result.environment = await waitWithin(readWorkspaceEnvironment(project, view === 'changes'), 5000, 'Git status is still loading.');
      if (view === 'git' && result.environment.isGitRepository) result.history = await readWorkspaceGitHistory(project);
    }
  } catch (error) { result.warnings.push(error instanceof Error ? error.message : String(error)); }
  return result;
}
