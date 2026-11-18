import type { ApiProxySnapshot, ApiProxyRequestLog } from "../../src/domain/dashboard/apiProxy";
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiProxyConnection, type ApiProxyKeyAccess } from "./apiProxyConnection";
import { ApiProxyRoutes } from "./apiProxyRoutes";
import { getSensitiveDisplayValue } from "./helpers";

function RequestTable({
  requests,
  detailed,
  privacyMode
}: {
  requests: ApiProxyRequestLog[];
  detailed: boolean;
  privacyMode: boolean;
}) {
  const tokens = (value?: number) => (value === undefined ? "—" : value.toLocaleString());
  return (
    <div
      class="api-proxy-table-scroll"
      role="region"
      aria-label={detailed ? "Proxy request logs" : "Recent proxy requests"}
      tabIndex={0}
    >
      <table class="api-proxy-table">
        <thead>
          <tr>
            <th scope="col">Model / request</th>
            <th scope="col">Account / API key</th>
            <th scope="col">In / Out</th>
            <th scope="col">Status</th>
            <th scope="col">Duration</th>
            <th scope="col">When</th>
            {detailed ? <th scope="col">Details</th> : null}
          </tr>
        </thead>
        <tbody>
          {requests.map((row) => (
            <tr key={row.id}>
              <td>
                <strong>{row.model ?? "Model discovery / validation"}</strong>
                <small>
                  {row.method} {row.path}
                </small>
              </td>
              <td class="api-proxy-route-cell">
                <strong>
                  {row.accountEmail
                    ? getSensitiveDisplayValue(row.accountEmail, privacyMode, "email")
                    : row.path === "/v1/messages/count_tokens" ? "Local estimate" : "Account unavailable"}
                </strong>
                <small>{row.apiKeyName ?? "Unknown API key"}</small>
              </td>
              <td class="api-proxy-tokens">
                <span>{row.estimatedInputTokens === undefined ? tokens(row.inputTokens) : `~${tokens(row.estimatedInputTokens)} estimated`} ↑</span> <span>{tokens(row.outputTokens)} ↓</span>
              </td>
              <td>
                <span class={`api-proxy-status is-${row.status}`}>{row.status}</span>
                {row.httpStatus ? <small>HTTP {row.httpStatus}</small> : null}
              </td>
              <td>{row.durationMs === undefined ? "In progress" : `${row.durationMs.toLocaleString()} ms`}</td>
              <td>
                <time dateTime={new Date(row.startedAt).toISOString()}>{new Date(row.startedAt).toLocaleString()}</time>
              </td>
              {detailed ? (
                <td>
                  {row.error ? <p>{row.error}</p> : null}
                  <small>Request ID: {row.id}</small>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {!requests.length ? (
        <div class="api-empty-state">
          <strong>No requests yet</strong>
          <p>External /v1 requests will appear here.</p>
        </div>
      ) : null}
    </div>
  );
}

export function ApiProxyPanel(props: {
  snapshot?: ApiProxySnapshot;
  connected: boolean;
  baseUrl?: string;
  keyAccess: ApiProxyKeyAccess;
  privacyMode?: boolean;
  loading?: boolean;
  onRefresh: () => void;
}) {
  const [allLogs, setAllLogs] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const requests = props.snapshot?.requests ?? [];
  const refresh = useRef(props.onRefresh);
  refresh.current = props.onRefresh;
  useEffect(() => {
    if (!props.connected || props.loading || connectionOpen || props.keyAccess.error || props.keyAccess.uncertain || props.keyAccess.pending) return;
    const timer = setInterval(() => {
      if (!document.hidden) refresh.current();
    }, 3000);
    return () => clearInterval(timer);
  }, [props.connected, props.loading, connectionOpen, props.keyAccess.error, props.keyAccess.uncertain, props.keyAccess.pending]);
  return (
    <section class="api-proxy-panel" aria-label="API proxy overview">
      <div class="api-proxy-split">
        <section class="api-proxy-diagram-pane" aria-label="Proxy route" tabIndex={0}>
          <div class="api-section-heading">
            <h4>Request route</h4>
            <button
              type="button"
              aria-label="Proxy connection settings"
              title="Proxy connection settings"
              onClick={() => setConnectionOpen(true)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7">
                <path d="m9 3 6 0 1 4 4 1v7l-4 1-1 4H9l-1-4-4-1V8l4-1 1-4Z" />
                <circle cx="12" cy="11.5" r="3" />
              </svg>
            </button>
          </div>
          <ApiProxyRoutes requests={requests} connected={props.connected} privacyMode={props.privacyMode ?? false} />
        </section>
        <section class="api-proxy-log-pane" aria-label="Recent proxy logs">
          <div class="api-section-heading">
            <div class="api-log-title">
              <h4 title="Latest 100 external requests. Cleared on host restart.">
                {allLogs ? "All request logs" : "Recent logs"}
              </h4>
              <span class="api-proxy-update" role="status">
                {props.loading
                  ? "Loading proxy activity…"
                  : props.snapshot
                    ? `Updated ${new Date(props.snapshot.capturedAt).toLocaleTimeString()}`
                    : "Proxy activity unavailable. Refresh to retry; the host may need an update."}
              </span>
            </div>
            <div class="api-log-actions">
              <button
                type="button"
                aria-label="Refresh proxy"
                title="Refresh proxy"
                disabled={!props.connected || props.loading}
                onClick={props.onRefresh}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7">
                  <path d="M20 7v5h-5M4 17v-5h5" />
                  <path d="M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9" />
                </svg>
              </button>
              <button
                type="button"
                aria-label={allLogs ? "Show recent" : "Show all logs"}
                aria-pressed={allLogs}
                onClick={() => setAllLogs((value) => !value)}
              >
                {allLogs ? "Recent" : "All logs"}
              </button>
            </div>
          </div>
          {props.snapshot ? (
            <RequestTable
              requests={allLogs ? requests : requests.slice(0, 8)}
              detailed={allLogs}
              privacyMode={props.privacyMode ?? false}
            />
          ) : null}
        </section>
      </div>
      <ApiProxyConnection
        open={connectionOpen}
        baseUrl={props.baseUrl}
        keyAccess={props.keyAccess}
        onClose={() => setConnectionOpen(false)}
      />
    </section>
  );
}
