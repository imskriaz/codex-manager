import type { ProjectBoard, ProjectTaskDetails } from '../domain/projectTasks';
import { projectTaskKey, readProjectTasks, readProjectTask, syncProjectSessions } from './projectTasks';
import { readCodexCliSessions, readCodexCliSessionSummary, readCodexCliSessionMessagePage, resolveCodexHome } from './codexSessionResume';
import { resolveWorkspaceProjectPathAsync, readWorkspaceEnvironment } from './workspaceTools';
import { waitWithin } from '../utils/concurrency';
import type { ProjectShare } from './projectTasks';
import { readWorkspaceFile } from './workspaceTools';
import { getSqliteStateStore } from '../storage/sqliteState';
import { readStoredSessionLive } from '../storage/sqliteSessions';
import { combineCliLiveMessages } from '../domain/codexSessionLive';
import { listConversationFiles, readConversationAttachment, safeConversationImage } from '../domain/conversationFiles';
import { withoutChatTextAttachments } from '../domain/chatAttachments';

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
  const normalizedView = view === 'messages' ? 'activities' : view;
  const hasViewPermission = normalizedView === 'activities'
    ? share.permissions.includes('activities') || share.permissions.includes('messages')
    : share.permissions.includes(normalizedView as NonNullable<import('../domain/dashboard/types').DashboardActionPayload['taskView']>);
  if (!['activities','files','changes'].includes(normalizedView) || !hasViewPermission) throw new Error('This feature is not enabled for this shared link.');
  const details = await readProjectTaskDetails(share.projectPath, taskId, normalizedView as NonNullable<import('../domain/dashboard/types').DashboardActionPayload['taskView']>, before);
  if (filePath !== undefined) {
    if (normalizedView !== 'files') throw new Error('File access is not enabled for this view.');
    const entry = details.files.find(file => file.path === filePath);
    if (!entry) throw new Error('This file is not part of the shared conversation history.');
    if (entry.attachment) {
      const file = readConversationAttachment(details.messages, filePath);
      if (!file) throw new Error('This attachment is unavailable. Refresh this history page.');
      return { file };
    }
    return { file: await readWorkspaceFile(share.projectPath, filePath) };
  }
  return {
    messages: details.messages.filter(item => normalizedView === 'activities'
      ? (!item.kind || item.kind === 'message' ? share.permissions.includes('messages') : share.permissions.includes('activities') && item.kind !== 'file-change')
      : normalizedView === 'changes' && item.changes?.length).map(item => ({
      id: item.id, role: item.role, kind: item.kind, text: item.role === 'user' ? withoutChatTextAttachments(item.text) : item.text, title: item.title, status: item.status,
      ...(share.permissions.includes('files') && item.images?.length ? { images: item.images.filter(image => safeConversationImage(image.src)) } : {}),
      ...(normalizedView === 'activities' && share.permissions.includes('activities') ? { command: item.command, output: item.output, result: item.result, arguments: item.arguments } : {}),
      ...(normalizedView === 'changes' ? { changes: item.changes } : {})
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
export async function readProjectTaskDetails(projectPath: string, taskId: string, view: 'activities' | 'files' | 'changes' = 'activities', before?: string): Promise<ProjectTaskDetails> {
  if (!['activities','files','changes'].includes(view)) throw new Error('Unknown task detail view.');
  const project = await resolveWorkspaceProjectPathAsync(projectPath);
  const task = readProjectTask(project, taskId);
  const sessionId = task?.sessionId;
  if (!task) throw new Error('This task was not found. Refresh the project.');
  const session = sessionId ? await waitWithin(readCodexCliSessionSummary(sessionId, task.sourceHome), 5000, 'The session project could not be verified.') : undefined;
  if (sessionId) {
    if (!session?.projectPath || projectTaskKey(session.projectPath) !== projectTaskKey(project)) throw new Error('This session does not belong to this project.');
  }
  const result: ProjectTaskDetails = { task, taskId, messages: [], files: [], history: [], warnings: [] };
  try {
    if (sessionId) {
      try { Object.assign(result, await waitWithin(readCodexCliSessionMessagePage(sessionId, before, task.sourceHome), 5000, 'Task activity is still loading. Retry shortly.')); }
      catch (error) { result.warnings.push(error instanceof Error ? error.message : String(error)); }
      if (before === undefined) {
        try {
          const store = getSqliteStateStore();
          const live = store ? readStoredSessionLive(store, task.sourceHome ?? resolveCodexHome(), sessionId) : undefined;
          if (live && !(Date.parse(session?.updatedAt ?? '') > live.updatedAt)) result.messages = combineCliLiveMessages(result.messages, live);
        } catch (error) { result.warnings.push(`Live activity is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    if (view === 'files' && sessionId) {
      result.files = listConversationFiles(result.messages);
    }
    if (view === 'changes') {
      result.environment = await waitWithin(readWorkspaceEnvironment(project, true), 5000, 'Project changes are still loading.');
    }
  } catch (error) { result.warnings.push(error instanceof Error ? error.message : String(error)); }
  return result;
}
