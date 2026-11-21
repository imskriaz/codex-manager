import { useEffect, useState } from "preact/hooks";
import { request } from "./teamSettingsRequest";
import { SettingsRecordList, SettingsRecordDetails } from "./settingsRecordList";
import type { OfficeAuditEntry } from "../../src/services/officeAudit";
import type { ApiProxySnapshot } from "../../src/domain/dashboard/apiProxy";

export function TeamActivity(props: { view: "logs" | "proxy"; open?: boolean }) {
  const [audit, setAudit] = useState<OfficeAuditEntry[]>([]);
  const [proxy, setProxy] = useState<ApiProxySnapshot>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [updated, setUpdated] = useState("");
  const load = async () => {
    setBusy(true); setError("");
    try {
      const body = await request<ApiProxySnapshot & { entries?: OfficeAuditEntry[] }>(`/api/office/${props.view}`);
      if (props.view === "logs") setAudit(body.entries ?? []); else setProxy(body);
      setUpdated(new Date().toLocaleTimeString());
    } catch (value) { setError(value instanceof Error ? value.message : "Management data could not be loaded."); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, [props.view]);
  const query = filter.toLowerCase();
  const rows = props.view === "logs" ? audit.map(entry => ({ id: entry.id, at: entry.at, actor: entry.actor.email || entry.actor.name, action: entry.action, status: entry.status, detail: entry.sessionId ? `Session ${entry.sessionId}` : "" }))
    : (proxy?.requests ?? []).map(entry => ({ id: entry.id, at: entry.startedAt, actor: entry.actor?.email || entry.actor?.name || entry.apiKeyName || "Unidentified request", action: `${entry.method} ${entry.path}`, status: entry.status, detail: [entry.upstreamModel || entry.model, entry.durationMs === undefined ? undefined : `${entry.durationMs} ms`, entry.inputTokens === undefined ? undefined : `${entry.inputTokens} input tokens`, entry.outputTokens === undefined ? undefined : `${entry.outputTokens} output tokens`, entry.error].filter(Boolean).join(" · ") }));
  const filtered = rows.filter(row => `${row.actor} ${row.action} ${row.status} ${row.detail}`.toLowerCase().includes(query));
  return <div class="team-activity">
    <div class="team-list-toolbar"><input type="search" aria-label={`Filter ${props.view}`} placeholder="Filter by user, action, or status…" value={filter} onInput={event => setFilter(event.currentTarget.value)} /><button class="team-button" type="button" disabled={busy} onClick={() => void load()}>{busy ? "Refreshing…" : "Refresh"}</button></div>
    <p class="team-activity-note">{props.view === "logs" ? "Recent user actions and outcomes. Master sign-in credentials and message contents are excluded. Up to 500 events are retained." : "Recent proxy requests, who initiated them, running status, models, timing, and token use. Request history covers this host process."}{updated ? ` Updated ${updated}.` : ""}</p>
    {error ? <div class="team-notice is-error" role="alert">{error}</div> : null}
    <div role="status" aria-live="polite">{busy ? "Loading activity…" : error ? "Activity could not be refreshed. Previously loaded records are kept." : query ? `${filtered.length} of ${rows.length} records match.` : `${rows.length} records loaded.`}</div>
    <SettingsRecordList label={props.view === "logs" ? "User audit log" : "Proxy requests"} open={props.open} columns={["Action", "User", "Status", "Time"]} rows={filtered.map(row => ({ id: row.id, label: row.action, cells: [row.action, row.actor, row.status, new Date(row.at).toLocaleTimeString()], details: <SettingsRecordDetails fields={[["Action",row.action],["User",row.actor],["Status",row.status],["Time",new Date(row.at).toLocaleString()],["Details",row.detail]]} /> }))} />
    {!filtered.length && !busy && !error ? <p class="team-empty">{query && rows.length ? "No activity matches your filter." : "No activity has been recorded yet."}</p> : null}
  </div>;
}
