import type { SessionPlan } from '../../src/domain/sessionPlan';

export function SessionPlanChecklist({ plan, status, compact = false }: { plan: SessionPlan; status?: string; compact?: boolean }) {
  const completed = plan.steps.filter(step => step.status === 'completed').length;
  const paused = completed < plan.steps.length && status && ['interrupted', 'unknown', 'failed', 'declined'].includes(status);
  const current = plan.steps.find(step => step.status === 'inProgress') ?? plan.steps.find(step => step.status === 'pending');
  return <details class={`session-plan${compact ? ' is-compact' : ''}`} open={!compact}>
    <summary>{compact ? <svg class="session-plan-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 4 1 1 2-2M7 4h7M2 8h3m2 0h7M2 12h3m2 0h7" /></svg> : <span aria-hidden="true">☷</span>}<strong>Plan</strong>{compact ? <span class="session-plan-current" title={current?.step}>{current?.step ?? 'All steps complete'}</span> : null}<span class="session-plan-count" role="status">{completed} of {plan.steps.length} complete{paused ? ' · Paused' : ''}</span>{compact ? <svg class="session-plan-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg> : <span class="session-plan-chevron" aria-hidden="true">⌄</span>}</summary>
    {plan.explanation ? <p>{plan.explanation}</p> : null}
    <ol aria-label="Task steps">{plan.steps.map((step, index) => <li key={index} class={`is-${step.status}`} aria-current={step.status === 'inProgress' && !paused ? 'step' : undefined}>
      <span class="session-plan-marker" aria-hidden="true">{compact ? <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r={step.status === 'pending' ? 4 : 6} />{step.status === 'completed' ? <path d="m5 8 2 2 4-4" /> : step.status === 'inProgress' && !paused ? <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" /> : null}</svg> : step.status === 'completed' ? '✓' : step.status === 'inProgress' && !paused ? '•' : index + 1}</span>
      <span class="sr-only">{step.status === 'completed' ? 'Completed: ' : step.status === 'inProgress' && !paused ? 'In progress: ' : paused ? 'Unfinished: ' : 'Pending: '}</span><span class="session-plan-step">{step.step}</span>
    </li>)}</ol>
  </details>;
}
