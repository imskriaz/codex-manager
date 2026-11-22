import type { DashboardActionName } from '../domain/dashboard/types';

export const OFFICE_ISOLATION_REQUIRED = 'This tool needs an isolated runtime before it can be used in User Workspace. Your files and chats are still available.';
const hostExecution: DashboardActionName[] = ['listWorkspaceTerminals', 'workspaceTerminal', 'runWorkspaceTerminalCommand', 'createWorkspaceTerminal', 'focusWorkspaceTerminal', 'closeWorkspaceTerminal', 'cancelWorkspaceTerminalCommand', 'workspaceGit', 'commitWorkspaceChanges', 'pushWorkspaceBranch', 'workspaceGitHub', 'openExternalUrl'];
export function assertOfficeHostIsolation(action: DashboardActionName): void {
  if (hostExecution.includes(action)) throw new Error(OFFICE_ISOLATION_REQUIRED);
}

export function validateOfficeFilePath(file: string): void {
  const parts = file.replace(/\\/g, '/').split('/');
  if(parts.some(part=>/^\.workspace-(?:history|trash)$/i.test(part)))throw new Error('Choose a file in your workspace. Use Library to manage saved versions and Trash.');
  if (parts.some(part => /[\x00-\x1f:]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Choose a valid file name inside your workspace.');
}
