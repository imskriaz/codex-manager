import type { DashboardCliProject } from '../../src/domain/dashboard/types';
import { canonicalWebPath } from './helpers';
export { userWorkspaceNotice, userSessionActivity } from '../../src/domain/teamWorkspacePresentation';

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

