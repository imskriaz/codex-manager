#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const base = new URL(process.env.CODEX_MANAGER_URL || "http://127.0.0.1:39875");
if (
  !["http:", "https:"].includes(base.protocol) ||
  base.username ||
  base.password ||
  (base.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
)
  throw new Error("Use loopback HTTP or HTTPS for CODEX_MANAGER_URL.");
const token = process.env.CODEX_MANAGER_TOKEN;
const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const operations = [
  "list",
  "open",
  "close",
  "navigate",
  "back",
  "forward",
  "reload",
  "snapshot",
  "screenshot",
  "click",
  "fill",
  "type",
  "press",
  "scroll",
  "hover",
  "select",
  "wait",
  "resize",
  "evaluate",
  "html",
  "styles",
  "events",
  "storage",
  "cdp",
  "feedback",
  "deleteFeedback",
  "readFeedback"
];
const calls = new Map();
let initialized = false,
  ending = false,
  buffer = "";
const content = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const failure = (message) => ({ isError: true, content: [{ type: "text", text: message }] });
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

async function api(path, signal, body) {
  if (!token) throw new Error("Set CODEX_MANAGER_TOKEN to a permitted Manager API token.");
  const timeout = AbortSignal.timeout(16 * 60_000);
  const combined = AbortSignal.any([signal, timeout]);
  let response;
  try {
    response = await fetch(new URL(path, base), {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: combined,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.body) throw new Error("Manager returned no response body.");
    let bytes = 0,
      chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error("Manager response exceeded 16 MiB.");
      chunks.push(Buffer.from(chunk));
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!response.ok)
      throw new Error(
        `Manager HTTP ${response.status}: ${typeof data.error === "string" ? data.error : "Request rejected."}`
      );
    return data;
  } catch (error) {
    throw new Error(
      `${error.message}${body ? " The outcome may be unknown. Inspect current state before retrying; no automatic retry was attempted." : ""}`
    );
  }
}

async function action(args, signal) {
  if (!object(args) || typeof args.action !== "string" || (args.payload !== undefined && !object(args.payload)))
    throw new Error("Supply action and an optional payload object.");
  const requestId = args.requestId || randomUUID();
  if (args.action === 'workspaceBrowser' && object(args.payload?.browserRequest)) args = { ...args, payload: { ...args.payload, browserRequest: { ...args.payload.browserRequest, openedBy: 'ai' } } };
  if (typeof requestId !== "string" || requestId.length > 100)
    throw new Error("Use a requestId of at most 100 characters.");
  const response = await api("/api/message", signal, {
    type: "dashboard:action",
    requestId,
    action: args.action,
    ...(args.accountId ? { accountId: args.accountId } : {}),
    payload: args.payload || {}
  });
  const result = response.messages?.find(
    (row) => row.type === "dashboard:action-result" && row.requestId === requestId
  );
  if (!result) throw new Error(`Operation ${requestId} has an unknown outcome. Inspect state before retrying.`);
  return { ...content(result), ...(result.status !== "completed" ? { isError: true } : {}) };
}

const browserSchema = {
  type: "object",
  required: ["projectPath", "request"],
  additionalProperties: false,
  properties: {
    projectPath: { type: "string" },
    surfaceId: { type: "string", description: "Exact surfaceId from manager_workspace. Uses that dashboard's execution device and presents opened pages in its right panel." },
    sessionId: { type: "string", description: "Session owning the shared browser tabs. Required with surfaceId: exact sessionId returned by workspace discovery." },
    targetDeviceId: {
      type: "string",
      description: "Optional connected remote device ID from manager_state.connectedPeers. Omit to use the MCP host."
    },
    request: {
      type: "object",
      required: ["operation"],
      additionalProperties: false,
      properties: {
        operation: { type: "string", enum: operations },
        operationId: { type: "string" },
        pageId: { type: "string" },
        revision: { type: "string" },
        url: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        key: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "integer" },
        height: { type: "integer" },
        confirmed: { type: "boolean" },
        method: { type: "string", description: "Page DevTools method, for example Network.getResponseBody or CSS.setStyleTexts." },
        params: { type: "object", additionalProperties: true },
        eventNames: { type: "array", items: { type: "string" }, maxItems: 32 },
        after: { type: "integer", minimum: 0 },
        feedbackId: { type: "string" },
        feedback: {
          type: "object",
          required: ["id", "pageId", "revision", "kind", "points", "text"],
          properties: {
            id: { type: "string" },
            pageId: { type: "string" },
            revision: { type: "string" },
            kind: { type: "string", enum: ["pointer", "area", "draw", "comment"] },
            text: { type: "string" },
            referenceUrl: { type: "string" },
            points: {
              type: "array",
              maxItems: 500,
              items: {
                type: "object",
                required: ["x", "y"],
                properties: { x: { type: "number" }, y: { type: "number" } }
              }
            }
          }
        }
      }
    }
  }
};
const tools = [
  {
    name: 'manager_workspace',
    description: 'Discover live browser/VS Code workspace surfaces, including mobile dashboards. List first and choose the exact surfaceId, dashboard host targetDeviceId and sessionId. Read returns the current right-panel tab and its browser snapshot or terminal screen. Open adds a visible tool tab; select chooses an existing tab ID; hide closes the right panel. Commands finish only after that dashboard acknowledges them. Never substitute a local dashboard when the requested surface is missing.',
    inputSchema: {
      type: 'object', required: ['projectPath', 'request'], additionalProperties: false,
      properties: {
        projectPath: { type: 'string' }, targetDeviceId: { type: 'string', description: 'Dashboard host device returned by discovery; differs from the surface execution device.' },
        request: {
          type: 'object', required: ['operation'], additionalProperties: false,
          properties: {
            operation: { type: 'string', enum: ['list', 'read', 'open', 'select', 'hide'] },
            surfaceId: { type: 'string' }, sessionId: { type: 'string' },
            includeContent: { type: 'boolean', description: 'Read metadata only when false; defaults to reading the selected tab content.' },
            tab: { type: 'string', description: 'Open: env/browser/terminal/files/git/reviews/agents. Select: exact tab ID, including browser:<pageId>.' },
            url: { type: 'string', description: 'URL for a new Browser tab.' }
          }
        }
      }
    }
  },
  {
    name: "manager_schema",
    description: "Discover permitted Manager actions and their request envelopes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "manager_state",
    description: "Read Manager state or one granted project.",
    inputSchema: { type: "object", properties: { projectPath: { type: "string" } }, additionalProperties: false }
  },
  {
    name: "manager_action",
    description:
      "Run a permitted Manager action: sessions, accounts, workspace files, terminal, Git, tasks, maintenance. Read manager_schema first; preserve previews, revision checks and confirmations.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string" },
        accountId: { type: "string" },
        requestId: { type: "string" },
        payload: { type: "object", additionalProperties: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "manager_setting",
    description: "Change a permitted global Manager setting. Needs settings permission.",
    inputSchema: {
      type: "object",
      required: ["key", "value"],
      properties: { key: { type: "string" }, value: {} },
      additionalProperties: false
    }
  },
  {
    name: "manager_browser",
    description:
      "Control shared Manager browser tabs, including user-opened pages. For the user's visible right panel, FIRST call manager_workspace list and supply its surfaceId, sessionId and dashboard host targetDeviceId here; never assume the local host is the user's displayed view. Start with list for page IDs and revisions, then snapshot/screenshot. AI-opened tabs are labeled AI. Mutations need the current page revision; preserve operationId for the same attempt. Read HTML, styles (params.action rules/listeners), sources (html params.action resources/resource), events and storage; modify JavaScript/CSS/DOM with evaluate or page-scoped cdp. evaluate/cdp/storage changes require confirmed=true.",
    inputSchema: browserSchema
  }
];
async function tool(name, args, signal) {
  if (!object(args)) throw new Error("Tool arguments must be an object.");
  if (name === "manager_schema") return content(await api("/api/schema", signal));
  if (name === "manager_state")
    return content(
      await api("/api/state" + (args.projectPath ? "?projectPath=" + encodeURIComponent(args.projectPath) : ""), signal)
    );
  if (name === "manager_action") return action(args, signal);
  if (name === 'manager_workspace') {
    if (typeof args.projectPath !== 'string' || !object(args.request)) throw new Error('Provide projectPath and request.');
    const call = targetDeviceId => action({ action: 'workspacePanel', payload: { projectPath: args.projectPath, targetDeviceId, panelRequest: args.request } }, signal);
    if (args.request.operation !== 'list' || args.targetDeviceId !== undefined) return workspaceImage(await call(args.targetDeviceId));
    const local = await call(undefined);
    if (local.isError) return local;
    const result = JSON.parse(local.content[0].text);
    const surfaces = (result.payload?.workspacePanel?.surfaces ?? []).map(surface => ({ ...surface, dashboardHostDeviceId: 'local' }));
    const warnings = [];
    // Discovery reads other hosts; mutations always require one explicit surface.
    try {
      const state = await api('/api/state?projectPath=' + encodeURIComponent(args.projectPath), signal);
      const peers = (state.connectedPeers ?? []).filter(peer => !peer.local && peer.connected).slice(0, 16);
      const reads = await Promise.allSettled(peers.map(async peer => {
        const response = await call(peer.id);
        if (response.isError) throw new Error(`Surface discovery on ${peer.id} failed: ${response.content[0].text}`);
        return JSON.parse(response.content[0].text).payload?.workspacePanel?.surfaces?.map(surface => ({ ...surface, dashboardHostDeviceId: peer.id })) ?? [];
      }));
      for (const read of reads) { if (read.status === 'fulfilled') surfaces.push(...read.value); else warnings.push(read.reason.message); }
    } catch (error) { warnings.push('Remote surface discovery was inconclusive: ' + error.message); }
    return content({ surfaces, ...(warnings.length ? { warnings } : {}) });
  }
  if (name === "manager_setting") {
    const response = await api("/api/message", signal, { type: "dashboard:setting", key: args.key, value: args.value });
    const notice = response.messages?.find((row) => row.type === "dashboard:notice");
    if (!notice) return failure("The setting outcome is unknown. Read the stored setting before retrying.");
    return { ...content(response), ...(notice.level !== "info" ? { isError: true } : {}) };
  }
  if (name === "manager_browser") {
    if (typeof args.projectPath !== "string" || !object(args.request))
      throw new Error("Provide projectPath and request.");
    let executionDeviceId = args.targetDeviceId;
    let surface;
    if (args.surfaceId) {
      if (typeof args.sessionId !== 'string' || !args.sessionId) throw new Error('Supply the exact sessionId from manager_workspace discovery with surfaceId. No browser operation was sent.');
      const read = await action({ action: 'workspacePanel', payload: { projectPath: args.projectPath, targetDeviceId: args.targetDeviceId, panelRequest: { operation: 'read', surfaceId: args.surfaceId, sessionId: args.sessionId, includeContent: false } } }, signal);
      if (read.isError) return read;
      surface = JSON.parse(read.content[0].text).payload?.workspacePanel?.surfaces?.[0];
      if (!surface) throw new Error('The requested dashboard did not return a workspace surface. No browser operation was sent.');
      executionDeviceId = surface.targetDeviceId ?? args.targetDeviceId;
    }
    const response = await action(
      {
        action: "workspaceBrowser",
        payload: {
          projectPath: args.projectPath,
          ...(typeof executionDeviceId === "string" && executionDeviceId.trim() ? { targetDeviceId: executionDeviceId } : {}),
          browserRequest: { operationId: randomUUID(), ...args.request, sessionId: surface?.sessionId ?? args.sessionId }
        }
      },
      signal
    );
    if (response.isError) return response;
    const result = JSON.parse(response.content[0].text),
      state = result.payload?.workspaceBrowser;
    if (surface && state?.pageId && ['open', 'navigate'].includes(args.request.operation)) {
      const presented = await action({ action: 'workspacePanel', payload: { projectPath: args.projectPath, targetDeviceId: args.targetDeviceId,
        panelRequest: { operation: 'select', surfaceId: args.surfaceId, sessionId: surface.sessionId, tab: `browser:${state.pageId}` } } }, signal);
      if (presented.isError) return failure('The browser operation completed, but the requested dashboard did not confirm showing its tab. Inspect before retrying. ' + presented.content[0].text);
    }
    if (state?.image || state?.feedbackImage) {
      const image = state.image || state.feedbackImage;
      delete state.feedbackImage;
      delete state.image;
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
          { type: "image", mimeType: "image/jpeg", data: image.split(",")[1] }
        ]
      };
    }
    return response;
  }
  throw new Error("Unknown tool. Call tools/list.");
}

function workspaceImage(response) {
  if (response.isError) return response;
  const result = JSON.parse(response.content[0].text);
  const contentValue = result.payload?.workspacePanel?.content;
  if (contentValue?.image?.startsWith('data:image/jpeg;base64,')) {
    const image = contentValue.image; delete contentValue.image;
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }, { type: 'image', mimeType: 'image/jpeg', data: image.split(',')[1] }] };
  }
  return response;
}
async function handle(message, signal) {
  if (message.method === "initialize") {
    initialized = true;
    return {
      protocolVersion: versions.includes(message.params?.protocolVersion)
        ? message.params.protocolVersion
        : versions[0],
      capabilities: { tools: {} },
      serverInfo: { name: "codex-manager", version: manifest.version }
    };
  }
  if (message.method === "ping") return {};
  if (!initialized) throw Object.assign(new Error("Initialize MCP first."), { code: -32002 });
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") {
    try {
      return await tool(message.params?.name, message.params?.arguments || {}, signal);
    } catch (error) {
      return failure(error.message);
    }
  }
  throw Object.assign(new Error("Method not found."), { code: -32601 });
}
function receive(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    write({ id: null, error: { code: -32700, message: "Parse error." } });
    return;
  }
  if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    write({ id: message?.id ?? null, error: { code: -32600, message: "Invalid request." } });
    return;
  }
  if (message.id === undefined) {
    if (message.method === "notifications/cancelled") calls.get(message.params?.requestId)?.abort();
    return;
  }
  if (!["string", "number"].includes(typeof message.id)) {
    write({ id: null, error: { code: -32600, message: "Invalid request ID." } });
    return;
  }
  if (calls.has(message.id)) {
    write({ id: message.id, error: { code: -32600, message: "Duplicate pending request ID." } });
    return;
  }
  if (calls.size >= 8) {
    write({ id: message.id, error: { code: -32000, message: "MCP request capacity reached. Nothing was queued." } });
    return;
  }
  const controller = new AbortController();
  calls.set(message.id, controller);
  handle(message, controller.signal)
    .then(
      (result) => write({ id: message.id, result }),
      (error) => write({ id: message.id, error: { code: error.code || -32603, message: error.message } })
    )
    .finally(() => {
      calls.delete(message.id);
      if (ending && !calls.size) process.exitCode = 0;
    });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) {
    process.stderr.write("MCP input exceeded 2 MiB.\n");
    process.exit(1);
  }
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (line) receive(line);
  }
});
process.stdin.on("end", () => {
  ending = true;
  for (const controller of calls.values()) controller.abort();
});
process.once("SIGTERM", () => {
  for (const controller of calls.values()) controller.abort();
  process.exit(0);
});
