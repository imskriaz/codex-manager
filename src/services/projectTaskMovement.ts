import { readProjectAttachmentInput } from './projectTaskAttachments';
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
    if (!current || !current.prompt.trim() && !current.attachments?.length && prompt === undefined) throw new Error('Add a task prompt before starting Codex.');
    const attachments = [];
    if (prompt === undefined) for (const file of current.attachments ?? []) attachments.push(await readProjectAttachmentInput(projectTaskKey(project), file));
    if (resolveCodexHome() !== home) throw new Error('The account home changed. No task session was started.');
    const task = claimProjectTaskStart(project, id, revision, prompt !== undefined);
    signal.throwIfAborted();
    const text = prompt ?? (task.prompt || `Review the attached files for ${task.title}.`);
    const sessionId = await startCodexCliSession({ projectPath: project, text, ...(attachments.length ? { attachments } : {}) });
    if (resolveCodexHome() !== home) throw new Error('The account home changed after startup. Check the new session before retrying; startup was not replayed.');
    const session = readNewCodexCliSessionSummary(sessionId);
    finishProjectTaskStart(project, id, sessionId, home, text, session?.title);
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
