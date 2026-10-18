import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";

const consoleDateFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function parseSystemLogRecords(records: unknown[]) {
  return records.slice(-1_000).flatMap((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    if (typeof row["message"] !== "string") return [];
    const timestamp = typeof row["timestamp"] === "string" && Number.isFinite(Date.parse(row["timestamp"])) ? row["timestamp"] : undefined;
    const level = ["debug", "info", "warning", "error"].includes(String(row["level"])) ? String(row["level"]) : "info";
    const host = typeof row["hostRunId"] === "string" ? row["hostRunId"] : "";
    const sequence = typeof row["sequence"] === "number" && Number.isSafeInteger(row["sequence"]) ? row["sequence"] : index;
    return [{ key: `${timestamp ?? "unknown"}:${host}:${sequence}`, timestamp, level,
      scope: typeof row["scope"] === "string" ? row["scope"].slice(0, 100) : "system",
      message: row["message"].slice(0, 4_096), details: JSON.stringify(row, null, 2).slice(0, 65_536) }];
  });
}

export function SystemLogConsole(props: { records: unknown[]; loading: boolean; emptyMessage?: string }) {
  const records = useMemo(() => parseSystemLogRecords(props.records), [props.records]);
  const [filter, setFilter] = useState("all");
  const [following, setFollowing] = useState(true);
  const follow = useRef(true);
  const viewport = useRef<HTMLDivElement>(null);
  const visible = records.filter(row => filter === "all" || row.level === filter);
  const errors = records.filter(row => row.level === "error").length;
  const warnings = records.filter(row => row.level === "warning").length;
  const scrollToLatest = () => {
    follow.current = true;
    setFollowing(true);
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  };
  useLayoutEffect(() => { if (follow.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }, [props.records, filter]);
  return <>
    <div class="system-log-toolbar">
      <div class="system-log-summary" aria-label="Log summary"><strong>{records.length}</strong> entries <span class="is-error">{errors} errors</span><span class="is-warning">{warnings} warnings</span></div>
      <select class="settings-select" aria-label="Filter log entries" value={filter} onChange={event => setFilter(event.currentTarget.value)}>
        <option value="all">All levels</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Info</option><option value="debug">Debug</option>
      </select>
    </div>
    <div class="log-console-output" ref={viewport} tabIndex={0} role="region" aria-label="Log records" aria-busy={props.loading}
      onScroll={() => {
        const node = viewport.current;
        if (!node) return;
        follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        setFollowing(follow.current);
      }}>
      {!visible.length ? <div class="system-log-empty">{props.emptyMessage ?? (records.length ? "No entries match this level." : props.loading ? "Loading logs…" : "No saved logs.")}</div> : visible.map(row => <details class={`system-log-entry is-${row.level}`} key={row.key} onToggle={event => { if (event.currentTarget.open) { follow.current = false; setFollowing(false); } }}>
        <summary><time dateTime={row.timestamp} title={row.timestamp ? new Date(row.timestamp).toLocaleString() : "Date unavailable"}>{row.timestamp ? consoleDateFormat.format(new Date(row.timestamp)) : "—"}</time><span class="system-log-level">{row.level === "warning" ? "warn" : row.level}</span><span class="system-log-message"><span class="system-log-scope">{row.scope}</span>{row.message}</span></summary>
        <pre>{row.details}</pre>
      </details>)}
    </div>
    <div class="system-log-follow"><span>{following ? "Following latest entries" : "Auto-scroll paused"}</span><button class="settings-action-btn" type="button" disabled={following} onClick={scrollToLatest}>Latest ↓</button></div>
  </>;
}
