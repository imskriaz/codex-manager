import { useId } from "preact/hooks";
import type { ApiProxyRequestLog } from "../../src/domain/dashboard/apiProxy";
import { getSensitiveDisplayValue } from "./helpers";

export function ApiProxyRoutes(props: { requests: ApiProxyRequestLog[]; connected: boolean; privacyMode: boolean }) {
  const markerId = useId();
  const accounts = new Map<string, string>(),
    keys = new Map<string, string>();
  const routes = new Map<string, { account: string; key: string; running: boolean; count: number }>();
  for (const request of props.requests) {
    if (request.path === "/v1/messages/count_tokens") continue;
    const account = request.accountId ?? request.accountEmail ?? "unknown-account";
    const key = request.apiKeyId ?? request.apiKeyName ?? "unknown-key";
    if (!accounts.has(account)) accounts.set(account, request.accountEmail ?? "Account unavailable");
    if (!keys.has(key)) keys.set(key, request.apiKeyName ?? "Unknown API key");
    const id = JSON.stringify([account, key]);
    const route = routes.get(id) ?? { account, key, running: false, count: 0 };
    route.count++;
    route.running ||= props.connected && request.status === "running";
    routes.set(id, route);
  }
  const accountIds = [...accounts.keys()],
    keyIds = [...keys.keys()];
  const height = Math.max(1, accounts.size, keys.size) * 86 + 20;
  const center = (index: number, count: number) => 10 + ((index + 0.5) * (height - 20)) / count;
  return (
    <div class="api-proxy-routes" role="img" aria-label="Proxy routes from saved accounts to API keys">
      {!routes.size ? (
        <div class="api-empty-state">
          <strong>No routes yet</strong>
          <p>Account and key connections appear after external API requests.</p>
        </div>
      ) : (
        <>
          <div class="api-route-headings">
            <span>Accounts</span>
            <span>API keys</span>
          </div>
          <div class="api-route-canvas" style={{ height }}>
            <svg viewBox={`0 0 600 ${height}`} preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <marker id={markerId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                  <path d="M0 0 7 3.5 0 7" fill="none" stroke="currentColor" stroke-width="1.2" />
                </marker>
              </defs>
              {[...routes.entries()].map(([id, route]) => {
                const from = center(accountIds.indexOf(route.account), accounts.size),
                  to = center(keyIds.indexOf(route.key), keys.size);
                return (
                  <path
                    key={id}
                    class={route.running ? "api-route-edge is-running" : "api-route-edge"}
                    d={`M228 ${from} C300 ${from} 300 ${to} 372 ${to}`}
                    marker-end={`url(#${markerId})`}
                  >
                    <title>
                      {accounts.get(route.account) &&
                        getSensitiveDisplayValue(accounts.get(route.account), props.privacyMode, "email")}{" "}
                      to {keys.get(route.key)}: {route.count} requests{route.running ? ", running" : ""}
                    </title>
                  </path>
                );
              })}
            </svg>
            {accountIds.map((id, index) => (
              <div key={id} class="api-route-node is-account" style={{ top: center(index, accounts.size) }}>
                <small>Account</small>
                <strong title={getSensitiveDisplayValue(accounts.get(id), props.privacyMode, "email")}>
                  {getSensitiveDisplayValue(accounts.get(id), props.privacyMode, "email")}
                </strong>
              </div>
            ))}
            {keyIds.map((id, index) => (
              <div key={id} class="api-route-node is-key" style={{ top: center(index, keys.size) }}>
                <strong title={keys.get(id)}>{keys.get(id)}</strong>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
