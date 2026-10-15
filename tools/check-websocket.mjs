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
  sockets.push(socket);
  await once(socket, "open", { signal: AbortSignal.timeout(15_000) });
  return { socket, messages };
};
const message = (client, predicate, label) => new Promise((resolve, reject) => {
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
  console.log(JSON.stringify({ transport: "websocket only", local: { snapshot: "passed", concurrentRequests: responseMs.length, responseMs, heartbeat: "passed", invalidFrameRecovery: "passed", reconnect: "passed" }, crossPc: configured ? "configured" : "disabled without Cloudflared domain" }));
} finally {
  for (const socket of sockets) { socket.on("error", () => undefined); socket.readyState === WebSocket.OPEN ? socket.close() : socket.terminate(); }
}
