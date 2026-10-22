import type { DashboardCliSessionMessage } from './dashboard/types';
import type { ProjectComment } from './projectTasks';

export type TaskActivity = {
  id: string; label: string; timestamp?: string;
} & ({ message: DashboardCliSessionMessage; comment?: never } | { comment: ProjectComment; message?: never });

/** Filter the task summary only; the full conversation keeps every provider event. */
export function projectTaskActivity(messages: DashboardCliSessionMessage[], comments: ProjectComment[]): TaskActivity[] {
  const events: Array<{ order: number; activity: TaskActivity }> = [];
  let order = 0;
  for (const message of messages) {
    const kind = message.kind ?? 'message';
    if (kind === 'reasoning' || kind === 'compaction') continue;
    if (kind !== 'message' && kind !== 'error' && (message.status === 'failed' || message.status === 'declined' || message.status === 'interrupted' || typeof message.exitCode === 'number' && message.exitCode !== 0)) continue;
    if (!message.text.trim() && !message.title && !message.command && !message.output && !message.result && !message.changes?.length && !message.images?.length && !message.textAttachments?.length) continue;
    const time = Date.parse(message.timestamp ?? '');
    // Keep transcript order when timestamps are missing or provider clocks go backwards.
    if (Number.isFinite(time)) order = Math.max(order, time);
    const label = kind === 'message' ? message.role === 'user' ? 'You' : 'Codex' : ({ command: 'Command', 'tool-call': 'Tool', 'file-change': 'File changes', collaboration: 'Agents', 'web-search': 'Search', plan: 'Plan', image: 'Image', review: 'Review', error: 'Session issue' })[kind];
    events.push({ order, activity: { id: `message:${message.id}`, label, timestamp: Number.isFinite(time) ? message.timestamp : undefined, message } });
  }
  for (const comment of comments) events.push({ order: comment.createdAt > 0 ? comment.createdAt : Infinity, activity: { id: `comment:${comment.id}`, label: comment.author, timestamp: comment.createdAt > 0 && Number.isFinite(new Date(comment.createdAt).getTime()) ? new Date(comment.createdAt).toISOString() : undefined, comment } });
  return events.sort((a, b) => a.order - b.order).map(event => event.activity);
}
