import type { DashboardCliSessionMessage, DashboardCodexSessionLiveState } from './dashboard/types';

export type SessionPlan = NonNullable<DashboardCodexSessionLiveState['plan']>;

/** Native update_plan uses in_progress; app-server notifications use inProgress. */
export function readSessionPlan(value: unknown): SessionPlan | undefined {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return; } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const input = value as { plan?: unknown; steps?: unknown; explanation?: unknown };
  const rows = input.steps ?? input.plan;
  if (!Array.isArray(rows) || !rows.length || rows.length > 100 || (input.explanation !== undefined && (typeof input.explanation !== 'string' || input.explanation.length > 8000))) return;
  const steps: SessionPlan['steps'] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') return;
    const item = row as { step?: unknown; status?: unknown };
    const status = item.status === 'in_progress' ? 'inProgress' : item.status;
    if (typeof item.step !== 'string' || !item.step.trim() || item.step.length > 1000 || (status !== 'pending' && status !== 'inProgress' && status !== 'completed')) return;
    steps.push({ step: item.step.trim(), status });
  }
  if (steps.filter(step => step.status === 'inProgress').length > 1) return;
  return { ...(typeof input.explanation === 'string' ? { explanation: input.explanation } : {}), steps };
}

export function messageSessionPlan(message: DashboardCliSessionMessage): SessionPlan | undefined {
  return message.kind === 'plan' ? readSessionPlan(message.arguments) : undefined;
}

export function sessionPlanMessage(id: string, plan: SessionPlan): DashboardCliSessionMessage {
  return { id, kind: 'plan', title: 'Plan', text: plan.steps.map(step => `${step.status === 'completed' ? '[x]' : '[ ]'} ${step.step}`).join('\n'), arguments: JSON.stringify(plan), status: plan.steps.every(step => step.status === 'completed') ? 'completed' : 'inProgress' };
}
