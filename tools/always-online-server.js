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
  if (!message || message.type !== "peer:sessions" || typeof message.deviceId !== "string" ||
      typeof message.deviceName !== "string" || !Array.isArray(message.sessions) ||
      typeof message.sentAt !== "number" || typeof message.signature !== "string") return false;
  if (Math.abs(Date.now() - message.sentAt) > 120000 || !hostKey) return false;
  const expected = crypto.createHmac("sha256", Buffer.from(hostKey, "base64url"))
    .update(signaturePayload(message), "utf8").digest("base64url");
  const a = Buffer.from(expected); const b = Buffer.from(message.signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function aggregate() {
  return { type: "peer:aggregate", peers: [...peers.values()].map((entry) => entry.message) };
}

function broadcast(value) {
  const raw = JSON.stringify(value);
  for (const entry of peers.values()) if (entry.socket.readyState === 1) entry.socket.send(raw);
}

function removePeer(deviceId, socket) {
  const entry = peers.get(deviceId);
  if (entry && entry.socket === socket) {
    peers.delete(deviceId);
    broadcast(aggregate());
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
  if (pendingActions.has(message.requestId)) return false;
  const timer = setTimeout(() => {
    const pending = pendingActions.get(message.requestId);
    if (!pending || pending.originSocket !== originSocket) return;
    pendingActions.delete(message.requestId);
    if (originSocket.readyState === 1) {
      originSocket.send(JSON.stringify({
        type: "peer:action-result",
        requestId: message.requestId,
        status: "failed",
        error: "The selected PC did not respond in time. The operation outcome is unknown; check the target PC before retrying."
      }));
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
        peers.set(message.deviceId, { message, socket: { readyState: 0, send() {} }, lastSeen: Date.now() });
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
  let deviceId;
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(String(raw));
      if (message.type === "peer:sessions") {
        if (!isValidPeer(message)) { socket.close(); return; }
        deviceId = message.deviceId;
        peers.set(deviceId, { socket, message, lastSeen: Date.now() });
        socket.send(JSON.stringify(aggregate()));
        broadcast(aggregate());
      } else if (message.type === "peer:action" && deviceId && peers.get(deviceId)?.socket === socket) {
        if (typeof message.requestId !== "string" || message.requestId.length > 256 ||
            typeof message.action !== "string" || message.action.length > 128) {
          socket.close();
          return;
        }
        const target = message.payload && message.payload.targetDeviceId;
        const destination = target && target !== "local" ? peers.get(target) : undefined;
        if (!destination || destination.socket.readyState !== 1) {
          socket.send(JSON.stringify({ type: "peer:action-result", requestId: message.requestId, status: "failed", error: "The selected PC is offline." }));
          return;
        }
        if (!rememberPendingAction(message, socket, destination.socket)) {
          socket.send(JSON.stringify({ type: "peer:action-result", requestId: message.requestId, status: "failed", error: "That action request is already pending. Try again." }));
          return;
        }
        destination.socket.send(JSON.stringify({
          ...message,
          payload: message.payload ? { ...message.payload, targetDeviceId: undefined } : message.payload
        }));
      } else if (message.type === "peer:action-result" && typeof message.requestId === "string" &&
                 deviceId && peers.get(deviceId)?.socket === socket) {
        const origin = takePendingAction(message.requestId, socket);
        if (origin && origin.readyState === 1) origin.send(JSON.stringify(message));
      }
    } catch { socket.close(); }
  });
  socket.on("close", () => removePeer(deviceId, socket));
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
  for (const entry of peers.values()) closePeerSocket(entry.socket);
  peers.clear();
  wsServer.close(finish);
  httpServer.close(finish);
  setTimeout(finish, 1000).unref();
}
process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));
setInterval(() => {
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
