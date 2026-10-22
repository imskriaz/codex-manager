import type { DashboardCliSessionSummary, DashboardCliSessionMessage, DashboardWorkspaceEnvironment, DashboardWorkspaceFileEntry } from './dashboard/types';

export type TaskStage = 'idea' | 'planned' | 'running' | 'completed';
export type ProjectTask = {
  id: string; title: string; prompt: string; stage: TaskStage; revision: number;
  createdAt: number; updatedAt: number; sessionId?: string; launchPending?: boolean;
  parentTaskId?: string; sourceKey?: string; sourceHome?: string;
  sessionStatus?: DashboardCliSessionSummary['status']; sessionArchived?: boolean;
  manualStage?: TaskStage; archived?: boolean; hidden?: boolean;
  timing?: { firstStartedAt: number; lastObservedAt: number; durationMs: number; runCount: number };
};
export type ProjectComment = { id: string; taskId: string; author: string; text: string; createdAt: number };
export type ProjectBoard = { projectPath: string; tasks: ProjectTask[]; comments: ProjectComment[]; sessions: DashboardCliSessionSummary[]; updatedAt: number; revision?: number; homeKey?: string };
export type ProjectTaskFile = DashboardWorkspaceFileEntry & { attachment?: boolean };
export type ProjectTaskDetails = {
  task?: ProjectTask;
  taskId: string; initialPrompt?: string; messages: DashboardCliSessionMessage[]; files: ProjectTaskFile[];
  environment?: DashboardWorkspaceEnvironment; history: Array<{ hash: string; author: string; date: string; subject: string }>;
  warnings: string[];
  olderThan?: string;
};
export type ProjectTaskMutation = { id: string; title: string; prompt: string; stage: TaskStage; expectedRevision: number; parentTaskId?: string | null; archived?: boolean; hidden?: boolean };
export const PROJECT_SHARE_FEATURES = [
  { key: 'activities', label: 'Activities', description: 'Read messages, reasoning, tool calls, output, and logs.' },
  { key: 'files', label: 'Conversation files', description: 'Read files shared or changed in the conversation history.' },
  { key: 'changes', label: 'Changes', description: 'View recorded edits and current project changes.' },
  { key: 'comments', label: 'Comments', description: 'Read and add task comments.' },
  { key: 'submissions', label: 'Submissions', description: 'Submit new ideas for the owner to review.' },
  { key: 'embed', label: 'Allow embedding', description: 'Show this shared board inside other websites.' }
] as const;
export type ProjectSharePermission = typeof PROJECT_SHARE_FEATURES[number]['key'] | 'messages' | 'git';
export function taskSessionAgents(sessions: DashboardCliSessionSummary[], sessionId: string | undefined, deviceId?: string): DashboardCliSessionSummary[] {
  if (!sessionId) return [];
  const children = new Map<string, DashboardCliSessionSummary[]>();
  for (const session of sessions) if (session.parentSessionId && session.deviceId === deviceId) {
    const rows = children.get(session.parentSessionId) ?? [];
    rows.push(session); children.set(session.parentSessionId, rows);
  }
  const result: DashboardCliSessionSummary[] = [], seen = new Set([sessionId]), pending = [sessionId];
  while (pending.length) for (const child of children.get(pending.pop()!) ?? []) if (!seen.has(child.id)) {
    seen.add(child.id); result.push(child); pending.push(child.id);
  }
  return result;
}
export function sessionTaskStage(session: DashboardCliSessionSummary): TaskStage {
  if (session.status === 'running') return 'running';
  if (session.archived || session.goal?.status === 'complete') return 'completed';
  if (session.status === 'idle' && !session.interrupted && !session.goal) return 'completed';
  return 'planned';
}

/** Display running descendants on their parent, without silently completing parent tasks. */
export function projectTaskStages(tasks: ProjectTask[]): Map<string, TaskStage> {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const stages = new Map(tasks.map(task => [task.id, task.archived ? 'completed' as const : task.manualStage ?? (task.stage === 'running' && task.sessionStatus === 'unknown' ? 'planned' as const : task.stage)]));
  for (const task of tasks) {
    if (task.stage === 'completed') continue;
    const seen = new Set<string>();
    let parent = task.parentTaskId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      if (byId.get(parent)?.manualStage || byId.get(parent)?.archived) { parent = byId.get(parent)?.parentTaskId; continue; }
      if (task.stage === 'running' && task.sessionStatus !== 'unknown') stages.set(parent, 'running');
      else if (stages.get(parent) === 'completed') stages.set(parent, 'planned');
      parent = byId.get(parent)?.parentTaskId;
    }
  }
  return stages;
}
