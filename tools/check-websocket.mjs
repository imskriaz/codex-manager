import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const localOrigin = "http://127.0.0.1:39875";
const sockets = [];
const open = async (url, origin) => {
  const socket = new WebSocket(url, { origin, handshakeTimeout: 10_000 });
  const messages = [];
  socket.on("message", raw => messages.push(JSON.parse(String(raw))));
  socket.on("error", () => undefined);
  sockets.push(socket);
  await once(socket, "open", { signal: AbortSignal.timeout(15_000) });
  return { socket, messages };
};
const message = (client, predicate, label) => new Promise((resolve, reject) => {
  const existing = client.messages.find(predicate);
  if (existing) { resolve(existing); return; }
  if (client.socket.readyState !== WebSocket.OPEN) { reject(new Error(`${label}: socket closed`)); return; }
  const timer = setTimeout(() => finish(new Error(`${label}: no response within 30 seconds`)), 30_000);
  const finish = (error, value) => { clearTimeout(timer); client.socket.off("message", onMessage); client.socket.off("close", onClose); client.socket.off("error", onError); error ? reject(error) : resolve(value); };
  const onMessage = raw => { const value = JSON.parse(String(raw)); if (predicate(value)) finish(undefined, value); };
  const onClose = () => finish(new Error(`${label}: socket closed`));
  const onError = error => finish(error);
  client.socket.on("message", onMessage).once("close", onClose).once("error", onError);
});
const request = async (client, action) => {
  const requestId = randomUUID();
  const started = performance.now();
  client.socket.send(JSON.stringify({ type: "dashboard:action", action, requestId }));
  const result = await message(client, value => value.type === "dashboard:action-result" && value.requestId === requestId, action);
  assert.equal(result.status, "completed", result.error);
  return Math.round(performance.now() - started);
};
const heartbeat = async socket => { const token = randomUUID(); const pong = once(socket, "pong", { signal: AbortSignal.timeout(10_000) }); socket.ping(token); assert.equal(String((await pong)[0]), token); };

try {
  const first = await open("ws://127.0.0.1:39875/ws", localOrigin);
  const snapshot = await message(first, value => value.type === "dashboard:snapshot", "snapshot");
  assert.ok(Array.isArray(snapshot.state.accounts));
  const responseMs = await Promise.all(Array.from({ length: 6 }, () => request(first, "refreshView")));
  await heartbeat(first.socket);
  first.socket.send("{");
  await message(first, value => value.type === "dashboard:notice" && value.level === "error", "invalid frame");
  first.socket.terminate();
  const recovered = await open("ws://127.0.0.1:39875/ws", localOrigin);
  await message(recovered, value => value.type === "dashboard:snapshot", "reconnect snapshot");
  await request(recovered, "refreshView");
  await heartbeat(recovered.socket);
  const configured = String(snapshot.state.settings.cloudflaredDomain || "").trim();
  if (!configured) await assert.rejects(open("ws://127.0.0.1:39875/ws?peer=1", localOrigin));
  let crossPc = "disabled without Cloudflared domain";
  if (configured) {
    const origin = new URL(/^https?:\/\//i.test(configured) ? configured : `https://${configured}`);
    assert.ok(origin.protocol === "https:" && !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash, "Cloudflared must be a valid HTTPS origin");
    const endpoint = new URL("/ws", origin);
    endpoint.protocol = "wss:";
    endpoint.searchParams.set("peer", "1");
    endpoint.searchParams.set("deviceId", `socket-check-${randomUUID()}`);
    const remote = await open(endpoint, origin.origin);
    await heartbeat(remote.socket);
    crossPc = "configured domain: secure handshake and heartbeat passed; signed peer authentication not checked";
  }
  console.log(JSON.stringify({ transport: "websocket only", local: { snapshot: "passed", concurrentRequests: responseMs.length, responseMs, heartbeat: "passed", invalidFrameRecovery: "passed", reconnect: "passed" }, crossPc }));
} finally {
  for (const socket of sockets) { socket.on("error", () => undefined); socket.readyState === WebSocket.OPEN ? socket.close() : socket.terminate(); }
}
