import type { DashboardCliProject, DashboardCliSessionMessage } from '../../src/domain/dashboard/types';
import { messageSessionPlan } from '../../src/domain/sessionPlan';
import { canonicalWebPath } from './helpers';
export { userWorkspaceNotice, userSessionActivity } from '../../src/domain/teamWorkspacePresentation';

export function currentUserWorkspacePlan(messages: DashboardCliSessionMessage[], turnId: string | undefined, running: boolean): DashboardCliSessionMessage | undefined {
  const reverse=[...messages].reverse();
  const prompt=reverse.findIndex(message=>message.role==='user'&&(!message.kind||message.kind==='message'));
  const message=running&&turnId?reverse.find(message=>message.turnId===turnId&&messageSessionPlan(message)):reverse.slice(0,prompt<0?undefined:prompt).find(message=>messageSessionPlan(message));
  return message&&!running&&message.status==='inProgress'?{...message,status:'unknown'}:message;
}

export function userCommandSummary(command: string): string {
  const line = command.split('\n')[0]!;
  const shell = /^"?PowerShell"?\s+(?:(?:-NoProfile|-NoLogo|-NonInteractive)\s+)*-(?:Command|c)\s+(.+)$/i.exec(line);
  if (!shell) return line;
  const script = shell[1]!;
  return `PowerShell: ${/^(['"])[\s\S]*\1$/.test(script) ? script.slice(1,-1) : script}`;
}

export function userProjectLabel(projectPath: string | undefined, projects: DashboardCliProject[] = []): string {
  return projects.find(project => projectPath && canonicalWebPath(project.path) === canonicalWebPath(projectPath))?.label || 'My workspace';
}

