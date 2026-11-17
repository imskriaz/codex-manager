import type { ApiProxySnapshot, ApiProxyRequestLog } from '../../src/domain/dashboard/apiProxy';

function RequestTable({ requests, detailed }: { requests: ApiProxyRequestLog[]; detailed: boolean }) {
  const tokens = (value?: number) => value === undefined ? '—' : value.toLocaleString();
  return <div class="api-proxy-table-scroll" role="region" aria-label={detailed ? 'Proxy request logs' : 'Recent proxy requests'} tabIndex={0}>
    <table class="api-proxy-table"><thead><tr><th scope="col">Model / request</th><th scope="col">In / Out</th><th scope="col">Status</th><th scope="col">Duration</th><th scope="col">When</th>{detailed ? <th scope="col">Details</th> : null}</tr></thead>
      <tbody>{requests.map(row => <tr key={row.id}><td><strong>{row.model ?? 'Model discovery / validation'}</strong><small>{row.method} {row.path}</small></td>
        <td class="api-proxy-tokens"><span>{tokens(row.inputTokens)} ↑</span> <span>{tokens(row.outputTokens)} ↓</span></td>
        <td><span class={`api-proxy-status is-${row.status}`}>{row.status}</span>{row.httpStatus ? <small>HTTP {row.httpStatus}</small> : null}</td>
        <td>{row.durationMs === undefined ? 'In progress' : `${row.durationMs.toLocaleString()} ms`}</td>
        <td><time dateTime={new Date(row.startedAt).toISOString()}>{new Date(row.startedAt).toLocaleString()}</time></td>
        {detailed ? <td>{row.error ? <p>{row.error}</p> : null}<small>Request ID: {row.id}</small></td> : null}</tr>)}</tbody></table>
    {!requests.length ? <p class="task-board-empty">No proxy requests recorded in this host process yet.</p> : null}
  </div>;
}

export function ApiProxyPanel(props: { snapshot?: ApiProxySnapshot; logs: boolean; enabled: boolean; connected: boolean; loading?: boolean; baseUrl?: string; onRefresh: () => void }) {
  const requests = props.snapshot?.requests ?? [];
  const completed = requests.filter(row => row.status === 'completed').length;
  return <section class="api-proxy-panel" aria-label={props.logs ? 'API proxy logs' : 'API proxy overview'}>
    <div class="api-console-heading"><div><h3>{props.logs ? 'Proxy request logs' : 'API proxy'}</h3><code>{props.baseUrl ? props.baseUrl + '/v1' : 'Proxy base URL unavailable'}</code></div>
      <span class={`api-service-state${props.enabled && props.connected ? ' is-ready' : ''}`}>{!props.connected ? 'Offline' : props.enabled ? 'Enabled' : 'Disabled'}</span>
      <button type="button" disabled={!props.connected || props.loading} onClick={props.onRefresh}>{props.loading ? 'Refreshing…' : 'Refresh proxy'}</button></div>
    <p class="settings-note" role="status">{props.loading ? 'Loading proxy activity…' : props.snapshot ? `Updated ${new Date(props.snapshot.capturedAt).toLocaleTimeString()}.` : 'Proxy activity unavailable. Refresh to retry; the host may need an update.'}</p>
    {!props.logs ? <>
      <div class="api-proxy-metrics"><div><strong>{requests.length}</strong><span>Retained requests</span></div><div><strong>{completed}</strong><span>Completed</span></div><div><strong>{requests.filter(row => ['failed', 'cancelled', 'incomplete'].includes(row.status)).length}</strong><span>Failed / incomplete / cancelled</span></div><div><strong>{requests.filter(row => row.status === 'running').length}</strong><span>In progress</span></div></div>
      <div class="api-proxy-flow" role="img" aria-label="API clients connect to Codex Manager, which forwards requests to the active saved-account Codex backend">
        <div class="api-proxy-node"><strong>API clients</strong><small>OpenAI / Claude compatible</small></div><span class="api-proxy-edge" aria-hidden="true">↓</span>
        <div class="api-proxy-node is-router"><strong>Codex Manager</strong><small>API proxy · /v1</small></div><span class="api-proxy-edge" aria-hidden="true">↓</span>
        <div class="api-proxy-node"><strong>Codex backend</strong><small>Active saved account</small></div>
      </div><h4>Recent requests</h4>
    </> : null}
    {props.snapshot ? <RequestTable requests={props.logs ? requests : requests.slice(0, 8)} detailed={props.logs}/> : null}
    <p class="settings-note">External /v1 API calls only. Latest 100 requests in this host process; reset on host restart. Token counts appear when the backend reports usage. Prompts, responses, and credentials are not logged. Refresh to update.</p>
  </section>;
}
