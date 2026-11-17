import { useEffect, useRef, useState } from "preact/hooks";
import type { DashboardCliProject } from "../../src/domain/dashboard/types";
import type { DashboardApiToken } from "../../src/domain/dashboard/apiActions";
import { DASHBOARD_API_ACTIONS, PROJECT_API_ACTIONS, apiTokenProjects } from "../../src/domain/dashboard/apiActions";
import { formatApiResponse, readApiResponse } from "./apiResponse";
import {
  API_ENDPOINTS,
  apiPayloadExample,
  buildApiTestRequest,
  canTestApiEndpoint,
  type ApiEndpointId,
  type ApiInspection
} from "./apiPlayground";
import { handleTabKeyDown } from "./primitives";
import { ApiProxyPanel } from "./apiProxyPanel";
import { ApiDocsModal } from "./apiDocs";
export function ApiWorkspace(props: {
  open: boolean;
  token?: string;
  tokenId?: string;
  tokens: DashboardApiToken[];
  projects?: DashboardCliProject[];
  baseUrl?: string;
  privacyMode?: boolean;
  proxy?: import("../../src/domain/dashboard/apiProxy").ApiProxySnapshot;
  error?: string;
  notice?: string;
  uncertain?: boolean;
  loading?: boolean;
  onRefresh: () => void;
  enabled: boolean;
  connected: boolean;
  pending: boolean;
  onGenerate: (name: string, projectPaths: string[] | undefined, permissions: string[]) => void;
  onRevoke: (id: string) => void;
}) {
  const [projectInput, setProjectInput] = useState("");
  const [tab, setTab] = useState<"keys" | "explorer" | "proxy">("keys");
  const [createOpen, setCreateOpen] = useState(false),
    [name, setName] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [docsOpen, setDocsOpen] = useState(false);
  const [allProjects, setAllProjects] = useState(true),
    [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<string[]>(["state", "getProjectBoard", "getProjectTaskDetails"]);
  const [operation, setOperation] = useState("getProjectBoard");
  const [endpoint, setEndpoint] = useState<ApiEndpointId>("action");
  const [payloads, setPayloads] = useState<Partial<Record<ApiEndpointId, string>>>({ action: "{}" });
  const payload = payloads[endpoint] ?? apiPayloadExample(endpoint);
  const setPayload = (value: string) => setPayloads((current) => ({ ...current, [endpoint]: value }));
  const [model, setModel] = useState(""),
    [models, setModels] = useState<string[]>([]);
  const [requestMeta, setRequestMeta] = useState<{ status?: number; duration: number; bytes?: number }>();
  const [requestCopy, setRequestCopy] = useState("");
  const selectedEndpoint = API_ENDPOINTS.find((item) => item.id === endpoint)!;
  const [credential, setCredential] = useState(""),
    [result, setResult] = useState(""),
    [testing, setTesting] = useState(false);
  const bearer = credential.trim() || props.token?.trim() || "";
  const [access, setAccess] = useState<ApiInspection & { credential: string; name: string }>();
  const [inspection, setInspection] = useState(""),
    [inspectRetry, setInspectRetry] = useState(0);
  const [testProject, setTestProject] = useState("");
  const requestRef = useRef<AbortController>();
  const requestGeneration = useRef(0);
  const checked = access?.credential === bearer ? access : undefined;
  const [createdToken, setCreatedToken] = useState<string>(),
    [copyStatus, setCopyStatus] = useState("");
  useEffect(() => {
    if (props.token) setCreatedToken(props.token);
  }, [props.token]);
  useEffect(() => {
    if (!props.open) {
      requestGeneration.current++;
      setCreatedToken(undefined);
      setCredential("");
      setCreateOpen(false);
      setTab("keys");
      setDetailsOpen(false);
      setDocsOpen(false);
      setCopyStatus("");
      setAccess(undefined);
      setInspection("");
      setResult("");
      setModels([]);
      setModel("");
      setRequestMeta(undefined);
      requestRef.current?.abort();
      requestRef.current = undefined;
      setTesting(false);
    }
  }, [props.open]);
  const allowedPermissions = [
    "state",
    ...(allProjects ? ["settings", "aiProxy"] : []),
    ...DASHBOARD_API_ACTIONS.filter((action) => allProjects || PROJECT_API_ACTIONS.has(action))
  ];
  const browser = location.protocol === "http:" || location.protocol === "https:";
  const baseUrl = browser ? location.origin : props.baseUrl;
  const canUse = props.enabled && props.connected && !props.pending && !props.uncertain;
  const changeModel = (value: string) => {
    setModel(value);
    if (selectedEndpoint.method === "GET") return;
    try {
      const current: unknown = JSON.parse(payload);
      if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("Invalid payload");
      setPayload(JSON.stringify({ ...current, model: value }, null, 2));
    } catch {
      setRequestCopy("Fix the JSON payload or load an example before changing its model.");
    }
  };
  useEffect(() => {
    setAccess(undefined);
    if (!props.open || createOpen || !browser || !props.connected || !props.enabled || !bearer) {
      setInspection("");
      return;
    }
    const controller = new AbortController();
    let active = true;
    setInspection("Checking token permissions…");
    const timeout = setTimeout(() => controller.abort(), 10000);
    const debounce = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch("/api/schema", {
            headers: { Authorization: `Bearer ${bearer}` },
            signal: controller.signal,
            cache: "no-store"
          });
          const body = await readApiResponse(response);
          if (!active) return;
          if (!response.ok) {
            setInspection(formatApiResponse(response.status, body));
            return;
          }
          const schema = JSON.parse(body.text) as {
            actions?: unknown;
            token?: { name?: unknown; projectPaths?: unknown; permissions?: unknown };
          };
          if (
            body.truncated ||
            !Array.isArray(schema.actions) ||
            !schema.actions.every(
              (action) => typeof action === "string" && DASHBOARD_API_ACTIONS.includes(action as never)
            ) ||
            !schema.token ||
            typeof schema.token.name !== "string" ||
            !Array.isArray(schema.token.projectPaths) ||
            !schema.token.projectPaths.every((path) => typeof path === "string")
          )
            throw new Error("Invalid permission response. Recheck the token.");
          const actions = schema.actions as string[],
            projects = schema.token.projectPaths as string[];
          const permissions = schema.token.permissions;
          if (
            permissions !== undefined &&
            (!Array.isArray(permissions) || !permissions.every((item) => typeof item === "string"))
          )
            throw new Error("Invalid token permissions. Recheck the token.");
          setAccess({
            credential: bearer,
            actions,
            projects,
            permissions: (permissions as string[] | undefined) ?? [],
            name: schema.token.name
          });
          setOperation((current) => (actions.includes(current) ? current : (actions[0] ?? "")));
          setTestProject((current) => (projects.includes(current) ? current : (projects[0] ?? "")));
          setInspection("");
        } catch (error) {
          if (active) setInspection(`Token check failed: ${(error as Error).message}. No action was sent.`);
        } finally {
          clearTimeout(timeout);
        }
      })();
    }, 300);
    return () => {
      active = false;
      clearTimeout(debounce);
      clearTimeout(timeout);
      controller.abort();
    };
  }, [props.open, createOpen, bearer, props.connected, props.enabled, inspectRetry]);
  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (!props.connected) requestRef.current?.abort("Connection lost");
  }, [props.connected]);
  const test = async (target = endpoint) => {
    if (!canUse || !browser || !canTestApiEndpoint(target, checked, operation) || requestRef.current) return;
    setTesting(true);
    setResult("Sending once…");
    setRequestMeta(undefined);
    setRequestCopy("");
    const controller = new AbortController();
    requestRef.current = controller;
    const generation = requestGeneration.current;
    const started = performance.now();
    const timer = setTimeout(() => controller.abort("Request timed out"), 60000);
    try {
      const request = buildApiTestRequest(
        target,
        payload,
        operation,
        checked!.projects.length ? testProject : "",
        "api-" + crypto.randomUUID()
      );
      const response = await fetch(request.path, {
        method: request.method,
        signal: controller.signal,
        cache: "no-store",
        headers: { Authorization: "Bearer " + bearer, ...(request.body ? { "Content-Type": "application/json" } : {}) },
        ...(request.body ? { body: request.body } : {})
      });
      const body = await readApiResponse(response);
      if (generation !== requestGeneration.current) return;
      setResult(formatApiResponse(response.status, body));
      setRequestMeta({
        status: response.status,
        duration: Math.round(performance.now() - started),
        bytes: new TextEncoder().encode(body.text).length
      });
      if (target === "models" && response.ok && !body.truncated) {
        try {
          const data = JSON.parse(body.text) as { data?: Array<{ id?: unknown }> };
          const ids = Array.isArray(data.data)
            ? data.data.flatMap((item) => (item && typeof item.id === "string" ? [item.id] : [])).slice(0, 200)
            : [];
          setModels(ids);
          setModel((current) => (ids.includes(current) ? current : (ids[0] ?? "")));
        } catch {
          setRequestCopy(
            "The response is not a valid model catalogue. Review the response before sending a generation."
          );
        }
      }
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      setRequestMeta({ duration: Math.round(performance.now() - started) });
      setResult(
        "Request not confirmed: " +
          (controller.signal.aborted ? String(controller.signal.reason) : (error as Error).message) +
          ". Check current state before retrying a write."
      );
    } finally {
      clearTimeout(timer);
      if (requestRef.current === controller) {
        requestRef.current = undefined;
        setTesting(false);
      }
    }
  };
  const copy = (value: string) => {
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(value))
      .then(
        () => setRequestCopy("Copied."),
        () => setRequestCopy("Copy blocked. Select the text and copy it manually.")
      );
  };
  let requestPreview = "";
  try {
    const request = buildApiTestRequest(
      endpoint,
      payload,
      operation,
      checked?.projects.length ? testProject : "",
      "unique-request-id"
    );
    requestPreview = JSON.stringify(
      { ...request, ...(request.body ? { body: JSON.parse(request.body) as unknown } : {}) },
      null,
      2
    );
  } catch {
    requestPreview = "Enter a valid request payload to see the complete request.";
  }
  if (!props.open) return null;
  return (
    <>
      <section class="api-workspace-screen" aria-label="API access">
        {requestCopy ? (
          <p class="api-inline-feedback" role="status">
            {requestCopy}
          </p>
        ) : null}
        {!props.enabled ? <p role="status">Enable Dashboard API in Settings to create and use tokens.</p> : null}
        {!props.connected ? <p role="status">Offline. Reconnect before managing API keys.</p> : null}
        {props.error ? (
          <p class="share-outcome is-error" role="alert">
            {props.error}
          </p>
        ) : null}
        {props.uncertain ? (
          <p role="status">Refresh the list to verify the previous request before creating another token.</p>
        ) : null}
        <div class="api-topbar">
          <span id="api-sidebar-toggle-slot" class="content-sidebar-slot" />
          <h1 class="sr-only">API</h1>
          <div class="api-token-tabs" role="tablist" aria-label="API views" onKeyDown={handleTabKeyDown}>
            {(["keys", "explorer", "proxy"] as const).map((item) => (
              <span key={item} class={tab === item ? "is-active" : undefined}>
                <button
                  type="button"
                  role="tab"
                  id={`api-tab-${item}`}
                  aria-controls={`api-panel-${item}`}
                  aria-selected={tab === item}
                  tabIndex={tab === item ? 0 : -1}
                  disabled={testing || props.pending}
                  onClick={() => {
                    setTab(item);
                    setRequestCopy("");
                    if (item !== "explorer" && props.connected && !props.loading) props.onRefresh();
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                    {item === "keys" ? (
                      <>
                        <circle cx="8" cy="9" r="4" />
                        <path d="m11 12 9 9m-3-3 3-3m-6 0 3-3" />
                      </>
                    ) : item === "explorer" ? (
                      <>
                        <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16" />
                      </>
                    ) : (
                      <>
                        <rect x="8" y="2" width="8" height="6" rx="1" />
                        <rect x="2" y="16" width="7" height="6" rx="1" />
                        <rect x="15" y="16" width="7" height="6" rx="1" />
                        <path d="M12 8v4H5v4m7-4h7v4" />
                      </>
                    )}
                  </svg>
                  {item === "keys" ? "API keys" : item === "explorer" ? "API Explorer" : "Proxy"}
                </button>
              </span>
            ))}
          </div>
        </div>
        {tab === "proxy" ? (
          <div role="tabpanel" id="api-panel-proxy" aria-labelledby="api-tab-proxy">
            <ApiProxyPanel
              snapshot={props.proxy}
              baseUrl={baseUrl}
              keyAccess={{
                tokens: props.tokens,
                token: props.token,
                tokenId: props.tokenId,
                enabled: canUse,
                pending: props.pending,
                loading: props.loading,
                uncertain: props.uncertain,
                error: props.error,
                onCreate: (name) => props.onGenerate(name, undefined, ["aiProxy"]),
                onRefresh: props.onRefresh
              }}
              privacyMode={props.privacyMode}
              connected={props.connected}
              loading={props.loading}
              onRefresh={props.onRefresh}
            />
          </div>
        ) : null}

        <div role="tabpanel" id="api-panel-keys" aria-labelledby="api-tab-keys" hidden={tab !== "keys"}>
          {props.notice ? (
            <p class="api-workspace-notice" role="status">
              {props.notice}
            </p>
          ) : null}
          <div class={createOpen ? "api-keys-layout is-creating" : "api-keys-layout"}>
            <div class="api-token-workspace">
              <section class="api-token-pane api-token-list-pane" aria-label="API keys">
                <div class="api-pane-heading">
                  <h2>
                    Keys{" "}
                    <span class="api-key-count" role="status">
                      {props.loading ? "Loading…" : props.tokens.length}
                    </span>
                  </h2>
                  <span>
                    <button
                      type="button"
                      disabled={!props.connected || props.loading || props.pending}
                      onClick={props.onRefresh}
                    >
                      Refresh
                    </button>
                    <button
                      type="button"
                      class="modal-primary-btn"
                      disabled={!canUse}
                      onClick={() => {
                        setCreatedToken(undefined);
                        setCopyStatus("");
                        setName("");
                        setCreateOpen(true);
                      }}
                    >
                      Create API key
                    </button>
                  </span>
                </div>
                <div class="api-table-scroll" role="region" aria-label="API keys" tabIndex={0}>
                  {props.tokens.length ? (
                    <table class="api-token-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Project scope</th>
                          <th>Permissions</th>
                          <th>Created</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {props.tokens.map((token) => (
                          <tr key={token.id}>
                            <td>{token.name}</td>
                            <td title={apiTokenProjects(token).join("\n")}>
                              {apiTokenProjects(token)
                                .map((path) => path.split(/[\\/]/).pop())
                                .join(", ") || "All projects"}
                            </td>
                            <td title={token.permissions.join(", ")}>
                              {token.permissions.includes("*")
                                ? "All operations"
                                : `${token.permissions.length} operations`}
                            </td>
                            <td>{new Date(token.createdAt).toLocaleDateString()}</td>
                            <td>
                              <button type="button" disabled={!canUse} onClick={() => props.onRevoke(token.id)}>
                                Revoke
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                  {!props.tokens.length ? (
                    <p class="task-board-empty">
                      {props.loading
                        ? "Loading tokens…"
                        : props.error
                          ? "Token list unavailable. Refresh to retry."
                          : "No API keys yet. Create a key to connect your tools."}
                    </p>
                  ) : null}
                </div>
              </section>
            </div>
            {createOpen ? (
              <section class="api-key-create-panel" aria-label="Create API key" tabIndex={0}>
                <header class="api-section-heading">
                  <h2>Create API key</h2>
                  <button type="button" disabled={props.pending} onClick={() => setCreateOpen(false)}>
                    {createdToken ? "Done" : "Close form"}
                  </button>
                </header>
                <fieldset
                  hidden={!!createdToken}
                  disabled={props.pending || !!createdToken}
                  class="api-key-form-fields"
                >
                  {" "}
                  <form
                    class="api-token-create"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (canUse && !createdToken && (allProjects || selectedProjects.length))
                        props.onGenerate(name, allProjects ? undefined : selectedProjects, permissions);
                    }}
                  >
                    <section class="api-token-identity">
                      <label>
                        Token name
                        <input
                          value={name}
                          maxLength={80}
                          required
                          onInput={(event) => setName(event.currentTarget.value)}
                          placeholder="Build pipeline"
                        />
                      </label>
                      <fieldset class="api-project-scope">
                        <legend>Project scope</legend>
                        <label class="api-check-all">
                          <input
                            type="checkbox"
                            checked={allProjects}
                            onChange={(event) => {
                              const all = event.currentTarget.checked;
                              setAllProjects(all);
                              if (!all)
                                setPermissions((current) =>
                                  current.filter(
                                    (permission) =>
                                      permission === "state" ||
                                      PROJECT_API_ACTIONS.has(
                                        permission as import("../../src/domain/dashboard/types").DashboardActionName
                                      )
                                  )
                                );
                            }}
                          />
                          All projects
                        </label>
                        <div class="api-project-options">
                          {props.projects?.map((item) => (
                            <label key={item.path} title={item.path}>
                              <input
                                type="checkbox"
                                checked={allProjects || selectedProjects.includes(item.path)}
                                onChange={(event) => {
                                  const checked = event.currentTarget.checked;
                                  const current = allProjects
                                    ? (props.projects ?? []).map((project) => project.path)
                                    : selectedProjects;
                                  setSelectedProjects(
                                    checked
                                      ? [...new Set([...current, item.path])]
                                      : current.filter((path) => path !== item.path)
                                  );
                                  setAllProjects(false);
                                  setPermissions((current) =>
                                    current.filter(
                                      (permission) =>
                                        permission === "state" ||
                                        PROJECT_API_ACTIONS.has(
                                          permission as import("../../src/domain/dashboard/types").DashboardActionName
                                        )
                                    )
                                  );
                                }}
                              />
                              {item.label || item.path.split(/[\\/]/).pop()}
                            </label>
                          ))}
                        </div>
                        {!props.projects?.length ? (
                          <small>No open project folders on this host. Enter an existing host folder below.</small>
                        ) : null}
                        <label>
                          Additional host project folder
                          <input
                            value={projectInput}
                            placeholder="Absolute folder path on this host"
                            onInput={(event) => setProjectInput(event.currentTarget.value)}
                          />
                        </label>
                        <button
                          type="button"
                          disabled={!projectInput.trim() || props.pending || selectedProjects.length >= 32}
                          onClick={() => {
                            setSelectedProjects((current) => [...new Set([...current, projectInput.trim()])]);
                            setAllProjects(false);
                            setProjectInput("");
                            setPermissions((current) =>
                              current.filter(
                                (permission) =>
                                  permission === "state" ||
                                  PROJECT_API_ACTIONS.has(
                                    permission as import("../../src/domain/dashboard/types").DashboardActionName
                                  )
                              )
                            );
                          }}
                        >
                          Add folder
                        </button>
                        {selectedProjects
                          .filter((path) => !props.projects?.some((project) => project.path === path))
                          .map((path) => (
                            <label key={path}>
                              <input
                                type="checkbox"
                                checked
                                onChange={() =>
                                  setSelectedProjects((current) => current.filter((value) => value !== path))
                                }
                              />
                              {path}
                            </label>
                          ))}
                      </fieldset>
                    </section>
                    <section class="api-token-permission-column">
                      <label class="api-check-all">
                        <input
                          type="checkbox"
                          checked={allowedPermissions.every((action) => permissions.includes(action))}
                          onChange={(event) =>
                            setPermissions(event.currentTarget.checked ? [...allowedPermissions] : [])
                          }
                        />
                        Check all permissions
                      </label>
                      <details class="api-permissions" open>
                        <summary>{permissions.length} permissions selected</summary>
                        <div>
                          {allowedPermissions.map((action) => (
                            <label key={action}>
                              <input
                                type="checkbox"
                                checked={permissions.includes(action)}
                                onChange={(event) =>
                                  setPermissions((current) =>
                                    event.currentTarget.checked
                                      ? [...current, action]
                                      : current.filter((value) => value !== action)
                                  )
                                }
                              />
                              {action}
                            </label>
                          ))}
                        </div>
                      </details>
                    </section>
                    <div class="dialog-actions">
                      <button
                        type="button"
                        class="modal-secondary-btn"
                        disabled={props.pending}
                        onClick={() => {
                          setCreateOpen(false);
                          setRequestCopy("Key creation cancelled.");
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        class="modal-primary-btn"
                        disabled={
                          !canUse ||
                          !!createdToken ||
                          !name.trim() ||
                          !permissions.length ||
                          (!allProjects && (!selectedProjects.length || selectedProjects.length > 32))
                        }
                      >
                        {props.pending ? "Creating…" : createdToken ? "Token created" : "Create token"}
                      </button>
                    </div>
                  </form>
                </fieldset>
                {createdToken ? (
                  <div class="api-token-result">
                    <strong>Copy this token now</strong>
                    <textarea
                      readOnly
                      value={createdToken}
                      rows={2}
                      aria-label="New API token"
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        void Promise.resolve()
                          .then(() => navigator.clipboard.writeText(createdToken))
                          .then(
                            () => setCopyStatus("Token copied."),
                            () => setCopyStatus("Copy blocked. Select the token and copy it manually.")
                          );
                      }}
                    >
                      Copy token
                    </button>
                    <p role="status">{copyStatus}</p>
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
        </div>
        <div
          class="api-playground"
          aria-label="Explorer and Test"
          role="tabpanel"
          id="api-panel-explorer"
          aria-labelledby="api-tab-explorer"
          hidden={tab !== "explorer"}
        >
          <div class="api-playground-layout">
            <nav class="api-endpoints" aria-label="API endpoints">
              {["Manager", "AI proxy"].map((group) => (
                <div key={group}>
                  <h4>{group}</h4>
                  {API_ENDPOINTS.filter((item) => item.group === group).map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      title={`${item.method} ${item.path}`}
                      aria-pressed={endpoint === item.id}
                      disabled={testing}
                      onClick={() => {
                        setEndpoint(item.id);
                        setResult("");
                        setRequestMeta(undefined);
                        setRequestCopy("");
                      }}
                    >
                      <span class={item.method === "GET" ? "api-method is-get" : "api-method"}>{item.method}</span>
                      <span>
                        <strong>{item.label}</strong>
                        <code>{item.path}</code>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </nav>

            <section class="api-test-form" aria-label="Request editor" tabIndex={0}>
              <div class="api-section-heading">
                <h4>Request</h4>
                <div class="api-send-row">
                  {selectedEndpoint.method === "GET" ? (
                    <button type="button" aria-label="Endpoint documentation" onClick={() => setDocsOpen(true)}>
                      Docs
                    </button>
                  ) : null}
                  <button
                    type="button"
                    class="api-details-button"
                    aria-label="Request details"
                    aria-expanded={detailsOpen}
                    onClick={() => setDetailsOpen((value) => !value)}
                  >
                    Details
                  </button>

                  <button
                    type="button"
                    class="modal-primary-btn api-send-icon"
                    title={testing ? "Waiting for response" : "Send request once"}
                    aria-label={testing ? "Waiting…" : "Send request once"}
                    disabled={!canUse || !browser || testing || !canTestApiEndpoint(endpoint, checked, operation)}
                    onClick={() => {
                      void test();
                    }}
                  >
                    {testing ? (
                      <span class="cli-live-spinner" aria-hidden="true" />
                    ) : (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="m4 3 17 9-17 9 3-9-3-9Zm3 9h14"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.7"
                          stroke-linejoin="round"
                        />
                      </svg>
                    )}
                    {testing ? "Sending" : "Send"}
                  </button>
                  {testing ? (
                    <button type="button" onClick={() => requestRef.current?.abort("Cancelled by user")}>
                      Cancel request
                    </button>
                  ) : null}
                </div>
              </div>
              <div class="api-auth-bar">
                <label>
                  Bearer token
                  <input
                    type="password"
                    autoComplete="off"
                    value={credential}
                    placeholder={props.token ? "Uses the newly created token" : "Paste an API token"}
                    disabled={testing}
                    onInput={(event) => {
                      setCredential(event.currentTarget.value);
                      setAccess(undefined);
                      setModels([]);
                      setModel("");
                      setResult("");
                      setRequestMeta(undefined);
                    }}
                  />
                </label>
                <div class="api-access-check">
                  <button
                    type="button"
                    disabled={!browser || !props.connected || !props.enabled || !bearer || testing}
                    onClick={() => setInspectRetry((current) => current + 1)}
                  >
                    Recheck token
                  </button>
                  {checked ? (
                    <small>
                      {checked.name} · {checked.actions.length} operations ·{" "}
                      {checked.projects.length ? checked.projects.length + " project folders" : "Host-wide"}
                    </small>
                  ) : null}
                </div>
                {inspection ? (
                  <p class="settings-note" role="status">
                    {inspection}
                  </p>
                ) : null}
                {!browser ? <p role="status">Open the browser dashboard to test HTTP API requests.</p> : null}
              </div>

              {endpoint === "action" ? (
                <>
                  <label>
                    Operation
                    <select
                      aria-label="Operation"
                      value={checked ? operation : ""}
                      disabled={!checked?.actions.length || testing}
                      onChange={(event) => setOperation(event.currentTarget.value)}
                    >
                      {!checked?.actions.length ? (
                        <option value="">Check a token to see permitted operations</option>
                      ) : (
                        checked.actions.map((action) => (
                          <option key={action} value={action}>
                            {action}
                          </option>
                        ))
                      )}
                    </select>
                  </label>
                  {checked?.projects.length ? (
                    <label>
                      Host project
                      <select
                        aria-label="Host project"
                        value={testProject}
                        disabled={testing}
                        onChange={(event) => setTestProject(event.currentTarget.value)}
                      >
                        {checked.projects.map((path) => (
                          <option key={path} value={path}>
                            {path}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </>
              ) : null}
              {selectedEndpoint.permission === "aiProxy" && selectedEndpoint.method === "POST" ? (
                <div class="api-model-controls">
                  <label>
                    Model ID
                    <input
                      list="api-proxy-models"
                      value={model}
                      disabled={testing}
                      placeholder="Discover or enter a model ID"
                      onInput={(event) => changeModel(event.currentTarget.value)}
                    />
                    <datalist id="api-proxy-models">
                      {models.map((id) => (
                        <option key={id} value={id} />
                      ))}
                    </datalist>
                  </label>
                  <button
                    type="button"
                    disabled={!canUse || !browser || testing || !canTestApiEndpoint("models", checked, operation)}
                    onClick={() => {
                      void test("models");
                    }}
                  >
                    Load models
                  </button>
                </div>
              ) : null}
              <label>
                Endpoint
                <div class="api-endpoint-field">
                  <span class={selectedEndpoint.method === "GET" ? "api-method is-get" : "api-method"}>
                    {selectedEndpoint.method}
                  </span>
                  <input
                    aria-label="Endpoint"
                    readOnly
                    value={(baseUrl ?? "<host>") + selectedEndpoint.path}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button
                    type="button"
                    aria-label="Copy endpoint"
                    title="Copy endpoint"
                    onClick={() => copy((baseUrl ?? "<host>") + selectedEndpoint.path)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <rect
                        x="8"
                        y="8"
                        width="12"
                        height="12"
                        rx="2"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.7"
                      />
                      <path d="M15 8V4H4v11h4" fill="none" stroke="currentColor" stroke-width="1.7" />
                    </svg>
                  </button>
                </div>
              </label>
              {selectedEndpoint.method === "POST" ? (
                <>
                  <div class="api-payload-heading">
                    <label for="api-request-body">Payload (JSON)</label>
                    <span class="api-payload-actions">
                      <button type="button" aria-label="Endpoint documentation" onClick={() => setDocsOpen(true)}>
                        Docs
                      </button>
                      <button
                        type="button"
                        disabled={testing}
                        onClick={() => setPayload(apiPayloadExample(endpoint, model || undefined))}
                      >
                        Load example
                      </button>
                    </span>{" "}
                  </div>
                  <textarea
                    id="api-request-body"
                    aria-label="Payload (JSON)"
                    rows={8}
                    spellcheck={false}
                    value={payload}
                    disabled={testing}
                    onInput={(event) => setPayload(event.currentTarget.value)}
                  />
                </>
              ) : null}

              {checked && !canTestApiEndpoint(endpoint, checked, operation) ? (
                <p role="status" class="settings-note">
                  This token does not grant access to this endpoint.
                </p>
              ) : null}
              {detailsOpen ? (
                <section class="api-request-reference" aria-label="Request details">
                  <p>{selectedEndpoint.description}</p>
                  <pre>{requestPreview}</pre>
                  <button type="button" onClick={() => copy(requestPreview)}>
                    Copy request
                  </button>
                </section>
              ) : null}
            </section>
            <section class="api-response-pane" aria-label="Response">
              <div class="api-section-heading">
                <h4>Response</h4>
                {requestMeta ? (
                  <span
                    class={
                      requestMeta.status && requestMeta.status < 400
                        ? "api-response-meta is-success"
                        : "api-response-meta"
                    }
                  >
                    {requestMeta.status ? "HTTP " + requestMeta.status + " · " : ""}
                    {requestMeta.duration} ms{requestMeta.bytes !== undefined ? " · " + requestMeta.bytes + " B" : ""}
                  </span>
                ) : (
                  <small>Ready when you are</small>
                )}
                {result && !testing ? (
                  <button
                    type="button"
                    class="api-copy-response"
                    title="Copy response"
                    aria-label="Copy response"
                    onClick={() => copy(result)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <rect
                        x="8"
                        y="8"
                        width="12"
                        height="12"
                        rx="2"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.7"
                      />
                      <path d="M15 8V4H4v11h4" fill="none" stroke="currentColor" stroke-width="1.7" />
                    </svg>
                  </button>
                ) : null}
              </div>
              {result ? (
                <pre class="api-test-result" role="status" tabIndex={0}>
                  {result}
                </pre>
              ) : (
                <div class="api-response-empty">Response appears here.</div>
              )}
            </section>
          </div>
        </div>
      </section>
      <ApiDocsModal
        endpoint={docsOpen ? endpoint : undefined}
        baseUrl={baseUrl}
        operation={operation}
        model={model}
        onClose={() => setDocsOpen(false)}
      />
    </>
  );
}
