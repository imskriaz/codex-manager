import { useEffect, useRef, useState } from "preact/hooks";
import { MAINTENANCE_TOOLS, isMaintenanceJob, mergeMaintenanceJob, type CodexInspection, type MaintenanceJob, type MaintenancePreview, type MaintenancePage, type MaintenanceTool, type MaintenanceReport } from "../../src/domain/maintenance";
import type { DashboardActionName, DashboardActionPayload, DashboardHostMessage } from "../../src/domain/dashboard/types";
import type { SendAction } from "./hookTypes";
import { getActionTimeoutMs } from './host';
import { ModalShell } from './primitives';
import { renderRefreshIcon as RefreshIcon, renderRemoveIcon as TrashIcon } from './icons';

const dialogTitles: Record<string, string> = { startup: "Codex Manager", archives: "Archive Management", sessions: "Conversation Cleanup", goals: "Codex Manager", snapshots: "Codex Manager", projects: "Codex Manager", "large-sessions": "Archive Management", storage: "About Codex" };
const sessionTools: MaintenanceTool[] = ["archives"];
const codexManagerTools: Array<{ id: MaintenanceTool | CodexInspection; label: string; inspect: boolean }> = [
  { id: "snapshots", label: "Shell snapshots", inspect: false },
  { id: "startup", label: "Codex UI startup", inspect: true },
  { id: "projects", label: "Missing projects", inspect: true }
];

export function MaintenanceTools(props: { sendAction: SendAction; targetDeviceId?: string; targetName: string; parentOpen: boolean; connected?: boolean }) {
  const [dialog, setDialog] = useState<string>();
  const [preview, setPreview] = useState<MaintenancePreview>();
  const [page, setPage] = useState<MaintenancePage>();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"recent" | "title" | "project">("recent");
  const [selected, setSelected] = useState(new Set<string>());
  const [confirmation, setConfirmation] = useState<{ ids?: string[]; operation: "delete" | "restore" }>();
  const [job, setJob] = useState<MaintenanceJob>();
  const [error, setError] = useState<string>();
  const [report, setReport] = useState<MaintenanceReport>();
  const [busy, setBusy] = useState(false);
  const origin = useRef({ id: props.targetDeviceId, name: props.targetName });
  const pageKey = useRef("");
  const pending = useRef(new Map<string, { action: DashboardActionName; timer: ReturnType<typeof setTimeout>; pageKey?: string }> ());
  const activeToken = useRef<string>();
  const attempted = useRef(false);
  const currentJob = useRef<MaintenanceJob>();
  const currentProps = useRef(props); currentProps.current = props;
  const clearPending = (id: string) => { clearTimeout(pending.current.get(id)?.timer); pending.current.delete(id); };
  const updateBusy = () => setBusy([...pending.current.values()].some(item => item.action !== 'getMaintenanceStatus'));
  const clearRequests = () => { for (const id of pending.current.keys()) clearPending(id); };
  useEffect(() => { if (!props.parentOpen) setDialog(undefined); }, [props.parentOpen]);
  const request = (action: DashboardActionName, payload: DashboardActionPayload = {}) => {
    if (currentProps.current.connected === false) return;
    // Tools owns action feedback so a late transport timeout cannot contradict verified progress.
    const id = currentProps.current.sendAction(action, undefined, { ...payload, automatic: true, targetDeviceId: origin.current.id });
    if (id) pending.current.set(id, { action, pageKey: action === 'getMaintenancePage' ? pageKey.current : undefined, timer: setTimeout(() => {
      clearPending(id); updateBusy();
      setError('Connection timed out. An accepted operation may still be running. Check status before starting another operation.');
    }, getActionTimeoutMs(action)) });
    return id;
  };
  const act = (action: DashboardActionName, payload: DashboardActionPayload = {}) => {
    if (action === 'runMaintenance') attempted.current = true;
    setBusy(true); setError(undefined);
    if (!request(action, payload)) { setBusy(false); setError("This system could not connect. Retry when online."); }
  };
  const inspect = (tool: MaintenanceTool) => {
    clearRequests(); origin.current = { id: props.targetDeviceId, name: props.targetName };
    activeToken.current = undefined; currentJob.current = undefined; attempted.current = false;
    setDialog(tool); setPreview(undefined); setPage(undefined); setQuery(""); setSearch(''); setSelected(new Set()); setConfirmation(undefined); setJob(undefined); setReport(undefined);
    act("previewMaintenance", { maintenanceTool: tool });
  };
  const check = (tool: string) => {
    clearRequests(); origin.current = { id: props.targetDeviceId, name: props.targetName };
    activeToken.current = undefined; currentJob.current = undefined; attempted.current = false;
    setDialog(tool); setPreview(undefined); setPage(undefined); setJob(undefined); setReport(undefined); setConfirmation(undefined);
    act("inspectMaintenanceStorage", { maintenanceInspection: tool as DashboardActionPayload["maintenanceInspection"] });
  };
  const loadPage = (offset: number) => {
    if (!preview || !props.parentOpen || !dialog || props.connected === false) return;
    pageKey.current = `${preview.token}:${query}:${offset}`;
    act("getMaintenancePage", { maintenanceToken: preview.token, maintenanceQuery: query, maintenanceOffset: offset });
  };
  const refreshStatus = () => {
    if ([...pending.current.values()].some(item => item.action === 'getMaintenanceStatus')) return;
    const known = currentJob.current;
    if (known || activeToken.current) request('getMaintenanceStatus', { maintenanceJobId: known?.id, maintenanceToken: activeToken.current });
  };
  useEffect(() => {
    const applyJob = (next: MaintenanceJob) => {
      currentJob.current = mergeMaintenanceJob(currentJob.current, next);
      setJob(currentJob.current); setConfirmation(undefined); setPreview(undefined); setPage(undefined);
    };
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type === 'dashboard:maintenance-progress') {
        if (message.deviceId !== origin.current.id || !isMaintenanceJob(message.job) ||
          !(currentJob.current?.id === message.job.id || activeToken.current && activeToken.current === message.job.previewToken)) return;
        if (mergeMaintenanceJob(currentJob.current, message.job) === currentJob.current) return;
        applyJob(message.job); setError(undefined);
        for (const [id, sent] of pending.current) if (sent.action === 'runMaintenance' || sent.action === 'cancelMaintenance' && (message.job.cancelRequested || message.job.status !== 'running')) clearPending(id);
        updateBusy();
        return;
      }
      if (message?.type !== "dashboard:action-result" || !pending.current.has(message.requestId)) return;
      const sent = pending.current.get(message.requestId)!;
      clearPending(message.requestId); updateBusy();
      if (sent.pageKey && sent.pageKey !== pageKey.current) return;
      if (message.status !== "completed") {
        setError(message.error ?? "The tool could not finish. Review current data before retrying.");
        if (sent.action === "getMaintenanceStatus" && message.error?.includes("no longer available") && currentJob.current?.status === 'running') {
          currentJob.current = { ...currentJob.current, status: 'unknown' }; setJob(currentJob.current);
        }
        return;
      }
      setError(undefined);
      if (!message.payload?.maintenancePreview && !message.payload?.maintenanceReport && !message.payload?.maintenancePage && !message.payload?.maintenanceJob) {
        setError("This host did not return tool data. Update the selected system and retry."); return;
      }
      if (message.payload?.maintenancePreview) { activeToken.current = message.payload.maintenancePreview.token; setPreview(message.payload.maintenancePreview); }
      if (message.payload?.maintenanceReport) setReport(message.payload.maintenanceReport);
      const nextPage = message.payload?.maintenancePage;
      if (nextPage && pageKey.current === `${nextPage.token}:${nextPage.query}:${nextPage.offset}`) setPage(nextPage);
      if (message.payload?.maintenanceJob) {
        const next = message.payload.maintenanceJob;
        if (!isMaintenanceJob(next) || next.previewToken && next.previewToken !== activeToken.current ||
          sent.action === 'getMaintenanceStatus' && currentJob.current && next.id !== currentJob.current.id) { setError('This host returned invalid progress. Refresh status before retrying.'); return; }
        applyJob(next);
      }
    };
    window.addEventListener("message", receive);
    return () => { window.removeEventListener("message", receive); clearRequests(); };
  }, []);
  useEffect(() => {
    if (!preview || !props.parentOpen || !dialog || props.connected === false) return;
    setPage(undefined);
    pageKey.current = `${preview.token}:${query}:0`;
    loadPage(0);
  }, [preview?.token, query, props.parentOpen, dialog, props.connected]);
  useEffect(() => {
    if (props.connected === false) {
      for (const [id, sent] of pending.current) if (sent.action === 'getMaintenanceStatus') clearPending(id);
      return;
    }
    if (!props.parentOpen || !dialog) return;
    const catchUp = () => { if (document.visibilityState !== 'hidden' && currentJob.current?.status === 'running') refreshStatus(); };
    catchUp(); window.addEventListener('focus', catchUp); document.addEventListener('visibilitychange', catchUp);
    return () => { window.removeEventListener('focus', catchUp); document.removeEventListener('visibilitychange', catchUp); };
  }, [props.parentOpen, props.connected, dialog, job?.id]);
  const running = job?.status === "running";
  const completedJob = job && job.status !== "running" ? job : undefined;
  const scopeChanged = (origin.current.id ?? 'local') !== (props.targetDeviceId ?? 'local');
  const count = confirmation?.ids?.length ?? preview?.count ?? 0;
  const storage = report?.storage;
  const pageSelected = page?.items.filter(item => selected.has(item.id)).length ?? 0;
  const sortedItems = [...(page?.items ?? [])].sort((left, right) => sort === "title" ? left.title.localeCompare(right.title) : sort === "project" ? (left.detail ?? "").localeCompare(right.detail ?? "") || left.title.localeCompare(right.title) : 0);
  const choose = (id: string, checked: boolean) => setSelected(current => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; });
  return <div class={`maintenance-tools ${dialog ? 'has-workspace' : ''}`}>
    <div class="maintenance-scope"><span>System</span><strong>{props.targetName}</strong>{props.connected === false ? <small>Offline · reconnect to run tools.</small> : null}</div>
    <div class="maintenance-layout">
    {!dialog ? <section class="maintenance-dashboard" aria-label="Codex Manager Tools">
      <header class="maintenance-dashboard-heading"><div><span class="maintenance-kicker">Codex Manager Tools</span><strong>Keep Codex fast, tidy, and recoverable</strong></div><button class="settings-action-btn" type="button" disabled={props.connected === false || busy || running} onClick={() => check("storage")}>{busy ? "Reading…" : "About Codex"}</button></header>
      <div class="maintenance-dashboard-grid">
        <button class="maintenance-dashboard-card" type="button" disabled={props.connected === false || busy || running} onClick={() => inspect("archives")}><span class="maintenance-dashboard-icon">⌘</span><span><strong>Archive Management</strong><small>Restore archives or remove old conversations.</small></span><span aria-hidden="true">→</span></button>
        <button class="maintenance-dashboard-card" type="button" disabled={props.connected === false || busy || running} onClick={() => inspect("snapshots")}><span class="maintenance-dashboard-icon">✦</span><span><strong>Codex Manager</strong><small>Startup recovery, shell snapshots, and missing projects.</small></span><span aria-hidden="true">→</span></button>
        <button class="maintenance-dashboard-card" type="button" disabled={props.connected === false || busy || running} onClick={() => check("storage")}><span class="maintenance-dashboard-icon">ⓘ</span><span><strong>About Codex</strong><small>Compact storage, database, and workspace health overview.</small></span><span aria-hidden="true">→</span></button>
      </div>
    </section> : null}
    <ModalShell open={Boolean(dialog && props.parentOpen)} title={dialogTitles[dialog ?? ""] ?? 'Codex tools'} closeLabel="Close tool" className="maintenance-tool-modal" onClose={() => { if (confirmation) setConfirmation(undefined); else setDialog(undefined); }}>
      {dialog ? <section class="maintenance-workspace" role="region" aria-label={dialogTitles[dialog] ?? 'Codex tools'}>
      <div class="maintenance-toolbar"><span class="maintenance-system" title={origin.current.name}>{origin.current.name}</span><button class="settings-action-btn maintenance-back" type="button" onClick={() => setDialog(undefined)}><span aria-hidden="true">←</span> All tools</button></div>
      {codexManagerTools.some(tool => tool.id === dialog) ? <div class="maintenance-tabs" role="tablist" aria-label="Codex Manager"><button type="button" role="tab" aria-selected={dialog === "snapshots"} onClick={() => dialog !== "snapshots" && inspect("snapshots")}>Snapshots</button><button type="button" role="tab" aria-selected={dialog === "startup"} onClick={() => dialog !== "startup" && check("startup")}>Startup</button><button type="button" role="tab" aria-selected={dialog === "projects"} onClick={() => dialog !== "projects" && check("projects")}>Projects</button></div> : null}
      {scopeChanged ? <p role="alert" class="settings-notice-warning">This preview belongs to {origin.current.name}. Choose a tool again to load {props.targetName} before changing data.</p> : null}
      {error ? <p class="settings-notice-warning" role="alert">{error}</p> : null}
      {dialog === 'startup' ? <button class="settings-action-btn" type="button" disabled={props.connected === false || busy || scopeChanged} onClick={() => act('reopenCodexUi')}>{busy ? 'Working...' : 'Open fresh Codex panel'}</button> : null}
      {busy && !page && !report && !job ? <p class="settings-note" role="status">Reading this system's data…</p> : null}
      {report ? <section class={`maintenance-report${storage ? " has-storage" : ""}`} aria-label={report.title}>{storage ? <section class="maintenance-storage-summary" aria-label="Storage summary"><div class="maintenance-storage-total"><span>Storage footprint</span><strong>{storage.totalBytes.toLocaleString()} bytes</strong></div>{storage.database ? <section class="maintenance-storage-projects" aria-label="Database allocation"><strong>Database allocation{storage.database.complete ? "" : " · partial"}</strong>{[["Allocated pages", storage.database.allocatedBytes], ["Live pages", storage.database.liveBytes], ["Reusable inside databases", storage.database.reusableBytes], ["Write-ahead logs (WAL)", storage.database.walBytes], ["Shared-memory files", storage.database.sharedMemoryBytes]].map(([label, bytes]) => <div key={String(label)}><span>{label}</span><small>{Number(bytes).toLocaleString()} bytes</small></div>)}<p>Reusable pages are already free for Codex to reuse. Deleting archives may not shrink database files. This check changes no data.</p></section> : null}<div class="maintenance-storage-heatmap" aria-label="Storage heatmap">{storage.buckets.map(bucket => { const width = `${Math.max(4, Math.round(bucket.bytes / Math.max(storage.buckets[0]?.bytes ?? 1, 1) * 100))}%`; return <div class="maintenance-storage-bucket" key={bucket.label} title={`${bucket.label}: ${bucket.detail}`}><div><span>{bucket.label}</span><strong>{bucket.detail}</strong></div><i style={{ width }} /></div>; })}</div>{storage.projects.length ? <div class="maintenance-storage-projects"><strong>Largest projects</strong>{storage.projects.map(project => <div key={project.label}><span title={project.label}>{project.label}</span><small>{project.detail}</small></div>)}</div> : null}</section> : null}<dl>{report.items.map((item, index) => <div key={index}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl><button class="settings-action-btn" type="button" disabled={props.connected === false || busy} onClick={() => check(dialog!)}>Refresh report</button></section> : null}
      {preview ? <>
        {preview.warning ? <p class="settings-notice-warning" role="status">{preview.warning}</p> : null}
        <form class="maintenance-search" onSubmit={event => { event.preventDefault(); if (!busy && !confirmation) { if (query === search) loadPage(0); else setQuery(search); } }}><input class="settings-text-input" type="search" aria-label="Search tool items" placeholder={preview.tool === "archives" ? "Find archived conversations…" : "Search titles and projects…"} maxLength={256} value={search} disabled={Boolean(confirmation)} onInput={event => setSearch(event.currentTarget.value)} /><button class="settings-action-btn maintenance-icon-button" type="submit" aria-label="Search" title="Search" disabled={props.connected === false || busy || Boolean(confirmation)}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg></button><button class="settings-action-btn maintenance-icon-button" type="button" aria-label="Refresh" title="Refresh" disabled={props.connected === false || busy || Boolean(confirmation)} onClick={() => inspect(preview.tool)}><RefreshIcon /></button></form>
        <div class="maintenance-selection">
          <label class="maintenance-select-page" title="Select or deselect this page"><input type="checkbox" aria-label="Select page" checked={Boolean(page?.items.length && pageSelected === page.items.length)} ref={input => { if (input) input.indeterminate = pageSelected > 0 && pageSelected < (page?.items.length ?? 0); }} disabled={props.connected === false || !page?.items.length || busy || Boolean(confirmation)} onChange={event => { const checked = event.currentTarget.checked; setSelected(current => { const next = new Set(current); for (const item of page?.items ?? []) { if (checked) next.add(item.id); else next.delete(item.id); } return next; }); }} /><span>{page ? `${page.total.toLocaleString()} ${query ? "matching" : page.total === 1 ? "item" : "items"}` : `${preview.count.toLocaleString()} ${preview.count === 1 ? "item" : "items"}`}</span></label>
          {sessionTools.includes(dialog as MaintenanceTool) ? <label class="maintenance-sort">Sort <select value={sort} disabled={busy || Boolean(confirmation)} onChange={event => setSort(event.currentTarget.value as typeof sort)}><option value="recent">Recent</option><option value="title">Title</option><option value="project">Project</option></select></label> : null}
          {selected.size ? <><span class="maintenance-selected-count" role="status">{selected.size.toLocaleString()} selected</span><button class="settings-action-btn maintenance-clear" type="button" disabled={Boolean(confirmation)} onClick={() => setSelected(new Set())}>Clear selection</button></> : null}
          {!confirmation ? <div class="maintenance-row-actions">
            {selected.size ? <>{preview.tool === "archives" ? <button class="settings-action-btn" type="button" disabled={props.connected === false || busy || scopeChanged} onClick={() => setConfirmation({ ids: [...selected], operation: "restore" })}>Restore selected</button> : null}<button class="settings-action-btn maintenance-icon-button is-danger" type="button" aria-label="Delete selected" title="Delete selected" disabled={props.connected === false || busy || scopeChanged} onClick={() => setConfirmation({ ids: [...selected], operation: "delete" })}><TrashIcon /></button></> : null}
            {preview.tool !== "large-sessions" ? <details class="maintenance-more" onKeyDown={event => { if (event.key === "Escape" && event.currentTarget.open) { event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}><summary tabIndex={0} class="settings-action-btn maintenance-icon-button" aria-label="More cleanup actions" title="More cleanup actions"><span aria-hidden="true">···</span></summary><div><button class="settings-action-btn is-danger" type="button" disabled={props.connected === false || busy || scopeChanged || !preview.count} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setConfirmation({ operation: "delete" }); }}>{MAINTENANCE_TOOLS.find(tool => tool.id === preview.tool)?.title}</button></div></details> : null}
          </div> : null}
        </div>
        <div class="maintenance-items" role="group" aria-label="Tool items" aria-busy={busy}>
          {sortedItems.length ? sortedItems.map(item => <label class={`maintenance-item${selected.has(item.id) ? " is-selected" : ""}`} key={item.id} title={`${item.title}${item.detail ? `\n${item.detail}` : ""}`}><input type="checkbox" aria-label={`Select ${item.title}`} disabled={props.connected === false || busy || Boolean(confirmation)} checked={selected.has(item.id)} onChange={event => choose(item.id, event.currentTarget.checked)} /><span><strong>{item.title}</strong>{item.detail ? <small>{item.detail}</small> : null}</span></label>) : !busy ? <div class="maintenance-empty" role="status">{query ? "No matching items." : "Nothing to clean up."}</div> : null}
        </div>
        {page && page.total > 50 ? <div class="maintenance-pagination"><button class="settings-action-btn" type="button" disabled={props.connected === false || busy || page.offset === 0 || Boolean(confirmation)} onClick={() => loadPage(Math.max(0, page.offset - 50))}>Previous</button><span>{page.offset + 1}–{Math.min(page.offset + 50, page.total)} of {page.total.toLocaleString()}</span><button class="settings-action-btn" type="button" disabled={props.connected === false || busy || page.offset + 50 >= page.total || Boolean(confirmation)} onClick={() => loadPage(page.offset + 50)}>Next</button></div> : null}
      </> : null}
      {attempted.current && !job ? <button class="settings-action-btn" type="button" disabled={props.connected === false} onClick={refreshStatus}>Check operation status</button> : null}
      {running ? <section class="maintenance-review" aria-label="Maintenance progress" aria-live="polite"><strong>{job.operation === "restore" ? "Restore" : "Cleanup"} in progress</strong>
        <progress max={Math.max(1, job.total)} value={job.processed} aria-label="Maintenance progress" /><p>{job.processed} / {job.total} checked · {job.cleared} {job.operation === "restore" ? "restored" : "cleared"} · {job.skipped} kept · {job.failed} failed</p>
        <p>{job.cancelRequested ? "Stopping after the current items finish…" : "Working in the background. You can keep using the dashboard."}</p>
        <div class="settings-actions"><button class="settings-action-btn" type="button" disabled={props.connected === false} onClick={refreshStatus}>Refresh status</button><button class="settings-action-btn" type="button" disabled={props.connected === false || busy || job.cancelRequested || scopeChanged} onClick={() => act("cancelMaintenance", { maintenanceJobId: job.id })}>Cancel operation</button></div>
      </section> : null}
      {!busy && error && !preview && !job && !report ? <button class="settings-action-btn" type="button" disabled={props.connected === false} onClick={() => MAINTENANCE_TOOLS.some(tool => tool.id === dialog) ? inspect(dialog as MaintenanceTool) : check(dialog!)}>Retry</button> : null}
      </section> : null}
    </ModalShell>
    <ModalShell open={Boolean(confirmation)} title={confirmation?.operation === "restore" ? "Restore conversations" : "Delete conversations permanently"} closeLabel="Close confirmation" className="maintenance-confirm-modal" onClose={() => { if (!busy) setConfirmation(undefined); }}>
      {confirmation ? <div class="maintenance-confirm-content"><span class="maintenance-kicker">Confirm action</span><strong>{confirmation.operation === "restore" ? "Restore" : "Permanently delete"} {count.toLocaleString()} {count === 1 ? "conversation" : "conversations"}?</strong><p>{confirmation.operation === "restore" ? "Return the selected conversations to active Codex history. Their messages and goals stay intact." : "This cannot be undone. Running or unavailable conversations are kept and reported."}</p><div class="settings-actions"><button class="settings-action-btn" type="button" disabled={props.connected === false || busy} onClick={() => setConfirmation(undefined)}>Cancel</button><button class={`settings-action-btn ${confirmation.operation === "delete" ? "is-danger" : ""}`} type="button" disabled={props.connected === false || busy || scopeChanged} onClick={() => { const action = { maintenanceToken: preview?.token, maintenanceIds: confirmation.ids, maintenanceOperation: confirmation.operation, confirmed: true }; setConfirmation(undefined); act("runMaintenance", action); }}>{busy ? "Starting…" : confirmation.operation === "restore" ? "Restore selected" : "Delete permanently"}</button></div></div> : null}
    </ModalShell>
    <ModalShell open={Boolean(completedJob)} title={completedJob?.operation === "restore" ? "Restore result" : "Cleanup result"} closeLabel="Close result" className="maintenance-result-modal" onClose={() => setJob(undefined)}>
      {completedJob ? <section class="maintenance-result" aria-live="polite"><span class="maintenance-kicker">Operation complete</span><strong>{completedJob.processed} / {completedJob.total} checked</strong><div class="maintenance-result-metrics"><span><b>{completedJob.operation === "restore" ? completedJob.cleared : completedJob.cleared}</b><small>{completedJob.operation === "restore" ? "restored" : "cleared"}</small></span><span><b>{completedJob.skipped}</b><small>kept</small></span><span><b>{completedJob.failed}</b><small>failed</small></span></div><p>{completedJob.status === "unknown" ? "The host restarted or became unavailable. Review current data before retrying; the previous outcome is unconfirmed." : completedJob.status === "cancelled" ? "Cancelled. Remaining items were kept." : completedJob.status === "failed" ? "Some items could not be processed. Review the details before retrying." : "All checked items have been reported."}</p>{completedJob.errors.length ? <details open={completedJob.status === "failed"}><summary>Details ({completedJob.errors.length})</summary><ul>{completedJob.errors.map((text, index) => <li key={index}>{text}</li>)}</ul></details> : null}<div class="settings-actions"><button class="settings-action-btn" type="button" disabled={props.connected === false} onClick={refreshStatus}>Refresh status</button><button class="settings-action-btn" type="button" disabled={props.connected === false} onClick={() => { setJob(undefined); inspect(completedJob.tool); }}>Review current data</button></div></section> : null}
    </ModalShell>
    </div>
    {!dialog && job ? <div class="maintenance-job-summary" role="status"><span>{dialogTitles[job.tool]} · {running ? 'In progress' : 'Review result'}</span><button class="settings-action-btn" type="button" onClick={() => setDialog(job.tool)}>View {running ? 'progress' : 'result'}</button></div> : null}
    {!dialog && error ? <p class="settings-notice-warning" role="alert">{error}</p> : null}
  </div>;
}
