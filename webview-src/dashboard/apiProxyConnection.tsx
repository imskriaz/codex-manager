import { useEffect, useRef, useState } from "preact/hooks";
import { handleTabKeyDown, ModalShell } from "./primitives";
import { apiTokenProjects, type DashboardApiToken } from "../../src/domain/dashboard/apiActions";
import {
  mapClaudeModels,
  mapDiscoveredModels,
  MODEL_PLACEHOLDER,
  type ApiProxyModel,
  type ClaudeModelMapping
} from "./apiProxyModelMapping";

export type ApiProxyKeyAccess = {
  tokens: DashboardApiToken[];
  token?: string;
  tokenId?: string;
  enabled: boolean;
  pending: boolean;
  loading?: boolean;
  uncertain?: boolean;
  error?: string;
  onCreate: (name: string) => void;
  onRefresh: () => void;
};

export function ApiProxyConnection(props: {
  open: boolean;
  baseUrl?: string;
  keyAccess: ApiProxyKeyAccess;
  onClose: () => void;
}) {
  const [notice, setNotice] = useState("");
  const [client, setClient] = useState<"codex" | "claude">("codex");
  const [selectedId, setSelectedId] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [models, setModels] = useState<ApiProxyModel[]>([]);
  const [claudeMapping, setClaudeMapping] = useState<ClaudeModelMapping>(() => mapClaudeModels([]));
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const creating = useRef(false);
  const keyAccess = props.keyAccess;
  const proxyKeys = keyAccess.tokens.filter(
    (token) =>
      !apiTokenProjects(token).length && (token.permissions.includes("aiProxy") || token.permissions.includes("*"))
  );
  const selectedKey = proxyKeys.find((token) => token.id === selectedId);
  useEffect(() => {
    if (!props.open) {
      setWaiting(false);
      creating.current = false;
      return;
    }
    if (
      creating.current &&
      keyAccess.tokenId &&
      proxyKeys.some((token) => token.id === keyAccess.tokenId) &&
      keyAccess.token
    ) {
      setSelectedId(keyAccess.tokenId);
      setWaiting(false);
      creating.current = false;
      setNotice("Proxy key created. Copy its configuration now.");
    } else if (!proxyKeys.some((token) => token.id === selectedId)) {
      setSelectedId(proxyKeys[0]?.id ?? "");
    }
    if (creating.current && !keyAccess.pending && keyAccess.token && proxyKeys.length && !keyAccess.tokenId) {
      setWaiting(false);
      creating.current = false;
      setNotice(
        "Key created, but this host did not identify its one-time secret. Refresh keys and paste its saved value."
      );
    }
    if ((keyAccess.error || keyAccess.uncertain) && !keyAccess.pending) {
      setWaiting(false);
      creating.current = false;
    }
  }, [
    props.open,
    keyAccess.tokens,
    keyAccess.tokenId,
    keyAccess.token,
    keyAccess.pending,
    keyAccess.error,
    keyAccess.uncertain,
    selectedId
  ]);
  const freshKey = selectedKey && selectedId === keyAccess.tokenId ? keyAccess.token : undefined;
  const keyValue = freshKey || "YOUR_MANAGER_API_KEY";
  const launchCommand = "$env:MANAGER_API_KEY = '" + keyValue.replaceAll("'", "''") + "'\ncodex";
  const busy = keyAccess.pending || waiting;
  useEffect(() => {
    setNotice("");
    if (props.open) setClient("codex");
  }, [props.open]);
  const baseUrl = props.baseUrl?.replace(/\/+$/, "");
  const proxyUrl = baseUrl ? baseUrl + "/v1" : "";
  const modelMapping = mapClaudeModels(models);
  useEffect(() => {
    const available = new Set(models.map((model) => model.id));
    setClaudeMapping((current) => {
      const next = { ...modelMapping };
      for (const key of Object.keys(next) as Array<keyof ClaudeModelMapping>) {
        if (available.has(current[key])) next[key] = current[key];
      }
      return next;
    });
  }, [models]);
  const discoveryKey = keyValue === "YOUR_MANAGER_API_KEY" ? "" : keyValue;
  useEffect(() => {
    if (!props.open || !baseUrl || !discoveryKey) {
      setModels([]);
      setModelsError("");
      setModelsLoading(false);
      return;
    }
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 10_000);
    setModelsLoading(true);
    setModelsError("");
    void fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${discoveryKey}` },
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Model discovery returned HTTP ${response.status}.`);
        return mapDiscoveredModels(await response.json());
      })
      .then((discovered) => {
        if (!discovered.length) throw new Error("No models were returned by the proxy.");
        setModels(discovered);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setModels([]);
          setModelsError(error instanceof Error ? error.message : "Model discovery failed.");
        }
      })
      .finally(() => {
        globalThis.clearTimeout(timeout);
        if (!controller.signal.aborted) setModelsLoading(false);
      });
    return () => {
      controller.abort();
      globalThis.clearTimeout(timeout);
    };
  }, [props.open, baseUrl, discoveryKey]);
  const copy = (value: string) => {
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(value))
      .then(
        () => setNotice("Copied."),
        () => setNotice("Copy blocked. Select the text and copy it manually.")
      );
  };
  const codexConfig = [
    `model = ${JSON.stringify(models[0]?.id ?? MODEL_PLACEHOLDER)}`,
    'model_provider = "manager_proxy"',
    "",
    "[model_providers.manager_proxy]",
    'name = "Manager proxy"',
    "base_url = " + JSON.stringify(proxyUrl || "https://YOUR_MANAGER_HOST/v1"),
    'env_key = "MANAGER_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false"
  ].join("\n");
  const claudeConfig = JSON.stringify(
    {
      env: {
        ANTHROPIC_BASE_URL: baseUrl || "https://YOUR_MANAGER_HOST",
        ANTHROPIC_AUTH_TOKEN: keyValue,
        ANTHROPIC_MODEL: claudeMapping.model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: claudeMapping.opus,
        ANTHROPIC_DEFAULT_SONNET_MODEL: claudeMapping.sonnet,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: claudeMapping.haiku,
        ANTHROPIC_DEFAULT_FABLE_MODEL: claudeMapping.fable
      }
    },
    null,
    2
  );
  return (
    <ModalShell
      open={props.open}
      title="Proxy connection"
      closeLabel="Close proxy connection"
      className="api-docs-modal"
      closeDisabled={busy}
      onClose={props.onClose}
    >
      <div class="api-docs-content api-proxy-connection">
        <div class="api-connection-toolbar">
          <div class="api-token-tabs" role="tablist" aria-label="Proxy clients" onKeyDown={handleTabKeyDown}>
            {(["codex", "claude"] as const).map((value) => (
              <span key={value} class={client === value ? "is-active" : undefined}>
                <button
                  type="button"
                  role="tab"
                  id={`proxy-client-${value}`}
                  aria-controls={`proxy-config-${value}`}
                  aria-selected={client === value}
                  tabIndex={client === value ? 0 : -1}
                  onClick={() => {
                    setClient(value);
                    setNotice("");
                  }}
                >
                  {value === "codex" ? "Codex" : "Claude"}
                </button>
              </span>
            ))}
          </div>
          {notice ? <p role="status">{notice}</p> : null}
          {keyAccess.error ? (
            <p role="alert" class="api-key-error">
              {keyAccess.error}
            </p>
          ) : null}
          {keyAccess.uncertain ? (
            <div role="status">
              Key creation was not confirmed. Refresh before trying again.{" "}
              <button type="button" disabled={keyAccess.loading} onClick={keyAccess.onRefresh}>
                Refresh keys
              </button>
            </div>
          ) : null}
        </div>
        <section class="api-connection-keys">
          {proxyKeys.length ? (
            <>
              <label>
                Proxy API key
                <select
                  aria-label="Proxy API key"
                  value={selectedId}
                  disabled={busy}
                  onChange={(event) => {
                    setSelectedId(event.currentTarget.value);
                    setNotice("");
                  }}
                >
                  {proxyKeys.map((token) => (
                    <option key={token.id} value={token.id}>
                      {token.name}
                    </option>
                  ))}
                </select>
              </label>
              {freshKey ? (
                <p role="status">New key selected. Copy the configuration now; its secret is shown only once.</p>
              ) : (
                <p role="status">Select a newly created key to copy its one-time secret into the configuration.</p>
              )}
            </>
          ) : (
            <div class="api-connection-create">
              <p>{keyAccess.loading ? "Loading available proxy keys…" : "No host-wide key with AI proxy access."}</p>
              <button
                type="button"
                disabled={!keyAccess.enabled || busy || !!keyAccess.uncertain}
                onClick={() => {
                  if (creating.current) return;
                  creating.current = true;
                  setWaiting(true);
                  setNotice("");
                  keyAccess.onCreate(client === "codex" ? "Codex proxy" : "Claude proxy");
                }}
              >
                {busy ? "Creating…" : "Create proxy key"}
              </button>
              <small>Creates one host-wide key with aiProxy permission only.</small>
            </div>
          )}
        </section>
        <div
          role="tabpanel"
          id="proxy-config-codex"
          aria-labelledby="proxy-client-codex"
          hidden={client !== "codex"}
          class="api-connection-guide"
        >
          <section>
            <h3>Base URL</h3>
            <div class="api-connection-field">
              <input
                aria-label="Proxy base URL"
                value={proxyUrl}
                placeholder="Host address unavailable"
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
              <button
                type="button"
                aria-label="Copy proxy base URL"
                disabled={!proxyUrl}
                onClick={() => copy(proxyUrl)}
              >
                Copy
              </button>
            </div>
            <p>Codex uses /v1/responses. Keep /v1 in the base URL.</p>
          </section>
          <section>
            <h3>~/.codex/config.toml</h3>
            <pre tabIndex={0} aria-label="Codex configuration">
              {codexConfig}
            </pre>
            <button type="button" aria-label="Copy Codex configuration" onClick={() => copy(codexConfig)}>
              Copy configuration
            </button>
          </section>
          <section>
            <h3>Set the key and start Codex</h3>
            <pre tabIndex={0} aria-label="Codex PowerShell setup">
              {launchCommand}
            </pre>
            <button type="button" aria-label="Copy Codex launch command" onClick={() => copy(launchCommand)}>
              Copy launch command
            </button>
            <p>
              PowerShell shown. For Bash or Zsh, use export MANAGER_API_KEY="YOUR_MANAGER_API_KEY" before starting
              codex.
            </p>
          </section>
          <p>
            <a href="https://developers.openai.com/codex/config-reference/" target="_blank" rel="noreferrer">
              Codex configuration reference
            </a>
          </p>
        </div>
        <div
          role="tabpanel"
          id="proxy-config-claude"
          aria-labelledby="proxy-client-claude"
          hidden={client !== "claude"}
          class="api-connection-guide"
        >
          <section>
            <h3>Claude Desktop gateway</h3>
            <p>In Claude Desktop, open Configure third-party inference and choose Gateway.</p>
            <ul class="api-model-list">
              <li>
                Gateway base URL: <code>{baseUrl || "https://YOUR_MANAGER_HOST"}</code> (without <code>/v1</code>)
              </li>
              <li>Gateway API key: use the selected Manager key above</li>
              <li>
                Gateway auth scheme: <code>x-api-key</code>
              </li>
              <li>Model discovery: enable it so Claude Desktop loads the mapped Claude names below</li>
            </ul>
          </section>
          <section>
            <h3>Host URL</h3>
            <div class="api-connection-field">
              <input
                aria-label="Claude host URL"
                value={baseUrl ?? ""}
                placeholder="Host address unavailable"
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
              <button
                type="button"
                aria-label="Copy Claude host URL"
                disabled={!baseUrl}
                onClick={() => copy(baseUrl!)}
              >
                Copy
              </button>
            </div>
            <p>Claude Code appends /v1/messages. Use the host URL without /v1.</p>
          </section>
          <section>
            <h3>~/.claude/settings.json</h3>
            <pre tabIndex={0} aria-label="Claude configuration">
              {claudeConfig}
            </pre>
            <button type="button" aria-label="Copy Claude configuration" onClick={() => copy(claudeConfig)}>
              Copy configuration
            </button>
          </section>
          <section aria-label="Claude model mapping">
            <h3>Model mapping</h3>
            {modelsLoading ? <p role="status">Loading models from the active account…</p> : null}
            {modelsError ? <p role="alert">{modelsError} Use a model ID from GET /v1/models.</p> : null}
            <table class="api-model-mapping">
                  <thead>
                    <tr>
                      <th scope="col">Claude model</th>
                      <th scope="col">Available backend model</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ["claude-sonnet (default)", "model"],
                      ["claude-opus", "opus"],
                      ["claude-sonnet", "sonnet"],
                      ["claude-haiku", "haiku"],
                      ["claude-fable", "fable"]
                    ].map(([label, key]) => (
                      <tr key={label}>
                        <th scope="row"><code>{label}</code></th>
                        <td>
                          <select
                            aria-label={`Proxy model for ${label}`}
                            value={claudeMapping[key as keyof ClaudeModelMapping]}
                            onChange={(event) =>
                              setClaudeMapping((current) => ({
                                ...current,
                                [String(key)]: event.currentTarget.value
                              }))
                            }
                          >
                            {models.length ? models.map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.id}{model.name !== model.id ? ` — ${model.name}` : ""}
                              </option>
                            )) : <option value="" disabled>No Codex models discovered</option>}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
            </table>
            {models.length ? (
                <details>
                  <summary>Available models ({models.length})</summary>
                  <ul class="api-model-list">
                    {models.map((model) => (
                      <li key={model.id}>
                        <code>{model.id}</code>
                        {model.name !== model.id ? ` — ${model.name}` : ""}
                      </li>
                    ))}
                  </ul>
                </details>
            ) : !modelsLoading && !modelsError ? (
              <p>Save or create a new Manager key to load Codex models.</p>
            ) : null}
            <small>
              Claude model names stay in the <code>claude-*</code> format; each maps to a selected Codex model.
            </small>
          </section>
          <p>
            The settings.json block is for Claude Code. Claude Desktop uses the Gateway fields above and does not read
            this env block.
          </p>
          <p>
            This proxy serves Codex models through the Claude-compatible protocol. It does not provide Anthropic models.
          </p>
          <p>
            <a href="https://code.claude.com/docs/en/llm-gateway-connect" target="_blank" rel="noreferrer">
              Claude Code gateway guide
            </a>
          </p>
        </div>
        <p>
          Use a Manager key with host-wide aiProxy permission. The model fields are filled from GET /v1/models when
          discovery succeeds; Manager controls use /api/message on the same host.
        </p>
      </div>
    </ModalShell>
  );
}
