import type { DashboardApiToken } from './dashboardApiToken';
import type { DashboardClientMessage, DashboardHostMessage, DashboardActionResultPayload } from '../domain/dashboard/types';
import { hasApiPermission } from './dashboardApiToken';
import { readCodexCliSessionSummary } from './codexSessionResume';
import { resolveWorkspaceProjectPathAsync } from './workspaceTools';
import { projectTaskKey } from './projectTasks';
import { waitWithin } from '../utils/concurrency';

import { PROJECT_API_ACTIONS, apiTokenProjects } from '../domain/dashboard/apiActions';
export { PROJECT_API_ACTIONS } from '../domain/dashboard/apiActions';

export class ApiPermissionError extends Error {}

export async function authorizeApiMessage(token: DashboardApiToken, message: DashboardClientMessage, localDeviceId?: string): Promise<DashboardClientMessage> {
  const projects = apiTokenProjects(token);
  if (message.type === 'dashboard:setting') {
    if (projects.length || !hasApiPermission(token, 'settings')) throw new ApiPermissionError('This token cannot change global settings.');
    return message;
  }
  if (message.type !== 'dashboard:action' || !hasApiPermission(token, message.action)) throw new ApiPermissionError('This token does not permit that operation.');
  if (!projects.length) return message;
  const target = message.payload?.targetDeviceId;
  if (!PROJECT_API_ACTIONS.has(message.action) || target && target !== 'local' && target !== localDeviceId || message.accountId) throw new ApiPermissionError(`Operation ${message.action} is outside this token project scope. Account operations such as refreshAll require an all-project token.`);
  const requestedProject = message.payload?.projectPath ?? (projects.length === 1 ? projects[0] : undefined);
  let sessionProject: string | undefined;
  if (message.action === 'resumeCodexSessions' && !message.payload?.sessionId) throw new ApiPermissionError('Choose one session inside this token project. Bulk recovery requires an all-project token.');
  if (message.payload?.sessionId) {
    const session = await waitWithin(readCodexCliSessionSummary(message.payload.sessionId), 5000, 'Session ownership could not be verified. Retry when connected.');
    sessionProject = session?.projectPath;
    if (!sessionProject) throw new Error('Session ownership is unavailable. Reconnect the host and retry. No operation was started.');
    if (!projects.some(project => projectTaskKey(project) === projectTaskKey(sessionProject!))) throw new ApiPermissionError('This session is outside the token project scope.');
  }
  if (!requestedProject && !sessionProject) throw new ApiPermissionError('Choose a projectPath from this token scope.');
  if (requestedProject && !projects.some(allowed => projectTaskKey(allowed) === projectTaskKey(requestedProject))) throw new ApiPermissionError('This token cannot access another project.');
  const project = await resolveWorkspaceProjectPathAsync(requestedProject ?? sessionProject);
  if (!projects.some(allowed => projectTaskKey(allowed) === projectTaskKey(project)) || sessionProject && projectTaskKey(sessionProject) !== projectTaskKey(project)) throw new ApiPermissionError('This token cannot access another project.');
  return { ...message, payload: { ...message.payload, targetDeviceId: undefined, projectPath: project } };
}

/** Mutations can return a global refreshed session list; never leak it through a project token. */
export function scopeApiResults(token: DashboardApiToken, messages: DashboardHostMessage[]): DashboardHostMessage[] {
  const projects = apiTokenProjects(token);
  if (!projects.length) return messages.filter(message => message.type !== 'dashboard:snapshot' || hasApiPermission(token, 'state'));
  const keys = new Set(projects.map(projectTaskKey));
  const owns = (session: { projectPath?: string } | undefined) => Boolean(session?.projectPath && keys.has(projectTaskKey(session.projectPath)));
  return messages.filter(message => message.type === 'dashboard:action-result').map(message => {
    if (message.type !== 'dashboard:action-result' || !message.payload) return message;
    const input = message.payload;
    const payload: DashboardActionResultPayload = {};
    for (const key of ['notice','projectBoard','projectTaskDetails','projectShare','cliSessionMessages','cliSessionLive','workspaceEnvironment','workspaceFiles','workspaceFile','deletedWorkspaceFilePath'] as const) {
      if (input[key] !== undefined) Object.assign(payload, { [key]: input[key] });
    }
    if (input.cliSessions) payload.cliSessions = input.cliSessions.filter(owns);
    if (owns(input.cliSession)) payload.cliSession = input.cliSession;
    if (owns(input.cliSubAgentSession)) { payload.cliSubAgentSession = input.cliSubAgentSession; payload.cliSubAgentMessages = input.cliSubAgentMessages; }
    if (input.cliComposerConfig) payload.cliComposerConfig = { ...input.cliComposerConfig, projects: input.cliComposerConfig.projects?.filter(project => owns({ projectPath: project.path })) };
    return { ...message, payload };
  });
}
