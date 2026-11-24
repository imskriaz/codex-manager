import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useAnchoredPopover } from './anchoredPopover';
import { canonicalWebPath } from './helpers';
import { createPortal } from 'preact/compat';
import { useModalAccessibility } from './primitives';

type Project = { path: string; label: string };
const changed = 'codexManager.projectPickerChanged';
const storageKey = (scope: string) => `codexManager.projectPicker.removed.${scope}`;
function readRemoved(scope: string): string[] {
  const value: unknown = JSON.parse(localStorage.getItem(storageKey(scope)) ?? '[]');
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Error('Invalid recent project preferences.');
  return value;
}

export function ProjectPicker(props: {
  label: string; value: string; projects: Project[]; scope?: string; disabled?: boolean;
  title?: string; name?: string; allowEmpty?: boolean; onChange: (path: string) => void; onAdd?: () => void;
}) {
  const id = useId(), scope = props.scope ?? 'local';
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(0);
  const [removed, setRemoved] = useState<string[]>([]), [notice, setNotice] = useState(''), [failed, setFailed] = useState(false);
  const [toast, setToast] = useState<{ message: string }>();
  const [pending, setPending] = useState<Project>();
  useEffect(() => {
    if (!toast) return;
    const timer = globalThis.setTimeout(() => setToast(undefined), 4500);
    return () => globalThis.clearTimeout(timer);
  }, [toast]);
  useEffect(() => { setOpen(false); setQuery(''); setPending(undefined); }, [scope, props.disabled]);
  useEffect(() => {
    setNotice(''); setFailed(false);
    const load = () => { try { setRemoved(readRemoved(scope)); } catch { setRemoved([]); setFailed(true); setNotice('Recent project preferences could not be loaded.'); } };
    load();
    window.addEventListener(changed, load); window.addEventListener('storage', load);
    return () => { window.removeEventListener(changed, load); window.removeEventListener('storage', load); };
  }, [scope]);
  const projects = [...new Map(props.projects.map(project => [canonicalWebPath(project.path), project])).values()];
  const selected = projects.find(project => canonicalWebPath(project.path) === canonicalWebPath(props.value));
  const matches = projects.filter(project => (query.trim() || !removed.includes(canonicalWebPath(project.path))) && `${project.label} ${project.path}`.toLowerCase().includes(query.trim().toLowerCase()));
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  const choose = (path: string) => { if (!props.disabled) { props.onChange(path); close(true); } };
  const remove = (project: Project) => {
    if (props.disabled) return;
    try {
      const next = [...new Set([...readRemoved(scope), canonicalWebPath(project.path)])];
      localStorage.setItem(storageKey(scope), JSON.stringify(next));
      setRemoved(next); setFailed(false); setNotice(''); setToast({ message: `Removed ${project.label} from recent projects.` });
      window.dispatchEvent(new Event(changed)); setPending(undefined); setActive(0); trigger.current?.focus({ preventScroll: true });
    } catch { setFailed(true); setNotice('Could not remove this recent project. Your project is still available.'); }
  };
  useAnchoredPopover(open, trigger, panel, 'start');
  useLayoutEffect(() => {
    if (!open) return;
    search.current?.focus({ preventScroll: true });
    const outside = (event: Event) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('focusin', outside);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside); };
  }, [open]);
  useLayoutEffect(() => { if (open) panel.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [open, active, query]);
  const show = () => { setQuery(''); setActive(0); if (!failed) setNotice(''); setOpen(true); };
  return <div class="project-picker">
    {toast ? createPortal(<div class="dashboard-notice-stack project-picker-toast" aria-live="polite"><div class="dashboard-notice is-info" role="status"><span>{toast.message}</span><button type="button" aria-label="Dismiss project notification" onClick={() => setToast(undefined)}>×</button></div></div>, document.body) : null}
    <button ref={trigger} type="button" role="combobox" name={props.name} class="project-picker-trigger" aria-label={props.label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined} disabled={props.disabled} title={props.title ?? props.value} data-value={props.value} onClick={() => open ? close() : show()} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); } }}>
      <span>{selected?.label ?? (props.value ? props.value.split(/[\\/]/).filter(Boolean).pop() : 'No folder')}</span><svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="m5 8 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
    </button>
    {open ? <div ref={panel} class="project-picker-popover" popover="manual" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || (event.target !== search.current && (event.key === 'Home' || event.key === 'End'))) {
        event.preventDefault(); event.stopPropagation();
        const options = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
        const index = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : index < 0 ? event.key === 'ArrowDown' ? 0 : options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        setActive(next); options[next]?.focus();
      } else if (event.key === 'Enter' && event.target === search.current) {
        event.preventDefault(); panel.current?.querySelector<HTMLButtonElement>('[data-active="true"]')?.click();
      }
    }}>
      <input ref={search} type="search" aria-label={`Search ${props.label.toLowerCase()}`} placeholder="Search folders…" value={query} onInput={event => { setQuery(event.currentTarget.value); setActive(event.currentTarget.value.trim() && props.allowEmpty !== false ? 1 : 0); }}/>
      <div id={`${id}-list`} role="listbox" aria-label={`${props.label} folders`} class="project-picker-options">
        {props.allowEmpty !== false ? <button type="button" role="option" aria-selected={!props.value} data-active={active === 0} onClick={() => choose('')}><span>No folder</span></button> : null}
        <div class="project-picker-heading" role="presentation">{query.trim() ? 'Folders' : 'Recent'}</div>
        {matches.map((project, index) => <div class="project-picker-row" key={project.path} role="presentation">
          <button type="button" role="option" title={project.path} aria-selected={canonicalWebPath(project.path) === canonicalWebPath(props.value)} data-value={project.path} data-active={active === index + (props.allowEmpty !== false ? 1 : 0)} onClick={() => choose(project.path)}><span>{project.label}</span></button>
          <button type="button" class="project-picker-remove" title="Remove from recent" aria-label={`Remove ${project.label} from recent`} onClick={() => { close(true); setNotice(''); setFailed(false); setPending(project); }}>×</button>
        </div>)}
      </div>
      {!matches.length ? <p class="project-picker-empty">{query ? 'No matching folders' : 'No recent folders'}</p> : null}
      {failed && notice ? <p class="project-picker-error" role="alert">{notice}</p> : null}
      {props.onAdd ? <button type="button" class="project-picker-add" onClick={() => { close(); props.onAdd?.(); }}>Create new</button> : null}
    </div> : null}
    {!pending && !failed && notice ? <span class="sr-only" role="status">{notice}</span> : null}
    {pending ? <RemoveProjectConfirmation project={pending} error={failed ? notice : undefined} onCancel={() => { setPending(undefined); setNotice('Project removal cancelled.'); setFailed(false); }} onConfirm={() => remove(pending)} /> : null}
  </div>;
}

function RemoveProjectConfirmation(props: { project: Project; error?: string; onCancel: () => void; onConfirm: () => void }) {
  const accessibility = useModalAccessibility(true, props.onCancel);
  return createPortal(<div class="cli-delete-overlay" role="presentation" onPointerDown={accessibility.onBackdropPointerDown} onMouseDown={accessibility.onBackdropMouseDown} onClick={accessibility.onBackdropClick}>
    <section ref={accessibility.modalRef} class="cli-delete-confirm project-remove-confirm" role="alertdialog" aria-modal="true" aria-label={`Remove ${props.project.label} from recent projects`} tabIndex={-1} onKeyDown={accessibility.onKeyDown}>
      <div class="cli-delete-confirm-copy"><span><strong>Remove from recent?</strong> {props.project.label} will leave the recent list. Its folder and sessions stay available.{props.error ? <span role="alert">{props.error}</span> : null}</span></div>
      <div class="cli-delete-confirm-actions"><button type="button" class="cli-secondary-button" onClick={props.onCancel}>Cancel</button><button type="button" class="cli-danger-button" onClick={props.onConfirm}>Remove</button></div>
    </section>
  </div>, document.body);
}
