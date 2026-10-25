import { useAnchoredPopover } from './anchoredPopover';
import { createPortal } from 'preact/compat';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DashboardCliSessionSummary } from '../../src/domain/dashboard/types';
import { isSessionQueuePriority } from '../../src/domain/sessionQueuePriority';

export function SessionPolicySelect(props: {
  session: DashboardCliSessionSummary;
  globalEnabled: boolean;
  disabled: boolean;
  onAutoResume: (session: DashboardCliSessionSummary, enabled: boolean) => void;
}) {
  const enabled = props.globalEnabled ? props.session.autoResumeEnabled !== false : props.session.autoResumeEnabled === true;
  return <label class="cli-session-policy-control" title={enabled ? "Resume automatically when the Codex server is ready" : "Resume manually only"}>
    <span class="sr-only">Session resume policy for {props.session.title}</span>
    <select aria-label={`Resume policy for ${props.session.title}`} value={enabled ? "auto" : "manual"} disabled={props.disabled} onChange={event => props.onAutoResume(props.session, event.currentTarget.value === "auto")}>
      <option value="auto">Auto</option>
      <option value="manual">Manual</option>
    </select>
  </label>;
}

export function SessionQueueControl(props: {
  session: DashboardCliSessionSummary; disabled: boolean;
  onQueue: (session: DashboardCliSessionSummary, enabled: boolean, priority?: number) => void;
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
  return <span class="cli-running-queue cli-session-queue-wrap">
    <button ref={trigger} type="button" class={`cli-icon-button ${session.queueEnabled ? 'is-active' : ''}`} disabled={props.disabled}
      aria-label={`Queue priority for ${session.title}`} title={session.queueEnabled ? `Queued · priority ${session.queuePriority ?? 3}` : 'Run after other work'}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => { setPriority(String(session.queuePriority ?? 3)); setOpen(!open); }}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M4 11h8M4 16h6m5-2 4 4-4 4m-3-4h7" /></svg>
      {session.queueEnabled ? <small>{session.queuePriority ?? 3}</small> : null}
    </button>
    {open ? createPortal(<div ref={panel} popover="manual" class="cli-session-queue-menu is-floating" role="dialog" aria-label={`Queue ${session.title}`}
      onClick={event => event.stopPropagation()}>
      <header><div><strong>Run after other work</strong><small class="cli-queue-current">{session.queueEnabled ? `Queued · priority ${session.queuePriority ?? 3}` : 'Schedule this session'}</small></div><button type="button" class="cli-queue-close" aria-label="Close queue options" onClick={() => close(true)}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m6 6 12 12M6 18 18 6" /></svg></button></header>
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
