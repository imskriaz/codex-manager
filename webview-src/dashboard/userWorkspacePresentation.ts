import type { DashboardCliProject } from '../../src/domain/dashboard/types';
import { canonicalWebPath } from './helpers';
export { userWorkspaceNotice, userSessionActivity } from '../../src/domain/teamWorkspacePresentation';

export function userProjectLabel(projectPath: string | undefined, projects: DashboardCliProject[] = []): string {
  return projects.find(project => projectPath && canonicalWebPath(project.path) === canonicalWebPath(projectPath))?.label || 'My workspace';
}

