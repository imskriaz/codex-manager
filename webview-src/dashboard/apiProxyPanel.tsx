import type { ApiProxySnapshot, ApiProxyRequestLog } from "../../src/domain/dashboard/apiProxy";
import { useState } from "preact/hooks";

function RequestTable({ requests, detailed }: { requests: ApiProxyRequestLog[]; detailed: boolean }) {
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
              <td class="api-proxy-tokens">
                <span>{tokens(row.inputTokens)} ↑</span> <span>{tokens(row.outputTokens)} ↓</span>
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
  loading?: boolean;
  baseUrl?: string;
  onRefresh: () => void;
}) {
  const [allLogs, setAllLogs] = useState(false);
  const requests = props.snapshot?.requests ?? [];
  const completed = requests.filter((row) => row.status === "completed").length;
  return (
    <section class="api-proxy-panel" aria-label="API proxy overview">
      <div class="api-console-heading">
        <div>
          <h2>Proxy activity</h2>
          <code>{props.baseUrl ? props.baseUrl + "/v1" : "Proxy base URL unavailable"}</code>
        </div>

        <button type="button" disabled={!props.connected || props.loading} onClick={props.onRefresh}>
          {props.loading ? "Refreshing…" : "Refresh proxy"}
        </button>
      </div>
      <p class="api-proxy-update" role="status">
        {props.loading
          ? "Loading proxy activity…"
          : props.snapshot
            ? `Updated ${new Date(props.snapshot.capturedAt).toLocaleTimeString()}`
            : "Proxy activity unavailable. Refresh to retry; the host may need an update."}
      </p>
      <div class="api-proxy-metrics">
        <div>
          <span>Requests</span>
          <strong>{requests.length}</strong>
        </div>
        <div>
          <span>Completed</span>
          <strong>{completed}</strong>
        </div>
        <div>
          <span>Needs attention</span>
          <strong>{requests.filter((row) => ["failed", "cancelled", "incomplete"].includes(row.status)).length}</strong>
        </div>
        <div>
          <span>In progress</span>
          <strong>{requests.filter((row) => row.status === "running").length}</strong>
        </div>
      </div>
      <div class="api-proxy-split">
        <section class="api-proxy-diagram-pane" aria-label="Proxy route">
          <div class="api-section-heading">
            <h4>Request route</h4>
            <small>External calls only</small>
          </div>
          <div
            class="api-proxy-flow"
            role="img"
            aria-label="API clients connect to Codex Manager, which forwards requests to the active saved-account Codex backend"
          >
            <div class="api-proxy-node">
              <strong>API clients</strong>
              <small>OpenAI / Claude compatible</small>
            </div>
            <span class="api-proxy-edge" aria-hidden="true">
              &#8595;
            </span>
            <div class="api-proxy-node is-router">
              <strong>Codex Manager</strong>
              <small>API proxy /v1</small>
            </div>
            <span class="api-proxy-edge" aria-hidden="true">
              &#8595;
            </span>
            <div class="api-proxy-node">
              <strong>Codex backend</strong>
              <small>Active saved account</small>
            </div>
          </div>
        </section>
        <section class="api-proxy-log-pane" aria-label="Recent proxy logs">
          <div class="api-section-heading">
            <h4>{allLogs ? "All request logs" : "Recent logs"}</h4>
            <button type="button" aria-pressed={allLogs} onClick={() => setAllLogs((value) => !value)}>
              {allLogs ? "Show recent" : "Show all logs"}
            </button>
          </div>
          {props.snapshot ? (
            <RequestTable requests={allLogs ? requests : requests.slice(0, 8)} detailed={allLogs} />
          ) : null}
        </section>
      </div>
      <p class="api-proxy-retention">Latest 100 external requests · Cleared on host restart</p>
    </section>
  );
}
