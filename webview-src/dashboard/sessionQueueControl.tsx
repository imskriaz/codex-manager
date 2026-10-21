import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { DashboardCliSessionSummary } from '../../src/domain/dashboard/types';
import { isSessionQueuePriority } from '../../src/domain/sessionQueuePriority';

export function SessionQueueControl(props: {
  session: DashboardCliSessionSummary; disabled: boolean;
  onQueue: (session: DashboardCliSessionSummary, enabled: boolean, priority?: number) => void;
}) {
  const { session } = props;
  const [open, setOpen] = useState(false), [priority, setPriority] = useState('3');
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => { if (props.disabled) setOpen(false); }, [props.disabled]);
  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return;
    const reposition = () => {
      if (!panel.current || !trigger.current) return;
      const viewport = window.visualViewport, x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
      const rect = trigger.current.getBoundingClientRect(), menu = panel.current.getBoundingClientRect();
      const below = rect.bottom + 6;
      setPosition({ left: Math.max(x + 8, Math.min(rect.right - menu.width, x + width - menu.width - 8)),
        top: Math.max(y + 8, Math.min(below + menu.height <= y + height - 8 ? below : rect.top - menu.height - 6, y + height - menu.height - 8)) });
    };
    reposition();
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
    window.addEventListener('resize', reposition); window.addEventListener('scroll', reposition, true);
    window.visualViewport?.addEventListener('resize', reposition); window.visualViewport?.addEventListener('scroll', reposition);
    return () => {
      window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true);
      window.visualViewport?.removeEventListener('resize', reposition); window.visualViewport?.removeEventListener('scroll', reposition);
    };
  }, [open]);
  return <span class="cli-running-queue cli-session-queue-wrap">
    <button ref={trigger} type="button" class={`cli-icon-button ${session.queueEnabled ? 'is-active' : ''}`} disabled={props.disabled}
      aria-label={`Queue priority for ${session.title}`} title={session.queueEnabled ? `Queued · priority ${session.queuePriority ?? 3}` : 'Run after other work'}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => { setPriority(String(session.queuePriority ?? 3)); setOpen(!open); }}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6h10M5 12h10M5 18h10m3-3 3 3-3 3" /></svg>
      {session.queueEnabled ? <small>{session.queuePriority ?? 3}</small> : null}
    </button>
    {open ? createPortal(<div ref={panel} class="cli-session-queue-menu is-floating" role="dialog" aria-label={`Queue ${session.title}`}
      style={{ top: `${position.top}px`, left: `${position.left}px` }} onClick={event => event.stopPropagation()}>
      <header><strong>Run after other work</strong><button type="button" class="cli-queue-close" aria-label="Close queue options" onClick={() => close(true)}>×</button></header>
      <small class="cli-queue-current">{session.queueEnabled ? `Queued · priority ${session.queuePriority ?? 3}` : 'Not queued'}</small>
      <p class="cli-queue-hint">Lower numbers run first. Equal priorities run together when other work finishes.</p>
      {session.queueError ? <p role="status" class="settings-note">{session.queueError}</p> : null}
      <div class="cli-queue-presets" aria-label="Priority presets">{[1,2,3].map(value => <button key={value} type="button" aria-pressed={Number(priority) === value} class={Number(priority) === value ? 'is-selected' : ''} onClick={() => setPriority(String(value))}><span>Priority {value}</span><small>{value === 1 ? 'First' : value === 2 ? 'Next' : 'Later'}</small></button>)}</div>
      <label class="cli-queue-priority-field"><span>Custom priority</span><input aria-label="Queue priority" type="number" min="1" step="1" inputMode="numeric" value={priority} onInput={event => setPriority(event.currentTarget.value)} /></label>
      <button type="button" class="is-primary" disabled={props.disabled || !isSessionQueuePriority(Number(priority))} onClick={() => { close(true); props.onQueue(session, true, Number(priority)); }}>Queue session</button>
      {session.queueEnabled ? <button type="button" class="is-muted" disabled={props.disabled} onClick={() => { close(true); props.onQueue(session, false); }}>Remove from queue</button> : null}
    </div>, document.body) : null}
  </span>;
}
