import type { SessionPlan } from '../../src/domain/sessionPlan';

export function SessionPlanChecklist({ plan, status }: { plan: SessionPlan; status?: string }) {
  const completed = plan.steps.filter(step => step.status === 'completed').length;
  const paused = completed < plan.steps.length && status && ['interrupted', 'unknown', 'failed', 'declined'].includes(status);
  return <details class="session-plan" open>
    <summary><span aria-hidden="true">☷</span><strong>Plan</strong><span class="session-plan-count" role="status">{completed} of {plan.steps.length} complete{paused ? ' · Paused' : ''}</span><span class="session-plan-chevron" aria-hidden="true">⌄</span></summary>
    {plan.explanation ? <p>{plan.explanation}</p> : null}
    <ol aria-label="Task steps">{plan.steps.map((step, index) => <li key={index} class={`is-${step.status}`} aria-current={step.status === 'inProgress' && !paused ? 'step' : undefined}>
      <span class="session-plan-marker" aria-hidden="true">{step.status === 'completed' ? '✓' : step.status === 'inProgress' && !paused ? '•' : index + 1}</span>
      <span class="sr-only">{step.status === 'completed' ? 'Completed: ' : step.status === 'inProgress' && !paused ? 'In progress: ' : paused ? 'Unfinished: ' : 'Pending: '}</span><span class="session-plan-step">{step.step}</span>
    </li>)}</ol>
  </details>;
}
