import type { DashboardCliProject, DashboardCliSessionMessage } from '../../src/domain/dashboard/types';
import { messageSessionPlan } from '../../src/domain/sessionPlan';
import { canonicalWebPath } from './helpers';
import { userWorkspaceNotice } from '../../src/domain/teamWorkspacePresentation';
import { answeredSessionQuestionIds } from '../../src/domain/sessionQuestions';
export { userWorkspaceNotice, userSessionActivity } from '../../src/domain/teamWorkspacePresentation';

export function currentUserWorkspaceQuestion(messages: DashboardCliSessionMessage[], queuedAnswers: DashboardCliSessionMessage[] = []): DashboardCliSessionMessage | undefined {
  const question = messages.at(-1);
  if (question?.role === 'user') return;
  const answered = answeredSessionQuestionIds([...messages, ...queuedAnswers]);
  return question?.questions?.some((_, index) => !answered.has(JSON.stringify(['request_user_input_async', question.id, index]))) ? question : undefined;
}

/** Tool envelopes and file contents belong in Files, not the conversation. */
export function userToolSummary(message: DashboardCliSessionMessage): string {
  let result: {status?: string; error?: unknown; payload?: {notice?: {message?: unknown}}} | undefined;
  try { result = JSON.parse(message.result ?? 'null') as typeof result; } catch { /* Older activities may contain plain text. */ }
  if (message.status === 'failed' || result?.status === 'failed') {
    const error = typeof result?.error === 'string' ? result.error : 'This action could not be completed. Please try again.';
    return userWorkspaceNotice(error).slice(0, 600);
  }
  if (message.status === 'inProgress') return 'Working on this action…';
  if (message.status === 'interrupted' || message.status === 'declined') return 'This action was stopped.';
  if (message.status === 'unknown') return 'This action could not be confirmed. Check your files before retrying.';
  const notice = result?.payload?.notice?.message;
  if (typeof notice === 'string') return userWorkspaceNotice(notice).slice(0, 600);
  return /read/i.test(message.title ?? '') ? 'File read. Open Files to view its contents.' : /browse|list/i.test(message.title ?? '') ? 'Workspace files checked. Open Files to browse them.' : 'Action completed. Open Files to view your work.';
}

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

