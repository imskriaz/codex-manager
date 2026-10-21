import { useEffect, useRef, useState } from "preact/hooks";
import { CODEX_INSPECTIONS, MAINTENANCE_TOOLS, type MaintenanceJob, type MaintenancePreview, type MaintenancePage, type MaintenanceTool, type MaintenanceReport } from "../../src/domain/maintenance";
import type { DashboardActionName, DashboardActionPayload, DashboardHostMessage } from "../../src/domain/dashboard/types";
import type { SendAction } from "./hookTypes";

const dialogTitles: Record<string, string> = { archives: "Archive manager", sessions: "Conversation cleanup", goals: "Goal manager", snapshots: "Shell snapshot cleanup", projects: "Missing projects", "large-sessions": "Largest conversations", storage: "Codex storage check" };

export function MaintenanceTools(props: { sendAction: SendAction; targetDeviceId?: string; targetName: string; parentOpen: boolean }) {
  const [dialog, setDialog] = useState<string>();
  const [preview, setPreview] = useState<MaintenancePreview>();
  const [page, setPage] = useState<MaintenancePage>();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(new Set<string>());
  const [confirmation, setConfirmation] = useState<{ ids?: string[]; operation: "delete" | "restore" }>();
  const [job, setJob] = useState<MaintenanceJob>();
  const [error, setError] = useState<string>();
  const [report, setReport] = useState<MaintenanceReport>();
  const [busy, setBusy] = useState(false);
  const origin = useRef({ id: props.targetDeviceId, name: props.targetName });
  const pageKey = useRef("");
  const pending = useRef(new Map<string, { action: DashboardActionName; at: number }> ());
  useEffect(() => { if (!props.parentOpen) setDialog(undefined); }, [props.parentOpen]);
  const request = (action: DashboardActionName, payload: DashboardActionPayload = {}, automatic = false) => {
    const id = props.sendAction(action, undefined, { ...payload, automatic, targetDeviceId: origin.current.id });
    if (id) pending.current.set(id, { action, at: Date.now() });
    return id;
  };
  const act = (action: DashboardActionName, payload: DashboardActionPayload = {}) => {
    setBusy(true); setError(undefined);
    if (!request(action, payload)) { setBusy(false); setError("This system could not connect. Retry when online."); }
  };
  const inspect = (tool: MaintenanceTool) => {
    pending.current.clear(); origin.current = { id: props.targetDeviceId, name: props.targetName };
    setDialog(tool); setPreview(undefined); setPage(undefined); setQuery(""); setSelected(new Set()); setConfirmation(undefined); setJob(undefined); setReport(undefined);
    act("previewMaintenance", { maintenanceTool: tool });
  };
  const check = (tool: string) => {
    pending.current.clear(); origin.current = { id: props.targetDeviceId, name: props.targetName };
    setDialog(tool); setPreview(undefined); setPage(undefined); setJob(undefined); setReport(undefined); setConfirmation(undefined);
    act("inspectMaintenanceStorage", { maintenanceInspection: tool as DashboardActionPayload["maintenanceInspection"] });
  };
  const loadPage = (offset: number) => {
    if (!preview) return;
    pageKey.current = `${preview.token}:${query}:${offset}`;
    act("getMaintenancePage", { maintenanceToken: preview.token, maintenanceQuery: query, maintenanceOffset: offset });
  };
  useEffect(() => {
    const receive = (event: MessageEvent<DashboardHostMessage>) => {
      const message = event.data;
      if (message?.type !== "dashboard:action-result" || !pending.current.has(message.requestId)) return;
      const sent = pending.current.get(message.requestId)!;
      pending.current.delete(message.requestId);
      if (sent.action !== "getMaintenanceStatus") setBusy([...pending.current.values()].some(item => item.action !== "getMaintenanceStatus"));
      if (message.status !== "completed") {
        setError(message.error ?? "The tool could not finish. Review current data before retrying.");
        if (sent.action === "getMaintenanceStatus" && message.error?.includes("no longer available")) setJob(current => current ? { ...current, status: "unknown" } : current);
        return;
      }
      setError(undefined);
      if (!message.payload?.maintenancePreview && !message.payload?.maintenanceReport && !message.payload?.maintenancePage && !message.payload?.maintenanceJob) {
        setError("This host did not return tool data. Update the selected system and retry."); return;
      }
      if (message.payload?.maintenancePreview) setPreview(message.payload.maintenancePreview);
      if (message.payload?.maintenanceReport) setReport(message.payload.maintenanceReport);
      const nextPage = message.payload?.maintenancePage;
      if (nextPage && pageKey.current === `${nextPage.token}:${nextPage.query}:${nextPage.offset}`) setPage(nextPage);
      if (message.payload?.maintenanceJob) {
        const next = message.payload.maintenanceJob;
        setJob(current => current?.id === next.id && (current.processed > next.processed || (current.status !== "running" && next.status === "running")) ? current : { ...next, cancelRequested: current?.id === next.id && current.cancelRequested || next.cancelRequested });
        setConfirmation(undefined); setPreview(undefined); setPage(undefined);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(() => {
    if (!preview) return;
    setPage(undefined);
    pageKey.current = `${preview.token}:${query}:0`;
    const timer = setTimeout(() => loadPage(0), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [preview?.token, query]);
  useEffect(() => {
    if (job?.status !== "running" && !busy) return;
    const poll = () => {
      for (const [id, sent] of pending.current) if (Date.now() - sent.at > 30_000) {
        pending.current.delete(id); setBusy(false);
        setError("Connection timed out. An accepted operation may still be running; check its status before retrying.");
      }
      if (job?.status === "running" && ![...pending.current.values()].some(sent => sent.action === "getMaintenanceStatus")) request("getMaintenanceStatus", { maintenanceJobId: job.id }, true);
    };
    poll(); const timer = setInterval(poll, 2_000);
    return () => clearInterval(timer);
  }, [job?.id, job?.status, busy, props.sendAction]);
  const running = job?.status === "running";
  const scopeChanged = (origin.current.id ?? 'local') !== (props.targetDeviceId ?? 'local');
  const count = confirmation?.ids?.length ?? preview?.count ?? 0;
  const choose = (id: string, checked: boolean) => setSelected(current => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; });
  return <div class={`maintenance-tools ${dialog ? 'has-workspace' : ''}`}>
    <div class="maintenance-scope"><span>System</span><strong>{props.targetName}</strong><small>Preview first. Running work stays protected.</small></div>
    <div class="maintenance-layout">
    <nav class="maintenance-tool-grid" aria-label="Maintenance tools">{[...MAINTENANCE_TOOLS.map(tool => ({...tool, label:dialogTitles[tool.id], inspection:false})),...CODEX_INSPECTIONS.map(tool => ({...tool,label:tool.title,inspection:true}))].map(tool => <button class="maintenance-tool" type="button" key={tool.id} aria-pressed={dialog === tool.id} disabled={busy || running} onClick={() => tool.inspection ? check(tool.id) : inspect(tool.id as MaintenanceTool)}><span class="maintenance-tool-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d={tool.inspection ? 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6' : tool.id === 'archives' ? 'M3 4h18v4H3zM5 8v12h14V8M9 12h6' : 'M5 6h14M9 6V3h6v3M7 6l1 15h8l1-15M10 10v7m4-7v7'} /></svg></span><span><strong>{tool.label}</strong><small>{tool.description}</small></span><span class="maintenance-tool-kind">{tool.inspection ? 'Inspect' : 'Manage'} →</span></button>)}</nav>
    {dialog && props.parentOpen ? <section class="maintenance-workspace" role="region" aria-label={dialogTitles[dialog] ?? 'Codex tools'} onKeyDown={event => { if(event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if(confirmation) setConfirmation(undefined); else setDialog(undefined); } }}>
      <header class="maintenance-workspace-head"><div><strong>{dialogTitles[dialog]}</strong><small>{origin.current.name}</small></div><button class="settings-action-btn" type="button" onClick={() => setDialog(undefined)}>All tools</button></header>
      <div class="maintenance-modal-context"><strong>{origin.current.name}</strong><span>{preview ? `${preview.count.toLocaleString()} items` : "Codex storage"}</span></div>
      {scopeChanged ? <p role="alert" class="settings-notice-warning">This preview belongs to {origin.current.name}. Choose a tool again to load {props.targetName} before changing data.</p> : null}
      {error ? <p class="settings-notice-warning" role="alert">{error}</p> : null}
      {busy && !page && !report && !job ? <p class="settings-note" role="status">Reading this system's data…</p> : null}
      {report ? <section class="maintenance-report" aria-label={report.title}><dl>{report.items.map((item, index) => <div key={index}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl><button class="settings-action-btn" type="button" disabled={busy} onClick={() => check(dialog!)}>Refresh report</button></section> : null}
      {preview ? <>
        <div class="maintenance-search"><input class="settings-text-input" type="search" aria-label="Search tool items" placeholder={preview.tool === "archives" ? "Find archived conversations…" : "Search titles and projects…"} maxLength={256} value={query} disabled={Boolean(confirmation)} onInput={event => setQuery(event.currentTarget.value)} /><button class="settings-action-btn" type="button" disabled={busy} onClick={() => inspect(preview.tool)}>Refresh</button></div>
        <div class="maintenance-selection"><span>{selected.size} selected{page ? ` · ${page.total.toLocaleString()} matching` : ""}</span><button class="settings-action-btn" type="button" disabled={!page?.items.length || busy || Boolean(confirmation)} onClick={() => setSelected(current => new Set([...current, ...page!.items.map(item => item.id)]))}>Select page</button><button class="settings-action-btn" type="button" disabled={!selected.size || Boolean(confirmation)} onClick={() => setSelected(new Set())}>Clear selection</button></div>
        <div class="maintenance-items" role="group" aria-label="Tool items" aria-busy={busy}>
          {page?.items.length ? page.items.map(item => <label class="maintenance-item" key={item.id}><input type="checkbox" aria-label={`Select ${item.title}`} disabled={busy || Boolean(confirmation)} checked={selected.has(item.id)} onChange={event => choose(item.id, event.currentTarget.checked)} /><span><strong>{item.title}</strong>{item.detail ? <small>{item.detail}</small> : null}</span></label>) : !busy ? <div class="maintenance-empty">{query ? "No matching items." : "Nothing to clean up."}</div> : null}
        </div>
        {page && page.total > 50 ? <div class="maintenance-pagination"><button class="settings-action-btn" type="button" disabled={busy || page.offset === 0 || Boolean(confirmation)} onClick={() => loadPage(Math.max(0, page.offset - 50))}>Previous</button><span>{page.offset + 1}–{Math.min(page.offset + 50, page.total)} of {page.total.toLocaleString()}</span><button class="settings-action-btn" type="button" disabled={busy || page.offset + 50 >= page.total || Boolean(confirmation)} onClick={() => loadPage(page.offset + 50)}>Next</button></div> : null}
        {confirmation ? <section class="maintenance-confirm" aria-label="Confirm maintenance"><strong>{confirmation.operation === "restore" ? "Restore" : "Permanently delete"} {count.toLocaleString()} items?</strong><p>{confirmation.operation === "restore" ? "Return these conversations to the active Codex history." : "Deletion cannot be undone. Running, unavailable, or unselected child conversations are kept and reported."}</p><div class="settings-actions"><button class="settings-action-btn" type="button" disabled={busy} onClick={() => setConfirmation(undefined)}>Cancel</button><button class={`settings-action-btn ${confirmation.operation === "delete" ? "is-danger" : ""}`} type="button" disabled={busy || scopeChanged} onClick={() => act("runMaintenance", { maintenanceToken: preview.token, maintenanceIds: confirmation.ids, maintenanceOperation: confirmation.operation, confirmed: true })}>{busy ? "Starting…" : confirmation.operation === "restore" ? "Restore selected" : "Delete permanently"}</button></div></section> : <div class="maintenance-footer">
          {preview.tool === "archives" ? <button class="settings-action-btn" type="button" disabled={busy || scopeChanged || !selected.size} onClick={() => setConfirmation({ ids: [...selected], operation: "restore" })}>Restore selected</button> : null}
          <button class="settings-action-btn" type="button" disabled={busy || scopeChanged || !selected.size} onClick={() => setConfirmation({ ids: [...selected], operation: "delete" })}>Delete selected</button><button class="settings-action-btn is-danger" type="button" disabled={busy || scopeChanged || !preview.count} onClick={() => setConfirmation({ operation: "delete" })}>{MAINTENANCE_TOOLS.find(tool => tool.id === preview.tool)?.title}</button>
        </div>}
      </> : null}
      {job ? <section class="maintenance-review" aria-label="Maintenance progress" aria-live="polite"><strong>{job.operation === "restore" ? "Restore" : "Cleanup"} {running ? "in progress" : job.status === "completed" ? "complete" : "result"}</strong>
        <progress max={Math.max(1, job.total)} value={job.processed} aria-label="Maintenance progress" /><p>{job.processed} / {job.total} checked · {job.cleared} {job.operation === "restore" ? "restored" : "cleared"} · {job.skipped} kept · {job.failed} failed</p>
        <p>{running ? job.cancelRequested ? "Stopping after the current items finish…" : "Working in the background. You can keep using the dashboard." : job.status === "unknown" ? "The host restarted or became unavailable. Review current data before retrying; the previous outcome is unconfirmed." : job.status === "cancelled" ? "Cancelled. Remaining items were kept." : job.status === "failed" ? "Some items could not be processed. Review the details before retrying." : "All checked items have been reported."}</p>
        {job.errors.length ? <details><summary>Details ({job.errors.length})</summary><ul>{job.errors.map((text, index) => <li key={index}>{text}</li>)}</ul></details> : null}
        {running ? <button class="settings-action-btn" type="button" disabled={busy || job.cancelRequested} onClick={() => act("cancelMaintenance", { maintenanceJobId: job.id })}>Cancel operation</button> : <button class="settings-action-btn" type="button" onClick={() => inspect(job.tool)}>Review current data</button>}
      </section> : null}
      {!busy && error && !preview && !job && !report ? <button class="settings-action-btn" type="button" onClick={() => MAINTENANCE_TOOLS.some(tool => tool.id === dialog) ? inspect(dialog as MaintenanceTool) : check(dialog!)}>Retry</button> : null}
    </section> : null}
    </div>
    {!dialog && job ? <div class="maintenance-job-summary" role="status"><span>{dialogTitles[job.tool]} · {running ? 'In progress' : 'Review result'}</span><button class="settings-action-btn" type="button" onClick={() => setDialog(job.tool)}>View {running ? 'progress' : 'result'}</button></div> : null}
  </div>;
}
