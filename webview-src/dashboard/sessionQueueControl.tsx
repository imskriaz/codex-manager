import { useAnchoredPopover } from './anchoredPopover';
import { createPortal } from 'preact/compat';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DashboardCliSessionSummary } from '../../src/domain/dashboard/types';
import { isSessionQueuePriority } from '../../src/domain/sessionQueuePriority';

export function SessionQueueControl(props: {
  session: DashboardCliSessionSummary; disabled: boolean;
  onQueue: (session: DashboardCliSessionSummary, enabled: boolean, priority?: number) => void;
  autoResumeEnabled?: boolean;
  onAutoResume?: (session: DashboardCliSessionSummary, enabled: boolean) => void;
}) {
  const { session } = props;
  const [open, setOpen] = useState(false), [priority, setPriority] = useState('3');
  const hintId = useId();
  const valid = isSessionQueuePriority(Number(priority));
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => { if (props.disabled) setOpen(false); }, [props.disabled]);
  useAnchoredPopover(open, trigger, panel);
  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return;
    // The top layer keeps nested queue controls above clipped lists and modal surfaces.
    panel.current.showPopover?.();
    panel.current.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    const outside = (event: Event) => { const target = event.target as Node; if (!panel.current?.contains(target) && !trigger.current?.contains(target)) close(); };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); close(true); }
      if (event.key === 'Tab' && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', keydown, true);
    return () => {
      window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', keydown, true);
    };
  }, [open]);
  const hasAutoResume = props.autoResumeEnabled !== undefined && props.onAutoResume;
  const autoResumeActive = Boolean(hasAutoResume && props.autoResumeEnabled);
  return <span class="cli-running-queue cli-session-queue-wrap">
    <button ref={trigger} type="button" class={`cli-icon-button ${session.queueEnabled || autoResumeActive ? 'is-active' : ''} ${autoResumeActive ? 'is-auto-resume-selected' : ''} ${session.queueError ? 'has-queue-error' : ''}`} disabled={props.disabled}
      data-state={session.queueError ? 'needs-review' : autoResumeActive ? 'auto-resume' : session.queueEnabled ? 'queued' : 'not-queued'}
      aria-label={`Queue and Auto Resume options for ${session.title}`} aria-description={session.queueError} title={session.queueError ? `Queue needs review · ${session.queueError}` : session.queueEnabled ? `Queued · priority ${session.queuePriority ?? 3} · waiting for active work to finish` : hasAutoResume && props.autoResumeEnabled ? 'Auto Resume on · Open queue options' : 'Queue and Auto Resume options'}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => { setPriority(String(session.queuePriority ?? 3)); setOpen(!open); }}>
      <span class="cli-session-control-markers" aria-hidden="true">
        <span class={`cli-session-main-icon ${autoResumeActive ? 'is-auto-resume-icon' : 'is-queue-icon'}`}>
          {autoResumeActive ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 8V3l-3 3a9 9 0 1 0 3.5 9" /><path d="M20 8h-5" /><path d="m10 8 6 4-6 4V8Z" fill="currentColor" stroke="none" /></svg> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h15M4 10h7M4 15h4" /><circle cx="16.5" cy="16" r="5" /><path d="M16.5 13v3l2 1.5" /></svg>}
        </span>
        {session.queueEnabled || session.queueError ? <small class="cli-session-control-badge is-queue-badge" title={`Priority ${session.queuePriority ?? 3}`}>{session.queueError ? '!' : session.queuePriority ?? 3}</small> : null}
      </span>
    </button>
    {open ? createPortal(<div ref={panel} popover="manual" class="cli-session-queue-menu is-floating" role="dialog" aria-label={`Queue ${session.title}`}
      onClick={event => event.stopPropagation()}>
      <header><div><strong>Run after other work</strong><small class="cli-queue-current">{session.queueError ? `Needs review · priority ${session.queuePriority ?? 3}` : session.queueEnabled ? `Queued · priority ${session.queuePriority ?? 3}` : 'Not queued'}</small></div><button type="button" class="cli-queue-close" aria-label="Close queue options" onClick={() => close(true)}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m6 6 12 12M6 18 18 6" /></svg></button></header>
      {hasAutoResume ? <button type="button" class={`cli-queue-auto-resume ${props.autoResumeEnabled ? 'is-enabled' : 'is-disabled'}`} disabled={props.disabled} aria-pressed={props.autoResumeEnabled} onClick={() => { close(true); props.onAutoResume?.(session, !props.autoResumeEnabled); }}><span><strong>Auto Resume</strong><small>{props.autoResumeEnabled ? 'Enabled for interrupted work' : 'Disabled for this session'}</small></span><span aria-hidden="true">{props.autoResumeEnabled ? 'On' : 'Off'}</span></button> : null}
      <p id={hintId} class="cli-queue-hint">Lower numbers run first. Equal priorities start together once active work finishes.</p>
      {session.queueError ? <p role="status" class="settings-note">{session.queueError}</p> : null}
      <div class="cli-queue-presets" aria-label="Priority presets">{[1,2,3].map(value => <button key={value} type="button" aria-pressed={Number(priority) === value} class={Number(priority) === value ? 'is-selected' : ''} onClick={() => setPriority(String(value))}><span>Priority {value}</span><small>{value === 1 ? 'First' : value === 2 ? 'Next' : 'Later'}</small></button>)}</div>
      <form onSubmit={event => { event.preventDefault(); if (props.disabled || !valid) return; close(true); props.onQueue(session, true, Number(priority)); }}>
      <label class="cli-queue-priority-field"><span>Custom priority</span><input aria-label="Queue priority" aria-describedby={hintId} aria-invalid={!valid} type="number" min="1" max={Number.MAX_SAFE_INTEGER} required step="1" inputMode="numeric" value={priority} onInput={event => setPriority(event.currentTarget.value)} /></label>
      {!valid ? <small class="cli-queue-validation" role="status">Enter a positive whole number.</small> : null}
      <button type="submit" class="is-primary" disabled={props.disabled || !valid}>{session.queueEnabled ? 'Save priority' : 'Queue session'}</button>
      </form>
      {session.queueEnabled ? <button type="button" class="is-muted" disabled={props.disabled} onClick={() => { close(true); props.onQueue(session, false); }}>Remove from queue</button> : null}
    </div>, document.body) : null}
  </span>;
}
