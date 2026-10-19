import type { DashboardCliSessionSummary, DashboardCliSessionMessage, DashboardWorkspaceEnvironment, DashboardWorkspaceFileEntry } from './dashboard/types';

export type TaskStage = 'idea' | 'planned' | 'running' | 'completed';
export type ProjectTask = {
  id: string; title: string; prompt: string; stage: TaskStage; revision: number;
  createdAt: number; updatedAt: number; sessionId?: string; launchPending?: boolean;
  parentTaskId?: string; sourceKey?: string; sourceHome?: string;
  sessionStatus?: DashboardCliSessionSummary['status'];
};
export type ProjectComment = { id: string; taskId: string; author: string; text: string; createdAt: number };
export type ProjectBoard = { projectPath: string; tasks: ProjectTask[]; comments: ProjectComment[]; sessions: DashboardCliSessionSummary[]; updatedAt: number; revision?: number; homeKey?: string };
export type ProjectTaskDetails = {
  task?: ProjectTask;
  taskId: string; messages: DashboardCliSessionMessage[]; files: DashboardWorkspaceFileEntry[];
  environment?: DashboardWorkspaceEnvironment; history: Array<{ hash: string; author: string; date: string; subject: string }>;
  warnings: string[];
  olderThan?: string;
};
export type ProjectTaskMutation = { id: string; title: string; prompt: string; stage: TaskStage; expectedRevision: number; parentTaskId?: string | null };
export const PROJECT_SHARE_FEATURES = [
  { key: 'messages', label: 'Messages', description: 'Read conversation messages and older history.' },
  { key: 'activities', label: 'Activities', description: 'Read reasoning, tool calls, output, and logs.' },
  { key: 'files', label: 'Project files', description: 'Browse and read project file contents.' },
  { key: 'changes', label: 'Changes', description: 'View recorded edits and current project changes.' },
  { key: 'git', label: 'Git history', description: 'Read repository commit history.' },
  { key: 'comments', label: 'Comments', description: 'Read and add task comments.' },
  { key: 'submissions', label: 'Submissions', description: 'Submit new ideas for the owner to review.' },
  { key: 'embed', label: 'Allow embedding', description: 'Show this shared board inside other websites.' }
] as const;
export type ProjectSharePermission = typeof PROJECT_SHARE_FEATURES[number]['key'];
export function sessionTaskStage(session: DashboardCliSessionSummary): TaskStage {
  if (session.status === 'running') return 'running';
  if (session.archived || session.goal?.status === 'complete') return 'completed';
  return 'planned';
}

/** Display running descendants on their parent, without silently completing parent tasks. */
export function projectTaskStages(tasks: ProjectTask[]): Map<string, TaskStage> {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const stages = new Map(tasks.map(task => [task.id, task.stage === 'running' && task.sessionStatus === 'unknown' ? 'planned' as const : task.stage]));
  for (const task of tasks) {
    if (task.stage === 'completed') continue;
    const seen = new Set<string>();
    let parent = task.parentTaskId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      if (task.stage === 'running' && task.sessionStatus !== 'unknown') stages.set(parent, 'running');
      else if (stages.get(parent) === 'completed') stages.set(parent, 'planned');
      parent = byId.get(parent)?.parentTaskId;
    }
  }
  return stages;
}
