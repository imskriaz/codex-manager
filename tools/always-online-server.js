/*
 * Detached, dependency-light WebSocket relay for Codex Manager.
 * It is intentionally a relay, not a second account store: VS Code peers
 * remain the source of truth and continue to execute all dashboard actions.
 */
const http = require("node:http");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const configPath = process.argv[2];
if (!configPath) throw new Error("Missing relay config path");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
// The detached relay takes over the normal dashboard port after VS Code
// releases it. Ignore stale config values so this project never opens a
// second dashboard port.
const port = 39875;
const hostKey = String(config.hostKey || "");
const adminToken = String(config.adminToken || "");
const peers = new Map();
const pendingActions = new Map();
const replayEvents = new Map();
const eventRevisions = new Map();
const EVENT_TTL_MS = 5 * 60 * 1000;
const MAX_PEERS = 64;
const MAX_PENDING_ACTIONS = 128;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_REPLAY_BYTES = 4 * 1024 * 1024;
const MAX_REPLAY_EVENTS = 256;
const MAX_EVENT_STREAMS = 64;
let replayBytes = 0;
let liveContract;
for (const root of config.modulePaths || [path.resolve(__dirname, "..")]) {
  try {
    liveContract = require(path.join(root, "out", "domain", "codexSessionLive.js"));
    if (typeof liveContract.isCodexSessionLiveState === "function" && typeof liveContract.isNewerCodexSessionLiveState === "function") break;
    liveContract = undefined;
  } catch { /* Other relay events remain available if this dependency is unavailable. */ }
}
const startedAt = Date.now();
let WebSocketServer;
try {
  const wsPackage = require.resolve("ws", { paths: config.modulePaths || [process.cwd()] });
  ({ WebSocketServer } = require(wsPackage));
} catch (error) {
  console.error("[codex-manager-relay] ws dependency unavailable", error);
  process.exitCode = 1;
  return;
}

function signaturePayload(message) {
  return JSON.stringify({
    type: "peer:sessions",
    deviceId: message.deviceId,
    deviceName: message.deviceName,
    sessions: message.sessions,
    accounts: message.accounts || [],
    enablementRegistry: message.enablementRegistry || [],
    sentAt: message.sentAt
  });
}

function isValidPeer(message) {
  if (!message || message.type !== "peer:sessions" || !boundedId(message.deviceId) ||
      !boundedText(message.deviceName, 256) || !Array.isArray(message.sessions) || message.sessions.length > 1000 ||
      typeof message.sentAt !== "number" || !Number.isFinite(message.sentAt) || typeof message.signature !== "string") return false;
  if (Math.abs(Date.now() - message.sentAt) > 120000 || !hostKey) return false;
  const expected = crypto.createHmac("sha256", Buffer.from(hostKey, "base64url"))
    .update(signaturePayload(message), "utf8").digest("base64url");
  const a = Buffer.from(expected); const b = Buffer.from(message.signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function aggregate() {
  return { type: "peer:aggregate", peers: [...peers.values()].map((entry) => entry.message) };
}

function send(socket, value) {
  if (!socket || socket.readyState !== 1) return false;
  try {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    const bytes = Buffer.byteLength(raw);
    if (bytes > MAX_EVENT_BYTES || (socket.bufferedAmount || 0) + bytes > MAX_REPLAY_BYTES) { closePeerSocket(socket); return false; }
    socket.send(raw);
    return true;
  } catch { closePeerSocket(socket); return false; }
}

function broadcast(value, originSocket) {
  const raw = JSON.stringify(value);
  for (const entry of peers.values()) if (entry.socket !== originSocket) send(entry.socket, raw);
}

function removePeer(deviceId, socket) {
  const entry = peers.get(deviceId);
  if (entry && entry.socket === socket) {
    peers.delete(deviceId);
    broadcast(aggregate());
  }
  for (const [requestId, pending] of pendingActions) {
    if (pending.originSocket !== socket && pending.destinationSocket !== socket) continue;
    pendingActions.delete(requestId);
    clearTimeout(pending.timer);
    if (pending.originSocket !== socket) send(pending.originSocket, { type: "peer:action-result", requestId,
      status: "failed", error: "The selected PC disconnected. The operation outcome is unknown; check that PC before retrying." });
  }
}

function closePeerSocket(socket) {
  if (!socket) return;
  if (typeof socket.terminate === "function") socket.terminate();
  else if (typeof socket.close === "function") socket.close();
}

function peerActionTimeoutMs(action) {
  if (action === "sendCodexCliSessionMessage") return 15 * 60 * 1000 + 15 * 1000;
  if (["runWorkspaceTerminalCommand", "saveWorkspaceFile", "pushWorkspaceBranch"].includes(action)) return 135000;
  if (["switch", "refresh", "refreshAll", "refreshToken", "reauthorize", "resyncProfile", "getDailyUsage", "startCodexCliSession", "importSharedJson", "completeOAuthSession"].includes(action)) return 120000;
  if (["restoreFromBackup", "restoreFromAuthJson", "commitWorkspaceChanges"].includes(action)) return 60000;
  return 30000;
}

function rememberPendingAction(message, originSocket, destinationSocket) {
  if (pendingActions.has(message.requestId) || pendingActions.size >= MAX_PENDING_ACTIONS) return false;
  const timer = setTimeout(() => {
    const pending = pendingActions.get(message.requestId);
    if (!pending || pending.originSocket !== originSocket) return;
    pendingActions.delete(message.requestId);
    if (originSocket.readyState === 1) {
      send(originSocket, {
        type: "peer:action-result",
        requestId: message.requestId,
        status: "failed",
        error: "The selected PC did not respond in time. The operation outcome is unknown; check the target PC before retrying."
      });
    }
  }, peerActionTimeoutMs(message.action));
  timer.unref();
  pendingActions.set(message.requestId, { originSocket, destinationSocket, timer });
  return true;
}

function takePendingAction(requestId, sourceSocket) {
  const pending = pendingActions.get(requestId);
  if (!pending || pending.destinationSocket !== sourceSocket) return undefined;
  pendingActions.delete(requestId);
  clearTimeout(pending.timer);
  return pending.originSocket;
}

function boundedText(value, limit) { return typeof value === "string" && value.length <= limit; }
function boundedId(value) { return boundedText(value, 256) && value.trim().length > 0; }
function ownedPayload(value, deviceId) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    (value.deviceId === undefined || value.deviceId === deviceId);
}
function removeReplay(key) {
  const entry = replayEvents.get(key);
  if (entry) replayBytes -= entry.bytes;
  replayEvents.delete(key);
}
function pruneEvents() {
  const now = Date.now();
  for (const [key, entry] of replayEvents) if (entry.expiresAt <= now) removeReplay(key);
  for (const [key, entry] of eventRevisions) if (entry.expiresAt <= now) eventRevisions.delete(key);
}
function rememberEvent(key, message, revisionKey, revision) {
  pruneEvents();
  if (revisionKey && !eventRevisions.has(revisionKey) && eventRevisions.size >= MAX_EVENT_STREAMS) return false;
  const raw = JSON.stringify(message);
  const bytes = Buffer.byteLength(raw);
  if (bytes > MAX_EVENT_BYTES) return false;
  removeReplay(key);
  while (replayEvents.size >= MAX_REPLAY_EVENTS || replayBytes + bytes > MAX_REPLAY_BYTES) {
    removeReplay(replayEvents.keys().next().value);
  }
  const expiresAt = Date.now() + EVENT_TTL_MS;
  replayEvents.set(key, { raw, bytes, deviceId: message.deviceId, expiresAt, type: message.type });
  replayBytes += bytes;
  if (revisionKey) eventRevisions.set(revisionKey, { ...revision, expiresAt });
  return true;
}
function acceptVault(message, socket, deviceId) {
  pruneEvents();
  if (peers.get(deviceId)?.lastSeen < Date.now() - 30000 || message.deviceId !== deviceId || !boundedText(message.vault, MAX_EVENT_BYTES) ||
      !Number.isFinite(message.sentAt) || Math.abs(Date.now() - message.sentAt) > 120000 ||
      typeof message.signature !== "string" || !hostKey) return false;
  const unsigned = { type: "peer:vault", deviceId, sentAt: message.sentAt, vault: message.vault };
  const expected = crypto.createHmac("sha256", Buffer.from(hostKey, "base64url"))
    .update(JSON.stringify(unsigned), "utf8").digest("base64url");
  const a = Buffer.from(expected), b = Buffer.from(message.signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const key = JSON.stringify([deviceId, "vault"]);
  if (eventRevisions.get(key)?.sentAt >= message.sentAt) return false;
  // Ciphertext signatures expire independently of the live-event replay window.
  if (!rememberEvent(key, message, key, { sentAt: message.sentAt })) return false;
  replayEvents.get(key).expiresAt = Math.min(Date.now() + EVENT_TTL_MS, message.sentAt + 120000);
  broadcast(message, socket);
  return true;
}
function replayTo(socket, ownDeviceId) {
  pruneEvents();
  for (const entry of replayEvents.values()) {
    if (entry.deviceId === ownDeviceId) continue;
    // Running output and unanswered prompts are useful only while their owner is reachable.
    if (entry.type !== "peer:terminal-complete" && peers.get(entry.deviceId)?.socket.readyState !== 1) continue;
    if (!send(socket, entry.raw)) break;
  }
}
function acceptRealtimeEvent(message, socket, deviceId) {
  if (message.deviceId !== deviceId || peers.get(deviceId)?.socket !== socket || peers.get(deviceId).lastSeen < Date.now() - 30000) return false;
  pruneEvents();
  let key, revisionKey, revision;
  if (message.type === "peer:codex-session-live") {
    const state = message.state;
    if (!liveContract?.isCodexSessionLiveState(state) || !ownedPayload(state, deviceId) ||
        state.updatedAt <= Date.now() - EVENT_TTL_MS || state.updatedAt > Date.now() + 10000) return false;
    revisionKey = JSON.stringify([deviceId, "live", state.sessionId]);
    const previous = eventRevisions.get(revisionKey)?.state;
    if (!liveContract.isNewerCodexSessionLiveState(state, previous)) return false;
    key = revisionKey;
    revision = { state: { sessionId: state.sessionId, deviceId: state.deviceId, streamId: state.streamId, sequence: state.sequence, updatedAt: state.updatedAt, status: state.status } };
  } else if (message.type === "peer:terminal-output") {
    const output = message.output;
    if (!ownedPayload(output, deviceId) || !boundedId(output.id) || !boundedId(output.terminalId) ||
        !boundedText(output.command, 12000) || !boundedText(output.cwd, 4096) || !boundedText(output.chunk, 128 * 1024) ||
        !["stdout", "stderr", "terminal"].includes(output.stream) || !Number.isSafeInteger(output.sequence) || output.sequence < 0) return false;
    revisionKey = JSON.stringify([deviceId, "terminal", output.id]);
    const previous = eventRevisions.get(revisionKey);
    if (previous && (previous.completed || output.sequence <= previous.sequence)) return false;
    key = JSON.stringify([revisionKey, output.sequence]);
    revision = { sequence: output.sequence };
  } else if (message.type === "peer:terminal-complete") {
    const result = message.result;
    if (!ownedPayload(result, deviceId) || !boundedId(result.id) || !boundedId(result.terminalId) ||
        !boundedText(result.command, 12000) || !boundedText(result.cwd, 4096) || !boundedText(result.output, 512 * 1024) ||
        !["running", "completed", "failed", "cancelled", "timedOut", "untracked"].includes(result.status) ||
        !Number.isFinite(result.durationMs) || result.durationMs < 0 || !boundedText(result.finishedAt, 64) ||
        !Number.isFinite(Date.parse(result.finishedAt)) ||
        Date.parse(result.finishedAt) <= Date.now() - EVENT_TTL_MS || Date.parse(result.finishedAt) > Date.now() + 10000 ||
        (result.exitCode !== undefined && !Number.isSafeInteger(result.exitCode))) return false;
    revisionKey = JSON.stringify([deviceId, "terminal", result.id]);
    const previous = eventRevisions.get(revisionKey);
    const signature = crypto.createHash("sha256").update(JSON.stringify(result)).digest("hex");
    if (previous?.completed || previous?.signature === signature) return false;
    // The completion contains the bounded full output, replacing incremental chunks.
    for (const [eventKey, entry] of replayEvents) if (entry.type === "peer:terminal-output" && eventKey.startsWith(`[${JSON.stringify(revisionKey)},`)) removeReplay(eventKey);
    key = revisionKey;
    revision = { completed: result.status !== "running", sequence: previous?.sequence ?? -1, signature };
  } else if (message.type === "peer:codex-request") {
    const request = message.request;
    if (!ownedPayload(request, deviceId) || !boundedId(request.id) || !boundedId(request.threadId) ||
        !["command", "file-change", "permissions", "question"].includes(request.kind) ||
        !boundedText(request.title, 12000) || (request.detail !== undefined && !boundedText(request.detail, 64000)) ||
        (request.cwd !== undefined && !boundedText(request.cwd, 4096)) ||
        (request.questions !== undefined && (!Array.isArray(request.questions) || request.questions.length > 20 ||
          !request.questions.every(question => question && boundedId(question.id) && boundedText(question.header, 256) &&
            boundedText(question.question, 12000) && typeof question.isSecret === "boolean" &&
            (question.options === undefined || (Array.isArray(question.options) && question.options.length <= 30 &&
              question.options.every(option => option && boundedText(option.label, 256) && boundedText(option.description, 2000)))))))) return false;
    revisionKey = JSON.stringify([deviceId, "prompt", request.id]);
    const previous = eventRevisions.get(revisionKey);
    const signature = crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex");
    if (previous?.resolved || previous?.signature === signature) return false;
    key = revisionKey;
    revision = { signature };
  } else if (message.type === "peer:codex-request-resolved") {
    if (!boundedId(message.requestId)) return false;
    revisionKey = JSON.stringify([deviceId, "prompt", message.requestId]);
    if (eventRevisions.get(revisionKey)?.resolved) return false;
    key = revisionKey;
    revision = { resolved: true };
  } else return false;
  if (!rememberEvent(key, message, revisionKey, revision)) return false;
  if (message.type === "peer:codex-session-live") replayEvents.get(key).expiresAt = Math.min(Date.now() + EVENT_TTL_MS, message.state.updatedAt + EVENT_TTL_MS);
  broadcast(message, socket);
  return true;
}

const httpServer = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ ok: true, service: "codex-manager-relay", port, peerCount: peers.size, startedAt }));
    return;
  }
  if (request.method === "POST" && request.url === "/shutdown") {
    if (request.headers["x-codex-admin"] !== adminToken || !adminToken) { response.statusCode = 403; response.end("Forbidden"); return; }
    response.end("Shutting down");
    setImmediate(() => shutdown(0));
    return;
  }
  if (request.method === "POST" && request.url === "/api/peer-heartbeat") {
    let body = "";
    request.on("data", (chunk) => { body += chunk; if (body.length > 2 * 1024 * 1024) request.destroy(); });
    request.on("end", () => {
      try {
        const message = JSON.parse(body);
        if (!isValidPeer(message)) throw new Error("invalid heartbeat");
        const previous = peers.get(message.deviceId);
        if (previous?.message.sentAt > message.sentAt) throw new Error("stale heartbeat");
        if (!previous && peers.size >= MAX_PEERS) throw new Error("peer limit reached");
        peers.set(message.deviceId, { message, socket: previous?.socket ?? { readyState: 0, send() {} }, lastSeen: Date.now() });
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify(aggregate()));
        broadcast(aggregate());
      } catch { response.statusCode = 400; response.end("Invalid heartbeat"); }
    });
    return;
  }
  if (request.method === "GET") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>Codex Manager relay</title><h1>Codex Manager relay is online</h1><p>WebSocket peers: " + peers.size + "</p><p>This host keeps the multi-PC transport alive while VS Code is closed.</p>");
    return;
  }
  response.statusCode = 404; response.end("Not found");
});

const wsServer = new WebSocketServer({ server: httpServer, path: "/ws", maxPayload: 2 * 1024 * 1024 });
wsServer.on("connection", (socket, request) => {
  const query = new URL(request.url || "/ws", "http://127.0.0.1").searchParams;
  if (query.get("peer") !== "1") { socket.close(); return; }
  if (wsServer.clients?.size > MAX_PEERS * 2) { closePeerSocket(socket); return; }
  let deviceId;
  const authenticationTimer = setTimeout(() => { if (!deviceId) closePeerSocket(socket); }, 10000);
  authenticationTimer.unref();
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(String(raw));
      if (message.type === "peer:sessions") {
        if (!isValidPeer(message)) { socket.close(); return; }
        if (deviceId && deviceId !== message.deviceId) { closePeerSocket(socket); return; }
        const previous = peers.get(message.deviceId);
        if (previous?.message.sentAt > message.sentAt) return;
        if (previous?.socket.readyState === 1 && previous.socket !== socket && previous.message.sentAt >= message.sentAt) {
          closePeerSocket(socket); return;
        }
        if (!previous && peers.size >= MAX_PEERS) { closePeerSocket(socket); return; }
        const firstAuthentication = !deviceId;
        if (previous?.socket !== socket) closePeerSocket(previous?.socket);
        deviceId = message.deviceId;
        clearTimeout(authenticationTimer);
        peers.set(deviceId, { socket, message, lastSeen: Date.now() });
        send(socket, aggregate());
        broadcast(aggregate());
        if (firstAuthentication) replayTo(socket, deviceId);
      } else if (message.type === "peer:action" && deviceId && peers.get(deviceId)?.socket === socket) {
        if (!boundedId(message.requestId) || !boundedText(message.action, 128) || !message.action ||
            (message.payload !== undefined && (!message.payload || typeof message.payload !== "object" || Array.isArray(message.payload)))) {
          socket.close();
          return;
        }
        const target = message.payload && message.payload.targetDeviceId;
        const destination = target && target !== "local" ? peers.get(target) : undefined;
        if (!destination || destination.socket.readyState !== 1) {
          send(socket, { type: "peer:action-result", requestId: message.requestId, status: "failed", error: "The selected PC is offline." });
          return;
        }
        if (!rememberPendingAction(message, socket, destination.socket)) {
          send(socket, { type: "peer:action-result", requestId: message.requestId, status: "failed", error: "That action request is already pending or the relay queue is full. Try again later." });
          return;
        }
        if (!send(destination.socket, {
          ...message,
          payload: message.payload ? { ...message.payload, targetDeviceId: undefined } : message.payload
        })) removePeer(target, destination.socket);
      } else if (message.type === "peer:action-result" && typeof message.requestId === "string" &&
                 deviceId && peers.get(deviceId)?.socket === socket) {
        if (!boundedId(message.requestId) || !["completed", "cancelled", "failed"].includes(message.status) ||
            (message.error !== undefined && !boundedText(message.error, 12000))) return;
        const origin = takePendingAction(message.requestId, socket);
        if (origin && origin.readyState === 1) send(origin, message);
      } else if (deviceId && peers.get(deviceId)?.socket === socket) {
        if (message.type === "peer:vault") acceptVault(message, socket, deviceId);
        else acceptRealtimeEvent(message, socket, deviceId);
      }
    } catch { socket.close(); }
  });
  socket.on("close", () => { clearTimeout(authenticationTimer); removePeer(deviceId, socket); });
  socket.on("error", () => { clearTimeout(authenticationTimer); removePeer(deviceId, socket); closePeerSocket(socket); });
});

const pidPath = config.pidPath;
// Record the waiting relay before binding. During a normal VS Code handoff the
// dashboard still owns the shared port briefly, and the next extension host
// must be able to identify and stop this exact relay process.
if (pidPath) fs.writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
function bind() {
  const onError = (error) => {
    httpServer.off("error", onError);
    if (error && error.code === "EADDRINUSE") {
      setTimeout(bind, 2000).unref();
      return;
    }
    console.error("[codex-manager-relay] listen failed", error);
    shutdown(1);
  };
  httpServer.once("error", onError);
  httpServer.listen(port, "127.0.0.1", () => {
    httpServer.off("error", onError);
    console.log(`[codex-manager-relay] listening on 127.0.0.1:${port}`);
  });
}
bind();

function shutdown(code) {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (pidPath) { try { fs.unlinkSync(pidPath); } catch {} }
    process.exit(code);
  };
  for (const pending of pendingActions.values()) clearTimeout(pending.timer);
  pendingActions.clear();
  replayEvents.clear();
  eventRevisions.clear();
  replayBytes = 0;
  for (const entry of peers.values()) closePeerSocket(entry.socket);
  peers.clear();
  wsServer.close(finish);
  httpServer.close(finish);
  setTimeout(finish, 1000).unref();
}
process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));
setInterval(() => {
  pruneEvents();
  const cutoff = Date.now() - 30000;
  let changed = false;
  for (const [id, entry] of peers) {
    if (entry.lastSeen >= cutoff) continue;
    peers.delete(id);
    changed = true;
    if (entry.socket.readyState === 1 && typeof entry.socket.terminate === "function") entry.socket.terminate();
  }
  if (changed) broadcast(aggregate());
}, 5000).unref();
