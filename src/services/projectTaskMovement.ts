import type { TaskStage } from '../domain/projectTasks';
import { claimProjectTaskStart, finishProjectTaskStart, projectTaskKey, readProjectTask, recordProjectTaskStage } from './projectTasks';
import { readNewCodexCliSessionSummary, resolveCodexHome, startCodexCliSession } from './codexSessionResume';
import { readSavedProjectBoard } from './projectBoard';
import { runCrossWindowExclusive } from '../utils/crossWindowOperations';

export async function startProjectTaskSession(project: string, id: string, revision: number | undefined, prompt?: string) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(id) || !Number.isSafeInteger(revision) || revision! < 0) throw new Error('Choose a task and its current revision.');
  if (prompt !== undefined && (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000)) throw new Error('Write a subtask prompt under 32,000 characters.');
  const home = resolveCodexHome();
  return runCrossWindowExclusive(`task-move:${projectTaskKey(project)}:${id}`, 'Task session start', async signal => {
    const current = readProjectTask(project, id);
    if (!current || !current.prompt.trim() && prompt === undefined) throw new Error('Add a task prompt before starting Codex.');
    const task = claimProjectTaskStart(project, id, revision, prompt !== undefined);
    signal.throwIfAborted();
    const sessionId = await startCodexCliSession({ projectPath: project, text: prompt ?? task.prompt });
    if (resolveCodexHome() !== home) throw new Error('The account home changed after startup. Check the new session before retrying; startup was not replayed.');
    const session = readNewCodexCliSessionSummary(sessionId);
    finishProjectTaskStart(project, id, sessionId, home, prompt ?? task.prompt, session?.title);
    return readSavedProjectBoard(project, session);
  }, { waitMs: 500 });
}

/** Board status is independent from Codex execution; movement never starts or stops work. */
export async function moveProjectTask(project: string, id: string, revision: number | undefined, stage: TaskStage | undefined, toBoard = false) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(id) || !['idea','planned','running','completed'].includes(stage ?? '') || !Number.isSafeInteger(revision) || revision! < 0) throw new Error('Choose a task, current revision and destination column.');
  return runCrossWindowExclusive(`task-move:${projectTaskKey(project)}:${id}`, 'Task movement', signal => {
    signal.throwIfAborted(); recordProjectTaskStage(project, id, revision!, stage!, toBoard);
    return Promise.resolve(readSavedProjectBoard(project));
  }, { waitMs: 500 });
}
